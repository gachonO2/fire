"""
기준층 도면 사진을 관제 배경으로 만든다.

## 왜 필요한가

6층이 화면에서 좋아 보이는 이유는 벽을 잘 세워서가 아니라 **도면 사진이
배경으로 깔려 있어서**다. 책상·문·방 이름이 사진에 다 있으니, 우리가 그린
것은 그 위에 얹는 주석이면 충분하다.

생성한 기준층에는 그 사진이 없어서, 벽 108장을 세워도 «회색 칸이 늘어선
판» 으로 보였다. 없으면 깔아야 한다.

## 6층과 다른 점 — 사진이 아니라 CAD 다

6층은 벽에 붙은 피난안내도를 폰으로 찍은 것이라 기울고 번져 있어서,
`extract-walls.py` 가 반듯하게 펴고 글씨를 지우는 일을 한다.

기준층은 건축 CAD 라 이미 반듯하고 선이 또렷하다. 할 일은 둘뿐이다 —
**본체만 잘라내고**(치수선·범례는 도면이 아니라 주석이다), **도면 좌표에
맞춰 늘린다.**

## 정렬

남쪽 외벽과 동쪽 외벽을 기준으로 맞춘다. 이 둘은 직선이라 재기 쉽고,
생성기(`make-standard-floors.mjs`)의 외곽선도 같은 두 벽에서 시작한다.
북쪽 대각선은 도면과 생성 기하가 조금 어긋나는데, 배경이 진실이고 우리가
그린 지점은 그 위의 표식이라 그 정도는 읽는 데 지장이 없다.

각 층 실사진을 찍어 올리면 판독기가 이 자리를 대신한다.
"""

import cv2
import numpy as np

SRC = 'backend/data/annotated/ai-standard.png'
# 도면 본체 — 치수선과 아래쪽 방 이름표 띠를 뺀 사각형
BODY = (285, 189, 1180, 574)
# 그 안에서 건물이 차지하는 범위 (위 여백 5px, 남쪽 외벽 570, 동쪽 외벽 1176)
BUILDING = (0, 5, 1176, 570)
# 생성기의 외곽선 bbox — `make-standard-floors.mjs` 의 FOOT 와 같은 값이라야 한다
TARGET = (80, 24, 1512, 672)
OUT_W, OUT_H = 1512, 672
FLOORS = ['1f', '2f', '3f', '4f', '5f', '7f', 'ph']


def main():
    full = cv2.imread(SRC)
    if full is None:
        raise SystemExit(f'못 읽음: {SRC}')
    bx, by, bw, bh = BODY
    body = full[by:by + bh, bx:bx + bw]

    sx0, sy0, sx1, sy1 = BUILDING
    tx0, ty0, tx1, ty1 = TARGET
    piece = body[sy0:sy1, sx0:sx1]
    resized = cv2.resize(piece, (tx1 - tx0, ty1 - ty0), interpolation=cv2.INTER_AREA)

    canvas = np.full((OUT_H, OUT_W, 3), 255, np.uint8)
    canvas[ty0:ty1, tx0:tx1] = resized

    # 흰 종이에 검은 선으로 둔다 — 화면 CSS 가 명도를 뒤집어 어두운 판에 얹는다.
    # 옅은 회색 잡티는 걷어낸다. 남겨 두면 뒤집었을 때 흐린 얼룩이 된다.
    g = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
    g = np.where(g > 205, 255, g).astype(np.uint8)
    out = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)

    for f in FLOORS:
        cv2.imwrite(f'backend/data/floor-ai-{f}.png', out,
                    [cv2.IMWRITE_PNG_COMPRESSION, 6])
    print(f'  기준층 배경 {len(FLOORS)}개 · {OUT_W}x{OUT_H}')


if __name__ == '__main__':
    main()
