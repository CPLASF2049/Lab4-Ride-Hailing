"""Generate the two implementation diagrams with Pillow and a CJK font.

Run from any directory: python scripts/generate_diagrams.py
The application itself needs only Node.js; Pillow is a documentation dependency.
Set DIAGRAM_FONT and DIAGRAM_FONT_BOLD to override the detected CJK fonts.
Only docs/architecture.png and docs/data-model.png are written by this script.
"""
from __future__ import annotations

import math
import os
import re
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs"
BG = "#F3F6FA"
INK = "#172C45"
MUTED = "#54677B"
LINE = "#CED8E4"
BLUE = "#2168B3"
PURPLE = "#7651B8"
TEAL = "#16786F"
ORANGE = "#A86920"
FONT_CANDIDATES = [
    os.environ.get("DIAGRAM_FONT", ""),
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]
BOLD_CANDIDATES = [
    os.environ.get("DIAGRAM_FONT_BOLD", ""),
    "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
]


def first_font(paths):
    for p in paths:
        if p and Path(p).is_file():
            return p
    raise SystemExit("A CJK font is required; set DIAGRAM_FONT to a font file.")


FONT = first_font(FONT_CANDIDATES)
BOLD = next((p for p in BOLD_CANDIDATES if p and Path(p).is_file()), FONT)


class Canvas:
    def __init__(self, size):
        self.image = Image.new("RGB", size, BG)
        self.draw = ImageDraw.Draw(self.image)
        self.fonts = {}

    def font(self, size, bold=False):
        key = (size, bold)
        if key not in self.fonts:
            self.fonts[key] = ImageFont.truetype(BOLD if bold else FONT, size)
        return self.fonts[key]

    def width(self, text, size=24, bold=False):
        return self.draw.textlength(text, font=self.font(size, bold))

    def text(self, xy, text, size=24, color=INK, bold=False, max_width=None):
        if max_width is not None and self.width(text, size, bold) > max_width:
            raise ValueError(f"Text exceeds its allotted width ({max_width}): {text}")
        self.draw.text(xy, text, fill=color, font=self.font(size, bold))

    def center(self, center, y, text, size=24, color=INK, bold=False):
        self.text((center - self.width(text, size, bold) / 2, y), text, size, color, bold)

    def box(self, bounds, fill="white", outline=LINE, radius=17, width=2):
        self.draw.rounded_rectangle(bounds, radius=radius, fill=fill, outline=outline, width=width)

    def line(self, points, color=BLUE, width=3, dashed=False):
        if not dashed:
            self.draw.line(points, fill=color, width=width, joint="curve")
            return
        for a, b in zip(points, points[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if not length:
                continue
            position = 0
            while position < length:
                end = min(position + 11, length)
                self.draw.line([(a[0] + dx * position / length, a[1] + dy * position / length),
                                (a[0] + dx * end / length, a[1] + dy * end / length)], fill=color, width=width)
                position += 19

    def arrow(self, points, color=BLUE, width=3, dashed=False):
        self.line(points, color, width, dashed)
        a, b = points[-2:]
        angle = math.atan2(b[1] - a[1], b[0] - a[0])
        length, spread = 13, 0.43
        vertices = [b,
                    (b[0] - length * math.cos(angle - spread), b[1] - length * math.sin(angle - spread)),
                    (b[0] - length * math.cos(angle + spread), b[1] - length * math.sin(angle + spread))]
        self.draw.polygon(vertices, fill=color)

    def tag(self, bounds, text, fill, color=INK, size=22):
        self.box(bounds, fill, outline=fill, radius=10)
        self.center((bounds[0] + bounds[2]) / 2, bounds[1] + (bounds[3] - bounds[1] - size) / 2 - 3,
                    text, size, color)

    def paragraph(self, xy, text, width, size=22, color=MUTED, line_height=None):
        line_height = line_height or size + 10
        current = ""
        lines = []
        # Prefer whitespace boundaries for long Latin identifiers where possible.
        for char in text:
            if current and self.width(current + char, size) > width:
                lines.append(current)
                current = char
            else:
                current += char
        if current:
            lines.append(current)
        for i, line in enumerate(lines):
            self.text((xy[0], xy[1] + i * line_height), line, size, color)
        return len(lines) * line_height

    def save(self, name):
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / name
        self.image.save(path, optimize=True, dpi=(160, 160))
        print(f"{path}: {self.image.width} x {self.image.height}")


def panel_title(c, x, y, number, title, color=BLUE):
    c.tag((x, y, x + 39, y + 38), number, color, "white", 23)
    c.text((x + 53, y - 1), title, 29, bold=True)


def architecture():
    c = Canvas((2000, 1510))
    c.text((50, 31), "上海网约车平台 · 微服务实现架构", 45, bold=True)
    c.text((52, 94), "Node.js 24 原生 HTTP + SQLite  |  5 个独立业务服务；网关与共享库不计入业务服务数量", 25, MUTED)

    # Entry points and stateless shared authentication.
    c.box((50, 155, 550, 302), fill="#EAF3FC", outline="#B8D2ED")
    c.text((76, 174), "乘客 / 司机 Web", 31, bold=True)
    c.text((76, 222), "Leaflet + OSM；展示起终点与行程", 23)
    c.text((76, 259), "地图失败保留坐标、状态与操作", 23, MUTED)
    c.box((675, 155, 1325, 302))
    c.text((704, 174), "Gateway  :8083", 32, bold=True)
    c.text((704, 222), "静态资源 + API 白名单代理；角色校验", 24)
    c.text((704, 260), "仅转发公开业务路由；内部接口使用独立令牌", 23, MUTED)
    c.arrow([(552, 229), (672, 229)])
    c.center(612, 189, "HTTP", 23, BLUE)
    c.box((1450, 155, 1950, 302), fill="#F0ECF8", outline="#D6CAE9")
    c.text((1476, 174), "共享认证 common/auth", 29, bold=True)
    c.text((1476, 222), "预设 2 名乘客 + 2 名司机", 23)
    c.text((1476, 260), "HMAC 无状态令牌；非独立业务服务", 23, MUTED)
    c.arrow([(1327, 229), (1447, 229)], color=PURPLE)
    c.center(1389, 188, "本地调用", 22, PURPLE)

    # Five service processes; the top bus represents gateway routing only.
    c.line([(1000, 302), (1000, 351), (235, 351)], BLUE)
    c.line([(1000, 351), (1770, 351)], BLUE)
    for center in [235, 620, 1005, 1390, 1770]:
        c.arrow([(center, 351), (center, 393)])
    c.tag((794, 320, 1215, 359), "网关同步 HTTP 转发至各业务服务", BG, BLUE, 22)

    specs = [
        (50, 420, "Order :3101", BLUE, ["订单写模型 / Order 聚合", "接口 · 应用 · 领域 · 基础设施", "状态版本 CAS / Saga 持久化任务", "订单变更与 Outbox 同一事务"], "order.sqlite"),
        (435, 805, "Order Query :3102", TEAL, ["订单详情 / 当前订单 / 历史查询", "独立持久化的订单读模型副本", "inbox 去重 + version 防乱序", "API 组合司机信息；依赖失败降级"], "query.sqlite"),
        (820, 1190, "Driver :3103", BLUE, ["司机档案 / online 开关", "原子 reserve / 幂等 release", "active_order + assignment 占用", "保留 RELEASED 墓碑防迟到预占"], "driver.sqlite"),
        (1205, 1575, "Dispatch :3104", PURPLE, ["匹配任务 / 顺序派单 offer", "接受 · 拒绝 · 超时 / 明确终止", "持久化 deadline；重启后继续", "订单事件 inbox / 版本保护"], "dispatch.sqlite"),
        (1590, 1950, "Pricing :3105", ORANGE, ["上海预设地点 / 报价 / 计费", "后端计算预估距离与费用", "报价持久化；地点与费率为常量", "费用单位为分；距离单位为米"], "pricing.sqlite"),
    ]
    for x1, x2, title, color, lines, db in specs:
        c.box((x1, 395, x2, 676))
        c.draw.rounded_rectangle((x1, 395, x2, 455), radius=17, fill=color)
        c.draw.rectangle((x1, 429, x2, 455), fill=color)
        c.center((x1 + x2) / 2, 407, title, 27, "white", True)
        for i, text in enumerate(lines):
            c.text((x1 + 16, 474 + i * 35), text, 21, max_width=x2 - x1 - 30)
        c.tag((x1 + 17, 623, x2 - 17, 660), db + "  独立库", "#EEF2F7", MUTED, 21)
    c.text((52, 695), "独立 SQLite；不跨服务读表。本地 data/<service>.sqlite；Compose 命名卷。Node 一键启动 / Compose 可选。", 23, MUTED)

    # A directed edge list is intentionally used so no service-to-service line crosses a card.
    c.box((50, 751, 993, 1207))
    panel_title(c, 75, 773, "1", "同步服务调用（实线）")
    rows = [
        ("Order", "Pricing", "读取报价 / 计算结束行程费用"),
        ("Order", "Dispatch", "读取、claim 与 resolve 派单"),
        ("Order", "Driver", "reserve / release；Saga 驱动"),
        ("Dispatch", "Driver", "读取司机候选与当前可用状态"),
        ("Dispatch", "Order", "确认接单 / 结束匹配"),
        ("Order Query", "Driver", "订单详情组合 / 查询当前占用"),
    ]
    for i, (source, dest, label) in enumerate(rows):
        y = 835 + 56 * i
        c.tag((76, y, 263, y + 39), source, "#EAF2FB", BLUE, 22)
        c.arrow([(270, y + 20), (332, y + 20)])
        c.tag((340, y, 513, y + 39), dest, "#EEF2F7", INK, 22)
        c.text((534, y + 5), label, 22, max_width=430)

    c.box((1020, 751, 1950, 1207))
    panel_title(c, 1045, 773, "2", "异步订单事件（虚线）", PURPLE)
    c.box((1047, 838, 1922, 926), fill="#F1ECFA", outline="#D5C8E9")
    c.center(1485, 850, "Order 本地事务：订单 / 状态日志 / jobs / outbox", 26, PURPLE, True)
    c.center(1485, 892, "后台投递 /internal/events；至少一次，失败退避重试", 23, MUTED)
    c.box((1048, 975, 1315, 1085), fill="#F6F3FC", outline="#D5C8E9")
    c.center(1182, 988, "Order Outbox", 26, PURPLE, True)
    c.center(1182, 1034, "event_id + version", 23)
    c.arrow([(1315, 1006), (1368, 1006), (1368, 986), (1451, 986)], PURPLE, dashed=True)
    c.arrow([(1315, 1054), (1368, 1054), (1368, 1083), (1451, 1083)], PURPLE, dashed=True)
    c.tag((1453, 956, 1920, 1018), "Order Query：inbox + 读模型投影", "#EAF5F2", TEAL, 24)
    c.tag((1453, 1052, 1920, 1114), "Dispatch：inbox + 匹配任务 / offer", "#F1ECFA", PURPLE, 24)
    c.text((1048, 1135), "接收方事务内去重；只应用更新的 version，旧事件不覆盖新状态", 22, MUTED, max_width=880)
    c.text((1048, 1172), "事件与任务均可在重启后继续；本实现无需独立消息中间件", 22, MUTED)

    c.box((50, 1233, 1950, 1465))
    panel_title(c, 75, 1254, "3", "Saga 接单确认与补偿", ORANGE)
    steps = [
        (75, 443, "ASSIGNING + 持久化任务"),
        (473, 767, "claim offer"),
        (797, 1113, "Driver 原子 reserve"),
        (1143, 1492, "Order CAS → ACCEPTED"),
        (1522, 1923, "resolve offer → ACCEPTED"),
    ]
    for i, (x1, x2, label) in enumerate(steps):
        c.tag((x1, 1313, x2, 1374), label, "#FBF0DF", ORANGE, 23)
        if i:
            c.arrow([(steps[i - 1][1] + 3, 1344), (x1 - 4, 1344)], ORANGE)
    c.text((77, 1394), "确认失败：回到匹配并持久化 RELEASE_DRIVER / RESOLVE_OFFER 补偿；取消或结束：持久化释放任务。", 23, MUTED)
    c.text((77, 1430), "释放携带 order_id + assignment_id，并保留墓碑；迟到的旧操作不会误释放或重新占用新订单。", 23, MUTED)
    c.save("architecture.png")


def split_sql_fields(body):
    fields, current, depth = [], "", 0
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            fields.append(current.strip())
            current = ""
        else:
            current += char
    if current.strip():
        fields.append(current.strip())
    result = []
    for field in fields:
        match = re.match(r"([A-Za-z_]\w*)\s+", field)
        if not match or match.group(1).upper() in {"PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"}:
            continue
        name = match.group(1)
        if "PRIMARY KEY" in field.upper():
            name = "PK " + name
        result.append(name)
    return result


def sql_schema(relative):
    """Read the actual CREATE TABLE declarations, including nested CHECK clauses."""
    source = (ROOT / relative).read_text(encoding="utf-8")
    result = {}
    for match in re.finditer(r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(", source):
        depth = 1
        at = match.end()
        end = at
        while depth and end < len(source):
            if source[end] == "(":
                depth += 1
            elif source[end] == ")":
                depth -= 1
            end += 1
        result[match.group(1)] = split_sql_fields(source[at:end - 1])
    return result


def group(c, bounds, name, db, color):
    c.box(bounds)
    x1, y1, x2, _ = bounds
    c.draw.rounded_rectangle((x1, y1, x2, y1 + 58), radius=17, fill=color)
    c.draw.rectangle((x1, y1 + 34, x2, y1 + 58), fill=color)
    c.text((x1 + 18, y1 + 10), name, 29, "white", True)
    c.text((x2 - c.width(db, 23) - 20, y1 + 16), db, 23, "white")


def table(c, bounds, name, rows, color=BLUE, note=None):
    x1, y1, x2, y2 = bounds
    c.box(bounds, fill="#FCFDFE", outline=LINE, radius=10)
    c.draw.line([(x1 + 1, y1 + 44), (x2 - 1, y1 + 44)], fill=LINE, width=1)
    c.text((x1 + 14, y1 + 7), name, 25, color, True, max_width=x2 - x1 - 28)
    y = y1 + 55
    for row in rows:
        used = c.paragraph((x1 + 14, y), row, x2 - x1 - 28, 22, INK, 29)
        y += used + 3
    if note:
        y += 5
        y += c.paragraph((x1 + 14, y), note, x2 - x1 - 28, 21, MUTED, 28)
    if y > y2 - 9:
        raise ValueError(f"Table {name} exceeds vertical space: {y} > {y2 - 9}")


def pack_fields(c, fields, width, size=22):
    rows, current = [], ""
    for field in fields:
        candidate = (current + "  |  " if current else "") + field
        if current and c.width(candidate, size) > width:
            rows.append(current)
            current = field
        else:
            current = candidate
    if current:
        rows.append(current)
    return rows


def data_model():
    c = Canvas((2200, 1800))
    c.text((40, 31), "数据归属与持久化模型", 46, bold=True)
    c.text((42, 96), "每个服务独占 SQLite 文件；图中列出主要字段。跨服务 ID 仅为逻辑引用，通过 API / 事件协作，不建立跨库外键。", 25, MUTED)
    c.text((42, 137), "PK = 主键；组合主键与业务唯一约束单独标注；orders.snapshot 保存完整聚合 JSON。", 23, MUTED)

    group(c, (40, 195, 730, 1390), "Order · 订单写模型（权威）", "order.sqlite", BLUE)
    table(c, (60, 268, 710, 562), "orders", [
        "PK id  |  rider_id  |  driver_id  |  status  |  version",
        "snapshot JSON：订单聚合完整快照",
        "  · origin / destination / estimate（报价快照）",
        "  · pending_driver_id / offer_id / assignment_id",
        "  · accepted_at / arrived_at / started_at / finished_at",
        "  · cancelled_at / final_distance_m / final_amount_cents",
    ], note="部分唯一索引：每位乘客最多一个有效订单。")
    table(c, (60, 577, 710, 722), "requests · 创建请求幂等", [
        "rider_id  |  request_key  |  request_hash  |  order_id",
    ], note="组合主键 (rider_id, request_key)；同标识异载荷拒绝。")
    table(c, (60, 737, 710, 939), "jobs · Saga / 失败恢复进度", [
        "PK id  |  type  |  order_id  |  payload  |  status",
        "attempts  |  next_attempt_at  |  last_error",
        "created_at  |  finished_at",
    ], note="持久化 reserve / release / resolve；退避重试。")
    table(c, (60, 954, 710, 1156), "outbox · 事务事件投递", [
        "event_id  |  destination  |  payload",
        "attempts  |  next_attempt_at  |  delivered_at  |  last_error",
    ], note="组合主键 (event_id, destination)；目标 query / dispatch。")
    table(c, (60, 1171, 710, 1358), "state_log · 状态审计", [
        "PK id  |  order_id  |  version  |  status",
        "event_id  |  changed_at",
    ], note="UNIQUE(order_id, version)；与订单及 Outbox 同事务。")

    group(c, (755, 195, 1405, 715), "Order Query · 查询副本", "query.sqlite", TEAL)
    table(c, (775, 268, 1385, 464), "order_views · 订单读模型副本", [
        "PK id  |  rider_id  |  driver_id  |  status  |  version",
        "snapshot  |  projected_at",
    ], TEAL, "来自订单事件；id 对应 orders.id，禁止用于订单写入。")
    table(c, (775, 479, 1385, 631), "inbox · 事件消费幂等", [
        "PK event_id  |  order_id  |  version  |  processed_at",
    ], TEAL, "事件去重与投影同事务；仅较新 version 可更新。")
    c.text((777, 652), "详情查询通过 API 组合 Driver 档案；失败保留订单。", 22, MUTED)
    c.text((777, 683), "min_version / sync_pending 标识读模型同步延迟。", 22, MUTED)

    group(c, (1430, 195, 2160, 858), "Driver · 司机与资源占用", "driver.sqlite", BLUE)
    table(c, (1450, 268, 2140, 481), "drivers", [
        "PK id  |  name  |  phone_mask  |  vehicle_json",
        "online  |  active_order_id  |  active_assignment_id",
        "updated_at",
    ], note="上下线与占用独立；下线不清除已承接订单。")
    table(c, (1450, 496, 2140, 710), "reservations · 预占与释放墓碑", [
        "PK assignment_id  |  order_id  |  driver_id",
        "state: RESERVED / RELEASED",
        "created_at  |  released_at",
    ], note="driver_id 为本库外键；order_id 是跨服务逻辑引用。")
    c.text((1452, 733), "部分唯一索引：仅 RESERVED 时 order_id / driver_id 唯一。", 22, MUTED)
    c.text((1452, 771), "原子预占；释放核对 order_id + assignment_id。", 22, MUTED)
    c.text((1452, 809), "RELEASED 墓碑阻止迟到的旧 reserve 再次生效。", 22, MUTED)

    # Dispatch tables and fields are obtained from the current implementation.
    group(c, (755, 744, 1405, 1390), "Dispatch · 派单进度", "dispatch.sqlite", PURPLE)
    dispatch = sql_schema("services/dispatch/service.mjs")
    if not dispatch:
        raise ValueError("No Dispatch tables found; generate diagrams after the service is implemented.")
    top = 818
    available = 1353 - top
    layouts = []
    for name, fields in dispatch.items():
        rows = pack_fields(c, fields, 565)
        height = 59 + len(rows) * 32 + 12
        layouts.append((name, rows, height))
    required = sum(h for _, _, h in layouts) + 12 * (len(layouts) - 1)
    if required > available:
        raise ValueError(f"Dispatch schema needs {required}px; available {available}px")
    for name, rows, height in layouts:
        table(c, (775, top, 1385, top + height), name, rows, PURPLE)
        top += height + 12
    if top + 30 < 1380:
        c.text((777, top + 2), "派单期限、认领标识与订单版本均持久化。", 21, MUTED)
    if top + 90 < 1390:
        c.text((777, top + 34), "本库外键：offers.order_id → dispatch_tasks.order_id。", 20, MUTED)
        c.text((777, top + 66), "同一订单仅一个 PENDING / CLAIMED 派单。", 21, MUTED)

    group(c, (1430, 887, 2160, 1390), "Pricing · 报价与计费", "pricing.sqlite", ORANGE)
    table(c, (1450, 960, 2140, 1220), "estimates", [
        "PK id  |  rider_id  |  origin_json  |  destination_json",
        "distance_m  |  duration_s  |  amount_cents",
        "created_at  |  expires_at  |  rule_json",
    ], ORANGE, "订单保留报价快照；过期报价仍可读取以完成已有行程。")
    c.text((1452, 1243), "places / fareRule 为代码常量，不是数据库表。", 23, MUTED)
    c.text((1452, 1283), "上海预设地点；费用按分、距离按米保存。", 23, MUTED)
    c.text((1452, 1323), "报价按 rider_id 归属；没有支付或实时定位数据表。", 22, MUTED)

    # Explicit dashed ID references are placed below tables to avoid intersecting fields.
    c.box((40, 1420, 2160, 1760))
    c.text((65, 1438), "跨服务逻辑引用 / 副本关系（虚线；均不直接跨库查询）", 30, bold=True)
    relationships = [
        ("Query.order_views.id", "Order.orders.id", "异步事件副本", TEAL),
        ("Dispatch.offers.order_id", "Order.orders.id", "订单 ID", PURPLE),
        ("Driver.reservations.order_id", "Order.orders.id", "订单 ID", BLUE),
        ("Order.orders.driver_id", "Driver.drivers.id", "司机 ID", BLUE),
        ("Dispatch.offers.driver_id", "Driver.drivers.id", "司机 ID", PURPLE),
        ("orders.snapshot.estimate.id", "Pricing.estimates.id", "Order 报价快照来源", ORANGE),
    ]
    for i, (source, target, label, color) in enumerate(relationships):
        col, row = i % 2, i // 2
        x, y = 66 + col * 1050, 1500 + row * 72
        c.tag((x, y + 15, x + 388, y + 59), source, "#F1F4F8", INK, 21)
        c.center(x + 477, y - 1, label, 19, color)
        c.arrow([(x + 398, y + 38), (x + 559, y + 38)], color, dashed=True)
        c.tag((x + 569, y + 15, x + 986, y + 59), target, "#F1F4F8", INK, 22)
    c.text((65, 1731), "简化认证使用 common/auth 的预设账号与无状态令牌；无独立 Identity / Payment / Location 业务服务或数据库。", 22, MUTED)
    c.save("data-model.png")


if __name__ == "__main__":
    architecture()
    data_model()
