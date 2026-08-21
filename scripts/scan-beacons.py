#!/usr/bin/env python3
"""
BLE 비콘 답사·보정 도구 (맥북용).

## 왜 맥북인가

아이폰으로는 **모르는 비콘을 찾을 수 없다.** iOS 의 CoreBluetooth 는 iBeacon 광고를
걸러내 앱에 주지 않고, CoreLocation 으로 받으려면 **UUID 를 미리 알아야** 한다.
지금 알아내려는 게 그 UUID 라서 닭과 달걀이 된다.

macOS 의 CoreBluetooth 에는 그 제한이 없다. 제조사 데이터를 그대로 준다.
그래서 **처음 보는 비콘을 찾는 일은 맥북이 아이폰보다 낫다.**
(안드로이드도 되지만, 맥북은 기록을 파일로 남길 수 있다는 이점이 있다.)

## 세 가지 일을 한다 — 이 순서로 쓴다

  discover   한 바퀴 돌며 **뭐가 있는지** 훑는다. 비콘이 있긴 한가부터 답한다
  survey     지점마다 서서 태그 → `beaconId → nodeId` 매핑 초안
  calibrate  한 비콘을 거리별로 측정 → txPower·경로손실 지수

`discover` 가 먼저인 이유: 건물에 비콘이 없으면 나머지는 할 일이 없다.
그리고 잡히는 것 대부분은 **지나가는 사람들의 폰**이라, 그 중에서 진짜 비콘을
골라내는 일이 먼저다.

둘 다 지금은 **가정값**으로 박혀 있다(`shared/beacon-sim.js` 의 `SIM_DEFAULTS`).
실측으로 바꿔야 "비콘 몇 개 필요한가"라는 답을 믿을 수 있다.

## 쓰는 법

    python3 -m venv .venv && .venv/bin/pip install bleak
    .venv/bin/python scripts/scan-beacons.py survey
    .venv/bin/python scripts/scan-beacons.py calibrate --target <이름 또는 주소 일부>

macOS 는 터미널에 블루투스 권한을 따로 요구한다.
거부되면 시스템 설정 → 개인정보 보호 및 보안 → Bluetooth 에서 켠다.
"""

import argparse
import asyncio
import json
import urllib.error
import urllib.request
import statistics
import sys
import threading
import time
from collections import defaultdict

try:
    from bleak import BleakScanner
except ImportError:
    sys.exit("bleak 이 없습니다.  python3 -m venv .venv && .venv/bin/pip install bleak")

APPLE_ID = 0x004C          # iBeacon 은 애플 제조사 데이터 안에 들어 있다
EDDYSTONE_UUID = "0000feaa-0000-1000-8000-00805f9b34fb"

# 지점마다 이만큼 모은다. 짧으면 노이즈에 휘둘리고, 길면 답사가 지겨워진다.
TAG_SECONDS = 5.0


def decode(dev, adv):
    """광고에서 우리가 쓸 id 와 종류를 뽑는다."""
    md = adv.manufacturer_data or {}

    # iBeacon: 애플 제조사 데이터, 타입 0x02, 길이 0x15
    raw = md.get(APPLE_ID)
    if raw and len(raw) >= 23 and raw[0] == 0x02 and raw[1] == 0x15:
        uuid = raw[2:18].hex()
        major = int.from_bytes(raw[18:20], "big")
        minor = int.from_bytes(raw[20:22], "big")
        tx = int.from_bytes(raw[22:23], "big", signed=True)
        pretty = f"{uuid[:8]}…:{major}:{minor}"
        return {"kind": "iBeacon", "id": f"ibeacon:{uuid}:{major}:{minor}",
                "label": pretty, "txPower": tx}

    sd = adv.service_data or {}
    if EDDYSTONE_UUID in sd:
        payload = sd[EDDYSTONE_UUID]
        return {"kind": "Eddystone", "id": f"eddystone:{payload.hex()[:20]}",
                "label": payload.hex()[:16], "txPower": None}

    # 나머지 — 이름이나 주소로 구분한다. 우리 시스템은 id 만 고유하면 된다.
    name = (adv.local_name or dev.name or "").strip()
    return {"kind": "BLE", "id": f"ble:{dev.address}",
            "label": name or dev.address[-8:], "txPower": None}


class Collector:
    """스캔 결과를 지점별로 모은다."""

    def __init__(self):
        self.tag = None                       # 지금 태그 중인 지점 이름
        self.tag_until = 0                    # 웹 화면에서 누른 태그의 만료 시각
        self.rows = defaultdict(list)         # (지점, 비콘id) -> [rssi]
        self.meta = {}                        # 비콘id -> {kind, label, txPower}
        self.live = {}                        # 비콘id -> (rssi, 마지막 수신 시각)
        self.seen = {}                        # 비콘id -> {first, last, n, rssis, buckets} (전체 이력)
        self.t0 = time.time()                 # 체류율 계산의 기준 시각

    def on_adv(self, dev, adv):
        info = decode(dev, adv)
        bid = info["id"]
        self.meta.setdefault(bid, info)
        now = time.time()
        self.live[bid] = (adv.rssi, now)

        s = self.seen.get(bid)
        if s is None:
            self.seen[bid] = {"first": now, "last": now, "n": 1, "rssis": [adv.rssi],
                              "buckets": {int((now - self.t0) // PRESENCE_BUCKET_S)}}
        else:
            s["last"] = now
            s["buckets"].add(int((now - self.t0) // PRESENCE_BUCKET_S))
            s["n"] += 1
            s["rssis"].append(adv.rssi)

        if self.tag and self.tag_until and now > self.tag_until:
            self.tag = None                   # 시간이 다 된 태그는 스스로 닫는다
            self.tag_until = 0
        if self.tag:
            self.rows[(self.tag, bid)].append(adv.rssi)

    def visible(self, within=3.0):
        """최근 몇 초 안에 잡힌 것만 — 지나간 기기가 목록에 쌓이지 않게"""
        now = time.time()
        out = [(bid, r) for bid, (r, t) in self.live.items() if now - t <= within]
        return sorted(out, key=lambda x: -x[1])

    def summary(self):
        """지점별로 어떤 비콘이 얼마나 세게 잡혔나"""
        by_spot = defaultdict(list)
        for (spot, bid), rs in self.rows.items():
            if len(rs) < 3:
                continue
            by_spot[spot].append({
                "beaconId": bid,
                "label": self.meta[bid]["label"],
                "kind": self.meta[bid]["kind"],
                "median": statistics.median(rs),
                "n": len(rs),
            })
        for spot in by_spot:
            by_spot[spot].sort(key=lambda b: -b["median"])
        return by_spot


async def scan_loop(collector, stop):
    async with BleakScanner(collector.on_adv):
        await stop.wait()


# ─────────────────────────────────────────────────────── discover

# 폰·워치·이어폰은 프라이버시 때문에 블루투스 주소를 주기적으로 바꾼다. 주소가
# 바뀌면 macOS 는 다른 기기로 보므로, 사람들 기기는 **짧게 살다 사라지는 항목
# 여럿**으로 흩어진다. 비콘은 주소가 고정이라 하나의 긴 항목으로 남는다.
#
# 그런데 이 구분은 **스캔이 회전 주기보다 길어야** 성립한다. 처음에 90초로 뒀다가
# 5분 스캔에서 107개 중 80개가 "고정"으로 나왔다 — 5분 동안은 아무도 주소를 안
# 바꿨으니 전부 고정으로 보인 것이다. 문턱이 아니라 **스캔 길이가 문제였다.**
ROTATION_S = 15 * 60          # 흔한 MAC 회전 주기
BEACON_MIN_LIFE_S = 12 * 60   # 이보다 오래 같은 주소면 회전을 안 하는 기기다


# 걸어 다니며 스캔할 때의 또 다른 단서: **벽에 붙은 비콘은 멀어지면 사라진다.**
#
# 층을 한 바퀴 도는 내내 끊김 없이 잡힌 기기는 벽에 붙은 것이 아니라 **나와 함께
# 움직인 것**이다 — 내 폰·워치·이어폰, 또는 가방 속 기기. 오히려 의심해야 한다.
# 반대로 한 구역에서만 잡히고 신호가 크게 오르내린 것이 비콘답다.
CARRIED_PRESENCE = 0.9        # 이 비율 이상 계속 보였고
CARRIED_RSSI_SPAN = 25        # 신호 변동이 이보다 좁으면 함께 움직인 것으로 본다

# 체류율은 **실제로 들린 시간**이어야 한다.
#
# 처음에는 `(마지막 − 처음) ÷ 전체시간` 으로 쟀는데, 그것은 간격이지 체류가 아니다.
# 한 바퀴 돌아 제자리로 오면 벽에 붙은 기기는 **출발할 때 한 번, 돌아와서 한 번**
# 들린다. 간격으로 재면 0.9 가 나와 "내가 들고 다닌 기기"로 버려진다 —
# 찾으려던 바로 그 기기를 버리는 셈이었다.
#
# 그래서 30초 칸으로 나눠 **몇 칸에서 들렸나**를 센다. 두 번만 들린 기기는
# 0.05 가 나오고, 가방 속 이어폰은 1.0 이 나온다. 이제 둘이 갈린다.
PRESENCE_BUCKET_S = 30

# 걸어서 한 바퀴 도는 탐색에서 **고정 설비의 가장 강한 증거는 재회다.**
#
# 벽에 붙은 기기는 지나갈 때 잠깐 들리고 사라졌다가, 한 바퀴 돌아 다시 그 앞을
# 지나면 **같은 id 로** 또 들린다. 주소를 돌리는 폰은 그럴 수 없다 — 15분 뒤의
# 그 폰은 다른 id 다. 그래서 「끊겼다 같은 id 로 다시 나타남 + 그 간격이 회전
# 주기보다 김」이면 회전하지 않는 기기라는 뜻이 된다.
#
# 이건 SLAM 의 루프 클로저와 같은 논리인데, 여기서는 위치가 아니라 **id 의
# 영속성**을 확인하는 데 쓴다.
REVISIT_GAP_BUCKETS = 4       # 2분 이상 끊기면 한 번의 방문이 끝난 것으로 본다


async def discover(minutes):
    """건물을 한 바퀴 돌며 무엇이 있는지 훑는다. 비콘이 있긴 한가부터 답한다."""
    c = Collector()
    stop = asyncio.Event()
    task = asyncio.create_task(scan_loop(c, stop))
    t0 = time.time()

    print(f"\n비콘 탐색 — {minutes}분 동안 계속 스캔합니다. 맥북을 들고 건물을 도세요.")
    print("  새로 잡히는 것을 실시간으로 보여줍니다.  Ctrl-C = 조기 종료\n")

    known = set()
    try:
        while time.time() - t0 < minutes * 60:
            await asyncio.sleep(1)
            for bid, (rssi, _) in list(c.live.items()):
                if bid in known:
                    continue
                known.add(bid)
                m = c.meta[bid]
                mark = "★" if m["kind"] in ("iBeacon", "Eddystone") else " "
                el = int(time.time() - t0)
                print(f"  [{el//60:02d}:{el%60:02d}] {mark} {rssi:>5} dBm  "
                      f"{m['kind']:<10} {m['label'][:32]}")
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass

    discover_report(c, time.time() - t0)   # 저장이 먼저
    stop.set()
    try:
        await asyncio.wait_for(task, timeout=5)
    except Exception:
        import os
        os._exit(0)


def _visit_clusters(buckets):
    """칸 집합을 방문 횟수로 접는다. [0,1,2, 40,41] -> 2회"""
    if not buckets:
        return 0
    ordered = sorted(buckets)
    n = 1
    for prev, cur in zip(ordered, ordered[1:]):
        if cur - prev >= REVISIT_GAP_BUCKETS:
            n += 1
    return n


def discover_report(c, elapsed):
    """오래 살아남은 항목이 비콘 후보다."""
    rows = []
    for bid, s in c.seen.items():
        life = s["last"] - s["first"]
        m = c.meta[bid]
        rows.append({
            "beaconId": bid, "kind": m["kind"], "label": m["label"],
            "lifeS": life, "n": s["n"],
            "coverage": min(1.0, len(s["buckets"]) / max(1, round(elapsed / PRESENCE_BUCKET_S))),
            "visits": _visit_clusters(s["buckets"]),
            "rssiMin": min(s["rssis"]), "rssiMax": max(s["rssis"]),
            "median": statistics.median(s["rssis"]),
        })
    rows.sort(key=lambda r: -r["lifeS"])

    for r in rows:
        r["presence"] = r["coverage"]
        r["span"] = r["rssiMax"] - r["rssiMin"]
        r["carried"] = (r["presence"] >= CARRIED_PRESENCE
                        and r["span"] <= CARRIED_RSSI_SPAN)

    formatted = [r for r in rows if r["kind"] in ("iBeacon", "Eddystone")]
    carried = [r for r in rows if r["carried"] and r not in formatted]
    lasting = [r for r in rows
               if r["lifeS"] >= BEACON_MIN_LIFE_S and not r["carried"]
               and r not in formatted]

    # 끊겼다 같은 id 로 다시 만난 기기 — 걸어서 도는 탐색의 핵심 증거
    revisited = [r for r in rows
                 if r["visits"] >= 2 and r["lifeS"] >= BEACON_MIN_LIFE_S
                 and r["coverage"] < 0.6 and r not in formatted]
    revisited.sort(key=lambda r: (-r["visits"], -r["lifeS"]))

    print("\n" + "=" * 66)
    print(f"탐색 결과 — {elapsed/60:.1f}분, 기기 {len(rows)}개")
    print("=" * 66)

    if elapsed < ROTATION_S:
        print(f"""
⚠️  스캔이 짧습니다 ({elapsed/60:.1f}분).

    폰·워치는 블루투스 주소를 대개 15분마다 바꿉니다. 그보다 짧게 스캔하면
    **아무도 주소를 안 바꿔서 전부 "고정 기기"로 보입니다.**
    아래의 「고정 기기」 숫자는 믿지 마세요.

    → 맥북을 책상에 두고 {int((ROTATION_S - elapsed) / 60) + 5}분 더 돌리면 갈라집니다.
       (걸어 다닐 필요 없습니다. 그냥 두면 됩니다.)""")

    if formatted:
        print(f"\n★ 비콘 규격으로 광고 중 ({len(formatted)}개) — 거의 확실합니다")
        for r in formatted[:15]:
            print(f"   {r['median']:>6.1f} dBm  {r['kind']:<10} {r['label'][:34]}"
                  f"   {r['lifeS']:.0f}초")

    if carried:
        print(f"\n· 나와 함께 움직인 것으로 보이는 기기 ({len(carried)}개)")
        print("  한 바퀴 도는 내내 끊기지 않고 신호도 일정했습니다 —")
        print("  벽에 붙은 비콘이라면 멀어질 때 사라져야 합니다. 내 폰·워치·이어폰일 것입니다.")
        for r in carried[:6]:
            print(f"   {r['median']:>6.1f} dBm  {r['label'][:30]:<32}"
                  f" 신호폭 {r['span']:>3} dB")

    if revisited:
        print(f"\n· 다시 만난 기기 ({len(revisited)}개) — 주소를 안 바꾸는 고정 설비입니다")
        print("  지나갈 때 들리고 사라졌다가, 돌아오니 **같은 id 로** 또 들렸습니다.")
        print("  회전하는 폰은 이럴 수 없습니다. 이게 곧 쓸 수 있는 앵커입니다.")
        for r in revisited[:15]:
            print(f"  {r['label'][:30]:32s} {r['visits']}회 방문  "
                  f"간격 {r['lifeS']/60:.0f}분  체류 {r['coverage']*100:.0f}%  "
                  f"신호 {r['rssiMin']}~{r['rssiMax']}")

    only_lasting = lasting
    if only_lasting:
        print(f"\n· 오래 붙어 있던 기기 ({len(only_lasting)}개) — 고정 설치일 수 있습니다")
        print("  (Wi-Fi AP 내장 BLE, 디지털 사이니지, 프린터 등도 여기 섞입니다)")
        for r in only_lasting[:15]:
            print(f"   {r['median']:>6.1f} dBm  {r['label'][:34]:<34}"
                  f"   {r['lifeS']:.0f}초  신호 {r['rssiMin']}~{r['rssiMax']}")

    keepers = {id(r) for r in formatted} | {id(r) for r in lasting} | {id(r) for r in revisited}
    passing = len(rows) - len(keepers)
    print(f"\n· 스쳐 지나간 기기 {passing}개 — 사람들의 폰·워치·이어폰입니다.")
    print("  요즘 기기는 주소를 주기적으로 바꿔서 짧은 항목 여럿으로 나타납니다.")

    print("\n" + "-" * 66)
    if elapsed < ROTATION_S and not formatted:
        print("판정: 아직 모릅니다. 비콘 규격은 없었지만, 스캔이 짧아")
        print("      나머지를 갈라내지 못했습니다. 더 돌려 보세요.")
    elif formatted:
        print("판정: 비콘이 있습니다. 다음은 `survey` 로 지점마다 태그하세요.")
        print("      구매는 필요 없을 수 있습니다.")
    elif only_lasting:
        print("판정: 비콘 규격은 없지만 고정 기기가 있습니다.")
        print("      같은 시간대에 한 번 더 돌아 같은 id 가 또 나오는지 보세요.")
        print("      그래도 남으면 그것을 비콘 대신 쓸 수 있습니다(고정 id 면 충분합니다).")
    else:
        print("판정: 쓸 만한 고정 신호가 없습니다. 비콘을 사야 합니다.")
        print("      사람이 적은 시간대에 한 번 더 확인해 보세요.")

    path = "beacon-discovery.json"
    with open(path, "w") as f:
        json.dump({"generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
                   "elapsedS": elapsed, "devices": rows}, f,
                  ensure_ascii=False, indent=2)
    print(f"\n저장: {path}")


async def survey():
    """복도를 걸으며 지점마다 태그한다."""
    c = Collector()
    stop = asyncio.Event()
    task = asyncio.create_task(scan_loop(c, stop))

    print("\n비콘 답사 — 지점 이름을 입력하면 5초간 기록합니다.")
    print("  지점 이름 예: R302, J1, EXIT   (도면의 노드 id 를 그대로 쓰면 좋습니다)")
    print("  그냥 Enter = 지금 보이는 것 목록 /  q = 끝내고 결과 저장\n")

    loop = asyncio.get_running_loop()
    try:
        while True:
            name = (await loop.run_in_executor(None, input, "지점> ")).strip()

            if name.lower() in ("q", "quit", "exit"):
                break

            if not name:
                seen = c.visible()
                if not seen:
                    print("  (아직 아무것도 안 잡힘 — 블루투스 권한을 확인하세요)")
                for bid, rssi in seen[:10]:
                    m = c.meta[bid]
                    print(f"  {rssi:>5} dBm  {m['kind']:<10} {m['label']}")
                print()
                continue

            c.tag = name
            for left in range(int(TAG_SECONDS), 0, -1):
                print(f"  {name} 기록 중… {left}초", end="\r")
                await asyncio.sleep(1)
            c.tag = None

            got = [(b, statistics.median(r)) for (s, b), r in c.rows.items() if s == name]
            got.sort(key=lambda x: -x[1])
            print(f"  {name}: {len(got)}개 비콘 기록" + " " * 20)
            for bid, med in got[:5]:
                print(f"      {med:>6.1f} dBm  {c.meta[bid]['label']}")
            print()
    finally:
        stop.set()
        await task

    report(c)


def report(c):
    by_spot = c.summary()
    if not by_spot:
        print("\n기록된 지점이 없습니다.")
        return

    print("\n" + "=" * 60)
    print("지점별 최강 비콘 — 이게 곧 beaconId → nodeId 매핑 초안입니다")
    print("=" * 60)
    mapping = {}
    for spot, beacons in by_spot.items():
        top = beacons[0]
        mapping[top["beaconId"]] = spot
        second = f"  (2등 {beacons[1]['median']:.0f})" if len(beacons) > 1 else ""
        print(f"  {spot:<10} {top['median']:>6.1f} dBm  {top['label']}{second}")

    # 2등과 차이가 작으면 그 지점은 구분이 안 된다 — 비콘을 더 달거나 옮겨야 한다
    print("\n주의가 필요한 지점:")
    weak = False
    for spot, beacons in by_spot.items():
        if len(beacons) >= 2 and beacons[0]["median"] - beacons[1]["median"] < 6:
            weak = True
            print(f"  {spot}: 1등과 2등 차이가 "
                  f"{beacons[0]['median'] - beacons[1]['median']:.1f} dB 뿐입니다. "
                  f"경계에서 위치가 오락가락합니다.")
    if not weak:
        print("  없음 — 모든 지점에서 1등이 뚜렷합니다.")

    out = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "mapping": mapping,
        "spots": {s: b for s, b in by_spot.items()},
    }
    path = "beacon-survey.json"
    with open(path, "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\n저장: {path}")
    print("도면 편집기에서 각 지점의 '비콘 id' 칸에 위 값을 넣으면 됩니다.")


async def calibrate(target):
    """
    한 비콘을 거리별로 재서 txPower 와 경로손실 지수를 구한다.

    이 두 값이 `SIM_DEFAULTS` 의 가정을 실측으로 바꾼다. 시뮬레이터가 낸
    "비콘 12개 필요" 같은 숫자는 이 값이 맞아야 믿을 수 있다.
    """
    c = Collector()
    stop = asyncio.Event()
    task = asyncio.create_task(scan_loop(c, stop))
    loop = asyncio.get_running_loop()

    print(f"\n비콘 보정 — '{target}' 을 찾습니다.")
    print("  거리(m)를 입력하면 5초간 기록합니다. 1, 2, 5, 10 을 권합니다.")
    print("  q = 끝내고 계산\n")

    samples = []   # (거리, 중앙값 rssi)
    try:
        while True:
            raw = (await loop.run_in_executor(None, input, "거리(m)> ")).strip()
            if raw.lower() in ("q", "quit", "exit"):
                break
            try:
                dist = float(raw)
            except ValueError:
                print("  숫자를 입력하세요 (예: 1)")
                continue

            hits = [b for b, _ in c.visible(5.0)
                    if target.lower() in c.meta[b]["label"].lower()
                    or target.lower() in b.lower()]
            if not hits:
                print(f"  '{target}' 이 안 보입니다. 이름 일부를 다시 확인하세요.")
                continue
            bid = hits[0]

            c.tag = f"d{dist}"
            for left in range(int(TAG_SECONDS), 0, -1):
                print(f"  {dist}m 기록 중… {left}초", end="\r")
                await asyncio.sleep(1)
            c.tag = None

            rs = c.rows.get((f"d{dist}", bid), [])
            if len(rs) < 3:
                print(f"  표본이 부족합니다 ({len(rs)}개). 가까이서 다시.")
                continue
            med = statistics.median(rs)
            samples.append((dist, med))
            print(f"  {dist}m → {med:.1f} dBm  (표본 {len(rs)})" + " " * 12)
    finally:
        stop.set()
        await task

    if len(samples) < 2:
        print("\n거리 두 개 이상을 재야 계산할 수 있습니다.")
        return

    # RSSI = txPower − 10·n·log10(d)  를 최소제곱으로 푼다
    import math
    xs = [math.log10(d) for d, _ in samples if d > 0]
    ys = [r for d, r in samples if d > 0]
    n_ = len(xs)
    mx, my = sum(xs) / n_, sum(ys) / n_
    denom = sum((x - mx) ** 2 for x in xs)
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom if denom else 0
    tx = my - slope * mx                 # log10(d)=0 → d=1m 일 때의 값
    path_loss = -slope / 10

    print("\n" + "=" * 60)
    print("실측 결과 — shared/beacon-sim.js 의 SIM_DEFAULTS 에 넣으세요")
    print("=" * 60)
    for d, r in samples:
        print(f"  {d:>5.1f} m   {r:>6.1f} dBm")
    print(f"\n  txPower:      {tx:>6.1f}   (지금 가정: -59)")
    print(f"  pathLossExp:  {path_loss:>6.2f}   (지금 가정: 2.5)")
    if path_loss < 1.5 or path_loss > 4.5:
        print("\n  ⚠️ 경로손실 지수가 상식 범위(1.5~4.5) 밖입니다. 측정을 다시 보세요.")


# ─────────────────────────────────────────────────────── serve (웹 화면)

PAGE = """<!doctype html><html lang=ko><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>비콘 탐색</title>
<style>
:root{--bg:#0b0f14;--card:#151b23;--line:rgba(255,255,255,.09);--tx:#f3f4f6;
--dim:#9ca3af;--ok:#22c55e;--warn:#f59e0b;--acc:#2563eb}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 -apple-system,
"Apple SD Gothic Neo",system-ui,sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:640px;margin:0 auto;padding:14px 14px 40px}
h1{font-size:18px;font-weight:800;margin:0 0 2px}
.sub{color:var(--dim);font-size:13px;margin:0 0 14px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px}
.stat{background:var(--card);border-radius:12px;padding:11px 13px}
.stat b{display:block;font-size:24px;font-weight:800;line-height:1.1;
font-variant-numeric:tabular-nums}
.stat span{font-size:11.5px;color:var(--dim)}
.stat.hit b{color:var(--ok)}
.tagbar{display:flex;gap:8px;margin-bottom:14px}
.tagbar input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);
border-radius:11px;color:var(--tx);padding:12px 14px;font-size:16px}
.tagbar button{background:var(--acc);border:0;border-radius:11px;color:#fff;
padding:12px 18px;font-size:15px;font-weight:700;white-space:nowrap}
.tagbar button:disabled{opacity:.5}
.nodes{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:14px;max-height:112px;overflow:auto}
.nodes button{background:var(--card);border:1px solid var(--line);border-radius:8px;
color:var(--tx);font-size:12.5px;padding:6px 9px}
.nodes button.done{background:rgba(34,197,94,.18);border-color:transparent;color:var(--ok)}
.rec{background:var(--warn);color:#000;border-radius:11px;padding:10px 14px;
font-weight:700;margin-bottom:14px;text-align:center}
ul{list-style:none;margin:0;padding:0}
li{background:var(--card);border-radius:12px;padding:11px 13px;margin-bottom:7px;
display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center}
.nm{font-size:15px;font-weight:650;overflow:hidden;text-overflow:ellipsis;
white-space:nowrap}
.rs{font-size:19px;font-weight:800;font-variant-numeric:tabular-nums;text-align:right}
.meta{font-size:11.5px;color:var(--dim);grid-column:1}
.bar{grid-column:1/-1;height:4px;background:rgba(255,255,255,.08);border-radius:99px;
overflow:hidden;margin-top:4px}
.bar i{display:block;height:100%;background:var(--acc);border-radius:99px}
li.star{outline:1.5px solid var(--ok)}
li.star .bar i{background:var(--ok)}
.badge{display:inline-block;font-size:10.5px;font-weight:800;padding:1px 6px;
border-radius:5px;background:rgba(34,197,94,.18);color:var(--ok);margin-right:5px}
.badge.gen{background:rgba(255,255,255,.08);color:var(--dim)}
.empty{color:var(--dim);font-size:14px;text-align:center;padding:30px 0}

/* 도면에서 찍어 기록한다.
   이름 목록에서 고르는 방식은 현장에서 성립하지 않았다 — 지금 서 있는 자리가
   43개 이름 중 어느 것인지 아는 사람이 없다. 그림에서 짚는 것이 유일하게
   현실적이다. 사진은 검은 바탕에 흰 선이라 명도를 뒤집어 흰 종이로 쓴다. */
.mapbox{overflow:auto;-webkit-overflow-scrolling:touch;border-radius:12px;
margin:10px 0;background:#fff}
.map{position:relative;width:calc(100% * var(--mz,2));touch-action:manipulation}
.map img{display:block;width:100%;filter:invert(1) hue-rotate(180deg)}
.map svg{position:absolute;inset:0;width:100%;height:100%}
.zoomrow{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:-4px}
.zoomrow button{width:38px;height:32px;border-radius:9px;border:1px solid var(--line);
background:var(--card);color:var(--tx);font-size:16px}
.zoomrow span{color:var(--dim);font-size:12px;min-width:74px;text-align:center}
/* 보이는 점과 **누르는 영역**을 나눈다.
   한 규칙으로 묶으면 CSS 의 fill 이 속성 fill="transparent" 를 이겨서
   손가락 크기로 키운 터치 영역까지 통째로 칠해진다 — 도면이 점으로 덮인다. */
.map circle.dot{fill:#94a3b8;stroke:#fff;stroke-width:2.5}
.map circle.dot.exit{fill:#22c55e}
.map circle.dot.done{fill:#2563eb}
.map circle.dot.sel{fill:#f59e0b;stroke:#111;stroke-width:3}
.map circle.hit{fill:transparent;stroke:none}
.pick{display:flex;gap:8px;align-items:center;background:var(--card);
border-radius:12px;padding:10px 12px;margin-bottom:8px}
.pick b{flex:1;font-size:15px}
.pick span{color:var(--dim);font-size:12.5px}
.hintbar{color:var(--dim);font-size:12.5px;text-align:center;margin:4px 0 8px}
</style>
<div class=wrap>
<h1>비콘 탐색</h1>
<p class=sub id=sub>연결 중…</p>
<div class=stats>
  <div class="stat hit"><b id=nstar>0</b><span>비콘 규격 ★</span></div>
  <div class=stat><b id=nfix>0</b><span>고정 기기</span></div>
  <div class=stat><b id=nall>0</b><span>전체</span></div>
</div>
<div class=hintbar id=hint>도면에서 지금 서 있는 자리를 누르세요</div>
<div class=mapbox id=mapbox><div class=map id=map><img id=mapimg alt=""><svg id=dots
  viewBox="0 0 100 100" preserveAspectRatio=none></svg></div></div>
<div class=zoomrow><button id=zout>−</button><span id=zlbl>2배</span><button id=zin>+</button></div>
<div class=pick id=pick hidden><b id=pickname>—</b><span id=pickhint>여기서 5초</span></div>
<div class=tagbar>
  <input id=tag placeholder="도면에서 고르거나 지점 id 입력" autocapitalize=off>
  <button id=go>5초 기록</button>
</div>
<details><summary style="color:#9ca3af;font-size:13px;margin:6px 0">이름으로 고르기</summary>
<div id=nodes class=nodes></div></details>
<div class=rec id=rec hidden></div>
<ul id=list></ul>
<div class=empty id=empty>스캔 중…</div>
</div>
<script>
const $=id=>document.getElementById(id);
async function poll(){
  try{
    const r=await fetch('/api/state');const d=await r.json();
    $('sub').textContent=`경과 ${Math.floor(d.elapsed/60)}분 ${Math.floor(d.elapsed%60)}초`
      +(d.tag?` · 「${d.tag}」 기록 중`:'')
      +(d.surveyed!=null?` · 답사 ${d.surveyed}지점`:'');
    $('nstar').textContent=d.nstar;$('nfix').textContent=d.nfix;$('nall').textContent=d.nall;
    $('rec').hidden=!d.tag; if(d.tag)$('rec').textContent=`「${d.tag}」 기록 중…`;
    const L=$('list');L.innerHTML='';
    $('empty').hidden=d.live.length>0;
    for(const b of d.live){
      const li=document.createElement('li');
      if(b.star)li.className='star';
      const w=Math.max(2,Math.min(100,(b.rssi+100)*1.6));
      li.innerHTML=`<div class=nm>${b.star?'<span class=badge>'+b.kind+'</span>':
        '<span class="badge gen">BLE</span>'}${b.label}</div>
        <div class=rs>${b.rssi}</div>
        <div class=meta>${b.life}초째 · ${b.n}회 수신</div>
        <div class=bar><i style="width:${w}%"></i></div>`;
      L.appendChild(li);
    }
  }catch(e){$('sub').textContent='연결 끊김 — 맥북 터미널을 확인하세요';}
}
$('go').onclick=async()=>{
  const n=$('tag').value.trim(); if(!n)return;
  $('go').disabled=true;
  await fetch('/api/tag',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({name:n})});
  setTimeout(()=>{
    $('go').disabled=false;$('tag').value='';
    done.add(n);
    document.querySelectorAll('#nodes button').forEach(b=>{
      if(done.has(b.dataset.id))b.classList.add('done');});
    paint();
    $('pickhint').textContent='기록됨 ✓';
  },5200);
};
// 도면 지점을 버튼으로 — 손으로 치면 오타 하나에 매핑이 엉킨다
const done=new Set();
let NODES=[], SEL=null;

function paint(){
  const svg=$('dots'); if(!svg) return;
  svg.innerHTML=NODES.map(n=>{
    const cls=[n.id===SEL?'sel':'', done.has(n.id)?'done':'',
               n.type==='exit'?'exit':''].filter(Boolean).join(' ');
    // 손가락으로 누를 수 있어야 한다 — 눈으로 보이는 점보다 누르는 영역을 크게.
    return `<circle class="dot ${cls}" cx="${n.x}" cy="${n.y}" r="${n.id===SEL?R*1.5:R}"/>`
         + `<circle class="hit" cx="${n.x}" cy="${n.y}" r="${R*3.2}" data-id="${n.id}"/>`;
  }).join('');
  [...svg.querySelectorAll('[data-id]')].forEach(c=>{
    c.onclick=()=>select(c.dataset.id);
  });
}

function select(id){
  SEL=id; const n=NODES.find(x=>x.id===id);
  $('tag').value=id;
  $('pick').hidden=!n;
  if(n){
    $('pickname').textContent=n.name||n.id;
    $('pickhint').textContent=done.has(id)?'이미 기록됨 — 다시 하면 덮어씁니다':'그 자리에 서서 5초';
  }
  paint();
  document.querySelectorAll('#nodes button').forEach(b=>
    b.classList.toggle('on', b.dataset.id===id));
}

let R=6;
(async()=>{
  try{
    const r=await fetch('/api/nodes');const d=await r.json();
    NODES=(d.nodes||[]).filter(n=>Number.isFinite(n.x));
    const img=d.image;
    if(img&&img.width){
      $('dots').setAttribute('viewBox',`0 0 ${img.width} ${img.height}`);
      // 점 크기를 도면 크기에 맞춘다 — 픽셀 좌표계라 도면마다 값이 크게 다르다
      R=Math.max(img.width,img.height)/150;
    }
    const box=$('nodes');
    for(const n of NODES){
      const b=document.createElement('button');
      b.textContent=n.name||n.id; b.dataset.id=n.id;
      b.onclick=()=>select(n.id);
      box.appendChild(b);
    }
    // 이미 기록한 지점은 새로고침해도 초록이어야 한다 — 어디까지 했는지가
    // 답사 중에 제일 자주 확인하는 정보다.
    try{
      const sv=await (await fetch('/api/surveyed')).json();
      (sv||[]).forEach(id=>done.add(id));
    }catch(e){}
    paint();
    // 처음에는 도면 가운데가 보이게 — 왼쪽 끝 로고부터 보이면 길을 잃는다
    setTimeout(()=>{ const b=$('mapbox'); b.scrollLeft=(b.scrollWidth-b.clientWidth)/2; },80);
    const pi=await (await fetch('/api/plan-image')).json();
    if(pi&&pi.dataUri){ $('mapimg').src=pi.dataUri; }
    else { $('map').style.display='none';
           $('hint').textContent='도면 사진이 없습니다 — 아래에서 이름으로 고르세요'; }
  }catch(e){ $('hint').textContent='도면을 못 불러왔습니다 — 이름으로 고르세요'; }
})();
let MZ=2;
function setZoom(v){
  const b=$('mapbox');
  const mid=(b.scrollLeft+b.clientWidth/2)/Math.max(1,b.scrollWidth);   // 보던 지점을 유지
  MZ=Math.max(1,Math.min(6,v));
  $('map').style.setProperty('--mz',MZ);
  $('zlbl').textContent=MZ+'배';
  setTimeout(()=>{ b.scrollLeft=mid*b.scrollWidth-b.clientWidth/2; },30);
}
$('zin').onclick=()=>setZoom(MZ+1);
$('zout').onclick=()=>setZoom(MZ-1);

poll();setInterval(poll,700);
</script>"""


# 한 지점에서 이만큼 세게 잡힌 신호만 그 지점 것으로 본다.
# 약한 것까지 담으면 옆 방 기기가 이 방 것이 되어 판정이 흐려진다.
SURVEY_MIN_RSSI = -80
SURVEY_TOP_N = 8

_server_url = None


_plan_image = None
_surveyed_cache = {"n": None, "at": 0.0}


def _surveyed_spots():
    """서버에 등록된 답사 지점 수. 0.7초마다 폴링되므로 짧게 캐시한다."""
    if not _server_url:
        return None
    now = time.time()
    if now - _surveyed_cache["at"] < 2.0:
        return _surveyed_cache["n"]
    try:
        with urllib.request.urlopen(
                _server_url.rstrip("/") + "/api/beacon-map", timeout=3) as r:
            sv = json.loads(r.read()).get("surveyed") or {}
        _surveyed_cache["n"] = len(set(sv.values()))
    except Exception:
        _surveyed_cache["n"] = None
    _surveyed_cache["at"] = now
    return _surveyed_cache["n"]


def push_survey(collector, spot):
    """태그한 지점의 최강 신호들을 서버 매핑으로 올린다."""
    if not _server_url:
        return
    rows = [(b, statistics.median(r)) for (s, b), r in collector.rows.items()
            if s == spot and len(r) >= 3]
    rows = [(b, m) for b, m in rows if m >= SURVEY_MIN_RSSI]
    rows.sort(key=lambda x: -x[1])
    picked = rows[:SURVEY_TOP_N]
    if not picked:
        print(f"  [측량] {spot}: 충분히 센 신호가 없습니다 (가까이서 다시)", flush=True)
        return
    body = json.dumps({"mapping": {b: spot for b, _ in picked}}).encode()
    req = urllib.request.Request(_server_url.rstrip("/") + "/api/beacon-map/mapping",
                                 data=body, method="PUT",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            n = json.loads(res.read()).get("count")
        print(f"  [측량] {spot} ← 신호 {len(picked)}개 등록 "
              f"(가장 센 것 {picked[0][1]:.0f}dBm) · 누적 {n}개", flush=True)
    except Exception as e:
        print(f"  [측량] 서버에 못 올렸습니다 ({e})", flush=True)


def make_handler(collector, t0):
    from http.server import BaseHTTPRequestHandler

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass                                   # 스캔 로그를 가리지 않게 조용히

        def _send(self, code, body, ctype):
            data = body.encode() if isinstance(body, str) else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith("/api/nodes"):
                # 좌표와 도면 크기를 함께 준다 — 폰이 **도면 위에서 찍어** 기록하려면
                # 지점 이름만으로는 안 된다. 현장에서 «SOUTH STREET 교차점 1
                # (ELEWAY 하단)» 이 어디인지 아는 사람은 없다. 그림에서 짚는 것이
                # 유일하게 현실적인 방법이다.
                out = {"nodes": [], "image": None}
                if _server_url:
                    try:
                        with urllib.request.urlopen(
                                _server_url.rstrip("/") + "/api/map", timeout=4) as r:
                            plan = json.loads(r.read())
                        out["nodes"] = [
                            {"id": n["id"], "name": n.get("name") or n["id"],
                             "x": n.get("x"), "y": n.get("y"), "type": n.get("type")}
                            for n in plan.get("nodes", [])]
                        out["image"] = plan.get("image")
                        out["planId"] = plan.get("id")
                    except Exception:
                        pass
                return self._send(200, json.dumps(out, ensure_ascii=False),
                                  "application/json")

            if self.path.startswith("/api/plan-image"):
                # 사진은 크다(수백 KB). 한 번 받아 두고 계속 쓴다.
                global _plan_image
                if _plan_image is None and _server_url:
                    try:
                        with urllib.request.urlopen(
                                _server_url.rstrip("/") + "/api/map", timeout=4) as r:
                            pid = json.loads(r.read()).get("id")
                        with urllib.request.urlopen(
                                _server_url.rstrip("/") + f"/api/plans/{pid}/image",
                                timeout=15) as r:
                            _plan_image = json.loads(r.read()).get("dataUri") or ""
                    except Exception:
                        _plan_image = ""
                return self._send(200, json.dumps({"dataUri": _plan_image or ""}),
                                  "application/json")

            if self.path.startswith("/api/surveyed"):
                # 이미 기록한 지점 — 새로고침해도 초록이 유지돼야 한다
                done = []
                if _server_url:
                    try:
                        with urllib.request.urlopen(
                                _server_url.rstrip("/") + "/api/beacon-map", timeout=4) as r:
                            done = sorted(set((json.loads(r.read()).get("surveyed") or {}).values()))
                    except Exception:
                        pass
                return self._send(200, json.dumps(done, ensure_ascii=False),
                                  "application/json")
            if self.path.startswith("/api/state"):
                st = state(collector, t0)
                # 진척은 **서버에 남은 것**을 센다. 스캐너 안의 기록을 세면
                # 올리기가 실패해도 숫자가 올라가서, 한 바퀴 다 돌고 나서야
                # 아무것도 안 쌓였다는 걸 알게 된다.
                st["surveyed"] = _surveyed_spots()
                self._send(200, json.dumps(st), "application/json")
            else:
                self._send(200, PAGE, "text/html; charset=utf-8")

        def do_POST(self):
            if not self.path.startswith("/api/tag"):
                return self._send(404, "{}", "application/json")
            n = int(self.headers.get("Content-Length", 0))
            try:
                name = json.loads(self.rfile.read(n) or b"{}").get("name", "").strip()
            except Exception:
                name = ""
            if name:
                collector.tag = name
                collector.tag_until = time.time() + TAG_SECONDS
                # 기록이 끝나면 그 자리의 최강 신호들을 서버 매핑으로 올린다.
                # 걸음 추정을 거치지 않으므로 이 값이 가장 믿을 만하다.
                threading.Timer(TAG_SECONDS + 0.4, push_survey,
                                args=(collector, name)).start()
            self._send(200, json.dumps({"ok": bool(name)}), "application/json")

    return H


def state(c, t0):
    """웹 화면이 700ms 마다 읽어 가는 현재 상태."""
    now = time.time()
    live = []
    for bid, (rssi, seen_at) in c.live.items():
        if now - seen_at > 4:
            continue
        m = c.meta[bid]
        s = c.seen[bid]
        star = m["kind"] in ("iBeacon", "Eddystone")
        live.append({
            "label": m["label"][:34], "kind": m["kind"], "rssi": rssi,
            "star": star, "life": int(s["last"] - s["first"]), "n": s["n"],
        })
    live.sort(key=lambda b: (-b["star"], -b["rssi"]))

    nstar = sum(1 for b in c.meta.values() if b["kind"] in ("iBeacon", "Eddystone"))
    nfix = sum(1 for bid, s in c.seen.items()
               if s["last"] - s["first"] >= BEACON_MIN_LIFE_S
               and c.meta[bid]["kind"] == "BLE")
    if c.tag and c.tag_until and now > c.tag_until:
        c.tag = None
    return {"elapsed": now - t0, "tag": c.tag, "live": live,
            "nstar": nstar, "nfix": nfix, "nall": len(c.seen)}


async def report_loop(collector, server, stop, every=1.0):
    """
    잡히는 신호를 서버로 올린다 — 서버가 폰 위치와 짝지어 비콘 지도를 만든다.

    맥은 자기가 어디 있는지 모르고 폰은 BLE 를 못 읽는다. 둘 다 보고 있는 곳은
    서버뿐이라, 합치는 일도 서버가 한다.
    """
    url = server.rstrip("/") + "/api/observations"
    sent = ok = 0
    while not stop.is_set():
        await asyncio.sleep(every)
        live = [(bid, r) for bid, (r, t) in list(collector.live.items())
                if time.time() - t <= 3]
        if not live:
            continue
        body = json.dumps({
            "readings": [{"beaconId": bid, "rssi": r} for bid, r in live]
        }).encode()
        req = urllib.request.Request(url, data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=3) as res:
                d = json.loads(res.read())
            sent += 1
            if d.get("taken"):
                ok += 1
                if ok % 10 == 1:
                    a = d.get("at") or {}
                    print(f"  [지도] {d['ready']}/{d['beacons']}개 확정 · "
                          f"폰 위치 {a.get('nodeId')} (확신 {a.get('confidence', 0):.2f})",
                          flush=True)
            elif sent % 20 == 1:
                print(f"  [지도] {d.get('reason', '대기')} — 폰 앱으로 걸어야 쌓입니다",
                      flush=True)
        except Exception as e:
            if sent % 30 == 0:
                print(f"  [지도] 서버에 못 닿습니다 ({e})", flush=True)
            sent += 1


async def serve(port, minutes, server=None):
    """
    브라우저로 보는 탐색 화면.

    맥북을 가방에 넣고 **폰으로 본다.** 노트북을 팔에 안고 화면을 들여다보며 걷는
    것보다 훨씬 낫고, 지점 태그도 폰에서 누를 수 있어 답사가 한 사람으로 끝난다.
    """
    import socket
    from http.server import ThreadingHTTPServer
    import threading

    c = Collector()
    stop = asyncio.Event()
    t0 = time.time()
    task = asyncio.create_task(scan_loop(c, stop))

    # 포트가 이미 쓰이면 옆으로 옮긴다.
    #
    # 앞서 띄운 스캐너가 남아 있거나 다른 도구가 잡고 있는 일이 흔한데, 그때마다
    # 오류를 뱉고 죽으면 사용자는 무엇을 꺼야 하는지 알 수 없다. 옮겨 뜨고
    # **바뀐 주소를 알려주는** 편이 낫다.
    srv = None
    for p_try in range(port, port + 10):
        try:
            srv = ThreadingHTTPServer(("0.0.0.0", p_try), make_handler(c, t0))
            if p_try != port:
                print(f"  (:{port} 은 이미 쓰이는 중 → :{p_try} 로 옮겼습니다)", flush=True)
            port = p_try
            break
        except OSError:
            continue
    if srv is None:
        print(f"❌ :{port} 부터 10개 포트가 모두 사용 중입니다.", flush=True)
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    global _server_url
    _server_url = server
    reporter = asyncio.create_task(report_loop(c, server, stop)) if server else None

    # 폰에서 열 주소를 알려준다 — 맥 IP 를 손으로 찾게 하지 않는다
    ip = "127.0.0.1"
    try:
        sk = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sk.connect(("8.8.8.8", 80)); ip = sk.getsockname()[0]; sk.close()
    except Exception:
        pass

    print(f"""
비콘 탐색 화면이 열렸습니다.

   폰에서   http://{ip}:{port}
   맥에서   http://localhost:{port}

  맥북을 가방에 넣고(뚜껑은 열어둔 채) 폰으로 보면서 걸으세요.
  지점 이름을 넣고 「5초 기록」을 누르면 그 자리의 신호가 저장됩니다.

  Ctrl-C = 끝내고 결과 저장
""", flush=True)
    if server:
        print(f"  비콘 지도: 관측을 {server} 로 올립니다.\n"
              f"  폰 앱으로 걸으면 관제 지도에 비콘이 하나씩 찍힙니다.\n", flush=True)   # 파이프로 넘길 때도 주소가 바로 보이게
    try:
        while time.time() - t0 < minutes * 60:
            await asyncio.sleep(1)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass

    # **정리보다 저장이 먼저다.**
    #
    # 처음에는 스캐너를 닫고 나서 보고서를 썼는데, macOS 에서 BleakScanner 종료가
    # 걸려 프로세스가 안 죽었고 그 바람에 한 바퀴 돌며 모은 것이 통째로 날아갈
    # 뻔했다. 몇 십 분 걸은 결과를 정리 절차 하나에 걸어 둘 이유가 없다.
    discover_report(c, time.time() - t0)
    if c.rows:
        report(c)

    try:
        srv.shutdown()
        stop.set()
        if reporter:
            reporter.cancel()
        await asyncio.wait_for(task, timeout=5)
    except (asyncio.TimeoutError, Exception):
        print("(스캐너 정리가 지연됩니다 — 저장은 끝났으니 그냥 닫아도 됩니다)")
        import os
        os._exit(0)


def main():
    ap = argparse.ArgumentParser(description="BLE 비콘 답사·보정 (맥북)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    dis = sub.add_parser("discover", help="한 바퀴 돌며 뭐가 있는지 훑는다 (먼저 이것부터)")
    dis.add_argument("--minutes", type=float, default=10, help="스캔 시간 (기본 10분)")
    srv = sub.add_parser("serve", help="브라우저(폰)로 보는 탐색 화면 — 가장 편하다")
    srv.add_argument("--port", type=int, default=8765)
    srv.add_argument("--minutes", type=float, default=60)
    srv.add_argument("--report", metavar="URL", default=None,
                     help="관측을 이 서버로 올려 비콘 지도를 만든다 "
                          "(예: http://localhost:8080)")
    sub.add_parser("survey", help="지점마다 태그해 beaconId → nodeId 매핑을 만든다")
    cal = sub.add_parser("calibrate", help="한 비콘을 거리별로 재 txPower·경로손실을 구한다")
    cal.add_argument("--target", required=True, help="비콘 이름 또는 주소 일부")
    args = ap.parse_args()

    runner = {
        "discover": lambda: discover(args.minutes),
        "serve": lambda: serve(args.port, args.minutes, args.report),
        "survey": survey,
        "calibrate": lambda: calibrate(args.target),
    }[args.cmd]

    try:
        asyncio.run(runner())
    except KeyboardInterrupt:
        print("\n중단")


if __name__ == "__main__":
    main()
