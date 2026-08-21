"""
층별 도면을 관제 배경으로 만든다.

## 왜 필요한가

6층이 화면에서 좋아 보이는 이유는 벽을 잘 세워서가 아니라 **도면이 배경으로
깔려 있어서**다. 책상·문·방 이름이 도면에 다 있으니, 우리가 그린 것은 그
위에 얹는 주석이면 충분하다. 배경이 없으면 벽을 150장 세워도 «회색 칸이
늘어선 판» 이 된다.

## 층마다 도면이 다르다

    1층        50,400 × 33,600mm  — 로비·원형 계단식강의실(240㎡)·기계실
    2·3·4·7층  75,600 × 33,600mm  — 기준층. 가운데가 하부 오픈
    5층        75,600 × 33,600mm  — 기준층 + 스터디 아룸파(120㎡)와 중앙 다리
    6층        COCONE 실측 도면 — 손대지 않는다
    옥탑       도면 없음

**1층은 폭이 다르다.** 50,400mm 라 기준층의 2/3 이고, 서쪽이 지반에 묻혀
있어 동쪽 절반만 쓴다. 같은 배경을 쓰면 방 위치가 통째로 어긋난다.

## 자르는 기준

치수선·통심선·아래쪽 이름표 띠는 도면이 아니라 **주석**이다. 관제 배경에
들어가면 건물 밖에 글씨가 떠다닌다. 굵은 선(외벽)의 범위를 재서 본체만
남긴다.
"""

import cv2
import numpy as np

PPM = 20  # 1m 를 몇 px 로 그릴 것인가

# (원본, 자를 범위 x0,y0,x1,y1, 실측 폭 m, 실측 깊이 m, 대상 층들)
SHEETS = [
    # 자를 범위는 «굵은 선(외벽)» 이 있는 곳에서 조금 넉넉히 잡는다.
    # 치수선·통심선·아래쪽 이름표 띠는 도면이 아니라 주석이라 뺀다.
    ('backend/data/annotated/ai-1f-src.png', (236, 352, 1500, 782), 50.4, 33.6, ['1f']),
    ('backend/data/annotated/ai-typical-src.png', (280, 180, 1560, 790), 75.6, 33.6,
     ['2f', '3f', '4f', '7f']),
    ('backend/data/annotated/ai-5f-src.png', (285, 189, 1465, 763), 75.6, 33.6, ['5f']),
]


def build(src, box, mw, mh, floors):
    im = cv2.imread(src)
    if im is None:
        raise SystemExit(f'못 읽음: {src}')
    x0, y0, x1, y1 = box
    crop = im[y0:y1, x0:x1]

    w, h = round(mw * PPM), round(mh * PPM)
    resized = cv2.resize(crop, (w, h), interpolation=cv2.INTER_AREA)

    # 흰 종이에 검은 선으로 둔다 — 화면 CSS 가 명도를 뒤집어 어두운 판에 얹는다.
    # 옅은 회색 잡티는 걷어낸다. 남겨 두면 뒤집었을 때 흐린 얼룩이 된다.
    g = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    g = np.where(g > 205, 255, g).astype(np.uint8)
    out = cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)

    for f in floors:
        cv2.imwrite(f'backend/data/floor-ai-{f}.png', out,
                    [cv2.IMWRITE_PNG_COMPRESSION, 6])
    print(f'  {",".join(floors):18s} {w}x{h}  ({mw}m × {mh}m)')


def main():
    for src, box, mw, mh, floors in SHEETS:
        build(src, box, mw, mh, floors)
    # 옥탑은 도면이 없다. 기준층 배경을 쓰면 «없는 방이 있다» 고 말하게 되므로
    # 빈 판으로 둔다 — 계단과 기계실만 지점으로 찍혀 있다.
    blank = np.full((round(33.6 * PPM), round(75.6 * PPM), 3), 255, np.uint8)
    cv2.imwrite('backend/data/floor-ai-ph.png', blank)
    print('  ph                 도면 없음 — 빈 판')


if __name__ == '__main__':
    main()
