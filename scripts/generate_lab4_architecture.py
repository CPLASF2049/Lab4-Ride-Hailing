"""Draw the Lab4 governance architecture with Pillow and a CJK font."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "architecture.png"
BG, INK, MUTED, LINE = "#F4F7FA", "#172C45", "#5A6C7E", "#C9D5E2"
BLUE, TEAL, PURPLE, ORANGE, WHITE = "#1F63AD", "#16786F", "#6D4AB0", "#A2651B", "#FFFFFF"
FONT = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"

W, H = 1800, 1180
image = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(image)
fonts = {}


def font(size, bold=False):
    key = (size, bold)
    if key not in fonts:
        fonts[key] = ImageFont.truetype(BOLD if bold else FONT, size)
    return fonts[key]


def text(x, y, value, size=18, color=INK, bold=False, anchor=None):
    draw.text((x, y), value, font=font(size, bold), fill=color, anchor=anchor)


def width(value, size=18, bold=False):
    return draw.textlength(value, font=font(size, bold))


def box(x1, y1, x2, y2, title, lines, color=BLUE, fill=WHITE, title_size=22, body_size=17, radius=16):
    draw.rounded_rectangle((x1, y1, x2, y2), radius=radius, fill=fill, outline=color, width=2)
    draw.rounded_rectangle((x1, y1, x2, y1 + 44), radius=radius, fill=color)
    draw.rectangle((x1, y1 + 30, x2, y1 + 44), fill=color)
    text(x1 + 14, y1 + 9, title, title_size, WHITE, True)
    y = y1 + 56
    for line in lines:
        text(x1 + 14, y, line, body_size, MUTED)
        y += body_size + 10


def arrow(points, color=BLUE, dashed=False, label=None, label_pos=None, label_color=None):
    if dashed:
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            length = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
            steps = max(1, int(length // 14))
            for i in range(steps):
                if i % 2 == 0:
                    t1, t2 = i / steps, min(1, (i + 1) / steps)
                    draw.line((x1 + (x2 - x1) * t1, y1 + (y2 - y1) * t1, x1 + (x2 - x1) * t2, y1 + (y2 - y1) * t2), fill=color, width=3)
    else:
        draw.line(points, fill=color, width=3, joint="curve")
    (x1, y1), (x2, y2) = points[-2], points[-1]
    if (x2, y2) != (x1, y1):
        import math
        angle = math.atan2(y2 - y1, x2 - x1)
        size = 11
        draw.polygon([(x2, y2), (x2 - size * math.cos(angle - 0.42), y2 - size * math.sin(angle - 0.42)),
                      (x2 - size * math.cos(angle + 0.42), y2 - size * math.sin(angle + 0.42))], fill=color)
    if label:
        lx, ly = label_pos or ((points[0][0] + points[-1][0]) / 2, (points[0][1] + points[-1][1]) / 2 - 22)
        text(lx - width(label, 15) / 2, ly, label, 15, label_color or color, True)


text(60, 34, "Lab 4 微服务治理：注册发现 · 统一网关 · 容错 · 水平扩缩容", 38, INK, True)
text(62, 86, "Docker Compose 单主机部署 | 5 个业务服务 + 注册中心 + 网关 | 所有调用经真实 HTTP", 19, MUTED)

# Entry and gateway
box(60, 140, 370, 250, "乘客 / 司机 Web", ["Leaflet 地图 + 双角色 UI"], TEAL)
box(60, 300, 1620, 418, "API Gateway :8083",
    ["静态资源与预设身份登录    白名单路由（order / order-query / driver / dispatch / pricing）    按服务名向注册中心取实例并轮询",
     "入口限流 80 容量 / 40 rps    GET 跨实例重试与故障转移    上游超时 5s    响应头 X-Instance 标记实际实例"],
    PURPLE, title_size=24)
box(1150, 140, 1620, 286, "Service Registry :8500",
    ["应用层注册中心：PUT 注册 / 心跳 3s / 租约 10s", "GET /v1/catalog/<service> 返回健康实例", "实例退出立即注销，崩溃由 TTL 摘除"], ORANGE, body_size=16)
arrow([(215, 250), (215, 300)], TEAL, label="HTTP", label_pos=(228, 268))
arrow([(1300, 300), (1300, 286)], ORANGE, dashed=True)

# Service row
sy1, sy2 = 520, 760
box(60, sy1, 330, sy2, "Order :3101", ["写模型 / DDD 聚合", "orders · jobs · outbox", "Saga 接单恢复"], BLUE)
box(385, sy1, 665, 640, "Order Query 副本 1 :3102", ["私有读模型 order_views", "inbox 去重 + 版本守卫"], TEAL, title_size=20, body_size=16)
box(385, 650, 665, sy2, "Order Query 副本 N :3102", ["启动时从 Order API 引导", "事件扇出保持同步"], TEAL, title_size=20, body_size=16)
box(720, sy1, 975, sy2, "Driver :3103", ["司机档案 / 在线开关", "独占占用 reservations", "释放墓碑防迟到"], BLUE)
box(1025, sy1, 1285, sy2, "Dispatch :3104", ["派单任务 / 顺序 offer", "拒绝 · 超时 · 期限", "持久化恢复"], BLUE)
box(1335, sy1, 1600, sy2, "Pricing :3105", ["上海预设地点", "5 分钟报价", "后端整数分计费"], BLUE)

# Gateway to services
for cx in (195, 525, 847, 1155, 1467):
    arrow([(cx, 418), (cx, sy1)], PURPLE if cx == 525 else BLUE, label=None)
text(720, 452, "按服务名路由 + 轮询 / GET 故障转移", 17, PURPLE, True)
text(1180, 452, "注册 / 心跳 / 租约 TTL 10s", 17, ORANGE, True)
arrow([(1500, sy1), (1500, 264)], ORANGE, dashed=True)

# Order collaboration (labels kept in the legend to avoid crossing boxes)
arrow([(330, 600), (385, 600)], BLUE, dashed=True)
arrow([(975, 610), (1025, 610)], BLUE)
arrow([(330, 680), (385, 680)], BLUE)
arrow([(665, 690), (720, 690)], BLUE)
text(665, 772, "Order Query → Driver：超时 600ms · 最多 2 次尝试 · 熔断 5 次/10s · 开路 8s · 降级 partial", 17, TEAL, True)
text(60, 802, "协作：Order → Pricing 报价/计费 · Order → Driver 占用/释放 · Order → Dispatch claim/resolve · Order → Order Query 事件扇出（虚线）", 17, MUTED)

# Panels
def panel(x1, y1, x2, y2, title, lines, color):
    draw.rounded_rectangle((x1, y1, x2, y2), radius=18, fill=WHITE, outline=color, width=2)
    text(x1 + 22, y1 + 18, title, 23, color, True)
    y = y1 + 62
    for line in lines:
        text(x1 + 22, y, line, 18, MUTED)
        y += 32

panel(60, 836, 865, 1128, "一次叫车请求（第 3 部分）", [
    "1. 前端 POST /api/orders + Idempotency-Key → 网关命中 order 路由",
    "2. 网关向注册中心查询 order 实例，转发 /orders 并透传身份",
    "3. Order 校验报价，事务写 orders + outbox，返回 201 与 X-Instance",
    "4. 事件后台扇出到每个 order-query 副本；副本 inbox 去重、版本守卫",
    "5. 乘客 GET /api/orders/{id} 由 order-query 组合 Driver 实时资料",
], BLUE)

panel(915, 836, 1740, 1128, "水平扩缩容与容错（第 4/5 部分）", [
    "docker compose up -d --scale order-query=2 --no-recreate  → 1 个实例扩到 2 个",
    "新副本注册后立即从 Order API 引导私有读模型，随后接收全部事件",
    "网关按注册目录轮询，X-Instance 证明请求分布到两个副本；缩容回 1 个",
    "超时/重试/熔断/降级作用于司机资料依赖；入口限流返回 429 + Retry-After",
    "司机服务停止时查询返回 partial 订单，恢复后半开探测自动闭合熔断",
], TEAL)

text(60, 1145, "证据：docs/evidence/{gateway-trace,scaling,fault-tolerance,fault-tolerance-docker}.json；契约：contracts/driver-profile.pact.json", 16, MUTED)

OUT.parent.mkdir(parents=True, exist_ok=True)
image.save(OUT, "PNG")
print(f"wrote {OUT} ({W}x{H})")
