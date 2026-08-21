#!/usr/bin/env python3
"""
도면 사진에서 **벽을 뽑는다.**

## 왜 필요한가

관제 지도를 기울여 놓기만 하면 «기울인 종이» 로 보인다. 건물의 한 층으로
읽히려면 벽이 서 있어야 하는데, 우리가 가진 것은 점과 선으로 된 그래프
(복도의 연결 관계)와 비트맵 한 장뿐이다. 그래프에는 방의 외곽선이 없다.

그래서 사진에서 직접 뽑는다. 이 도면은 사진이 아니라 **선화** 다 —
검은 바탕에 흰 선. 대비가 극단적이라 직선 검출이 잘 듣는다.

## 방법

    이진화        밝은 것만 남긴다 (선 = 흰색)
    허프 변환     직선 조각을 찾는다
    글자 제거     로고·설명 문구가 있는 위쪽 띠를 버린다
    각도 정렬     거의 수평/수직인 것은 딱 맞춰 준다 — 벽은 삐뚤지 않다
    병합          같은 직선 위의 조각을 잇는다

## 한계를 알고 쓴다

높이는 모른다. 도면에 층고가 없으니 **모든 벽을 같은 높이**로 세운다.
문과 창도 구분 못 한다. 이건 «실측 3D» 가 아니라 **평면도를 세운 것**이고,
관제에서 필요한 것도 딱 그만큼이다 — 방의 경계가 보이고 사람이 어느 방
안에 있는지 읽히면 된다.

사용:
    python scripts/extract-walls.py --plan cocone-6f --api http://127.0.0.1:8080
"""

import argparse
import base64
import json
import math
import pathlib
import urllib.request

import cv2
import numpy as np

# 이보다 짧은 조각은 글자 획이거나 잡음이다
MIN_LEN = 26
# 이 각도 안쪽이면 수평/수직으로 딱 맞춘다. 벽은 0.5도씩 기울지 않는다.
SNAP_DEG = 4.0
# 같은 직선으로 볼 때의 허용 오차
MERGE_GAP = 14.0
MERGE_OFF = 3.5
# 로고·설명 문구가 있는 위쪽 띠 (0~1)
TEXT_BAND = 0.22
# 글자를 걸러내는 문턱.
#
# 위쪽 띠만 지워도 도면 **가운데 인쇄된 방 이름**(OFFICE, NORTH STREET …)은
# 그대로 남는다. 그 획들이 짧은 선분으로 잡혀 벽으로 서면, 방 한가운데
# 허공에 벽 조각이 떠 있는 꼴이 된다.
#
# 글자와 벽은 **모양이 다르다** — 글자는 작은 덩어리, 벽은 길고 얇은 구조.
# 그래서 이진화한 뒤 «가로도 세로도 이보다 작은 덩어리» 를 통째로 지운다.
# 획 하나가 아니라 글자 하나가 사라지므로 남은 조각이 생기지 않는다.
GLYPH_MAX_PX = 30


def fetch_image(api: str, plan_id: str) -> np.ndarray:
    url = f"{api.rstrip('/')}/api/plans/{plan_id}/image"
    with urllib.request.urlopen(url, timeout=30) as r:
        data_uri = json.loads(r.read())["dataUri"]
    raw = base64.b64decode(data_uri.split(",", 1)[1])
    buf = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def snap(seg):
    """거의 수평/수직인 선분을 딱 맞춘다."""
    x1, y1, x2, y2 = seg
    a = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180
    if a < SNAP_DEG or a > 180 - SNAP_DEG:
        y = (y1 + y2) / 2
        return (x1, y, x2, y)
    if abs(a - 90) < SNAP_DEG:
        x = (x1 + x2) / 2
        return (x, y1, x, y2)
    return seg


def merge(segs):
    """같은 직선 위에 놓인 조각을 잇는다. 안 이으면 벽 하나가 수십 장이 된다."""
    out = []
    used = [False] * len(segs)
    for i, s in enumerate(segs):
        if used[i]:
            continue
        x1, y1, x2, y2 = s
        ang = math.atan2(y2 - y1, x2 - x1)
        ux, uy = math.cos(ang), math.sin(ang)
        # 이 직선 위의 좌표(t)와 직선에서 떨어진 거리(d)로 다시 적는다
        pts = [(0.0, 0.0), ((x2 - x1) * ux + (y2 - y1) * uy, 0.0)]
        for j in range(i + 1, len(segs)):
            if used[j]:
                continue
            a = math.atan2(segs[j][3] - segs[j][1], segs[j][2] - segs[j][0])
            if abs(((a - ang + math.pi / 2) % math.pi) - math.pi / 2) > math.radians(3):
                continue
            ok = True
            proj = []
            for px, py in ((segs[j][0], segs[j][1]), (segs[j][2], segs[j][3])):
                dx, dy = px - x1, py - y1
                t = dx * ux + dy * uy
                d = abs(-dx * uy + dy * ux)
                if d > MERGE_OFF:
                    ok = False
                    break
                proj.append(t)
            if not ok:
                continue
            lo, hi = min(t for t, _ in pts), max(t for t, _ in pts)
            if min(proj) > hi + MERGE_GAP or max(proj) < lo - MERGE_GAP:
                continue
            pts += [(p, 0.0) for p in proj]
            used[j] = True
        ts = [t for t, _ in pts]
        lo, hi = min(ts), max(ts)
        out.append((x1 + ux * lo, y1 + uy * lo, x1 + ux * hi, y1 + uy * hi))
        used[i] = True
    return out


def drop_glyphs(bw):
    """작은 덩어리(=글자)를 지운다. 길고 얇은 것(=벽)만 남는다."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
    keep = np.zeros_like(bw)
    dropped = 0
    for i in range(1, n):
        w = stats[i, cv2.CC_STAT_WIDTH]
        h = stats[i, cv2.CC_STAT_HEIGHT]
        # 가로도 세로도 짧으면 글자다. 한쪽이라도 길면 벽일 수 있다.
        if w < GLYPH_MAX_PX and h < GLYPH_MAX_PX:
            dropped += 1
            continue
        keep[labels == i] = 255
    return keep, dropped


def extract(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # 검은 바탕에 흰 선. 반대로 그려진 도면이면 밝은 화소가 절반을 넘으므로 뒤집는다.
    if g.mean() > 127:
        g = 255 - g
    _, bw = cv2.threshold(g, 150, 255, cv2.THRESH_BINARY)
    bw, dropped = drop_glyphs(bw)
    print(f"  글자 덩어리 {dropped}개 제거")

    lines = cv2.HoughLinesP(bw, 1, np.pi / 360, threshold=60,
                            minLineLength=MIN_LEN, maxLineGap=6)
    if lines is None:
        return []
    h = img.shape[0]
    segs = []
    for x1, y1, x2, y2 in lines.reshape(-1, 4).astype(float):
        # 로고와 설명 문구가 있는 띠는 통째로 버린다 — 글자 획이 벽으로 잡힌다
        if y1 < h * TEXT_BAND and y2 < h * TEXT_BAND:
            continue
        if math.hypot(x2 - x1, y2 - y1) < MIN_LEN:
            continue
        segs.append(snap((x1, y1, x2, y2)))

    segs.sort(key=lambda s: -math.hypot(s[2] - s[0], s[3] - s[1]))
    merged = merge(segs)
    return [{"x1": round(a, 1), "y1": round(b, 1), "x2": round(c, 1), "y2": round(d, 1)}
            for a, b, c, d in merged
            if math.hypot(c - a, d - b) >= MIN_LEN]


def clean_floor(img):
    """
    바닥에 깔 **깨끗한 도면**을 만든다.

    원본에는 로고와 설명 문구가 큼직하게 박혀 있는데, 그건 건물이 아니라
    인쇄물의 장식이다. 3D 로 세운 층 위에 로고가 누워 있으면 «건물» 이 아니라
    «인쇄물 사진» 으로 보인다.

    배경도 없앤다. 원본은 검은 판 위의 흰 선인데, 밝은 관제 화면에서는
    명도를 뒤집어 써 왔다. 뒤집는 대신 **선만 남기고 배경을 투명**으로
    만들면 층 슬래브의 색이 그대로 바닥이 되고, 벽과 색이 이어진다.
    """
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if g.mean() > 127:
        g = 255 - g
    h, w = g.shape

    # 로고·설명 문구 띠를 지운다
    g[: int(h * TEXT_BAND), :] = 0

    # 선의 진하기를 알파로 쓴다 — 가장자리가 부드럽게 남아 계단 현상이 준다
    alpha = cv2.normalize(g, None, 0, 255, cv2.NORM_MINMAX)
    _, mask = cv2.threshold(alpha, 60, 255, cv2.THRESH_BINARY)
    alpha = cv2.bitwise_and(alpha, mask)

    out = np.zeros((h, w, 4), np.uint8)
    out[:, :, 0] = 60      # B
    out[:, :, 1] = 48      # G
    out[:, :, 2] = 38      # R  → 짙은 남색 계열 선
    out[:, :, 3] = alpha
    return out


# 방으로 인정할 최소·최대 넓이 (전체 대비 비율)
ROOM_MIN_AREA = 0.0009
ROOM_MAX_AREA = 0.30
# 문틈을 메우는 정도. 벽 사이가 이만큼 벌어져 있어도 한 방으로 닫는다.
DOOR_CLOSE_PX = 5


def extract_rooms(img):
    """
    **빈 공간을 채워서** 방을 찾는다.

    선분을 이어 붙여 닫힌 다각형을 조립하는 방법도 있지만, 그건 선이 하나만
    끊겨도 방 둘이 하나로 새어 버린다. 실제 도면에는 문틈이 늘 있어서 거의
    반드시 샌다.

    그래서 반대로 한다 — 선을 벽으로 두고 **남은 빈 공간을 잇는다.** 벽으로
    둘러싸인 영역은 자기들끼리만 이어지므로, 이어진 덩어리 하나가 곧 방
    하나다. 문틈은 벽을 살짝 부풀려 미리 막는다.

    바깥 여백도 하나의 큰 덩어리로 잡히는데, 그건 넓이로 걸러 낸다.
    """
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if g.mean() > 127:
        g = 255 - g
    h, w = g.shape
    g[: int(h * TEXT_BAND), :] = 0          # 로고·문구는 벽이 아니다

    _, walls = cv2.threshold(g, 110, 255, cv2.THRESH_BINARY)
    # 문틈 메우기 — 안 막으면 방 둘이 복도를 통해 하나로 이어진다
    k = np.ones((DOOR_CLOSE_PX, DOOR_CLOSE_PX), np.uint8)
    walls = cv2.dilate(walls, k, iterations=1)

    free = cv2.bitwise_not(walls)
    n, labels, stats, cent = cv2.connectedComponentsWithStats(free, connectivity=4)

    total = h * w
    rooms = []
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < total * ROOM_MIN_AREA or area > total * ROOM_MAX_AREA:
            continue
        x, y, bw_, bh = (stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP],
                         stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])
        # 화면 가장자리에 붙은 덩어리는 바깥 여백이다
        if x <= 1 or y <= 1 or x + bw_ >= w - 1 or y + bh >= h - 1:
            continue
        mask = (labels == i).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        # 꼭짓점을 줄인다 — 화면에 그릴 때 점이 수백 개면 느리고, 방은 원래 각졌다
        approx = cv2.approxPolyDP(c, 2.5, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        rooms.append({
            "points": [[int(px), int(py)] for px, py in approx],
            "area": int(area),
            "cx": round(float(cent[i][0]), 1),
            "cy": round(float(cent[i][1]), 1),
        })
    rooms.sort(key=lambda r: -r["area"])
    return rooms


def extract_footprint(img, walls_list=None, rooms_list=None):
    """
    **건물의 외곽선**을 뽑는다.

    두 번 틀렸다. 기록해 둔다.

    1. «바깥에서 물 붓기» — 바깥 벽의 출입구로 물이 새어 들어가 건물 안쪽
       바닥까지 잘려 나갔다.
    2. «부풀렸다 같은 크기로 깎기» — 오목한 구석이 안쪽으로 끌려 들어가
       벽은 서 있는데 그 밑에 바닥이 없는 자리가 생겼다.

    그래서 지금은 **벽과 방을 직접 칠해서** 덩어리를 만든다. 벽 선을 굵게
    긋고 방 다각형을 채우면, 그 합집합이 곧 건물이다. 거기서 윤곽만 따면
    되므로 부풀렸다 깎을 일이 없다.

    마지막에 **검산한다** — 벽 끝점과 방 꼭짓점이 전부 윤곽 안에 있는지 센다.
    하나라도 밖에 있으면 그만큼 윤곽을 넓힌다. 눈으로 못 보고 넘어가는 일을
    막으려면 코드가 스스로 확인해야 한다.
    """
    h, w = img.shape[:2]
    span = max(h, w)
    mask = np.zeros((h, w), np.uint8)

    # 벽을 굵게 긋는다 — 굵기가 곧 «벽 두께» 이자 방 사이를 잇는 여유다
    thick = max(6, span // 90)
    for seg in (walls_list or []):
        cv2.line(mask, (int(seg["x1"]), int(seg["y1"])), (int(seg["x2"]), int(seg["y2"])),
                 255, thick)
    # 방을 채운다 — 벽만으로는 큰 방 한가운데가 비어 윤곽이 안으로 파인다
    for r in (rooms_list or []):
        cv2.fillPoly(mask, [np.array(r["points"], np.int32)], 255)

    if not mask.any():
        return None

    # 벽과 방 사이의 틈을 메운다.
    #
    # 처음에 span/55(=25px)로 잡았더니 **건물 한가운데가 뚫렸다.** 대각 외벽과
    # 안쪽 블록 사이에 벽도 방도 없는 넓은 구간이 있는데(로비·통로), 그 틈이
    # 25px 보다 훨씬 넓어서 윤곽이 거기로 파고들었다.
    #
    # 볼록 껍질로 감싸면 간단히 해결되지만, ㄱ자나 ㄷ자 건물에서는 실제로
    # 오목한 안뜰까지 «건물» 로 칠해 버린다. 그래서 껍질 대신 **틈만 메운다** —
    # 건물 안의 빈 구간보다 크고 건물 밖 여백보다 작은 크기로.
    close = max(10, span // 16)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((close, close), np.uint8))

    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    approx = cv2.approxPolyDP(c, span * 0.003, True).reshape(-1, 2)
    foot = [[int(x), int(y)] for x, y in approx]

    # ── 검산: 벽 끝점과 방 꼭짓점이 다 안에 있나 ──────────────────
    poly = np.array(foot, np.int32)
    pts = []
    for seg in (walls_list or []):
        pts += [(seg["x1"], seg["y1"]), (seg["x2"], seg["y2"])]
    for r in (rooms_list or []):
        pts += [tuple(pt) for pt in r["points"]]
    def count_outside(polygon):
        pg = np.array(polygon, np.int32)
        return sum(1 for x, y in pts
                   if cv2.pointPolygonTest(pg, (float(x), float(y)), False) < 0)

    # **0이 될 때까지 넓힌다.** 한 번 넓히고 마니 4개가 밖에 남았는데, 그
    # 4개가 바로 «벽은 서 있는데 밑에 바닥이 없는» 자리다. 한 점이라도
    # 밖에 있으면 화면에서 그게 보인다.
    outside = count_outside(foot)
    for _ in range(6):
        if outside == 0:
            break
        mask = cv2.dilate(mask, np.ones((close, close), np.uint8), iterations=1)
        cnts2, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not cnts2:
            break
        c2 = max(cnts2, key=cv2.contourArea)
        approx = cv2.approxPolyDP(c2, span * 0.003, True).reshape(-1, 2)
        foot = [[int(x), int(y)] for x, y in approx]
        outside = count_outside(foot)

    print(f"  외곽선 검산: 밖에 놓인 점 {outside}/{len(pts)}개")
    return foot


# 걸을 수 있는 칸 지도의 해상도. 도면 폭을 이 수로 나눈다.
# 너무 촘촘하면 파일이 커지고, 너무 성기면 문틈이 막힌다.
GRID_W = 220


def annotated_corridor(path, w, h):
    """
    **사람이 손으로 표시한 복도**를 읽는다.

    도면에서 복도를 알아내는 일을 세 번 고쳤는데도 완전하지 않았다 — 벽 사이
    빈 공간은 바깥 틈까지 복도로 잡고, 인쇄된 초록 화살표는 점선이라 끊긴다.
    그 사이 «창밖으로 도는 길» 이 나왔다.

    건물을 아는 사람이 그 위에 초록으로 그어 주면 그게 정답이다. 추론할 이유가
    없다. 복도선과 **각 방의 문 자국**까지 한 번에 들어온다 — 문은 도면에
    안 그려져 있어서 따로 알 방법이 없던 것이다.

    이건 «하드코딩» 이지만 좌표를 손으로 적는 것과는 다르다. 사람이 그림
    위에 그은 것을 그대로 읽으므로, 도면이 바뀌면 다시 그어서 넣으면 된다.
    """
    img = cv2.imread(str(path))
    if img is None:
        return None
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    # 손으로 그은 초록은 인쇄된 것보다 밝고 진하다
    green = cv2.inRange(hsv, (40, 120, 120), (90, 255, 255))
    # 선이 얇으므로 사람이 지나는 폭만큼 부풀린다
    # 넉넉히 부풀린다. 얇게 두면 격자로 줄일 때 **문 자국이 본선에서 떨어지고**,
    # 떨어진 조각은 «이어지지 않았다» 며 버려진다 — 그러면 그 방은 길이 없다.
    green = cv2.dilate(green, np.ones((21, 21), np.uint8), iterations=1)
    green = cv2.morphologyEx(green, cv2.MORPH_CLOSE, np.ones((41, 41), np.uint8))
    green = cv2.resize(green, (w, h), interpolation=cv2.INTER_NEAREST)
    return bridge_gaps(green, max(w, h) * 0.09)


def bridge_gaps(mask, limit):
    """
    끊긴 덩어리를 **가장 가까운 곳끼리 이어 준다.**

    사람이 손으로 그으면 펜이 안 닿아 몇십 픽셀씩 벌어진다. 눈으로는 이어진
    길인데 컴퓨터에는 남남이고, 그 상태로 길찾기를 하면 «저쪽으로는 못 간다»
    가 된다. 실제로 이 도면에서 세 덩이로 끊겨 최대 덩어리가 64% 였다.

    멀리 떨어진 것은 안 잇는다 — 그건 정말 다른 길이다.
    """
    for _ in range(8):
        n, lab, st, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if n <= 2:
            break
        order = sorted(range(1, n), key=lambda i: -st[i, cv2.CC_STAT_AREA])
        main = order[0]
        joined = False
        for other in order[1:]:
            ay, ax = np.where(lab == main)
            by, bx = np.where(lab == other)
            A = np.stack([ax[::9], ay[::9]], 1)
            B = np.stack([bx[::9], by[::9]], 1)
            best, pa, pb = 1e9, None, None
            for q in B:
                dd = np.hypot(A[:, 0] - q[0], A[:, 1] - q[1])
                j = int(dd.argmin())
                if dd[j] < best:
                    best, pa, pb = dd[j], A[j], q
            if best <= limit:
                cv2.line(mask, tuple(int(v) for v in pa), tuple(int(v) for v in pb), 255, 9)
                print(f"  손 표시가 {best:.0f}px 끊겨 있어 이어 붙였습니다")
                joined = True
                break
        if not joined:
            break
    return mask


def walkable_grid(img, foot, rooms=None, annotated=None):
    """
    **걸을 수 있는 칸** 지도를 만든다.

    경로가 벽을 뚫는 문제의 뿌리는, 두 지점을 잇는 선을 **곧게(또는 ㄱ자로)**
    긋고 있다는 데 있다. 실제로 사람은 복도를 따라 돈다. 꺾어 그리기는 ㄱ자
    두 가지를 시도할 뿐이라 둘 다 막히면 방법이 없다 — 45개 중 9개만 나아졌다.

    그래서 «어디를 밟을 수 있나» 를 먼저 정한다:

        건물 안(외곽선 내부)  이고
        벽 위가 아니면        걸을 수 있다

    문은 벽 선화에 난 **틈**이라 자연히 통과된다. 방 안도 걸을 수 있다 —
    방에서 복도로 나오는 것이 대피의 첫 걸음이니 막으면 안 된다.

    이 격자 위에서 길을 찾으면 «복도를 따라 돌아 나가는» 경로가 나온다.
    NORTH STREET·SOUTH STREET 같은 복도가 곧 빈 칸의 띠이기 때문에,
    글자를 읽지 않아도 길이 거기로 흐른다.
    """
    h, w = img.shape[:2]
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if g.mean() > 127:
        g = 255 - g
    g[: int(h * TEXT_BAND), :] = 0

    _, walls = cv2.threshold(g, 110, 255, cv2.THRESH_BINARY)
    walls, _ = drop_glyphs(walls)
    # 벽을 조금 두껍게 본다. 얇게 두면 격자를 성기게 줄일 때 벽에 구멍이 뚫려
    # 길이 그리로 새고, 그게 바로 «벽을 뚫는 경로» 다.
    walls = cv2.dilate(walls, np.ones((3, 3), np.uint8), iterations=1)

    inside = np.zeros((h, w), np.uint8)
    if foot:
        cv2.fillPoly(inside, [np.array(foot, np.int32)], 255)
    else:
        inside[:] = 255

    free = cv2.bitwise_and(inside, cv2.bitwise_not(walls))

    gw = GRID_W
    gh = max(1, round(gw * h / w))
    # 칸 하나라도 벽이 걸치면 막힌 것으로 본다(최솟값 축소). 반대로 하면
    # 벽이 사라져 길이 벽을 통과한다 — 안전한 쪽으로 틀린다.
    small = cv2.resize(free, (gw, gh), interpolation=cv2.INTER_AREA)
    grid = (small > 128).astype(np.uint8)

    # 문이 너무 좁아 막혀 버린 곳을 되살린다: 원본에서 열려 있던 칸 중
    # 이웃이 열려 있으면 열어 준다.
    # **복도만 따로 낸다.**
    #
    # 이 도면에는 문이 안 그려져 있다 — 방이 완전히 닫힌 사각형이다. 그래서
    # 격자를 아무리 촘촘히 해도 방에서 복도로 나갈 틈이 없고, 길찾기가
    # 45개 중 35개에서 실패했다.
    #
    # 현실은 이렇다: 방에서 **문으로 한 번 나가고**, 그 뒤로는 복도를 따라간다.
    # 그 «한 번 나가는» 것을 길찾기가 못 하니, 복도 격자를 따로 주어
    # 「방 → 가장 가까운 복도」 만 직선으로 잇고 나머지를 복도로 풀게 한다.
    inroom = np.zeros((h, w), np.uint8)
    for r in (rooms or []):
        cv2.fillPoly(inroom, [np.array(r["points"], np.int32)], 255)
    gaps = cv2.bitwise_and(free, cv2.bitwise_not(inroom))

    # **도면에 그려진 대피 경로를 그대로 쓴다.**
    #
    # 이 도면에는 초록 점선 화살표로 «이리로 나가세요» 가 이미 그려져 있다.
    # 벽 사이 빈 공간에서 복도를 추론하는 것보다, 그림이 말하는 길을 읽는
    # 편이 정확하다 — 추론은 틀릴 수 있지만 이건 건물이 정한 답이다.
    #
    # 다만 점선이라 조각조각 끊겨 있고(글자·아이콘이 가로지른다), 그것만으로는
    # 이어지지 않는다. 그래서 **둘을 합친다** — 초록이 길을 정하고, 빈 공간이
    # 끊긴 데를 메운다. 합치니 99% 가 하나로 이어졌다(초록만 38%, 빈 공간만 85%).
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    green = cv2.inRange(hsv, (35, 60, 60), (90, 255, 255))
    # 초록 선은 얇다. 격자 한 칸이 도면 6px 쯤이라, 얇은 채로 줄이면 «그린 길»
    # 표시가 복도의 18% 밖에 안 남았고 그러면 길찾기가 그 표시를 무시한다.
    # 복도 폭만큼 부풀려 둔다 — 어차피 사람이 걷는 폭이 그만큼이다.
    marked = cv2.dilate(
        cv2.morphologyEx(green, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8)),
        np.ones((29, 29), np.uint8), iterations=1)
    # **초록을 부풀려도 벽은 절대 안 연다.**
    #
    # 부풀린 두께가 방과 벽을 덮어서 복도가 방 안으로 번졌고, 길찾기가 그리로
    # 질러가 벽 통과가 10개에서 31개로 늘었다. 초록은 «어디를 선호할까» 를
    # 정하는 값이지 «어디를 뚫어도 되나» 가 아니다.
    corr = cv2.bitwise_and(cv2.bitwise_or(gaps, cv2.bitwise_and(marked, free)), inside)

    # 사람이 그어 준 것이 있으면 **그것만 쓴다.** 추론과 섞으면 추론이 만든
    # 샛길이 남아서, 애써 그어 준 뜻이 흐려진다.
    # 사람이 그어 준 것이 있으면 **그것을 «가야 할 길» 로** 삼는다.
    #
    # 처음에는 그것만 복도로 썼는데, 손으로 그은 선은 격자로 줄이면 조각조각
    # 끊긴다(7조각, 최대 64%). 끊기면 길찾기가 통째로 실패한다.
    #
    # 그래서 **연결은 빈 공간이 맡고, 선호는 손 표시가 정한다.** 빈 공간은
    # 이어져 있고(100%), 손 표시 위는 여섯 배 싸므로 길이 그리로 붙는다.
    # 문 자국도 손 표시라, 방에서 나오는 길이 저절로 문으로 간다.
    # 사람이 그어 준 것이 있으면 **그것만 복도다.**
    #
    # 빈 공간을 섞으면 «지나갈 수 있는 곳» 이 건물 절반이 되고, 길찾기가 그
    # 사이로 새서 애써 그어 준 뜻이 사라진다. 끊긴 자리는 위에서 이어 붙였다.
    hand = annotated_corridor(annotated, w, h) if annotated else None
    if hand is not None:
        # **손 표시와 인쇄된 초록 화살표를 함께 쓴다.**
        #
        # 손으로 그을 때 빠뜨리는 구간이 생긴다(THE PLAZA 쪽이 그랬다). 그런데
        # 거기에도 도면이 인쇄해 둔 초록 화살표는 있다 — 둘 다 «도면이 말하는
        # 길» 이므로 합치는 것이 맞다. 손 표시가 더 정확하니 문·복도는 그쪽이
        # 채우고, 빠뜨린 구간은 인쇄가 메운다.
        both = cv2.bitwise_or(hand, cv2.bitwise_and(marked, free))
        corr = bridge_gaps(cv2.bitwise_and(both, inside), max(w, h) * 0.09)
        print("  복도: 사람이 표시한 길 + 도면에 인쇄된 대피 화살표")

    # 문턱을 낮게 잡는다(칸의 절반만 열려도 열린 것으로 본다). 높게 잡으면
    # 좁은 목이 막혀 복도가 조각나고, 그러면 길찾기가 통째로 실패한다.
    csmall = cv2.resize(corr, (gw, gh), interpolation=cv2.INTER_AREA)
    cgrid = (csmall > 128).astype(np.uint8)

    # **도면이 그린 길을 따로 표시한다.**
    #
    # 복도를 «벽도 방도 아닌 곳» 으로만 정의했더니, 바깥 벽과 방 사이의 얇은
    # 틈까지 복도가 됐다. 길찾기는 그게 지름길이면 거기로 간다 — 화면에서는
    # **건물 바깥으로 돌아 나가는** 길이 됐다. 창문으로 나가는 셈이다.
    #
    # 그래서 초록 화살표가 지나는 칸을 따로 표시해 두고, 길찾기가 그 위를
    # 훨씬 싸게 지나가게 한다. 그러면 SOUTH STREET 를 두고 옆 틈으로 새지
    # 않는다. 틈도 막지는 않는다 — 초록이 안 그려진 구간은 거기로 가야 한다.
    msmall = cv2.resize(cv2.bitwise_and(marked, inside), (gw, gh),
                        interpolation=cv2.INTER_AREA)
    # 표시는 문턱을 낮게 — 칸에 조금이라도 걸치면 «그린 길» 로 본다.
    # 복도 판정(cgrid)과 달리 여기서는 넉넉한 쪽이 안전하다.
    if hand is not None:
        hsmall = cv2.resize(hand, (gw, gh), interpolation=cv2.INTER_AREA)
        mgrid = ((hsmall > 40) & (cgrid > 0)).astype(np.uint8)
    else:
        mgrid = ((msmall > 40) & (cgrid > 0)).astype(np.uint8)

    opened = int(grid.sum())

    # **이어지지 않은 조각은 버린다.**
    #
    # 떨어진 조각에 지점이 걸리면 길찾기가 «출발점에서 아무 데도 못 간다» 로
    # 끝난다. 조각을 남겨 두면 그 지점만 조용히 안내가 안 되는데, 어느 지점이
    # 그런지는 걸어봐야 안다. 차라리 버리고 가장 가까운 **이어진** 복도로
    # 나가게 하는 편이 낫다.
    n0, lab0, st0, _ = cv2.connectedComponentsWithStats(cgrid * 255, connectivity=8)
    # 사람이 그은 것은 함부로 버리지 않는다 — 문 자국 하나가 그 방의 유일한
    # 길이라, 떨어져 보인다고 지우면 그 방이 통째로 고립된다.
    if n0 > 1:
        biggest = 1 + int(np.argmax(st0[1:, cv2.CC_STAT_AREA]))
        dropped = int((cgrid.sum()) - st0[biggest, cv2.CC_STAT_AREA])
        cgrid = (lab0 == biggest).astype(np.uint8)
        mgrid = (mgrid & cgrid).astype(np.uint8)
        if dropped:
            print(f"  이어지지 않은 복도 조각 {n0-2}개({dropped}칸)를 버렸습니다")

    n, _, st, _ = cv2.connectedComponentsWithStats(cgrid * 255, connectivity=8)
    parts = sorted(st[1:, cv2.CC_STAT_AREA], reverse=True) or [0]
    linked = parts[0] / max(1, sum(parts)) * 100
    print(f"  걸을 수 있는 칸 {opened}/{gw*gh} ({opened/(gw*gh)*100:.0f}%)"
          f" · 복도 {int(cgrid.sum())} · 격자 {gw}×{gh}")
    print(f"  복도 이어짐: 조각 {n-1}개 중 제일 큰 것이 {linked:.0f}%"
          + ("" if linked > 95 else "  ⚠ 조각나 있으면 길찾기가 실패합니다"))
    return {
        "w": gw, "h": gh,
        "cells": "".join(str(v) for v in grid.flatten()),
        "corridor": "".join(str(v) for v in cgrid.flatten()),
        "marked": "".join(str(v) for v in mgrid.flatten()),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--api", default="http://127.0.0.1:8080")
    ap.add_argument("--out", default=None)
    ap.add_argument("--preview", default=None, help="검출 결과를 그려서 저장할 경로")
    ap.add_argument("--annotated", default=None,
                    help="사람이 초록으로 복도를 그어 둔 이미지 (있으면 그것을 복도로 쓴다)")
    ap.add_argument("--floor", default=None,
                    help="글씨·배경을 지운 바닥 도면 PNG 저장 경로")
    args = ap.parse_args()

    img = fetch_image(args.api, args.plan)
    walls = extract(img)
    rooms = extract_rooms(img)
    foot = extract_footprint(img, walls, rooms)
    grid = walkable_grid(img, foot, rooms, args.annotated)
    h, w = img.shape[:2]
    print(f"  도면 {w}×{h} · 벽 {len(walls)}개 · 방 {len(rooms)}개"
          + (f" · 외곽선 {len(foot)}점" if foot else " · 외곽선 못 찾음"))

    out = pathlib.Path(args.out or f"backend/data/walls-{args.plan}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"width": w, "height": h,
                               "walls": walls, "rooms": rooms,
                               "footprint": foot, "grid": grid}, indent=1))
    print(f"  저장: {out}")

    floor_path = pathlib.Path(args.floor or f"backend/data/floor-{args.plan}.png")
    floor_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(floor_path), clean_floor(img))
    print(f"  바닥 도면: {floor_path}  (글씨·배경 제거, 투명 배경)")

    if args.preview:
        # 뽑은 벽만 따로 그려 본다. 눈으로 봐야 «이게 벽이 맞나» 를 판단할 수 있다.
        canvas = np.zeros((h, w, 3), np.uint8)
        if foot:
            cv2.fillPoly(canvas, [np.array(foot, np.int32)], (32, 32, 32))
            cv2.polylines(canvas, [np.array(foot, np.int32)], True, (80, 120, 255), 3)
        for r in rooms:
            pts = np.array(r["points"], np.int32)
            cv2.fillPoly(canvas, [pts], (60, 45, 30))
            cv2.polylines(canvas, [pts], True, (140, 200, 120), 1)
        for s in walls:
            cv2.line(canvas, (int(s["x1"]), int(s["y1"])), (int(s["x2"]), int(s["y2"])),
                     (90, 210, 255), 2)
        cv2.imwrite(args.preview, canvas)
        print(f"  미리보기: {args.preview}")


if __name__ == "__main__":
    main()
