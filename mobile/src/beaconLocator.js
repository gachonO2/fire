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
import { simulateScan, withVirtualBeacons } from './beaconSim';

/** 스캔 주기(ms) — 실제 BLE 광고 주기와 같은 규모 */
const TICK_MS = 500;

/** 이 시간만큼 모아야 판정이 확정된다 (유지시간 2초 + 여유) */
const WINDOW_MS = 3000;

/**
 * 시뮬레이션에서 "실제로 서 있는 곳". 앱은 이 값을 보지 않고 **신호만 보고** 맞힌다.
 * 데모에서 다른 방에서 출발해 보려면 여기를 바꾸면 된다(지점 id 또는 null=첫 번째 방).
 */
let virtualStandNodeId = null;

export function setVirtualStandNode(nodeId) { virtualStandNodeId = nodeId; }

function standPosition(plan) {
  const nodes = plan?.nodes || [];
  const node =
    nodes.find(n => n.id === virtualStandNodeId) ||
    nodes.find(n => n.type === 'room') ||
    nodes[0];
  return node ? { x: node.x, y: node.y } : null;
}

/**
 * 한 번의 스캔. **실기기를 붙일 때 바뀌는 곳은 여기뿐이다.**
 *
 * 실제 구현은 react-native-ble-plx 의 `startDeviceScan` 으로 광고를 받아
 * `[{ beaconId, rssi, ts }]` 로 바꿔 주면 된다. iBeacon 이면 major/minor 를,
 * 일반 BLE 면 광고 이름이나 서비스 UUID 를 `beaconId` 로 쓴다.
 */
function scanOnce(plan, now) {
  return simulateScan(plan, standPosition(plan), now);
}

/**
 * `setLocator()` 에 꽂을 구현.
 * @returns {{ locate: (plan) => Promise<string|null>, simulated: boolean }}
 */
export function createBeaconLocator() {
  return {
    simulated: true,

    async locate(plan) {
      if (!plan?.nodes?.length) return null;

      // 비콘 id 가 없는 도면이면 지점마다 가상 비콘이 있다고 보고 돌린다.
      // 실제로 달기 전에 "달면 이렇게 된다"를 보여줄 수 있어야 하기 때문이다.
      const bp = withVirtualBeacons(plan);
      const pos = standPosition(bp);
      if (!pos) return null;

      const locator = new BeaconLocator(bp);

      // 실제 BLE 라면 여기서 3초간 실시간으로 모은다. 시뮬레이션은 기다릴 이유가
      // 없으므로 시계만 앞으로 감는다 — 평활·유지시간 판정은 그대로 다 거친다.
      const t0 = Date.now();
      for (let t = 0; t <= WINDOW_MS; t += TICK_MS) {
        const now = t0 + t;
        locator.addScans(scanOnce(bp, now));
        locator.estimate(now);
      }

      // 확정되지 않았으면 모른다고 한다. 아무 지점이나 돌려주면 엉뚱한 곳에서
      // 출발하는 경로가 나오고, 그건 안내를 안 하느니만 못하다.
      return locator.locked ? locator.nodeId : null;
    },
  };
}
