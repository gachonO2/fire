/**
 * 비콘 측위 — BLE 스캔(RSSI)에서 현재 노드를 판정한다.
 *
 * RSSI를 거리로 환산하는 삼각측량은 실내 반사·인체 감쇠로 3~5m씩 틀리지만,
 * "어느 비콘이 제일 가까운가"라는 **비교**는 그 오차에 견딘다. 대피 안내에
 * 필요한 해상도는 노드 단위("302호 앞")이고, 이 판정이 정확히 그 해상도다.
 *
 * 여기서 나온 nodeId 하나가 routeToNearestExit(floorPlan, fromId, hazards)의
 * fromId로 들어간다 — 측위 계층의 역할은 그것이 전부다.
 *
 * 입력은 {beaconId, rssi, ts} 배열일 뿐 출처를 모른다. 실제 BLE 스캔이든
 * 시뮬레이터(beacon-sim.js)든 같은 코드가 돈다 — 비콘 기기가 없어도
 * 로직 전체를 지금 만들고 테스트할 수 있는 이유다.
 *
 * 시간은 전부 인자로 받는다(내부에서 Date.now()를 부르지 않는다).
 * 테스트가 시간을 마음대로 감을 수 있어야 히스테리시스를 검증할 수 있다.
 */

/** 기본 파라미터 — 데모에서 조정하려면 BeaconLocator 두 번째 인자로 넘긴다 */
export const LOCATOR_DEFAULTS = {
  windowMs: 3000,   // 이동평균 창 — 원시 RSSI는 정지 상태에서도 ±10dB 튄다
  switchDb: 5,      // 이만큼 더 세야 전환 후보가 된다 (노드 경계 깜빡임 방지)
  holdMs: 2000,     // 후보가 이 시간 유지돼야 실제로 전환한다
  jumpFactor: 2,    // 인접하지 않은 노드로의 전환은 holdMs를 이 배수로 요구
  staleMs: 6000,    // 이보다 오래 신호가 없는 비콘은 판정에서 제외
};

export class BeaconLocator {
  /**
   * @param {FloorPlan} floorPlan  beaconId가 붙은 노드가 있는 도면
   * @param {Object} opts          LOCATOR_DEFAULTS 항목 덮어쓰기
   */
  constructor(floorPlan, opts = {}) {
    this.opts = { ...LOCATOR_DEFAULTS, ...opts };
    this.setFloorPlan(floorPlan);
    this.reset();
  }

  /** 도면 교체 시(SSE로 새 도면 수신) 매핑·인접표를 다시 만든다 */
  setFloorPlan(floorPlan) {
    this.beaconToNode = floorPlan.beaconMap();
    // 인접표: 순간이동 판정 구분용. 엣지로 이어진 노드 사이의 이동은 정상,
    // 아닌 곳으로의 "이동"은 대부분 다중경로 반사가 만든 허상이다.
    this.adjacent = new Map(floorPlan.nodes.map(n => [n.id, new Set()]));
    for (const e of floorPlan.edges) {
      this.adjacent.get(e.a)?.add(e.b);
      this.adjacent.get(e.b)?.add(e.a);
    }
  }

  reset() {
    this.samples = new Map();   // beaconId -> [{rssi, ts}]
    this.nodeId = null;         // 현재 노드 (locked 전에는 잠정값)
    this.candidate = null;      // { nodeId, since } 전환 대기 중인 후보
    this.locked = false;        // 초기 확정 여부 — 확정 전에는 히스테리시스를 걸지 않는다
  }

  /** 스캔 결과 주입 — 한 건씩이든 묶음이든 상관없다 */
  addScans(scans) {
    for (const s of Array.isArray(scans) ? scans : [scans]) {
      if (!this.beaconToNode[s.beaconId]) continue; // 남의 비콘·잡신호 무시
      let arr = this.samples.get(s.beaconId);
      if (!arr) this.samples.set(s.beaconId, (arr = []));
      arr.push({ rssi: s.rssi, ts: s.ts });
    }
  }

  /**
   * 현재 노드 판정.
   * @param {number} now  기준 시각(ms) — 스캔 ts와 같은 시계여야 한다
   * @returns {{nodeId, beaconId, rssi}|null}  신호가 하나도 없으면 null
   */
  estimate(now) {
    const smoothed = this._smoothed(now);
    if (smoothed.length === 0) {
      // 신호 전멸 — 마지막 확정 위치를 유지한다. 비콘 사이 구간을 걷는 중일
      // 수 있고, 위치를 null로 떨어뜨리면 안내가 통째로 끊기기 때문이다.
      // (이 구간을 메우는 것이 odometry.js의 PDR이다)
      return this.nodeId ? { nodeId: this.nodeId, beaconId: null, rssi: null } : null;
    }

    smoothed.sort((a, b) => b.rssi - a.rssi);
    const top = smoothed[0];
    const topNode = this.beaconToNode[top.beaconId];

    // 초기 확정 전: 잠정값으로 즉시 답하되, 잠그지는 않는다.
    // 첫 스캔에서 가까운 비콘의 패킷이 유실되면 멀리서 약하게 잡힌 비콘이
    // 1등일 수 있는데, 그걸 바로 잠그면 히스테리시스가 오답을 지키게 된다.
    // 1등이 holdMs 동안 유지될 때만 확정하고, 그때부터 전환 비용을 물린다.
    if (!this.locked) {
      if (this.candidate?.nodeId !== topNode) this.candidate = { nodeId: topNode, since: now };
      this.nodeId = topNode;
      if (now - this.candidate.since >= this.opts.holdMs) {
        this.locked = true;
        this.candidate = null;
      }
      return { nodeId: topNode, beaconId: top.beaconId, rssi: top.rssi };
    }

    if (topNode === this.nodeId) {
      this.candidate = null; // 현 위치가 다시 1등 — 전환 논의 종료
      return { nodeId: this.nodeId, beaconId: top.beaconId, rssi: top.rssi };
    }

    // 현 위치 비콘의 평활값. 신호가 끊겼으면 -Infinity — 어떤 도전자든 이긴다.
    const currentEntry = smoothed.find(s => this.beaconToNode[s.beaconId] === this.nodeId);
    const currentRssi = currentEntry ? currentEntry.rssi : -Infinity;

    // 확실히(switchDb 이상) 더 세지 않으면 도전 자격이 없다
    if (top.rssi < currentRssi + this.opts.switchDb) {
      this.candidate = null;
      return { nodeId: this.nodeId, beaconId: currentEntry?.beaconId ?? null, rssi: currentEntry?.rssi ?? null };
    }

    // 도전자가 바뀌면 유지시간을 처음부터 다시 센다
    if (this.candidate?.nodeId !== topNode) {
      this.candidate = { nodeId: topNode, since: now };
    }

    // 인접 노드로의 전환은 정상 이동이니 holdMs, 비인접은 허상일 가능성이
    // 높으니 그 배수를 요구한다. 아예 무시하지 않는 이유: 비콘이 죽거나
    // 사용자가 빨리 걸으면 중간 노드를 건너뛸 수 있고, 그때 영영 못 따라가면
    // 엉뚱한 위치 기준으로 계속 안내하게 된다.
    const isAdjacent = this.adjacent.get(this.nodeId)?.has(topNode) ?? false;
    const requiredHold = this.opts.holdMs * (isAdjacent ? 1 : this.opts.jumpFactor);

    if (now - this.candidate.since >= requiredHold) {
      this.nodeId = topNode;
      this.candidate = null;
      return { nodeId: topNode, beaconId: top.beaconId, rssi: top.rssi };
    }

    return { nodeId: this.nodeId, beaconId: currentEntry?.beaconId ?? null, rssi: currentEntry?.rssi ?? null };
  }

  /** UI 표시용: 비콘별 평활 RSSI 내림차순 */
  snapshot(now) {
    return this._smoothed(now)
      .map(s => ({ ...s, nodeId: this.beaconToNode[s.beaconId] }))
      .sort((a, b) => b.rssi - a.rssi);
  }

  /** 창(windowMs) 안 샘플의 이동평균. staleMs 넘게 조용한 비콘은 제외 */
  _smoothed(now) {
    const out = [];
    for (const [beaconId, arr] of this.samples) {
      // 오래된 샘플은 버린다 — 버리지 않으면 메모리도 새고 죽은 비콘이 판정에 남는다
      while (arr.length && arr[0].ts < now - Math.max(this.opts.windowMs, this.opts.staleMs)) arr.shift();
      const recent = arr.filter(s => s.ts >= now - this.opts.windowMs);
      if (recent.length === 0) continue;
      if (arr[arr.length - 1].ts < now - this.opts.staleMs) continue;
      out.push({ beaconId, rssi: recent.reduce((a, s) => a + s.rssi, 0) / recent.length });
    }
    return out;
  }
}
