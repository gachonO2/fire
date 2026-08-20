#!/usr/bin/env python3
"""
대피도(층별 피난안내도) 학습 데이터 생성기.

실제 피난안내도를 100장 모아 손으로 라벨링하려면 하루가 꼬박 걸리고, 그렇게 만든 라벨은
사람이 찍은 만큼 부정확하다. 그래서 도면을 **먼저 그리고** 그리는 순간의 좌표를 그대로
정답으로 적어 둔다. 라벨 오차가 0이고, 100장이든 5000장이든 같은 코드로 만든다.

한 장을 만들 때마다 세 가지가 함께 나온다.
  1. images/<split>/plan_XXX.png  — 학습용 이미지
  2. labels/<split>/plan_XXX.txt  — YOLO 라벨 (class cx cy w h, 0~1 정규화)
  3. plans/plan_XXX.json          — 정답 대피 그래프 (shared/floor-plan.js 스키마)

3번은 탐지 모델의 학습에는 쓰이지 않지만, "탐지 결과 → 대피 경로 그래프" 변환
(predict_to_plan.py)이 얼마나 맞는지 채점하는 기준이 된다.

사용법:
    python generate_dataset.py                     # 기본값: 100장, ml/dataset/
    python generate_dataset.py --count 500 --seed 7
    python generate_dataset.py --preview 6         # 라벨 겹쳐 그린 미리보기도 저장

Pillow 하나만 있으면 돌아간다 (numpy 불필요).
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from symbols import COLOR, INDEX, NAMES  # noqa: E402

# 그리는 캔버스는 크게, 내보내는 이미지는 학습 해상도에 맞춰 줄인다.
CANVAS = 1000

# 복도가 몇 줄·몇 칸인지 (가로 복도 수, 세로 복도 수).
# 가로만 여러 개면 서로 이어지지 않으므로, 2개 이상이면 세로를 최소 1개 둔다.
ARCHETYPES = [
    (1, 0),  # 일자 복도
    (0, 1),  # 세로 일자 복도
    (1, 1),  # 十자
    (2, 1),  # H (가로 2 + 세로 1)
    (1, 2),  # H 눕힌 것
    (2, 2),  # 격자 (순환 복도)
    (3, 1),  # 가로 3줄
    (1, 3),  # 세로 3줄
]

# ---------------------------------------------------------------------- 색 팔레트
PALETTES = [
    dict(  # 프로젝트의 test-*.svg 와 같은 톤
        name="cool", paper="#eef3f6", wall="#27343d", room="#f8fafb",
        corridor="#dde6ec", text="#2f3f49", faint="#8fa0ad", route="#1f9d55",
    ),
    dict(
        name="clean", paper="#f6f7f8", wall="#23303a", room="#ffffff",
        corridor="#e3e9ed", text="#2b3a44", faint="#98a5ae", route="#15803d",
    ),
    dict(
        name="print", paper="#ffffff", wall="#141414", room="#ffffff",
        corridor="#ededed", text="#141414", faint="#8a8a8a", route="#166534",
    ),
    dict(
        name="warm", paper="#f3ece0", wall="#4a4034", room="#fbf7ef",
        corridor="#e5dac6", text="#4a4034", faint="#a3937c", route="#3f6f3a",
    ),
    dict(  # 청사진 — 어두운 배경, 밝은 선
        name="blueprint", paper="#10395e", wall="#dbe9f6", room="#17456f",
        corridor="#205c92", text="#e8f2fb", faint="#7fa8cd", route="#7ee2a8",
    ),
]

# 소방 기호는 법으로 색이 정해져 있어 팔레트와 무관하게 거의 고정이다.
EXIT_GREEN = "#12a150"
EQUIP_RED = "#d92d20"
HERE_PINK = "#e11d48"

# ------------------------------------------------------------------- 실 이름 사전
BUILDING_KINDS = [
    dict(
        kind="hospital", title="병동 피난안내도",
        rooms=["병실", "처치실", "진료실", "간호사실", "검사실", "상담실",
               "치료실", "약제실", "면회실", "당직실", "물품창고", "탈의실"],
    ),
    dict(
        kind="school", title="교사동 피난안내도",
        rooms=["교실", "교무실", "과학실", "컴퓨터실", "음악실", "미술실",
               "도서실", "상담실", "보건실", "준비실", "행정실", "체육교구실"],
    ),
    dict(
        kind="office", title="사무동 피난안내도",
        rooms=["사무실", "회의실", "임원실", "자료실", "휴게실", "전산실",
               "접견실", "복사실", "창고", "탕비실", "면접실", "교육장"],
    ),
    dict(
        kind="public", title="청사 피난안내도",
        rooms=["민원실", "대기실", "상담실", "회의실", "문서고", "당직실",
               "방재실", "기계실", "전기실", "수유실", "직원휴게실", "창고"],
    ),
    dict(
        kind="mall", title="상가 피난안내도",
        rooms=["점포", "매장", "관리실", "창고", "직원실", "화장실",
               "준비실", "냉동창고", "사무실", "탈의실", "휴게실", "배전실"],
    ),
]

# 한글 폰트를 못 찾은 환경(폰트 없는 도커 등)에서 쓰는 대체 표기
ASCII_ROOMS = ["ROOM", "OFFICE", "LAB", "STORE", "MEETING", "WARD",
               "CLASS", "STAFF", "REST", "UTILITY", "ARCHIVE", "SHOP"]

FONT_CANDIDATES = [
    os.environ.get("KOREAN_FONT", ""),
    "C:/Windows/Fonts/malgun.ttf",
    "C:/Windows/Fonts/gulim.ttc",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/truetype/nanum/NanumBarunGothic.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/Library/Fonts/AppleGothic.ttf",
]


# =============================================================== 폰트 / 작은 도구
class Fonts:
    """한글 폰트를 찾고 크기별로 캐시한다. 못 찾으면 영문 표기로 자동 전환."""

    def __init__(self):
        self.path = None
        for cand in FONT_CANDIDATES:
            if cand and Path(cand).exists():
                try:
                    ImageFont.truetype(cand, 20)
                    self.path = cand
                    break
                except OSError:
                    continue
        self.korean = self.path is not None
        self._cache: dict[int, ImageFont.FreeTypeFont] = {}

    def at(self, size: int):
        size = max(6, int(size))
        if size not in self._cache:
            if self.path:
                self._cache[size] = ImageFont.truetype(self.path, size)
            else:
                self._cache[size] = ImageFont.load_default()
        return self._cache[size]


FONTS = Fonts()


def hex_rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def mix(a: str, b: str, t: float) -> tuple[int, int, int]:
    """색 a와 b를 t 비율로 섞는다 (t=0이면 a)."""
    ca, cb = hex_rgb(a), hex_rgb(b)
    return tuple(round(ca[i] + (cb[i] - ca[i]) * t) for i in range(3))


def jitter_color(rng: random.Random, value: str, amount: int = 10):
    r, g, b = hex_rgb(value)
    d = rng.randint(-amount, amount)
    return tuple(max(0, min(255, c + d)) for c in (r, g, b))


def place_corridors(rng: random.Random, lo: float, hi: float, n: int, width: float):
    """
    복도 n개를 놓아 (n+1)개의 실 구간을 만든다.

    구간 폭을 균등에 가깝게 두는 게 핵심이다. 무작위로 흩뿌리면 한쪽 실이 40m 깊이가
    되어 실제 건물에서는 나올 수 없는 도면이 만들어진다.
    """
    if n <= 0:
        return []
    room_total = (hi - lo) - n * width
    weights = [rng.uniform(0.82, 1.18) for _ in range(n + 1)]
    total = sum(weights)
    out, pos = [], lo
    for i in range(n):
        pos += room_total * weights[i] / total
        out.append((pos + width / 2, width))
        pos += width
    return out


def bands(lo: float, hi: float, corridors: list[tuple[float, float]]):
    """복도 사이에 남는 구간들 — 여기에 실을 채운다."""
    edges = [lo]
    for center, width in corridors:
        edges.append(center - width / 2)
        edges.append(center + width / 2)
    edges.append(hi)
    out = []
    for i in range(0, len(edges), 2):
        a, b = edges[i], edges[i + 1]
        if b - a > 1:
            out.append((a, b))
    return out


# ==================================================================== 층 배치 생성
DRAW_AREA = (58, 58, CANVAS - 58, 830)   # 제목·범례 자리를 뺀 도면 영역


def building_rect(rng: random.Random, archetype):
    """
    복도 개수에서 건물 크기를 거꾸로 계산한다.

    실의 깊이는 건물이 커진다고 같이 깊어지지 않는다(복도에서 창까지 8m를 넘는 실은
    거의 없다). 그래서 건물을 먼저 정하고 복도를 흩뿌리는 대신, 실 깊이를 먼저 정하고
    거기서 건물 크기를 얻는다.
    """
    n_rows, n_cols = archetype
    row_w = rng.uniform(48, 66)
    col_w = rng.uniform(46, 62)
    ax0, ay0, ax1, ay1 = DRAW_AREA
    max_w, max_h = ax1 - ax0, ay1 - ay0

    if n_rows > 0:  # 실은 가로 복도를 바라본다 → 세로 길이가 실 깊이로 묶인다
        depth = min(rng.uniform(170, 240), (max_h - n_rows * row_w) / (n_rows + 1))
        height = depth * (n_rows + 1) + n_rows * row_w
        width = rng.uniform(max_w * 0.72, max_w)
    else:           # 세로 복도만 있으면 반대로 가로가 묶인다
        depth = min(rng.uniform(170, 240), (max_w - n_cols * col_w) / (n_cols + 1))
        width = depth * (n_cols + 1) + n_cols * col_w
        height = rng.uniform(max_h * 0.72, max_h)

    x0 = ax0 + rng.uniform(0, max_w - width)
    y0 = ay0 + rng.uniform(0, max_h - height)
    return (x0, y0, x0 + width, y0 + height), row_w, col_w


def make_layout(rng: random.Random, archetype, building, row_w, col_w):
    """복도 격자를 놓고 남는 자리를 실로 채운 뒤, 대피 그래프까지 만든다."""
    bx0, by0, bx1, by1 = building
    n_rows, n_cols = archetype

    rows = place_corridors(rng, by0, by1, n_rows, row_w)
    cols = place_corridors(rng, bx0, bx1, n_cols, col_w)

    # 복도가 하나도 없으면 안내할 길이 없다
    if not rows and not cols:
        rows = [((by0 + by1) / 2, row_w)]

    y_bands = bands(by0, by1, rows)
    x_bands = bands(bx0, bx1, cols)

    room_target = rng.uniform(120, 200)
    rooms = []
    for (ry0, ry1) in y_bands:
        for (rx0, rx1) in x_bands:
            if rx1 - rx0 < 72 or ry1 - ry0 < 72:
                continue
            facing = pick_facing(rng, (rx0, ry0, rx1, ry1), rows, cols)
            if facing is None:
                continue
            rooms.extend(split_block((rx0, ry0, rx1, ry1), facing, room_target, rng))

    if not rooms:  # 건물이 너무 작게 뽑힌 경우 — 복도를 하나로 줄여 다시 시도
        return make_layout(rng, (1, 0), building, row_w, col_w)

    assign_cores(rng, rooms)
    graph = build_graph(rng, rooms, rows, cols, building)
    return dict(rows=rows, cols=cols, rooms=rooms, **graph)


def pick_facing(rng: random.Random, block, rows, cols):
    """이 블록의 실들이 어느 복도를 바라볼지 정한다."""
    x0, y0, x1, y1 = block
    row_adj, col_adj = [], []
    for yc, w in rows:
        if abs(y0 - (yc + w / 2)) < 0.5:
            row_adj.append(("top", yc, w))
        if abs(y1 - (yc - w / 2)) < 0.5:
            row_adj.append(("bottom", yc, w))
    for xc, w in cols:
        if abs(x0 - (xc + w / 2)) < 0.5:
            col_adj.append(("left", xc, w))
        if abs(x1 - (xc - w / 2)) < 0.5:
            col_adj.append(("right", xc, w))

    # 가로 복도를 낀 실이 기본이고, 세로 복도를 낀 블록은 가끔 그쪽을 바라본다
    if col_adj and (not row_adj or rng.random() < 0.35):
        side, center, _ = rng.choice(col_adj)
        return ("col", side, center)
    if row_adj:
        side, center, _ = rng.choice(row_adj)
        return ("row", side, center)
    return None


def split_block(block, facing, room_target, rng: random.Random):
    """블록을 복도와 나란한 방향으로 쪼개, 모든 실이 복도에 접하게 한다."""
    x0, y0, x1, y1 = block
    axis, side, center = facing
    rooms = []

    if axis == "row":  # 가로 복도를 바라봄 → x 방향으로 분할
        k = max(1, min(6, round((x1 - x0) / room_target)))
        cuts = [x0 + (x1 - x0) * i / k for i in range(k + 1)]
        for i in range(k):
            rect = (cuts[i], y0, cuts[i + 1], y1)
            door_x = (cuts[i] + cuts[i + 1]) / 2 + rng.uniform(-8, 8)
            door_y = y0 if side == "top" else y1
            rooms.append(dict(rect=rect, kind="room", side=side,
                              door=(door_x, door_y), corridor=("row", center)))
    else:  # 세로 복도를 바라봄 → y 방향으로 분할
        k = max(1, min(6, round((y1 - y0) / room_target)))
        cuts = [y0 + (y1 - y0) * i / k for i in range(k + 1)]
        for i in range(k):
            rect = (x0, cuts[i], x1, cuts[i + 1])
            door_y = (cuts[i] + cuts[i + 1]) / 2 + rng.uniform(-8, 8)
            door_x = x0 if side == "left" else x1
            rooms.append(dict(rect=rect, kind="room", side=side,
                              door=(door_x, door_y), corridor=("col", center)))
    return rooms


def assign_cores(rng: random.Random, rooms):
    """계단실·승강기를 실 몇 개에 배정한다. 계단은 반드시 하나 이상."""
    eligible = [r for r in rooms if area(r["rect"]) > 8000]
    if not eligible:
        eligible = list(rooms)
    rng.shuffle(eligible)

    n_stairs = 1 if len(eligible) < 4 else rng.choice([1, 2, 2])
    for room in eligible[:n_stairs]:
        room["kind"] = "stairs"
    rest = eligible[n_stairs:]
    if rest and rng.random() < 0.75:
        rest[0]["kind"] = "elevator"


def area(rect):
    x0, y0, x1, y1 = rect
    return max(0.0, x1 - x0) * max(0.0, y1 - y0)


# ------------------------------------------------------------------- 대피 그래프
def build_graph(rng: random.Random, rooms, rows, cols, building):
    """복도 중심선 위에 노드를 놓고 이어, Dijkstra가 돌 수 있는 그래프를 만든다."""
    bx0, by0, bx1, by1 = building
    nodes, edges = [], []
    seq = {"n": 1, "e": 1}

    def add_node(x, y, ntype, name):
        nid = f"N{seq['n']}"
        seq["n"] += 1
        nodes.append(dict(id=nid, name=name, x=round(x, 2), y=round(y, 2), type=ntype))
        return nid

    def add_edge(a, b):
        if a == b:
            return
        eid = f"E{seq['e']}"
        seq["e"] += 1
        edges.append(dict(id=eid, a=a, b=b, wall=None))
        return eid

    # 복도별로 "축 위 위치 t → 노드" 를 모은 뒤 정렬해서 사슬로 잇는다
    corridor_points: dict[tuple, list[tuple[float, str]]] = {}
    for i, (yc, _) in enumerate(rows):
        corridor_points[("row", i)] = []
    for i, (xc, _) in enumerate(cols):
        corridor_points[("col", i)] = []

    def corridor_key(kind, center):
        source = rows if kind == "row" else cols
        for i, (c, _) in enumerate(source):
            if abs(c - center) < 0.5:
                return (kind, i)
        return None

    # 1) 교차점
    for i, (yc, _) in enumerate(rows):
        for j, (xc, _) in enumerate(cols):
            nid = add_node(xc, yc, "junction", f"복도 교차점 {i + 1}-{j + 1}")
            corridor_points[("row", i)].append((xc, nid))
            corridor_points[("col", j)].append((yc, nid))

    # 2) 복도 양 끝 (건물 외벽에 닿는 지점) — 여기 일부가 비상구가 된다
    terminals = []
    for i, (yc, _) in enumerate(rows):
        for t, label in ((bx0, "서측"), (bx1, "동측")):
            nid = add_node(t, yc, "junction", f"{label} 복도 끝")
            corridor_points[("row", i)].append((t, nid))
            terminals.append(dict(id=nid, x=t, y=yc, wall="W" if t == bx0 else "E",
                                  length=bx1 - bx0))
    for j, (xc, _) in enumerate(cols):
        for t, label in ((by0, "북측"), (by1, "남측")):
            nid = add_node(xc, t, "junction", f"{label} 복도 끝")
            corridor_points[("col", j)].append((t, nid))
            terminals.append(dict(id=nid, x=xc, y=t, wall="N" if t == by0 else "S",
                                  length=by1 - by0))

    # 3) 실의 문 — 문 노드 + 복도 위 접속점
    #    접속점이 이미 있는 노드와 거의 같은 자리면 새로 만들지 않고 그 노드를 쓴다.
    #    (새로 만들고 나중에 걸러 내면 그 방은 어느 통로에도 닿지 않는 섬이 된다)
    for room in rooms:
        key = corridor_key(*room["corridor"])
        if key is None:
            continue
        dx, dy = room["door"]
        if key[0] == "row":
            cy = rows[key[1]][0]
            join_pos, join_xy = dx, (dx, cy)
        else:
            cx = cols[key[1]][0]
            join_pos, join_xy = dy, (cx, dy)

        ntype = {"room": "room", "stairs": "stair", "elevator": "elevator"}[room["kind"]]
        base = room.get("label") or "실"
        door_id = add_node(dx, dy, ntype, base)
        room["node_id"] = door_id

        join_id = None
        for pos, nid in corridor_points[key]:
            if abs(pos - join_pos) < 7.0:
                join_id = nid
                break
        if join_id is None:
            join_id = add_node(join_xy[0], join_xy[1], "junction", f"{base} 앞")
            corridor_points[key].append((join_pos, join_id))
        add_edge(door_id, join_id)

    # 4) 복도별로 정렬해 사슬 연결
    for key, points in corridor_points.items():
        points.sort(key=lambda p: p[0])
        for a, b in zip(points, points[1:]):
            add_edge(a[1], b[1])

    # 5) 비상구 지정 — 가장 긴 복도의 양 끝을 우선으로
    node_by_id = {n["id"]: n for n in nodes}
    terminals.sort(key=lambda t: -t["length"])
    n_exits = min(len(terminals), rng.choice([2, 2, 3, 4]))
    exits = []
    for term in terminals[:n_exits]:
        node = node_by_id[term["id"]]
        node["type"] = "exit"
        node["name"] = {"W": "서측 비상구", "E": "동측 비상구",
                        "N": "북측 비상구", "S": "남측 비상구"}[term["wall"]]
        exits.append(dict(**term, name=node["name"]))

    return dict(nodes=nodes, edges=edges, exits=exits, terminals=terminals)


def shortest_path(nodes, edges, start_id, goal_ids):
    """대피 경로 화살표를 그리기 위한 최단 경로 (거리 가중 Dijkstra)."""
    pos = {n["id"]: (n["x"], n["y"]) for n in nodes}
    adj: dict[str, list[tuple[str, float]]] = {n["id"]: [] for n in nodes}
    for e in edges:
        ax, ay = pos[e["a"]]
        bx, by = pos[e["b"]]
        w = math.hypot(bx - ax, by - ay)
        adj[e["a"]].append((e["b"], w))
        adj[e["b"]].append((e["a"], w))

    import heapq
    dist = {start_id: 0.0}
    prev: dict[str, str] = {}
    heap = [(0.0, start_id)]
    goals = set(goal_ids)
    while heap:
        d, cur = heapq.heappop(heap)
        if d > dist.get(cur, float("inf")):
            continue
        if cur in goals:
            path = [cur]
            while path[-1] in prev:
                path.append(prev[path[-1]])
            return [pos[p] for p in reversed(path)]
        for nxt, w in adj[cur]:
            nd = d + w
            if nd < dist.get(nxt, float("inf")):
                dist[nxt] = nd
                prev[nxt] = cur
                heapq.heappush(heap, (nd, nxt))
    return []


# ======================================================================= 기호 그리기
def rounded(draw, box, radius, **kw):
    try:
        draw.rounded_rectangle(box, radius=radius, **kw)
    except AttributeError:  # 아주 오래된 Pillow
        draw.rectangle(box, **kw)


def draw_exit_sign(draw, cx, cy, s, flip=False):
    """녹색 바탕에 흰 사람과 화살표 — 비상구 표지."""
    w, h = s * 1.7, s
    box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
    rounded(draw, box, radius=s * 0.14, fill=EXIT_GREEN, outline="#ffffff",
            width=max(1, int(s * 0.07)))
    # 달리는 사람
    px = cx - w * 0.18
    draw.ellipse([px - s * 0.09, cy - h * 0.30, px + s * 0.09, cy - h * 0.12], fill="#ffffff")
    draw.polygon([(px - s * 0.10, cy - h * 0.08), (px + s * 0.12, cy - h * 0.05),
                  (px + s * 0.05, cy + h * 0.30), (px - s * 0.16, cy + h * 0.26)],
                 fill="#ffffff")
    # 화살표
    ax = cx + w * 0.24
    d = -1 if flip else 1
    draw.polygon([(ax + d * s * 0.26, cy), (ax - d * s * 0.05, cy - s * 0.24),
                  (ax - d * s * 0.05, cy + s * 0.24)], fill="#ffffff")
    return box


def core_box(rect, max_w, max_h, lift=0.0):
    """실 한가운데에 기호를 놓을 자리 — 실이 커도 기호는 커지지 않는다."""
    x0, y0, x1, y1 = rect
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    w = max(30.0, min(x1 - x0 - 20, max_w))
    h = max(30.0, min(y1 - y0 - 20, max_h))
    cy -= min(lift, max(0.0, (y1 - y0 - h) / 2))
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def draw_stairs(draw, rect, palette, rng):
    """계단 — 발판 여러 줄과 올라가는 방향 화살표."""
    x0, y0, x1, y1 = core_box(rect, rng.uniform(78, 104), rng.uniform(92, 126), lift=14)
    line = jitter_color(rng, palette["wall"], 8)
    draw.rectangle([x0, y0, x1, y1], fill=mix(palette["room"], palette["corridor"], 0.5),
                   outline=line, width=2)

    # 발판은 계단실의 긴 쪽을 가로지른다
    vertical = (y1 - y0) >= (x1 - x0)
    span = (y1 - y0) if vertical else (x1 - x0)
    steps = max(4, min(9, int(span / 13)))
    for i in range(1, steps):
        t = i / steps
        if vertical:
            y = y0 + (y1 - y0) * t
            draw.line([x0, y, x1, y], fill=line, width=2)
        else:
            x = x0 + (x1 - x0) * t
            draw.line([x, y0, x, y1], fill=line, width=2)

    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    if vertical:
        draw.line([cx, y1 - 6, cx, y0 + 12], fill=EXIT_GREEN, width=3)
        draw.polygon([(cx, y0 + 4), (cx - 5, y0 + 14), (cx + 5, y0 + 14)], fill=EXIT_GREEN)
    else:
        draw.line([x0 + 6, cy, x1 - 12, cy], fill=EXIT_GREEN, width=3)
        draw.polygon([(x1 - 4, cy), (x1 - 14, cy - 5), (x1 - 14, cy + 5)], fill=EXIT_GREEN)
    return [x0, y0, x1, y1]


def draw_elevator(draw, rect, palette, rng):
    """승강기 — 문이 갈라진 사각형과 위·아래 삼각형."""
    x0, y0, x1, y1 = core_box(rect, rng.uniform(64, 84), rng.uniform(64, 88), lift=12)
    line = jitter_color(rng, palette["wall"], 8)
    draw.rectangle([x0, y0, x1, y1], fill=mix(palette["room"], palette["wall"], 0.10),
                   outline=line, width=2)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    draw.line([cx, y0 + 4, cx, y1 - 4], fill=line, width=2)
    t = min(9, (x1 - x0) * 0.16)
    draw.polygon([(cx - t * 1.5, cy + t * 0.2), (cx - t * 0.5, cy + t * 0.2),
                  (cx - t, cy - t * 0.9)], fill=line)
    draw.polygon([(cx + t * 0.5, cy - t * 0.2), (cx + t * 1.5, cy - t * 0.2),
                  (cx + t, cy + t * 0.9)], fill=line)
    return [x0, y0, x1, y1]


def draw_extinguisher(draw, cx, cy, s):
    """소화기 — 빨간 원 안의 소화기 실루엣."""
    box = [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2]
    draw.ellipse(box, fill=EQUIP_RED, outline="#ffffff", width=max(1, int(s * 0.08)))
    draw.rounded_rectangle([cx - s * 0.13, cy - s * 0.14, cx + s * 0.13, cy + s * 0.28],
                           radius=s * 0.07, fill="#ffffff")
    draw.line([cx - s * 0.02, cy - s * 0.16, cx - s * 0.02, cy - s * 0.28],
              fill="#ffffff", width=max(1, int(s * 0.09)))
    draw.line([cx - s * 0.02, cy - s * 0.26, cx + s * 0.20, cy - s * 0.20],
              fill="#ffffff", width=max(1, int(s * 0.09)))
    return box


def draw_hydrant(draw, cx, cy, s, fonts):
    """소화전 — 빨간 사각형 안의 호스 릴."""
    box = [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2]
    rounded(draw, box, radius=s * 0.16, fill=EQUIP_RED, outline="#ffffff",
            width=max(1, int(s * 0.08)))
    draw.ellipse([cx - s * 0.24, cy - s * 0.24, cx + s * 0.24, cy + s * 0.24],
                 outline="#ffffff", width=max(2, int(s * 0.09)))
    draw.line([cx, cy, cx + s * 0.34, cy + s * 0.16], fill="#ffffff",
              width=max(2, int(s * 0.08)))
    return box


def draw_you_are_here(draw, cx, cy, s, fonts, korean):
    """현재위치 — 지도에서 가장 눈에 띄는 마커."""
    r = s * 0.34
    draw.polygon([(cx, cy + s * 0.5), (cx - r * 0.62, cy + r * 0.30),
                  (cx + r * 0.62, cy + r * 0.30)], fill=HERE_PINK)
    draw.ellipse([cx - r, cy - r * 0.9, cx + r, cy + r * 1.1], fill=HERE_PINK,
                 outline="#ffffff", width=max(2, int(s * 0.07)))
    draw.ellipse([cx - r * 0.30, cy - r * 0.22, cx + r * 0.30, cy + r * 0.38],
                 fill="#ffffff")
    label = "현재위치" if korean else "YOU ARE HERE"
    f = fonts.at(int(s * 0.34))
    tw = draw.textlength(label, font=f)
    pad = s * 0.10
    ty = cy + s * 0.56
    draw.rectangle([cx - tw / 2 - pad, ty, cx + tw / 2 + pad, ty + s * 0.42],
                   fill=HERE_PINK)
    draw.text((cx, ty + s * 0.21), label, font=f, fill="#ffffff", anchor="mm")
    return [cx - max(r, tw / 2 + pad), cy - r * 0.9, cx + max(r, tw / 2 + pad), ty + s * 0.42]


def draw_door(draw, room, palette, rng):
    """문 — 벽을 끊고 여닫이 호를 그린다."""
    dx, dy = room["door"]
    side = room["side"]
    w = rng.uniform(26, 34)
    line = jitter_color(rng, palette["wall"], 10)
    gap = palette["corridor"]

    if side in ("top", "bottom"):
        draw.line([dx - w / 2, dy, dx + w / 2, dy], fill=gap, width=5)
        sign = -1 if side == "top" else 1
        draw.line([dx - w / 2, dy, dx - w / 2, dy + sign * w], fill=line, width=2)
        arc_box = [dx - w / 2 - w, dy - w, dx - w / 2 + w, dy + w]
        draw.arc(arc_box, 0 if sign < 0 else 270, 90 if sign < 0 else 360,
                 fill=line, width=2)
        box = [dx - w / 2 - 3, min(dy, dy + sign * w) - 3,
               dx + w / 2 + 3, max(dy, dy + sign * w) + 3]
    else:
        draw.line([dx, dy - w / 2, dx, dy + w / 2], fill=gap, width=5)
        sign = -1 if side == "left" else 1
        draw.line([dx, dy - w / 2, dx + sign * w, dy - w / 2], fill=line, width=2)
        arc_box = [dx - w, dy - w / 2 - w, dx + w, dy - w / 2 + w]
        draw.arc(arc_box, 270 if sign > 0 else 180, 360 if sign > 0 else 270,
                 fill=line, width=2)
        box = [min(dx, dx + sign * w) - 3, dy - w / 2 - 3,
               max(dx, dx + sign * w) + 3, dy + w / 2 + 3]
    return box


def dashed_line(draw, pts, color, width, dash=14, gap=9):
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        length = math.hypot(x1 - x0, y1 - y0)
        if length < 1:
            continue
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        t = 0.0
        while t < length:
            e = min(t + dash, length)
            draw.line([x0 + ux * t, y0 + uy * t, x0 + ux * e, y0 + uy * e],
                      fill=color, width=width)
            t = e + gap


def arrow_head(draw, a, b, color, size=11):
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    draw.polygon([
        b,
        (b[0] - size * math.cos(ang - 0.42), b[1] - size * math.sin(ang - 0.42)),
        (b[0] - size * math.cos(ang + 0.42), b[1] - size * math.sin(ang + 0.42)),
    ], fill=color)


# ==================================================================== 도면 한 장
def render_plan(rng: random.Random, archetype, palette, kind):
    """캔버스에 대피도 한 장을 그리고, 기호 상자와 그래프를 함께 돌려준다."""
    img = Image.new("RGB", (CANVAS, CANVAS), jitter_color(rng, palette["paper"], 6))
    draw = ImageDraw.Draw(img)
    dets: list[tuple[str, list[float]]] = []

    building, row_w, col_w = building_rect(rng, archetype)
    layout = make_layout(rng, archetype, building, row_w, col_w)
    rows, cols, rooms = layout["rows"], layout["cols"], layout["rooms"]
    bx0, by0, bx1, by1 = building

    wall_w = rng.choice([3, 4, 4, 5])
    line = jitter_color(rng, palette["wall"], 8)

    # 실 이름 배정 — 그래프 이름과 도면 글자가 같아야 채점이 가능하다
    name_pool = kind["rooms"] if FONTS.korean else ASCII_ROOMS
    floor = rng.choice([1, 2, 3, 4, 5])
    counter = rng.randint(1, 4)
    for room in rooms:
        if room["kind"] == "stairs":
            room["label"] = "계단" if FONTS.korean else "STAIRS"
        elif room["kind"] == "elevator":
            room["label"] = "엘리베이터" if FONTS.korean else "ELEVATOR"
        else:
            base = rng.choice(name_pool)
            room["label"] = f"{floor}{counter:02d}{'호' if FONTS.korean else ''} {base}" \
                if rng.random() < 0.55 else base
            counter += 1

    # 실 이름이 정해진 뒤에 그래프를 다시 만들어 노드 이름을 맞춘다
    layout.update(build_graph(rng, rooms, rows, cols, building))
    nodes, edges, exits = layout["nodes"], layout["edges"], layout["exits"]

    # ---- 1. 건물 외곽 + 복도 바닥
    draw.rectangle([bx0, by0, bx1, by1], fill=palette["corridor"], outline=line, width=wall_w + 1)
    for yc, w in rows:
        draw.rectangle([bx0, yc - w / 2, bx1, yc + w / 2], fill=palette["corridor"])
    for xc, w in cols:
        draw.rectangle([xc - w / 2, by0, xc + w / 2, by1], fill=palette["corridor"])

    # ---- 2. 실
    # 계단실·승강기실에도 room 상자를 씌운다. 기호 상자(stairs/elevator)는 실보다
    # 훨씬 작아 실 안에 들어앉으므로 라벨이 충돌하지 않고, 오히려 "이 실 안에 계단이
    # 있다"는 관계가 그대로 남는다. 뒤에서 복도(빈 공간)를 찾을 때도 실 사각형이
    # 빠짐없이 있어야 한다.
    for room in rooms:
        fill = palette["room"]
        if room["kind"] == "stairs":
            fill = mix(palette["room"], EXIT_GREEN, 0.10)
        elif room["kind"] == "elevator":
            fill = mix(palette["room"], palette["wall"], 0.06)
        draw.rectangle(room["rect"], fill=fill, outline=line, width=wall_w)
        dets.append(("room", list(room["rect"])))

    # ---- 3. 문
    for room in rooms:
        dets.append(("door", draw_door(draw, room, palette, rng)))

    # ---- 4. 계단·승강기 기호
    for room in rooms:
        if room["kind"] == "stairs":
            room["symbol_box"] = draw_stairs(draw, room["rect"], palette, rng)
            dets.append(("stairs", room["symbol_box"]))
        elif room["kind"] == "elevator":
            room["symbol_box"] = draw_elevator(draw, room["rect"], palette, rng)
            dets.append(("elevator", room["symbol_box"]))

    # ---- 5. 대피 경로 화살표 (도면 절반 정도에만 있다)
    here_node = None
    if rng.random() < 0.85:
        # 비상구 표지 옆이나 외벽에 붙으면 마커가 다른 기호·벽과 겹친다
        candidates = [
            n for n in nodes if n["type"] == "junction"
            and bx0 + 45 < n["x"] < bx1 - 45 and by0 + 45 < n["y"] < by1 - 45
            and all(math.hypot(n["x"] - e["x"], n["y"] - e["y"]) > 90 for e in exits)
        ]
        if candidates:
            here_node = rng.choice(candidates)
    if here_node and rng.random() < 0.6:
        exit_ids = [n["id"] for n in nodes if n["type"] == "exit"]
        path = shortest_path(nodes, edges, here_node["id"], exit_ids)
        if len(path) >= 2:
            dashed_line(draw, path, palette["route"], rng.choice([4, 5, 6]))
            arrow_head(draw, path[-2], path[-1], palette["route"], 13)
            if len(path) > 3:
                mid = len(path) // 2
                arrow_head(draw, path[mid - 1], path[mid], palette["route"], 11)

    # ---- 6. 비상구 표지 — 외벽을 끊어 문을 내고, 표지는 복도 폭 안에 붙인다
    taken = []          # 이미 기호가 차지한 자리 (겹침 방지용)
    for ex in exits:
        wall = ex["wall"]
        size = rng.uniform(22, 28)
        if wall in ("W", "E"):
            inward = 1 if wall == "W" else -1
            draw.line([ex["x"], ex["y"] - 25, ex["x"], ex["y"] + 25],
                      fill=palette["corridor"], width=wall_w + 3)
            sx, sy = ex["x"] + inward * 34, ex["y"] - 12
            dets.append(("exit", draw_exit_sign(draw, sx, sy, size, flip=(wall == "W"))))
        else:
            inward = 1 if wall == "N" else -1
            draw.line([ex["x"] - 25, ex["y"], ex["x"] + 25, ex["y"]],
                      fill=palette["corridor"], width=wall_w + 3)
            sx, sy = ex["x"] - 12, ex["y"] + inward * 30
            dets.append(("exit", draw_exit_sign(draw, sx, sy, size)))
        taken.append((sx, sy, 46))

    # ---- 7. 소화기·소화전 (복도 벽면을 따라)
    # 문·비상구·현재위치와 겹치면 라벨 상자가 서로를 가려 학습에 해가 된다
    for room in rooms:
        taken.append((room["door"][0], room["door"][1], 58))  # 여닫이 호까지 피한다
    if here_node:
        taken.append((here_node["x"], here_node["y"], 52))

    spots = corridor_spots(rng, rows, cols, building)
    rng.shuffle(spots)
    chosen = []
    for (sx, sy) in spots:
        if all(math.hypot(sx - tx, sy - ty) > r for tx, ty, r in taken):
            chosen.append((sx, sy))
            taken.append((sx, sy, 62))
    n_ext = min(len(chosen), rng.randint(2, 5))
    n_hyd = min(len(chosen) - n_ext, rng.randint(1, 3))
    for (sx, sy) in chosen[:n_ext]:
        dets.append(("fire_extinguisher", draw_extinguisher(draw, sx, sy, rng.uniform(20, 27))))
    for (sx, sy) in chosen[n_ext:n_ext + n_hyd]:
        dets.append(("fire_hydrant", draw_hydrant(draw, sx, sy, rng.uniform(22, 29), FONTS)))

    # ---- 8. 현재위치
    if here_node:
        dets.append(("you_are_here",
                     draw_you_are_here(draw, here_node["x"], here_node["y"],
                                       rng.uniform(30, 40), FONTS, FONTS.korean)))

    # ---- 9. 글자 (실 이름 · 제목 · 방위 · 축척)
    label_rooms(draw, rooms, palette, rng)
    meters_per_px = draw_title_block(draw, building, palette, kind, floor, rng, dets)

    return img, dets, dict(
        nodes=nodes, edges=edges, rooms=rooms, building=list(building),
        meters_per_px=meters_per_px,
        here=(here_node["id"] if here_node else None),
    )


def corridor_spots(rng: random.Random, rows, cols, building):
    """복도 벽에 붙는 소방설비 자리 후보."""
    bx0, by0, bx1, by1 = building
    spots = []
    for yc, w in rows:
        for _ in range(6):
            x = rng.uniform(bx0 + 40, bx1 - 40)
            y = yc + rng.choice([-1, 1]) * (w / 2 - rng.uniform(9, 15))
            spots.append((x, y))
    for xc, w in cols:
        for _ in range(6):
            y = rng.uniform(by0 + 40, by1 - 40)
            x = xc + rng.choice([-1, 1]) * (w / 2 - rng.uniform(9, 15))
            spots.append((x, y))
    return spots


def label_rooms(draw, rooms, palette, rng):
    for room in rooms:
        x0, y0, x1, y1 = room["rect"]
        w, h = x1 - x0, y1 - y0
        if w < 55 or h < 40:
            continue
        size = int(max(11, min(19, min(w / 6.2, h / 3.4))))
        font = FONTS.at(size)
        text = room["label"]
        while draw.textlength(text, font=font) > w - 12 and size > 9:
            size -= 1
            font = FONTS.at(size)
        if draw.textlength(text, font=font) > w - 8:
            continue
        cy = (y0 + y1) / 2
        if room.get("symbol_box"):
            # 기호 바로 아래에 두되, 벽을 넘지 않게 잡아 둔다
            cy = min(room["symbol_box"][3] + size * 0.95, y1 - size * 0.85)
        draw.text(((x0 + x1) / 2, cy), text, font=font,
                  fill=jitter_color(rng, palette["text"], 12), anchor="mm")


def draw_title_block(draw, building, palette, kind, floor, rng, dets):
    """제목·방위표·축척 막대 — 실제 안내도에 반드시 있는 요소들."""
    bx0, by0, bx1, by1 = building
    text_c = palette["text"]
    faint = palette["faint"]

    width_m = rng.uniform(26, 56)
    meters_per_px = width_m / (bx1 - bx0)

    title = f"{floor}층 {kind['title']}" if FONTS.korean else f"{floor}F EVACUATION PLAN"
    f_title = FONTS.at(rng.randint(24, 31))
    draw.text((bx0, by1 + 26), title, font=f_title, fill=text_c, anchor="lm")

    sub = "화재 시 엘리베이터를 이용하지 마십시오" if FONTS.korean \
        else "DO NOT USE ELEVATOR IN CASE OF FIRE"
    draw.text((bx0, by1 + 56), sub, font=FONTS.at(15), fill=faint, anchor="lm")

    # 방위표 — 도면 바깥 여백에 둔다 (건물 안에 그리면 실 위에 겹친다)
    nx, ny = bx1 - 18, by0 - 30
    draw.line([nx, ny + 18, nx, ny - 12], fill=faint, width=3)
    draw.polygon([(nx, ny - 20), (nx - 7, ny - 8), (nx + 7, ny - 8)], fill=faint)
    draw.text((nx - 17, ny + 4), "N", font=FONTS.at(15), fill=faint, anchor="mm")

    # 축척 막대
    bar_m = 5 if width_m < 38 else 10
    bar_px = bar_m / meters_per_px
    sx, sy = bx1 - bar_px, by1 + 62
    for i in range(4):
        seg = bar_px / 4
        draw.rectangle([sx + seg * i, sy, sx + seg * (i + 1), sy + 8],
                       fill=text_c if i % 2 == 0 else palette["paper"], outline=text_c)
    draw.text((sx + bar_px, sy + 20), f"{bar_m}m", font=FONTS.at(13),
              fill=faint, anchor="mm")

    # 범례 — 실제 안내도의 절반쯤에는 범례가 있다. 거기 찍힌 기호도 진짜 기호이므로
    # 정직하게 라벨한다. 대신 predict_to_plan.py 가 복도에서 먼 기호를 걸러 낸다.
    if rng.random() < 0.45:
        f_leg = FONTS.at(13)
        items = [
            ("exit", "비상구" if FONTS.korean else "EXIT", 18, 31),
            ("fire_extinguisher", "소화기" if FONTS.korean else "EXT.", 19, 19),
            ("fire_hydrant", "소화전" if FONTS.korean else "HYD.", 20, 20),
        ]
        span = sum(w + 6 + draw.textlength(t, font=f_leg) + 20 for _, t, _, w in items)
        lx, ly = max(bx0 + 260, bx1 - span), by1 + 34
        for name, label, size, width in items:
            cx = lx + width / 2
            if name == "exit":
                dets.append(("exit", draw_exit_sign(draw, cx, ly, size)))
            elif name == "fire_extinguisher":
                dets.append(("fire_extinguisher", draw_extinguisher(draw, cx, ly, size)))
            else:
                dets.append(("fire_hydrant", draw_hydrant(draw, cx, ly, size, FONTS)))
            draw.text((lx + width + 6, ly), label, font=f_leg, fill=faint, anchor="lm")
            lx += width + 6 + draw.textlength(label, font=f_leg) + 20

    return meters_per_px


# ================================================== 사진처럼 보이게 하는 후처리
def photo_transform(rng: random.Random, img, dets, nodes, out_size):
    """
    회전·축소·이동을 한 번에 적용하고, 같은 행렬로 상자와 노드 좌표도 옮긴다.

    벽에 붙은 안내도를 폰으로 찍으면 반드시 조금 기울고 여백이 남는다. 학습 데이터가
    반듯하기만 하면 실제 사진에서 성능이 떨어진다.
    """
    angle = math.radians(rng.uniform(-3.5, 3.5))
    scale = out_size / CANVAS * rng.uniform(0.86, 1.0)
    ox, oy = out_size / 2, out_size / 2
    tx, ty = rng.uniform(-22, 22), rng.uniform(-22, 22)
    cx, cy = CANVAS / 2, CANVAS / 2
    cos_a, sin_a = math.cos(angle), math.sin(angle)

    def forward(x, y):
        dx, dy = x - cx, y - cy
        return (scale * (cos_a * dx - sin_a * dy) + ox + tx,
                scale * (sin_a * dx + cos_a * dy) + oy + ty)

    # PIL의 AFFINE은 "출력 → 입력" 역행렬을 받는다
    inv = (
        cos_a / scale, sin_a / scale,
        cx - (cos_a * (ox + tx) + sin_a * (oy + ty)) / scale,
        -sin_a / scale, cos_a / scale,
        cy - (-sin_a * (ox + tx) + cos_a * (oy + ty)) / scale,
    )
    wall = mix("#d9d9d9", "#8b8b8b", rng.random())
    out = img.transform((out_size, out_size), Image.AFFINE, inv,
                        resample=Image.BICUBIC, fillcolor=wall)

    moved = []
    for name, box in dets:
        x0, y0, x1, y1 = box
        pts = [forward(x0, y0), forward(x1, y0), forward(x1, y1), forward(x0, y1)]
        nx0 = min(p[0] for p in pts)
        nx1 = max(p[0] for p in pts)
        ny0 = min(p[1] for p in pts)
        ny1 = max(p[1] for p in pts)
        full = (nx1 - nx0) * (ny1 - ny0)
        cx0, cy0 = max(0.0, nx0), max(0.0, ny0)
        cx1, cy1 = min(float(out_size), nx1), min(float(out_size), ny1)
        if cx1 - cx0 < 5 or cy1 - cy0 < 5:
            continue
        # 잘려 나간 상자는 라벨로 쓰면 오히려 방해가 된다
        if full > 0 and (cx1 - cx0) * (cy1 - cy0) / full < 0.55:
            continue
        moved.append((name, [cx0, cy0, cx1, cy1]))

    moved_nodes = []
    for n in nodes:
        nx, ny = forward(n["x"], n["y"])
        moved_nodes.append({**n, "x": round(nx, 2), "y": round(ny, 2)})

    return out, moved, moved_nodes, scale


def photo_effects(rng: random.Random, img):
    """조명·초점·노이즈·압축 — 폰 카메라가 남기는 흔적들."""
    w, h = img.size

    if rng.random() < 0.75:  # 한쪽에서 들어오는 빛
        grad = Image.new("L", (w, h))
        gd = ImageDraw.Draw(grad)
        steps = 24
        horiz = rng.random() < 0.5
        lo, hi = rng.randint(120, 165), rng.randint(200, 255)
        for i in range(steps):
            v = int(lo + (hi - lo) * (i / (steps - 1)))
            if horiz:
                gd.rectangle([w * i / steps, 0, w * (i + 1) / steps, h], fill=v)
            else:
                gd.rectangle([0, h * i / steps, w, h * (i + 1) / steps], fill=v)
        if rng.random() < 0.5:
            grad = grad.transpose(Image.FLIP_LEFT_RIGHT if horiz else Image.FLIP_TOP_BOTTOM)
        grad = grad.filter(ImageFilter.GaussianBlur(w / 12))
        dark = ImageEnhance.Brightness(img).enhance(0.72)
        img = Image.composite(img, dark, grad)

    if rng.random() < 0.6:  # 비네팅
        mask = Image.new("L", (w, h), 0)
        md = ImageDraw.Draw(mask)
        pad = rng.uniform(-0.08, 0.06)
        md.ellipse([w * (-0.18 + pad), h * (-0.18 + pad),
                    w * (1.18 - pad), h * (1.18 - pad)], fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(w / 9))
        img = Image.composite(img, ImageEnhance.Brightness(img).enhance(0.62), mask)

    img = ImageEnhance.Brightness(img).enhance(rng.uniform(0.88, 1.12))
    img = ImageEnhance.Contrast(img).enhance(rng.uniform(0.85, 1.18))
    img = ImageEnhance.Color(img).enhance(rng.uniform(0.6, 1.25))

    if rng.random() < 0.6:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 1.1)))
    if rng.random() < 0.35:
        img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=rng.randint(40, 110)))

    if rng.random() < 0.7:  # 센서 노이즈
        noise = Image.effect_noise((w, h), rng.uniform(8, 26)).convert("RGB")
        img = Image.blend(img, noise, rng.uniform(0.03, 0.09))

    if rng.random() < 0.8:  # JPEG 재압축
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=rng.randint(52, 92))
        buf.seek(0)
        img = Image.open(buf).convert("RGB")

    return img


# ============================================================================ 저장
def to_yolo(dets, size):
    lines = []
    for name, (x0, y0, x1, y1) in dets:
        cx = (x0 + x1) / 2 / size
        cy = (y0 + y1) / 2 / size
        w = (x1 - x0) / size
        h = (y1 - y0) / size
        if w <= 0 or h <= 0:
            continue
        lines.append(f"{INDEX[name]} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
    return "\n".join(lines) + "\n"


def save_preview(img, dets, path):
    canvas = img.convert("RGB").copy()
    d = ImageDraw.Draw(canvas)
    for name, (x0, y0, x1, y1) in dets:
        color = COLOR[name]
        d.rectangle([x0, y0, x1, y1], outline=color, width=2)
        f = FONTS.at(12)
        label = name
        tw = d.textlength(label, font=f)
        d.rectangle([x0, y0 - 14, x0 + tw + 6, y0], fill=color)
        d.text((x0 + 3, y0 - 13), label, font=f, fill="#ffffff")
    canvas.save(path, quality=92)


def main():
    # 윈도우 기본 콘솔(cp949)에서 한글·기호 출력이 깨지지 않게
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="대피도 탐지 학습 데이터 생성")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "dataset"))
    ap.add_argument("--count", type=int, default=100, help="만들 도면 장수")
    ap.add_argument("--size", type=int, default=800, help="내보낼 이미지 한 변(px)")
    ap.add_argument("--seed", type=int, default=20260814)
    ap.add_argument("--val", type=float, default=0.2, help="검증 비율")
    ap.add_argument("--test", type=float, default=0.1, help="시험 비율")
    ap.add_argument("--preview", type=int, default=4, help="라벨 겹쳐 그린 미리보기 장수")
    args = ap.parse_args()

    out = Path(args.out)
    for split in ("train", "val", "test"):
        (out / "images" / split).mkdir(parents=True, exist_ok=True)
        (out / "labels" / split).mkdir(parents=True, exist_ok=True)
    (out / "plans").mkdir(parents=True, exist_ok=True)
    if args.preview:
        (out / "preview").mkdir(parents=True, exist_ok=True)

    if not FONTS.korean:
        print("! 한글 폰트를 찾지 못해 영문 표기로 생성합니다.")
        print("  Colab: !apt-get -qq install fonts-nanum  또는  KOREAN_FONT=<ttf 경로>")

    # 분할을 먼저 정해 둔다 — 유형·팔레트가 한쪽에 쏠리지 않도록 섞는다
    order = list(range(args.count))
    random.Random(args.seed).shuffle(order)
    n_val = int(args.count * args.val)
    n_test = int(args.count * args.test)
    split_of = {}
    for pos, idx in enumerate(order):
        if pos < n_test:
            split_of[idx] = "test"
        elif pos < n_test + n_val:
            split_of[idx] = "val"
        else:
            split_of[idx] = "train"

    manifest = []
    counts = {name: 0 for name in NAMES}

    for i in range(args.count):
        rng = random.Random(args.seed * 1000 + i)
        archetype = ARCHETYPES[i % len(ARCHETYPES)]
        palette = PALETTES[(i // len(ARCHETYPES)) % len(PALETTES)]
        kind = BUILDING_KINDS[(i // 3) % len(BUILDING_KINDS)]

        img, dets, meta = render_plan(rng, archetype, palette, kind)
        img, dets, nodes, scale = photo_transform(rng, img, dets, meta["nodes"], args.size)
        img = photo_effects(rng, img)

        split = split_of[i]
        stem = f"plan_{i:03d}"
        # 노이즈까지 얹힌 사진풍 이미지라 PNG로 두면 한 장에 250KB가 넘는다.
        # 학습 성능 차이는 없으므로 저장소에 올릴 수 있는 크기로 JPEG 저장한다.
        img.save(out / "images" / split / f"{stem}.jpg", quality=90, subsampling=0)
        (out / "labels" / split / f"{stem}.txt").write_text(to_yolo(dets, args.size),
                                                            encoding="utf-8")

        # 정답 그래프 — 좌표계는 저장한 이미지의 픽셀과 같다
        plan = dict(
            id=stem,
            name=f"{stem} {kind['kind']}",
            metersPerUnit=round(meta["meters_per_px"] / scale, 6),
            stepLength=0.7,
            image=dict(width=args.size, height=args.size),
            nodes=nodes,
            edges=meta["edges"],
            initialHazards={},
        )
        (out / "plans" / f"{stem}.json").write_text(
            json.dumps(plan, ensure_ascii=False, indent=1), encoding="utf-8")

        for name, _ in dets:
            counts[name] += 1
        manifest.append(dict(file=f"{stem}.jpg", split=split,
                             archetype=f"{archetype[0]}x{archetype[1]}",
                             palette=palette["name"], building=kind["kind"],
                             objects=len(dets)))

        if i < args.preview:
            save_preview(img, dets, out / "preview" / f"{stem}.jpg")
        if (i + 1) % 20 == 0:
            print(f"  {i + 1}/{args.count} 생성")

    (out / "dataset.json").write_text(
        json.dumps(dict(count=args.count, size=args.size, seed=args.seed,
                        classes=NAMES, class_counts=counts, items=manifest),
                   ensure_ascii=False, indent=1), encoding="utf-8")

    splits = {s: sum(1 for m in manifest if m["split"] == s) for s in ("train", "val", "test")}
    print(f"\n완료 — {out}")
    print(f"  분할: train {splits['train']} / val {splits['val']} / test {splits['test']}")
    print("  클래스별 상자 수:")
    for name in NAMES:
        print(f"    {name:<18} {counts[name]:>6}")
    print(f"  총 {sum(counts.values())}개 상자")


if __name__ == "__main__":
    main()
