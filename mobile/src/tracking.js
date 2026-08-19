/**
 * 추적 계층 — 판단 계층과 세 앵커를 하나로 묶는다.
 *
 * ## 왜 따로 두는가
 *
 * `Fusion` 하나에 `BeaconAnchor` · `FloorChangeAnchor` · `MagneticAnchor` 를 각각
 * 물리고, 센서마다 다른 주기로 먹이는 배선이 필요하다. 그걸 화면(`GuideScreen`)에
 * 늘어놓으면 494줄짜리 파일이 600줄이 되고, 시연 경로가 걸린 파일이라 손대기가
 * 무서워진다.
 *
 * 더 큰 이유는 **시험**이다. 화면 안에 있으면 실기기 없이는 못 돌려본다.
 * 여기 빼두면 node 에서 가상 보행자를 걷게 해 "확신도가 시연 도중에 바닥으로
 * 떨어지지 않는가"를 미리 확인할 수 있다.
 *
 * ## 센서를 모른다
 *
 * expo 를 import 하지 않는다. 스캔·기압·자기장을 **받기만** 한다.
 * 실제 센서 연결은 부르는 쪽(앱 화면)이 한다. 그래야 node 에서 돌아간다.
 *
 * ## 경로 추종과는 다른 일을 한다
 *
 * `route.js` 의 `RouteFollower` 는 **계획된 경로 위 어디쯤**인지를 센다 — 안내
 * ("이쪽으로 7미터")를 만드는 쪽이다. 여기는 **그래프 위 어디인지**를 센다 —
 * 경로와 무관하게, 신호가 말하는 대로.
 *
 * 둘을 합치지 않는다. 합치면 "경로에서 벗어났다"를 영영 알 수 없기 때문이다.
 * 안내는 경로 추종이 하고, **믿어도 되는지는 여기가 말한다.**
 */

import { FloorPlan } from './floor-plan.js';
import { Fusion } from './fusion.js';
import { BeaconLocator } from './positioning.js';
import { BeaconAnchor } from './beacon-anchor.js';
import { AltitudeTracker } from './altitude.js';
import { FloorChangeAnchor } from './altitude-anchor.js';
import { MagneticMatcher } from './magnetic.js';
import { MagneticAnchor } from './magnetic-anchor.js';

export class Tracking {
  /**
   * @param {Object} plan 도면(평범한 객체 또는 FloorPlan). 비콘 id 가 붙어 있어야 한다.
   * @param {Object} opts
   * @param {string} [opts.startNodeId] 출발 지점 — 알면 첫 앵커로 넣는다
   */
  constructor(plan, { startNodeId = null, ...opts } = {}) {
    this.plan = plan instanceof FloorPlan ? plan : new FloorPlan(plan);
    this.fusion = new Fusion(this.plan, opts.fusion);
    this.locator = new BeaconLocator(this.plan, opts.locator);
    this.beacon = new BeaconAnchor(this.fusion, this.locator);
    this.altitude = new AltitudeTracker(opts.altitude);
    this.floor = new FloorChangeAnchor(this.fusion, this.plan);
    this.magnet = new MagneticMatcher(this.plan, opts.magnetic);
    this.magAnchor = new MagneticAnchor(this.fusion, this.magnet);

    this.steps = 0;
    this.lastFloorChange = null;
    this._lastRemote = null;
    this._pending = null;

    // 출발 지점은 이미 비콘이 확정해 준 값이다. 사람이 고른 것과 같은 무게로 둔다 —
    // 여기서 흔들리면 첫 안내부터 어긋나고, 그건 되돌리기 어렵다.
    if (startNodeId && this.plan.hasNode(startNodeId)) {
      this.fusion.anchorAt(startNodeId, { kind: 'beacon', trusted: true });
      this.beacon.lastNode = startNodeId;
    }
  }

  // ─────────────────────────────────────────── 입력

  /**
   * BLE 스캔 결과. 실기기든 시뮬레이터든 같은 모양이다.
   * @param {Array<{beaconId, rssi, ts}>} scans
   * @param {number} now 스캔 ts 와 같은 시계
   */
  pushScans(scans, now) {
    this.locator.addScans(scans);
    return this.beacon.update(now);
  }

  /**
   * 한 걸음.
   * @param {Object} o
   * @param {number} [o.heading] 진행 방위(도, 자북)
   * @param {number} [o.microTesla] 이 걸음에서 잰 자기장 크기
   */
  step({ heading, microTesla } = {}) {
    this.steps++;
    this.fusion.step({ heading });
    // 지자기는 **걸음 뒤에** 먹인다 — 후보들이 전진한 뒤라야 지문 색인이 맞는다
    if (Number.isFinite(microTesla)) this.magAnchor.update(microTesla);
  }

  /**
   * **다른 기기가 잡아 준 지점** — 맥이 BLE 를 대신 듣고 서버가 판정한 결과.
   *
   * 폰이 BLE 를 못 읽는 동안(Expo Go 제약) 실제 전파로 위치를 잡는 유일한 길이다.
   * 판정은 서버가 같은 `BeaconLocator` 로 하므로, 나중에 폰이 직접 읽게 되어도
   * 결과가 달라지지 않는다 — 바뀌는 것은 **누가 듣느냐**뿐이다.
   *
   * 늦게 도착할 수 있으므로(맥→서버→폰) 걸음 몇 개만큼 어긋난다. 지점 단위
   * 해상도에서는 그 정도가 문제되지 않지만, 그래서 신뢰도는 직접 들은 것보다 낮게 둔다.
   */
  pushRemoteFix(nodeId, { holdCount = 2, trusted = false } = {}) {
    if (!nodeId || !this.plan.hasNode(nodeId)) return false;

    if (nodeId === this._lastRemote) {
      this._pending = null;
      // 이미 그 지점을 믿고 있으면 **확인만** 한다 — 앵커를 다시 놓으면 걸음이 되감긴다.
      //
      // 그런데 아직 못 옮겨 갔으면 다시 밀어야 한다. 판단 계층은 «걸어온 거리로
      // 닿을 수 없는 앵커» 를 한 번에 믿지 않고 후보로만 넣는데(다중경로 반사로
      // 멀리 있는 비콘이 한 번 세게 잡히는 일이 있다), 그 설계는 **다음 스캔에
      // 또 들어와서 결국 이긴다** 는 전제 위에 서 있다.
      //
      // 여기서 같은 지점을 «확인» 으로 삼켜 버리면 그 다음 스캔이 영영 안 온다.
      // 한 번 0.3 만큼 밀고 끝나서, 전파가 아무리 옳은 답을 계속 보내도 점은
      // 옛 자리에 붙박인다. 실제로 지점 사이가 34~118 걸음인 도면에서 예산은
      // 6 걸음이라, 모든 이동이 이 경우에 걸렸다.
      if (this.fusion.position()?.nodeId === nodeId) {
        this.fusion.confirm('beacon');
        return false;
      }
      this.fusion.anchorAt(nodeId, { kind: 'beacon', trusted });
      return true;
    }

    // **바뀐 지점은 몇 번 이어질 때만 받아들인다.**
    //
    // 서버 판정도 잡음을 타서 한 번씩 옆 지점으로 튄다. 그때마다 앵커를 옮기면
    // 가만히 서 있어도 점이 두 지점 사이를 오간다. 서버에서 한 겹, 여기서 한 겹
    // 걸러야 조용해진다 — 듣는 쪽과 믿는 쪽 양쪽에서 거르는 것이 이 구조의 요지다.
    if (this._pending?.nodeId !== nodeId) {
      this._pending = { nodeId, n: 1 };
      return false;
    }
    if (++this._pending.n < holdCount) return false;

    this._pending = null;
    this._lastRemote = nodeId;
    // `trusted` 는 **전파만 믿는 화면**을 위한 것이다. 거리 검사를 건너뛰고 그
    // 자리로 확정한다 — 걸음도 나침반도 없는 화면에서는 검사에 쓸 근거가 없고,
    // 그 화면의 계약이 «서버가 말하는 곳을 그대로 보여준다» 이기 때문이다.
    this.fusion.anchorAt(nodeId, { kind: 'beacon', trusted });
    return true;
  }

  /**
   * 기압 측정값. 층이 바뀌면 엘리베이터·계단 노드에 앵커가 놓인다.
   * @returns {{kind, floors}|null} 층이 바뀐 순간에만 결과를 낸다
   */
  pushPressure(hPa, now) {
    const change = this.altitude.push(hPa, now, this.steps);
    if (!change) return null;
    this.lastFloorChange = change;
    this.floor.apply(change);
    return change;
  }

  // ─────────────────────────────────────────── 출력

  /** 0~1. 이 값이 낮으면 화면이 안내를 멈춰야 한다 */
  confidence() { return this.fusion.confidence(); }

  /** 'beacon' | 'barometer' | 'magnetic' | 'pdr' — 관제에서 색으로 구분한다 */
  source() { return this.fusion.source(); }

  /** {x, y, from, to, progress, nodeId, edgeId} 또는 null */
  position() { return this.fusion.position(); }

  /**
   * 도면 위쪽이 실제 몇 도인지 알려 준다 — 이걸 넣어야 나침반이 일을 한다.
   *
   * 도면에 값이 없으면 `observeHeading` 은 아무것도 하지 않는다(기준이 달라서
   * 비교하면 전부 틀린 값으로 깎게 된다). 그래서 걸어서 알아낸 값을 여기로 넣는다.
   */
  setNorthOffset(deg) {
    this.plan.setNorthOffset?.(deg);
  }

  /** 층이 바뀌었나 — 화면이 새 층 도면으로 갈아 끼워야 한다 */
  get floorOffset() { return this.altitude.floorOffset; }

  /** 지금 층을 이동하는 중인가 */
  get inTransit() { return this.altitude.inTransit; }

  /**
   * 계획된 경로에서 벗어났나.
   *
   * 경로 추종이 말하는 위치와 신호가 말하는 위치가 갈리면 둘 중 하나가 틀렸다.
   * 경로 추종은 "걸었으니 갔겠지"로 미는 값이라, **어긋나면 대개 그쪽이 틀렸다.**
   *
   * @param {string} routeEdgeId 경로 추종이 말하는 현재 통로
   * @returns {boolean} 확신도가 낮으면 판단하지 않는다(false) — 모르면 흔들지 않는다
   */
  offRoute(routeEdgeId, floor = 0.5) {
    if (!routeEdgeId || this.confidence() < floor) return false;
    const p = this.position();
    return !!p && p.edgeId !== null && p.edgeId !== routeEdgeId;
  }

  /** 도면 교체(층 이동·서버 갱신) */
  setPlan(plan) {
    this.plan = plan instanceof FloorPlan ? plan : new FloorPlan(plan);
    this.fusion.setFloorPlan(this.plan);
    this.locator.setFloorPlan(this.plan);
    this.floor.setFloorPlan(this.plan);
    this.magnet.setFloorPlan(this.plan);
  }
}
