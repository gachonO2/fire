/**
 * 비콘 위치 판정기 — `locator.js` 의 `setLocator()` 에 꽂는 구현.
 *
 * ## 왜 이게 필요했나
 *
 * 이게 없으면 `locate()` 가 서버에 물어보는 것밖에 못 하고, 서버가 위치를 모르면
 * **"위치를 못 찾았습니다 · 지금 계신 곳은?"** 화면이 떴다. 불이 난 상황에
 * 시각장애인에게 강의실 13개를 하나씩 넘겨보라는 뜻이 된다. 말이 안 된다.
 *
 * 위치는 **묻는 게 아니라 알아내는 것**이고, 그 수단이 비콘이다.
 * 가장 세게 들리는 비콘이 곧 내 위치다.
 *
 * ## 지금은 시뮬레이션으로 돈다
 *
 * BLE 스캔은 Expo Go 에서 안 된다(`react-native-ble-plx` 같은 네이티브 모듈 +
 * 개발 빌드가 필요하다). 그래서 지금은 도면 좌표에서 신호를 만들어 넣는다.
 *
 * **판정 로직은 진짜와 똑같은 것을 쓴다.** 시뮬레이터는 실측 수준의 노이즈(±6dB)와
 * 패킷 유실(15%)까지 섞어 주고, `BeaconLocator` 는 그게 가짜인지 모른다.
 * 그래서 비콘을 달았을 때 갑자기 처음 보는 문제가 튀어나오지 않는다 —
 * 바뀌는 건 `scanOnce()` 한 곳뿐이다.
 */

import { BeaconLocator } from './positioning';
import { available as bleAvailable, startScan } from './ble';
import { simulateScan, withVirtualBeacons } from './beaconSim';

/** 스캔 주기(ms) — 실제 BLE 광고 주기와 같은 규모 */
const TICK_MS = 500;

/** 이 시간만큼 모아야 판정이 확정된다 (유지시간 2초 + 여유) */
const WINDOW_MS = 3000;

/**
 * 시뮬레이션에서 "실제로 서 있는 곳". 앱은 이 값을 보지 않고 **신호만 보고** 맞힌다.
 * 데모에서 다른 방에서 출발해 보려면 여기를 바꾸면 된다(지점 id 또는 null=첫 번째 방).
 */
// 서버(/api/demo/stand)가 알려준다. 코드에 박지 않는다 — 시험할 때마다 파일을
// 고치게 되고, 무엇보다 그 값이 진짜인 척하게 된다.
let virtualStandNodeId = null;

export function setVirtualStandNode(nodeId) { virtualStandNodeId = nodeId; }

/**
 * 시뮬레이션에서 서 있는 자리.
 *
 * 예전에는 **도면의 첫 번째 방**을 썼는데, COCONE 6층에서 하필 그 방이 비상구
 * 바로 옆이었다. 경로가 «한 걸음»으로 나와 시작하자마자 도착 처리되고, 걸을
 * 구간이 없어 위치가 한 자리에 못 박혔다. 비콘 매핑도 그 한 곳에만 90개가 쌓였다.
 *
 * 그래서 **출구에서 가장 먼 방**에서 시작한다. 시연이든 검증이든 하려는 일은
 * "걸으면 위치가 따라오는가"인데, 걸을 거리가 없으면 아무것도 볼 수 없다.
 */
function farthestFromExit(nodes, edges) {
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges || []) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }
  // 출구들에서 동시에 퍼뜨려(다중 시작 BFS) 각 지점의 최단 거리를 잰다
  const dist = new Map();
  let front = nodes.filter(n => n.type === 'exit').map(n => n.id);
  front.forEach(id => dist.set(id, 0));
  for (let d = 1; front.length; d++) {
    const next = [];
    for (const id of front) {
      for (const o of adj.get(id) || []) {
        if (dist.has(o)) continue;
        dist.set(o, d);
        next.push(o);
      }
    }
    front = next;
  }
  const rooms = nodes.filter(n => n.type === 'room');
  const pool = rooms.length ? rooms : nodes;
  return pool.reduce((best, n) =>
    (dist.get(n.id) ?? -1) > (dist.get(best.id) ?? -1) ? n : best, pool[0]);
}

function standPosition(plan) {
  const nodes = plan?.nodes || [];
  if (!nodes.length) return null;
  const node =
    nodes.find(n => n.id === virtualStandNodeId) ||
    farthestFromExit(nodes, plan.edges);
  return node ? { x: node.x, y: node.y, id: node.id } : null;
}

/**
 * 한 번의 스캔. **실기기를 붙일 때 바뀌는 곳은 여기뿐이다.**
 *
 * 실제 구현은 react-native-ble-plx 의 `startDeviceScan` 으로 광고를 받아
 * `[{ beaconId, rssi, ts }]` 로 바꿔 주면 된다. iBeacon 이면 major/minor 를,
 * 일반 BLE 면 광고 이름이나 서비스 UUID 를 `beaconId` 로 쓴다.
 */
function scanOnce(plan, now) {
  // **진짜 전파가 있으면 그것을 쓴다.** 가상 신호와 섞지 않는다 — 섞으면
  // 가상이 만든 위치로 실제 신호를 해석하는 순환이 되어, 아무리 걸어도 진짜가
  // 되지 않는다.
  if (bleAvailable()) return realScans(now);
  return simulateScan(plan, standPosition(plan), now);
}

// ── 폰이 직접 듣는 경로 ───────────────────────────────────────────────────
//
// BLE 광고는 **밀려서 들어온다.** 판정기는 «지금 이 순간의 목록» 을 달라고
// 당겨 가므로, 들어오는 것을 모아 두었다가 최근 것만 건네준다.
//
// 같은 비콘이 창 안에서 여러 번 들어오면 **중앙값**을 쓴다. RSSI 는 정지
// 상태에서도 ±10dBm 튀는데, 마지막 값 하나를 그대로 쓰면 그 튐이 그대로
// 판정에 들어간다. (맥 스캐너도 같은 규칙이다)

/** 이 시간보다 오래된 관측은 버린다 */
const REAL_WINDOW_MS = 1500;

let realStop = null;
let realBuf = [];

/** 스캔을 켠다. 이미 켜져 있으면 아무 일도 안 한다. */
export function startRealScan(onError = null) {
  if (realStop || !bleAvailable()) return;
  realStop = startScan(r => {
    realBuf.push({ ...r, ts: Date.now() });
  }, onError);
}

/** 스캔을 끈다 — 화면을 닫을 때. 켜 둔 채로 두면 배터리를 먹는다. */
export function stopRealScan() {
  realStop?.();
  realStop = null;
  realBuf = [];
}

/** 지금 들리는 것들. 판정기가 바로 먹을 수 있는 모양으로 낸다. */
function realScans(now) {
  const t = now || Date.now();
  realBuf = realBuf.filter(r => t - r.ts <= REAL_WINDOW_MS);

  const byId = new Map();
  for (const r of realBuf) {
    if (!byId.has(r.beaconId)) byId.set(r.beaconId, []);
    byId.get(r.beaconId).push(r.rssi);
  }
  return [...byId].map(([beaconId, list]) => {
    list.sort((a, b) => a - b);
    return { beaconId, rssi: list[Math.floor(list.length / 2)], ts: t };
  });
}

/** 지금 몇 개가 들리나 — 화면이 «듣고 있다» 를 보여줄 때 쓴다 */
export function realHeardCount() {
  return new Set(realBuf.map(r => r.beaconId)).size;
}

/**
 * 연속 스캔 — **안내 중에** 계속 위치를 확인하는 쪽(`GuideScreen`)이 쓴다.
 *
 * 예전에는 출발 지점을 잡을 때 한 번만 스캔하고 그 뒤로는 걸음만으로 밀었다.
 * 비콘을 달아 놓고도 걷는 동안에는 안 쓰는 셈이라, 오차가 쌓여도 바로잡을 길이
 * 없었다.
 *
 * @param {Object} plan
 * @param {number} now
 * @param {{x,y}} [simPos] **시뮬레이션 전용.** 가상 사용자가 지금 서 있는 좌표.
 *   실기기 구현에서는 무시된다 — 진짜 전파에는 "어디서 쟀는지"를 넣을 수 없다.
 */
export function scanBeacons(plan, now, simPos = null) {
  if (bleAvailable()) return realScans(now);
  return simulateScan(plan, simPos || standPosition(plan), now);
}

/**
 * `setLocator()` 에 꽂을 구현.
 * @returns {{ locate: (plan) => Promise<string|null>, simulated: boolean }}
 */
export function createBeaconLocator() {
  return {
    // 진짜 전파를 듣고 있으면 시뮬레이션이 아니다. 화면이 «가상 비콘» 배지를
    // 띄울지 말지를 이 값으로 정하므로, 여기서 거짓말하면 검증이 무의미해진다.
    get simulated() { return !bleAvailable(); },

    async locate(plan) {
      if (!plan?.nodes?.length) return null;

      // 비콘 id 가 없는 도면이면 지점마다 가상 비콘이 있다고 보고 돌린다.
      // 실제로 달기 전에 "달면 이렇게 된다"를 보여줄 수 있어야 하기 때문이다.
      const bp = withVirtualBeacons(plan);
      const pos = standPosition(bp);
      if (!pos) return null;

      const locator = new BeaconLocator(bp);

      if (bleAvailable()) {
        // **진짜 전파는 기다려야 한다.** 시계를 감을 수 없다 — 광고가 실제로
        // 도착해야 하기 때문이다. 3초 동안 실시간으로 모으며 판정한다.
        startRealScan();
        const t0 = Date.now();
        while (Date.now() - t0 <= WINDOW_MS) {
          const now = Date.now();
          locator.addScans(scanOnce(bp, now));
          locator.estimate(now);
          // eslint-disable-next-line no-await-in-loop
          await new Promise(r => setTimeout(r, TICK_MS));
        }
      } else {
        // 시뮬레이션은 기다릴 이유가 없으므로 시계만 앞으로 감는다 —
        // 평활·유지시간 판정은 그대로 다 거친다.
        const t0 = Date.now();
        for (let t = 0; t <= WINDOW_MS; t += TICK_MS) {
          const now = t0 + t;
          locator.addScans(scanOnce(bp, now));
          locator.estimate(now);
        }
      }

      // 확정되지 않았으면 모른다고 한다. 아무 지점이나 돌려주면 엉뚱한 곳에서
      // 출발하는 경로가 나오고, 그건 안내를 안 하느니만 못하다.
      return locator.locked ? locator.nodeId : null;
    },
  };
}
