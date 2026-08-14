/**
 * 비콘 측위 — BLE 신호 세기(RSSI)에서 "지금 어느 지점인가"를 판정한다.
 *
 * ## 왜 삼각측량이 아닌가
 *
 * RSSI를 거리로 환산하는 방식은 실내 반사·인체 감쇠로 3~5m씩 틀린다. 하지만
 * **"어느 비콘이 제일 가까운가"라는 비교**는 그 오차에 견딘다. 대피 안내에
 * 필요한 해상도는 지점 단위("302호 앞")이고, 최근접 판정이 정확히 그 해상도다.
 *
 * ## 흔들림을 잡지 않으면 못 쓴다
 *
 * 원시 RSSI는 가만히 서 있어도 ±10dB씩 튄다. 그대로 쓰면 지점 경계에서 위치가
 * 초 단위로 오락가락하고, 그때마다 "302호입니다 / 복도입니다"를 번갈아 말하게 된다.
 * 그래서 평활(이동평균) → 문턱(5dB) → 유지시간(2초) 세 겹을 건다.
 *
 * ## 시간을 인자로 받는다
 *
 * 내부에서 Date.now()를 부르지 않는다. 테스트가 시간을 마음대로 감을 수 있어야
 * 히스테리시스를 검증할 수 있기 때문이다.
 *
 * `../fire/shared/positioning.js` 와 같은 알고리즘이다. 두 프로젝트가 npm 으로
 * 이어져 있지 않아 옮겨 왔고, 도면을 클래스가 아니라 **서버 응답 그대로의
 * 평범한 객체**로 받도록 맞췄다. 규칙을 고칠 일이 생기면 양쪽을 함께 고칠 것.
 */

export const LOCATOR_DEFAULTS = {
  windowMs: 3000,   // 이동평균 창
  switchDb: 5,      // 이만큼 더 세야 전환 후보가 된다
  holdMs: 2000,     // 후보가 이 시간 유지돼야 실제로 전환한다
  jumpFactor: 2,    // 통로로 안 이어진 지점으로의 전환은 유지시간을 이 배수로 요구
  staleMs: 6000,    // 이보다 오래 조용한 비콘은 판정에서 뺀다
};

export class BeaconLocator {
  constructor(plan, opts = {}) {
    this.opts = { ...LOCATOR_DEFAULTS, ...opts };
    this.setPlan(plan);
    this.reset();
  }

  setPlan(plan) {
    this.beaconToNode = {};
    for (const n of plan?.nodes || []) if (n.beaconId) this.beaconToNode[n.beaconId] = n.id;

    // 인접표 — 통로로 이어진 지점 사이의 이동은 정상, 아닌 곳으로의 "이동"은
    // 대개 다중경로 반사가 만든 허상이다.
    this.adjacent = new Map((plan?.nodes || []).map(n => [n.id, new Set()]));
    for (const e of plan?.edges || []) {
      this.adjacent.get(e.a)?.add(e.b);
      this.adjacent.get(e.b)?.add(e.a);
    }
  }

  reset() {
    this.samples = new Map();   // beaconId -> [{rssi, ts}]
    this.nodeId = null;
    this.candidate = null;
    this.locked = false;        // 확정 전 값은 잠정이다 — 알리기 전에 이걸 본다
  }

  addScans(scans) {
    for (const s of Array.isArray(scans) ? scans : [scans]) {
      if (!this.beaconToNode[s.beaconId]) continue;   // 남의 비콘·잡신호는 버린다
      let arr = this.samples.get(s.beaconId);
      if (!arr) this.samples.set(s.beaconId, (arr = []));
      arr.push({ rssi: s.rssi, ts: s.ts });
    }
  }

  /**
   * @returns {{nodeId, beaconId, rssi}|null} 신호가 하나도 없으면 null
   */
  estimate(now) {
    const smoothed = this._smoothed(now);
    if (smoothed.length === 0) {
      // 신호 전멸 — 마지막 위치를 유지한다. 비콘 사이 구간을 걷는 중일 수 있고,
      // 위치를 비우면 안내가 통째로 끊긴다. (그 구간을 메우는 게 odometry.js 의 걸음 추적)
      return this.nodeId ? { nodeId: this.nodeId, beaconId: null, rssi: null } : null;
    }

    smoothed.sort((a, b) => b.rssi - a.rssi);
    const top = smoothed[0];
    const topNode = this.beaconToNode[top.beaconId];

    // 확정 전에는 잠정값으로 즉시 답하되 잠그지 않는다. 첫 스캔에서 가까운 비콘의
    // 패킷이 유실되면 멀리서 약하게 잡힌 비콘이 1등일 수 있는데, 그걸 바로 잠그면
    // 히스테리시스가 오답을 지키게 된다.
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
      this.candidate = null;
      return { nodeId: this.nodeId, beaconId: top.beaconId, rssi: top.rssi };
    }

    const currentEntry = smoothed.find(s => this.beaconToNode[s.beaconId] === this.nodeId);
    const currentRssi = currentEntry ? currentEntry.rssi : -Infinity;

    // 확실히 더 세지 않으면 도전 자격이 없다
    if (top.rssi < currentRssi + this.opts.switchDb) {
      this.candidate = null;
      return { nodeId: this.nodeId, beaconId: currentEntry?.beaconId ?? null, rssi: currentEntry?.rssi ?? null };
    }

    if (this.candidate?.nodeId !== topNode) this.candidate = { nodeId: topNode, since: now };

    // 인접 지점으로의 이동은 정상이니 holdMs, 비인접은 허상일 가능성이 높으니 그 배수.
    // 아예 막지는 않는다 — 비콘이 죽거나 빨리 걸으면 중간 지점을 건너뛸 수 있고,
    // 그때 영영 못 따라가면 엉뚱한 위치 기준으로 계속 안내하게 된다.
    const isAdjacent = this.adjacent.get(this.nodeId)?.has(topNode) ?? false;
    const requiredHold = this.opts.holdMs * (isAdjacent ? 1 : this.opts.jumpFactor);

    if (now - this.candidate.since >= requiredHold) {
      this.nodeId = topNode;
      this.candidate = null;
      return { nodeId: topNode, beaconId: top.beaconId, rssi: top.rssi };
    }

    return { nodeId: this.nodeId, beaconId: currentEntry?.beaconId ?? null, rssi: currentEntry?.rssi ?? null };
  }

  /** 비콘별 평활 RSSI 내림차순 — 화면 표시·진단용 */
  snapshot(now) {
    return this._smoothed(now)
      .map(s => ({ ...s, nodeId: this.beaconToNode[s.beaconId] }))
      .sort((a, b) => b.rssi - a.rssi);
  }

  _smoothed(now) {
    const out = [];
    for (const [beaconId, arr] of this.samples) {
      // 오래된 샘플은 버린다 — 안 버리면 메모리가 새고 죽은 비콘이 판정에 남는다
      const keepFrom = now - Math.max(this.opts.windowMs, this.opts.staleMs);
      while (arr.length && arr[0].ts < keepFrom) arr.shift();
      const recent = arr.filter(s => s.ts >= now - this.opts.windowMs);
      if (recent.length === 0) continue;
      if (arr[arr.length - 1].ts < now - this.opts.staleMs) continue;
      out.push({ beaconId, rssi: recent.reduce((a, s) => a + s.rssi, 0) / recent.length });
    }
    return out;
  }
}
