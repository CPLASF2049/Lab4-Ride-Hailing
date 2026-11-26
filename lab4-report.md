# Lab 4：网约车平台的微服务治理报告

> 课程：高级软件工程　实验：Lab 4　小组：第 32 组
> 成员：李金正（26113050066）、李思源（26213050248）
> 仓库：`lab4-rideshare`　部署：Docker Compose（Docker Desktop 29.8，Linux 容器）
> 验证日期：2026-11-26

## 〇、部署环境与结论

本实验在 Lab 3 代码基础上完成，业务仍为上海单城网约车。新增治理能力均通过 **Docker Compose** 实际运行验证，不是仅做配置。

| 项目 | 实际值 |
| --- | --- |
| 容器运行时 | Docker Desktop 29.8.0（Linux 容器），Compose 5.5.1 |
| 基础镜像 | `node:24-alpine`，业务代码零 npm 依赖 |
| 容器数量 | 7：registry、gateway、order、order-query、driver、dispatch、pricing |
| 统一入口 | `http://localhost:8083` |
| 注册目录 | `http://localhost:8500/v1/catalog` |
| 自动化测试 | 77 项通过、0 失败（含 3 项契约测试） |
| 扩缩容实测 | order-query 1 → 2 → 1，两副本各承担 6/12 次查询 |
| 容错实测 | 慢依赖、持续失败、熔断、恢复、限流均触发并可恢复 |

一键启动：

```powershell
docker compose up -d --build
docker compose ps          # 7 个服务均 healthy
```

七项容器健康状态已保存于 [docs/evidence/compose-ps.txt](docs/evidence/compose-ps.txt)。所有后续数据均来自实际运行，日志带容器前缀，可按订单 ID 关联。

---

## 一、服务注册与发现

### 1.1 所选方案

采用**应用层注册中心**（`services/registry`），而不是 Eureka/Consul。原因：

1. 本组技术栈为 Node.js，引入 JVM 注册中心会额外增加运行依赖和镜像体积，不符合实验“部署可复现”的目标；
2. 作业明确允许“应用层注册中心，也可以使用部署平台提供的服务发现机制”；
3. 自建注册中心可以完整展示注册、心跳、租约、实例变更、摘除等过程，便于验证与讲解。

注册中心是独立业务容器 `registry:8500`，内存保存实例，不持久化；它是治理组件，不参与订单业务。

### 1.2 注册过程

每个业务进程启动并成功监听端口后，由 [common/registration.mjs](common/registration.mjs) 调用：

```http
PUT /v1/instances/{instanceId}
X-Internal-Token: ...
Content-Type: application/json

{"service":"order-query","address":"172.20.0.5","port":3102,"ttl_ms":10000}
```

- 实例 ID 为 `服务名-容器主机名-端口`，例如 `order-query-3e10332b5ac6-3102`，同一服务多副本天然不同。
- 注册成功后每 **3 秒**重复 PUT 续约；失败只记录日志并继续重试，不阻塞业务。
- 收到 `SIGTERM` 时执行 `DELETE /v1/instances/{id}` 立即注销；`docker compose stop` 属于优雅停止，因此缩容后目录马上减少。
- 若进程崩溃未注销，注册中心每秒扫描，超过 **10 秒** 租约的实例被摘除。

服务名与容器名一致：`order`、`order-query`、`driver`、`dispatch`、`pricing`、`gateway`。`order-query` 的目录名与 `services/query` 目录不同，但对外注册名统一为 `order-query`，与作业用词一致。

### 1.3 发现过程

网关和业务调用方都使用 [common/discovery.mjs](common/discovery.mjs)：

```http
GET /v1/catalog/order-query
```

返回当前健康实例列表。客户端行为：

1. 结果缓存 **1.5 秒**，避免每次请求都访问注册中心；
2. 同一服务的多个实例按轮询选择，游标保存在进程内；
3. GET 请求若连接某个实例失败，自动尝试下一个实例并记录 `instance_failover`；
4. 注册中心短暂不可用时使用最后一次缓存；从未取得结果时返回 `503 NO_INSTANCE`，不猜测地址。

内部调用关系全部改为按注册名解析，不再依赖固定 URL：

| 调用方 | 被调服务 |
| --- | --- |
| gateway | order、order-query、driver、dispatch、pricing |
| order | pricing、driver、dispatch、order-query（事件扇出） |
| dispatch | driver、order |
| order-query | driver（组合查询）、order（启动引导） |

### 1.4 实例变化验证

启动后目录（[gateway-trace.json](docs/evidence/gateway-trace.json)）：

```json
{"services":{
  "order":[{"id":"order-a4e3b8b49a23-3101"}],
  "order-query":[{"id":"order-query-7dc41aac4b7d-3102"}],
  "driver":[{"id":"driver-0c39d9213059-3103"}],
  "dispatch":[{"id":"dispatch-851b08003934-3104"}],
  "pricing":[{"id":"pricing-ac5bc66891fd-3105"}],
  "gateway":[{"id":"gateway-99398ed4dba3-8083"}]}}
```

扩容到两个副本后，`GET /v1/catalog/order-query` 返回两个不同实例；缩容后恢复一个。网关健康接口同时显示实例数量与每个副本的 `bootstrap_state`，见第五部分与 [scaling.json](docs/evidence/scaling.json)。

---

## 二、API 网关

### 2.1 网关与访问地址

网关由 [services/gateway/service.mjs](services/gateway/service.mjs) 实现，是唯一对外业务入口：

- 页面与静态资源：`http://localhost:8083/`
- 统一业务 API：`http://localhost:8083/api/...`
- 健康与目录观测：`GET /api/system/health`、`GET /api/system/discovery`

只有网关和注册中心发布到宿主机（均绑定 `127.0.0.1`），五个业务服务不发布端口。

### 2.2 路由与路径重写

网关先去掉 `/api` 前缀，再按白名单匹配；命中后由服务发现选择实例，转发路径保持业务路径：

| 外部请求 | 目标服务 | 上游路径 |
| --- | --- | --- |
| `POST /api/orders` | order | `/orders` |
| `POST /api/orders/{id}/cancel` | order | `/orders/{id}/cancel` |
| `POST /api/orders/{id}/arrive` | order | `/orders/{id}/arrive` |
| `POST /api/orders/{id}/start` | order | `/orders/{id}/start` |
| `POST /api/orders/{id}/finish` | order | `/orders/{id}/finish` |
| `GET /api/orders/history` | order-query | `/orders/history` |
| `GET /api/orders/current` | order-query | `/orders/current` |
| `GET /api/orders/{id}` | order-query | `/orders/{id}` |
| `GET /api/drivers/me` | driver | `/drivers/me` |
| `PUT /api/drivers/me/status` | driver | `/drivers/me/status` |
| `GET /api/drivers/me/offers` | dispatch | `/drivers/me/offers` |
| `POST /api/offers/{id}/accept\|reject` | dispatch | `/offers/{id}/accept\|reject` |
| `POST /api/orders/estimate` | pricing | `/orders/estimate` |
| `GET /api/places` | pricing | `/places` |

重写只去掉 `/api`，不改变资源路径；查询参数原样保留（例如 `min_version`）。

### 2.3 网关的其他职责

- **鉴权**：预设账号登录后签发 HMAC 令牌，网关校验角色；业务服务再次校验令牌和资源归属。
- **限流**：按客户端 IP 的令牌桶，默认容量 80、补充 40/秒，超限返回 `429 RATE_LIMITED` 与 `Retry-After: 1`。
- **超时与重试**：上游超时 5 秒；GET/HEAD 在实例连接失败时切换其他实例，写请求不跨实例重试，避免重复副作用。
- **可观测**：响应头 `X-Instance` 标记实际处理实例，`X-Request-Id` 贯穿网关与业务日志。
- **隔离**：只代理白名单公开路径，`/internal/*` 一律 404，内部令牌不进入浏览器。

### 2.4 统一入口实测

一次真实请求（[gateway-trace.json](docs/evidence/gateway-trace.json)）：

```http
POST http://localhost:8083/api/orders
Authorization: Bearer <rider-1 token>
Idempotency-Key: 63140a3c-2c5c-4cb6-b65e-5dc8dfe08275

{"estimate_id":"estimate_..."}
```

```http
HTTP/1.1 201 Created
X-Instance: order-a4e3b8b49a23-3101
X-Request-Id: ...

{"order":{"id":"ord_b0f08303-...","status":"MATCHING",...}}
```

随后查询同一订单：

```http
GET http://localhost:8083/api/orders/ord_b0f08303-...
```

```http
HTTP/1.1 200 OK
X-Instance: order-query-7dc41aac4b7d-3102

{"order":{...},"driver":{"id":"driver-1","name":"王师傅",...},
 "projection_version":3,"partial":false,"warnings":[]}
```

`X-Instance` 分别指向 order 与 order-query，说明两个服务确实共用同一个入口且由发现结果定位。

---

## 三、一次订单请求的完整处理过程

### 3.1 前端请求

乘客确认叫车时，前端向统一入口发出：

```http
POST /api/orders HTTP/1.1
Host: localhost:8083
Authorization: Bearer <token>
Idempotency-Key: 63140a3c-2c5c-4cb6-b65e-5dc8dfe08275
Content-Type: application/json

{"estimate_id":"estimate_5f1d...（由 /api/orders/estimate 获得，8671 米、26.18 元）"}
```

幂等键由浏览器在创建前生成；网络失败重试沿用同一键，服务端不会重复建单。

### 3.2 网关匹配与转发

1. 网关解析路径 `/api/orders`，去掉 `/api` 得 `/orders`；
2. 匹配白名单 `POST /orders`，目标服务为 `order`，角色 RIDER；
3. 校验 Bearer 令牌，检查入口限流；
4. 调用 `Discovery.list('order')`，从注册中心取得 `order-a4e3b8b49a23-3101`；
5. 转发到 `http://172.20.0.x:3101/orders`，携带 `Authorization`、`Idempotency-Key`、`X-Request-Id`；
6. 上游返回后，网关写回 `X-Instance: order-a4e3b8b49a23-3101`。

### 3.3 Order 实例执行业务

1. [orderRoutes](services/order/interfaces/routes.mjs) 将 `rider_id`、报价 ID、幂等键交给 `OrderApplication.create`；
2. 应用层通过发现调用 pricing 的 `/internal/estimates/{id}`，校验报价归属乘客、未过期；
3. 领域聚合 `Order.create` 生成 `MATCHING` 订单；
4. 仓储在一个 SQLite `BEGIN IMMEDIATE` 事务中写入 `orders`、`requests`、`state_log`、`outbox`；
5. 事务提交后返回 201，`Order.tick` 在 250ms 内异步投递 `order.created.v1`。

对应日志（同一次请求，订单 `ord_b0f08303...`）：

```text
order-1 | {"service":"order","action":"request","path":"/orders","status":201,"order_id":"ord_b0f08303-..."}
order-query-1 | {"service":"order-query","action":"event_projected","order_id":"ord_b0f08303-...","version":1,"applied":true}
dispatch-1 | {"service":"dispatch","action":"event_applied","version":1,"status":"MATCHING"}
dispatch-1 | {"service":"dispatch","action":"offer_created","offer_id":"offer_40d48e9a-...","driver_id":"driver-1"}
```

### 3.4 服务协作：派单与接单

1. Dispatch 收到订单事件后建立匹配任务，按司机 ID 顺序向在线空闲司机派单；司机看到带起终点的 offer；
2. 司机点击接受，`POST /offers/{id}/accept` 到网关，网关按发现结果转发给 dispatch；
3. Dispatch 校验派单归属和期限，调用 Order 内部接口 `/internal/orders/{id}/accept`；
4. Order 在同一事务中保存 `ASSIGNING` 状态、`RESERVE_DRIVER` 任务和 Outbox；随后 claim offer、调用 Driver 原子预占；
5. Driver 在本地事务中检查在线与占用唯一性，成功后 Order 通过版本条件更新为 `ACCEPTED`；
6. 若预占失败或响应丢失，任务留在 `jobs` 表，重启后按相同 assignment 重试，不会重复绑定。

日志：

```text
order-1 | {"action":"job_done","job_id":"reserve:asg_ea590223-...","type":"RESERVE_DRIVER"}
order-1 | {"method":"POST","path":"/internal/orders/ord_b0f08303-.../accept","status":200}
dispatch-1 | {"action":"offer_claimed","assignment_id":"asg_ea590223-..."}
order-query-1 | {"action":"event_projected","version":2,"applied":true}
order-query-1 | {"action":"event_projected","version":3,"applied":true}
```

### 3.5 结果返回与展示

- 创建订单返回 201 和 `order.id`，页面立即显示“正在寻找司机”，并用响应中的 `version` 防止旧查询回退；
- 接单后订单版本递增，Outbox 把事件投递到 **每个** order-query 副本；
- 乘客查询 `GET /api/orders/{id}` 时，order-query 读取自己的 `order_views`，再通过发现调用 Driver 资料接口，组合返回司机姓名、车牌、车型；
- 浏览器展示司机信息；`X-Instance` 可确认这次查询由哪个副本处理；
- 页面轮询约 1.2 秒；当查询版本低于操作响应版本时显示“已保存，正在同步”，不把读模型延迟当成失败。

完整请求、响应、实例、目录与日志均保存在 [docs/evidence/gateway-trace.json](docs/evidence/gateway-trace.json)。

---

## 四、服务容错

### 4.1 所选 API 与调用链

选择 **`GET /api/orders/{id}`**（order-query 组合查询）：

```text
浏览器 → Gateway → Order Query → Driver /internal/drivers/{id}
```

读取订单读模型是本服务本地操作；司机资料是外部依赖，最容易出现延迟或失败，因此五项策略围绕该调用链实现。

### 4.2 五项策略的实现位置与参数

| 策略 | 参数 | 实现位置 | 选择理由 |
| --- | --- | --- | --- |
| 超时 | 单次依赖 600ms | `Discovery.request` 的 `AbortSignal.timeout`，由 `guardedDriver` 传入 | 组合查询应在 1 秒级返回；600ms 足以覆盖正常局域网调用，又能快速失败 |
| 重试 | 最多 2 次尝试（1 次重试），退避 100ms；仅超时、5xx、429 | [common/resilience.mjs](common/resilience.mjs) `withRetry` | 幂等 GET 可安全重试；业务 4xx 不重试，避免放大错误 |
| 熔断 | 10 秒窗口 5 次失败，开路 8 秒，半开 1 次探测 | `CircuitBreaker`，每个 order-query 实例独立 | 防止持续故障拖慢所有请求；8 秒后自动探测，无需人工 |
| 降级 | `partial=true`、`warnings`、`degradation` | `guardedDriver` 捕获后返回空司机资料 | 订单本身仍可展示和操作，避免整个详情 500 |
| 限流 | 每用户 60 容量、30 rps；网关每 IP 80/40 | `RateLimiter` + 网关 `TokenBucket` | 保护查询服务；按用户/来源限制，超限返回 429 和 `Retry-After` |

参数都可通过 Compose 环境变量覆盖：`DRIVER_TIMEOUT_MS`、`DRIVER_ATTEMPTS`、`CIRCUIT_FAILURE_THRESHOLD`、`CIRCUIT_OPEN_MS`、`QUERY_RATE_CAPACITY`、`QUERY_RATE_REFILL`。

### 4.3 调用链行为

`guardedDriver` 的顺序：

1. 熔断器不允许 → 立即返回 `CIRCUIT_OPEN` 降级，不发起网络调用；
2. 允许 → 最多 2 次调用 Driver，每次 600ms 超时；
3. 成功 → 熔断器记录成功，返回司机资料；
4. 失败（超时/5xx/连接失败）→ 记录失败，达到阈值后开路；
5. 返回 `partial=true` 的订单详情，附带机器可读的 `degradation`：

```json
{
  "order": {"id":"ord_...","status":"ACCEPTED"},
  "driver": null,
  "partial": true,
  "degraded": true,
  "warnings": [{"code":"CIRCUIT_OPEN","message":"司机资料服务正在熔断保护中..."}],
  "degradation": {"dependency":"driver-service","elapsed_ms":5,"attempts":0,"circuit":"OPEN","code":"CIRCUIT_OPEN"}
}
```

前端已有降级展示：订单状态与操作保留，司机卡片显示“资料暂不可用”，不阻塞取消等操作。

### 4.4 验证方法与结果

**（1）可控故障注入**（[scripts/fault-demo.mjs](scripts/fault-demo.mjs)，本地 HTTP 替身）

| 场景 | 注入 | 结果 |
| --- | --- | --- |
| 正常 | 5ms 响应 | 200，`partial=false`，37ms |
| 慢依赖 | 900ms 延迟，客户端超时 250ms | 200，`partial=true`，653ms，尝试 2 次 |
| 持续失败 | 每次 500 | 3 次请求后熔断打开；开路请求 2ms 返回 `CIRCUIT_OPEN` |
| 恢复 | 等待 1.2 秒后恢复 200 | 半开探测成功，熔断关闭，详情完整 |
| 限流 | 容量 3、1 rps | 第 4 个请求起 429，等待 1 秒后恢复 200 |

证据：[fault-tolerance.json](docs/evidence/fault-tolerance.json)。

**（2）Docker 实际故障**（[scripts/docker-fault-demo.mjs](scripts/docker-fault-demo.mjs)）

| 阶段 | 操作 | 实测 |
| --- | --- | --- |
| 正常 | 查询订单详情 | 200，10ms，司机“王师傅” |
| 停止依赖 | `docker compose stop driver` | 第 1 次 711ms 后降级；后续约 107ms 返回 partial |
| 持续失败 | 连续 5 次 | 第 5 次进入 `OPEN`；开路请求 5ms 返回 `CIRCUIT_OPEN` |
| 恢复 | `docker compose start driver`，等待 8 秒 | 半开探测成功，`CLOSED`，司机资料恢复 |

证据：[fault-tolerance-docker.json](docs/evidence/fault-tolerance-docker.json)、[order-query.log](docs/evidence/order-query.log)。

停止容器时连接被立即拒绝，因此 Docker 场景体现的是“失败 + 重试 + 熔断”；真正的 600ms 超时由慢依赖注入场景（900ms 延迟）证明。两种场景都通过同一代码路径。

### 4.5 恢复后的表现

- 熔断器由 `OPEN` 转 `HALF_OPEN` 时只放行一个探测请求；成功即 `CLOSED`，失败重新计时；
- 降级期间读模型不被修改，订单状态、取消、后续操作均正常；
- 依赖恢复后下一次查询自动补齐司机资料，无需重启服务；
- 每次失败、重试、降级都有结构化日志（`driver_retry`、`driver_fallback`），可按 `order_id` 关联。

---

## 五、服务水平扩缩容

### 5.1 配置

`order-query` 在 [compose.yaml](compose.yaml) 中没有固定 `container_name`、没有发布端口，也不挂共享卷，因此可直接 `--scale`：

```yaml
order-query:
  environment:
    SERVICE_NAME: order-query
    DB_PATH: /data/query.sqlite
    DRIVER_TIMEOUT_MS: 600
  depends_on:
    registry: { condition: service_healthy }
```

每个副本拥有自己的容器文件系统与 SQLite 读模型。扩缩容不会让两个进程同时写一个数据库文件。

### 5.2 操作与结果

```powershell
docker compose up -d --scale order-query=2 --no-recreate
docker compose ps
curl http://localhost:8500/v1/catalog/order-query
```

实测：

| 阶段 | 实例数 | 说明 |
| --- | --- | --- |
| 初始 | 1 | `order-query-7dc41aac4b7d-3102` |
| 扩容 | 2 | 新副本 `order-query-3e10332b5ac6-3102` 注册并引导读模型 |
| 缩容 | 1 | 多余副本收到 SIGTERM 后注销 |

12 次经网关的订单查询在两个副本上各 6 次，全部 200 且包含司机资料；缩容后剩余实例继续正常返回。证据：[scaling.json](docs/evidence/scaling.json)。

### 5.3 为什么多副本仍能读到一致数据

1. **私有读模型**：每个副本独立 SQLite，避免共享库锁竞争；
2. **启动引导**：新副本启动后调用 Order 的 `GET /internal/orders/snapshots` 拉取全量快照，按版本条件写入；不直接读 Order 数据库；
3. **事件扇出**：Order Outbox 对 `order-query` 的每个注册实例分别投递；只有全部成功才标记该事件已投递，失败重试；
4. **幂等与版本**：每个副本用 `inbox(event_id)` 去重，仅接受更大 `version`，因此重复投递、乱序事件不会破坏读模型；
5. **网关轮询**：`X-Instance` 证明流量确实分布到两个副本。

扩缩容期间可能短暂出现新副本尚未引导完成的情况；网关健康检查显示 `bootstrap_state`，新副本完成引导后才进入稳定服务。

### 5.4 边界

- SQLite 与注册中心都是单机方案，未验证跨主机调度；
- 缩容时若正在处理请求，由连接关闭触发客户端重试；本实验未做连接排空（draining）；
- 熔断/限流计数是每实例的，扩容后不会全局共享。

---

## 六、契约测试

### 6.1 所选接口与双方

| 角色 | 服务 | 接口 |
| --- | --- | --- |
| 消费者 | order-query | 调用 `GET /internal/drivers/{id}` 获取司机资料 |
| 提供者 | driver-service | 返回 `{driver:{id,name,phone_mask,vehicle,online,...}}` |

选择该接口的原因：它是组合查询的真实跨服务调用，Lab 3 已在使用，契约变化会直接影响页面司机卡片。

### 6.2 契约定义

[contracts/driver-profile.pact.json](contracts/driver-profile.pact.json) 使用 Pact 3.0 格式，包含两个交互：

1. **已存在司机**：`GET /internal/drivers/driver-1` → 200，响应包含 `driver.id/name/phone_mask/vehicle/online/updated_at`，字段以 `match: type` 校验类型而非固定值；
2. **不存在司机**：`GET /internal/drivers/driver-404` → 404，响应包含 `error.code=DRIVER_NOT_FOUND`。

请求头明确要求 `X-Internal-Token`，消费者必须按内部调用约定发送。

### 6.3 双方测试

- **提供者侧**：[tests/contracts/driver-provider.test.mjs](tests/contracts/driver-provider.test.mjs) 启动真实 Driver 服务，按契约逐条请求，校验状态码、`Content-Type`、响应结构和匹配规则；
- **消费者侧**：[tests/contracts/order-query-consumer.test.mjs](tests/contracts/order-query-consumer.test.mjs) 启动返回契约响应的替身提供者，验证：
  - 请求方法、路径、内部令牌与契约一致；
  - order-query 能正确提取并组合司机字段；
  - 提供者返回契约 404 时，查询降级为 `partial=true`，订单不丢失；
- **校验器**：[tests/contracts/contract-kit.mjs](tests/contracts/contract-kit.mjs) 实现 Pact 交互所需的状态码、头、JSON 子集与 `match: type` 校验，不依赖 Pact Broker 或额外运行时。

选择自研轻量校验器的理由：本组为 Node 单运行时、无 npm 依赖，Pact 官方工具需要额外二进制与 Broker；契约文件仍保持 Pact 格式，语义覆盖本次交互。若后续接入 Pact 生态，可直接复用该文件。

### 6.4 执行方法与结果

```powershell
npm run test:contracts
```

结果：**3 项通过、0 失败**，见 [contract-tests.tap](docs/evidence/contract-tests.tap)：

```text
✔ Provider contract: driver-service responses satisfy every interaction
✔ Consumer contract: order-query calls the agreed driver endpoint and composes its fields
✔ Consumer contract: a provider 404 becomes an explicit partial response, not a crash
# tests 3 / pass 3 / fail 0
```

契约与实现的一致性由测试保证：提供者字段改名、状态码变化或消费者不再发送内部令牌，都会使测试失败。

---

## 七、与 Lab 3 的关系、测试与交付

### 7.1 保留与调整

| 方面 | Lab 3 | Lab 4 调整 |
| --- | --- | --- |
| 业务 | 叫车、派单、接驾、计费 | 保留，页面与接口不变 |
| 架构 | DDD 四层、CQRS、Saga/Outbox | 保留；订单查询增加容错与限流 |
| 服务寻址 | 固定 URL | 注册中心 + 服务发现 + 轮询 |
| 网关 | 静态地址代理 | 发现式路由、限流、超时、GET 故障转移、实例标记 |
| 读模型 | 单实例 SQLite | 可水平扩展、私有库、启动引导、事件扇出 |
| 部署 | Node 本地 + 可选 Compose | 以 Docker Compose 为正式验证环境 |
| 测试 | 68 项 | 77 项（新增注册、发现、网关、引导、契约等） |

### 7.2 测试

```powershell
npm test
```

结果：**77 项通过、0 失败**（[tests.tap](docs/evidence/tests.tap)）。覆盖：

- Order 领域单元测试、Order/Query 组件测试、前端状态测试；
- 注册中心注册/续约/过期/注销、发现轮询与故障转移、网关按目录路由；
- 新副本启动引导；
- 契约提供者与消费者测试；
- Driver/Dispatch/Pricing 原有测试。

### 7.3 交付物

- 源码与配置：`services/`、`common/`、`frontend/`、`compose.yaml`、`Dockerfile`；
- 测试材料：`tests/`、`contracts/driver-profile.pact.json`；
- [README](README.md)：分工、环境、启动、入口、扩缩容、测试命令；
- 本报告与 [architecture.png](docs/architecture.png)、`docs/evidence/` 下的实际运行证据；
- 仓库地址：`https://github.com/CPLASF2049/Lab4-Ride-Hailing`，初始提交 `e119286`（main 分支）；后续文档修订见仓库历史。

### 7.4 局限

- 单主机、单注册中心，无跨主机容灾与一致性；
- 注册中心内存存储，重启后依靠心跳恢复，恢复窗口内网关可能返回 503；
- 限流/熔断按实例计数，扩缩容后阈值总体变化；
- 未接入 TLS、真实身份提供方、Prometheus 指标、分布式追踪和自动告警；
- SQLite 适合课程规模，不代表生产吞吐。
