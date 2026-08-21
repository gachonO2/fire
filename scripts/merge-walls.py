"""
추출한 벽과 지어 놓은 방을 합친다.

## 왜 나눠서 쓰나

기준층 도면에 `extract-walls.py` 를 돌리면 **벽은 정확하다** — 150개가
도면 선을 그대로 따라간다. 그런데 **방은 9개밖에 못 찾는다.** 실제로는
32개인데.

이유는 CAD 도면의 성질이다. 방 검출은 «벽으로 둘러싸인 빈 칸» 을 찾는데,
이 도면은 방 안에 **책상과 의자가 잔뜩 그려져 있어서** 그 빈 칸이 잘게
쪼개진다. 6층 안내도는 방이 비어 있어서 잘 됐던 것이다.

그러면 방을 억지로 짜내는 대신, **더 나은 출처가 있는 쪽을 쓰면 된다.**

    벽·외곽선·격자   추출본 — 도면 선을 직접 따라가므로 배경과 딱 맞는다
    방              생성본 — 이름(`5.14 강의실`)과 면적(84㎡)이 도면 표에서 왔다

방 이름은 추출로는 절대 못 얻는다(글씨를 지우는 것이 파이프라인의 일이다).
반대로 벽은 생성으로 대충 그리면 배경과 어긋난다. 각자 잘하는 것을 쓴다.

## 복도는 추출본을 쓴다

추출본 격자는 도면의 실제 빈 공간에서 나온 것이라 «걸을 수 있는 칸» 이
훨씬 정확하다(복도 9189칸, 100% 이어짐). 생성본은 통로 선 주변에 띠를
칠한 것이라 실제 벽을 모른다.
"""

import json
import pathlib
import sys

FLOORS = ['1f', '2f', '3f', '4f', '5f', '7f', 'ph']


def main():
    src = pathlib.Path('backend/data')
    for f in FLOORS:
        wall_path = src / f'walls-ai-{f}.json'
        gen_path = src / f'gen-rooms-ai-{f}.json'
        if not wall_path.exists() or not gen_path.exists():
            print(f'  ai-{f} 건너뜀 (파일 없음)')
            continue
        walls = json.loads(wall_path.read_text())
        gen = json.loads(gen_path.read_text())

        before = len(walls.get('rooms', []))
        walls['rooms'] = gen['rooms']
        walls['corridors'] = gen.get('corridors', [])
        wall_path.write_text(json.dumps(walls))
        print(f'  ai-{f}  벽 {len(walls["walls"])} · 방 {before} → {len(gen["rooms"])}'
              f' · 복도면 {len(walls["corridors"])}'
              f' · 걸을수있는칸 {walls["grid"]["cells"].count("1")}')


if __name__ == '__main__':
    sys.exit(main())
