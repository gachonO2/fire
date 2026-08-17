/**
 * 비콘 수신 — 스캔을 모아 BeaconLocator에 먹이고, 판정된 노드가 바뀌면 알린다.
 *
 * 시각장애인에게 이 모듈의 값어치는 하나다: **"지금 어디 계신가요"를 묻지 않는 것.**
 * 목록에서 자기 방 이름을 찾는 일은 눈으로 훑으면 1초지만 스크린리더로는
 * 수십 번의 탭이다. 화재 상황에서 그 시간을 쓰게 해서는 안 된다.
 *
 * 스캔의 출처는 두 가지이고, 아래 로직은 어느 쪽인지 모른다:
 *   · 실제 BLE (navigator.bluetooth.requestLEScan) — 기기·플래그가 갖춰진 경우
 *   · 시뮬레이터 (shared/beacon-sim.js) — 비콘 기기가 없는 지금
 * 기기가 생기면 _tick 의 신호 생성만 실제 스캔으로 바뀐다.
 */

import { FloorPlan } from '../shared/floor-plan.js';
import { BeaconLocator } from '../shared/positioning.js';
import { simulateScan } from '../shared/beacon-sim.js';

/** 스캔 주기(ms) — 실제 BLE 광고 주기(100ms~1s)와 같은 규모 */
const TICK_MS = 500;

/**
 * 비콘을 아직 안 단 도면이면 지점마다 **가상 비콘**이 있다고 치고 돌린다.
 *
 * 데모에서 도면을 새로 올릴 때마다 편집기로 돌아가 비콘 id를 타이핑해야 한다면
 * 아무도 이 기능을 켜보지 않는다. 실제 설치 전에 "달면 이렇게 된다"를 먼저
 * 보여줄 수 있어야 설치 여부를 판단할 수 있다.
 *
 * 엘리베이터는 제외한다 — 화재 시 목적지가 될 수 없으니 여기 서 있을 일이 없다.
 */
function withVirtualBeacons(floorPlan) {
  if (floorPlan.beaconNodes().length > 0) return floorPlan;
  const plan = floorPlan.toJSON();
  return new FloorPlan({
    ...plan,
    nodes: plan.nodes.map(n =>
      n.type === 'elevator' ? n : { ...n, beaconId: `SIM-${n.id}` }),
  });
}

export class BeaconSense {
  /**
   * @param {() => FloorPlan} getPlan     활성 도면 (관제에서 바뀔 수 있어 함수로 받는다)
   * @param {() => {x,y}|null} getTruePos 시뮬레이션용 실제 위치. 실기기에서는 안 쓴다.
   */
  constructor(getPlan, getTruePos) {
    this.getPlan = getPlan;
    this.getTruePos = getTruePos;
    this.locator = null;
    this.beaconPlan = null;   // 가상 비콘이 채워진 도면 (시뮬레이션 좌표 계산용)
    this.timer = null;
    this.nodeId = null;
    this.locked = false;      // 판정이 확정됐는가 (확정 전 잠정값은 흔들릴 수 있다)
    this.virtual = false;     // 도면에 실제 비콘 id가 없어 가상으로 도는 중인가
    this.onLocate = () => {};   // (nodeId, {locked, node}) — 판정이 바뀔 때만
  }

  /** 실기기 BLE 스캔이 가능한 환경인가 (아니면 시뮬레이션으로 돈다) */
  get simulated() {
    return typeof navigator === 'undefined' || !navigator.bluetooth?.requestLEScan;
  }

  /** 지점이 하나라도 있으면 (가상 비콘으로라도) 측위를 보여줄 수 있다 */
  get available() {
    return (this.getPlan()?.nodes.length ?? 0) > 0;
  }

  start() {
    this.stop();
    if (!this.available) return false;
    const plan = this.getPlan();
    this.virtual = plan.beaconNodes().length === 0;
    this.beaconPlan = withVirtualBeacons(plan);
    this.locator = new BeaconLocator(this.beaconPlan);
    this.timer = setInterval(() => this._tick(), TICK_MS);
    return true;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.nodeId = null;
    this.locked = false;
  }

  /** 도면이 교체되면 매핑을 다시 만든다 — 이전 건물의 비콘 id로 판정하면 안 된다 */
  refreshPlan() {
    if (!this.timer) return;
    this.start();
    this.nodeId = null;
  }

  _tick() {
    const pos = this.getTruePos();
    if (!this.beaconPlan || !pos) return;

    const now = Date.now();
    this.locator.addScans(simulateScan(this.beaconPlan, pos, now));
    const est = this.locator.estimate(now);
    if (!est) return;

    // 지점이 바뀌었을 때뿐 아니라 **확정된 순간**에도 알린다. 서 있는 자리에서
    // 처음 잡은 지점이 그대로 확정되는 것이 정상 경로인데, 지점 변화만 보면
    // 그 순간을 놓쳐 영영 알리지 않게 된다.
    const settled = this.locator.locked;
    if (est.nodeId !== this.nodeId || settled !== this.locked) {
      this.nodeId = est.nodeId;
      this.locked = settled;
      this.onLocate(est.nodeId, { locked: settled, node: this.getPlan().getNode(est.nodeId) });
    }
  }
}
