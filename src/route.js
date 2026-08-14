/**
 * 경로 추종 — 서버가 준 경로를 "지금 어느 쪽, 몇 걸음"으로 바꾼다.
 *
 * ## 왜 구간마다 끊어 안내하는가
 *
 * 출구를 곧장 가리키면 **벽을 뚫고** 가리키게 된다. 사람은 벽을 보고 알아서 돌아가지만
 * 시각장애인은 부딪히며 헤맨다. 그래서 목적지가 아니라 **다음 꺾이는 지점**만 가리킨다.
 * 비상구 유도등이 하는 일과 같다 — 끝을 보여주는 게 아니라 다음 한 걸음을 보여준다.
 *
 * ## 방위에는 두 종류가 있다
 *
 *   도면 방위   도면 위쪽이 0. 도면 안에서만 참이다.
 *   실제 방위   자북이 0. 나침반과 견줄 수 있다.
 *
 * 둘을 잇는 값이 `northOffset`(도면 위쪽이 실제 몇 도인가)이다. 이게 없으면
 * "폰을 이쪽으로 돌리세요"를 할 수 없다 — 도면이 종이에 어느 방향으로 그려졌는지
 * 모르기 때문이다. 없으면 **없다고 말하지, 추측하지 않는다.**
 *
 * 반면 좌우 회전("여기서 왼쪽")은 **이전 구간과의 차이**라서 northOffset 없이도 맞다.
 * 그래서 보정이 없어도 안내가 아예 죽지는 않게 나눠 두었다.
 */

/** 이 각도 이상 꺾이면 "돌아라"라고 말한다. 이보다 작으면 직진으로 친다. */
export const TURN_DEG = 30;

/** 구간의 남은 걸음이 이보다 적어지면 다음 구간으로 넘어갈 준비를 한다 */
const ARRIVE_STEPS = 1;

export function norm360(d) { return ((d % 360) + 360) % 360; }

export function normalizeDelta(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export class RouteFollower {
  /**
   * @param plan   서버 /api/map 응답 (nodes, edges, metersPerUnit, stepLength, northOffset)
   * @param route  서버 /api/route 응답의 route ({ nodes: [id], edges: [id], distance, exit })
   */
  constructor(plan, route) {
    this.plan = plan;
    this.route = route;
    this.index = 0;          // 지금 걷고 있는 구간 번호
    this.stepsTaken = 0;     // 이 구간에서 걸은 걸음
    this._node = new Map((plan.nodes || []).map(n => [n.id, n]));
  }

  get metersPerUnit() { return this.plan.metersPerUnit ?? 1; }
  get stepLength() { return this.plan.stepLength ?? 0.7; }

  /** 도면 위쪽이 실제 몇 도인가. null 이면 절대 방향 안내 불가. */
  get northOffset() {
    if (Number.isFinite(this._northOffset)) return norm360(this._northOffset);
    const v = this.plan.northOffset;
    return Number.isFinite(v) ? norm360(v) : null;
  }

  /**
   * 걸어서 알아낸 보정값을 넣는다 (`src/calibrate.js`).
   * 도면에 값이 없어도 이걸로 절대 방향 안내가 켜진다.
   */
  setNorthOffset(deg) {
    this._northOffset = Number.isFinite(deg) ? norm360(deg) : null;
  }

  get segmentCount() { return Math.max(0, (this.route?.nodes?.length ?? 0) - 1); }
  get done() { return this.index >= this.segmentCount; }

  node(id) { return this._node.get(id); }

  /** 지금 구간의 시작·끝 지점 */
  segment(i = this.index) {
    const ids = this.route?.nodes || [];
    if (i < 0 || i + 1 >= ids.length) return null;
    return { from: this.node(ids[i]), to: this.node(ids[i + 1]) };
  }

  /** 다음 목표 지점 (사용자에게 이름으로 알려줄 대상) */
  get target() { return this.segment()?.to ?? null; }

  /** 도면 안에서의 방위 (도면 위쪽 = 0) */
  planBearing(i = this.index) {
    const s = this.segment(i);
    if (!s?.from || !s?.to) return null;
    const deg = Math.atan2(s.to.x - s.from.x, -(s.to.y - s.from.y)) * (180 / Math.PI);
    return norm360(deg);
  }

  /** 실제 나침반 기준 방위. 보정값이 없으면 null — 모르면 안내하지 않는다. */
  trueBearing(i = this.index) {
    const b = this.planBearing(i);
    const off = this.northOffset;
    if (b === null || off === null) return null;
    return norm360(b + off);
  }

  /** 이 구간의 실제 길이(m) */
  segmentMeters(i = this.index) {
    const s = this.segment(i);
    if (!s?.from || !s?.to) return 0;
    return Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) * this.metersPerUnit;
  }

  segmentSteps(i = this.index) {
    return Math.max(1, Math.round(this.segmentMeters(i) / this.stepLength));
  }

  /** 이 구간에서 앞으로 몇 걸음 남았나 */
  get stepsLeft() {
    return Math.max(0, this.segmentSteps() - this.stepsTaken);
  }

  /** 이 구간에서 앞으로 몇 미터 남았나 */
  get metersLeft() {
    return Math.max(0, this.stepsLeft * this.stepLength);
  }

  /** 출구까지 남은 전체 거리(m) — 지금 구간 나머지 + 이후 구간 전부 */
  get totalMetersLeft() {
    let m = this.metersLeft;
    for (let i = this.index + 1; i < this.segmentCount; i++) m += this.segmentMeters(i);
    return m;
  }

  /**
   * 이 구간에 들어설 때 얼마나 꺾어야 하나 (이전 구간 기준).
   *
   * **northOffset 없이도 맞는 값**이다 — 두 도면 방위의 차이라서 도면이 어느 쪽으로
   * 그려졌든 상쇄된다. 그래서 보정이 없는 도면에서도 "여기서 왼쪽"은 쓸 수 있다.
   *
   * @returns { deg, side: 'left'|'right'|'straight' } 또는 null(첫 구간)
   */
  turnInto(i = this.index) {
    if (i <= 0) return null;
    const prev = this.planBearing(i - 1);
    const now = this.planBearing(i);
    if (prev === null || now === null) return null;
    const deg = normalizeDelta(now - prev);
    const side = Math.abs(deg) < TURN_DEG ? 'straight' : (deg > 0 ? 'right' : 'left');
    return { deg, side };
  }

  /**
   * 한 걸음 걸었다. 구간을 다 걸었으면 다음으로 넘긴다.
   * @returns { advanced, arrived } advanced=구간이 바뀜, arrived=출구 도착
   */
  step() {
    if (this.done) return { advanced: false, arrived: true };
    this.stepsTaken++;
    if (this.stepsLeft > ARRIVE_STEPS - 1) return { advanced: false, arrived: false };

    this.index++;
    this.stepsTaken = 0;
    return { advanced: true, arrived: this.done };
  }

  /** 걸음이 어긋났을 때 되돌리기 (이탈 판정 후 복귀 등) */
  rewindSteps(n = 1) {
    this.stepsTaken = Math.max(0, this.stepsTaken - n);
  }

  /** 사람이 읽을 진행 상황 */
  describe() {
    const t = this.target;
    return {
      targetName: t?.name || '출구',
      exitName: this.route?.exit?.name || '출구',
      segment: this.index + 1,
      segments: this.segmentCount,
      stepsLeft: this.stepsLeft,
      metersLeft: this.metersLeft,
      totalMetersLeft: this.totalMetersLeft,
    };
  }
}

/**
 * 서버 경로에 위험 구간이 끼었는지 본다 — 재탐색이 필요한지 판단하는 데 쓴다.
 * 서버가 다시 계산해 주는 게 정답이지만, **다시 물어볼지 말지**는 앱이 정해야
 * 매번 불필요하게 호출하지 않는다.
 */
export function routeHitsHazard(route, hazards) {
  if (!route?.edges?.length || !hazards) return false;
  return route.edges.some(id => Boolean(hazards[id]));
}
