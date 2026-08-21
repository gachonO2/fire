#!/usr/bin/env python3
"""
걷는 동안의 신호 변화를 시계열로 남긴다 — **지도를 그리려면 이게 있어야 한다.**

## 왜 따로 필요한가

`scan-beacons.py` 는 "무엇이 있나"를 답한다. 각 기기의 총 수신 횟수와 신호 범위는
알지만 **언제 얼마였는지**는 안 남긴다. 그런데 지도를 그리려면 그 시간축이 필요하다.

    A 가 셀 때 B 가 약했다  →  A 와 B 는 떨어져 있다
    A 와 C 가 늘 함께 셌다   →  A 와 C 는 붙어 있다

이 관계를 모으면 **비콘끼리의 상대 배치**가 나온다. 좌표는 모르지만 "무엇이 무엇
옆에 있나"는 나온다. 거기에 걸음 수까지 있으면 거리까지 붙는다.

## 쓰는 법

    (scan-beacons.py serve 가 돌고 있는 상태에서)
    .venv/bin/python scripts/log-walk.py

걷기 시작할 때 켜고, 다 돌면 Ctrl-C. `walk-log.jsonl` 로 남는다.
"""
import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8765/api/state"
OUT = "walk-log.jsonl"
PERIOD = 1.0

print(f"""
걸음 기록 시작 — {PERIOD}초마다 신호를 남깁니다.

  지금 걷기 시작하세요. 다 돌면 Ctrl-C.
  파일: {OUT}
""", flush=True)

n = 0
t0 = time.time()
try:
    with open(OUT, "w") as f:
        while True:
            try:
                with urllib.request.urlopen(URL, timeout=3) as r:
                    d = json.loads(r.read())
            except Exception as e:
                print(f"  스캐너에 못 닿습니다 ({e}) — serve 가 돌고 있나요?", flush=True)
                time.sleep(2)
                continue

            row = {
                "t": round(time.time() - t0, 1),
                "tag": d.get("tag"),
                # 라벨은 사람이 읽기 위한 것, 판정은 라벨로 한다(맥에서는 이게 유일한 키)
                "seen": {b["label"]: b["rssi"] for b in d["live"]},
            }
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            f.flush()
            n += 1
            if n % 10 == 0:
                el = int(time.time() - t0)
                print(f"  [{el//60:02d}:{el%60:02d}] {len(row['seen'])}개 보임"
                      + (f" · 「{row['tag']}」 기록 중" if row["tag"] else ""), flush=True)
            time.sleep(PERIOD)
except KeyboardInterrupt:
    pass

print(f"\n{n}개 표본 저장: {OUT}")
print("이제 지도를 그릴 수 있습니다.")
