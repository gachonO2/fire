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

import { planRoute, pruneForGuidance } from './wall-route.js';

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
  constructor(plan, route, { walls = null, path = null, metersPerUnit = null } = {}) {
    this.plan = plan;
    this.route = route;
    this.index = 0;          // 지금 걷고 있는 구간 번호
    this.stepsTaken = 0;     // 이 구간에서 걸은 걸음
    this._node = new Map((plan.nodes || []).map(n => [n.id, n]));
    this._walls = walls;
    // 사진 위에 사용자가 직접 그린 경로가 있으면 그 선이 거리와 방향의 원본이다.
    // 지도만 그 선을 쓰고 안내가 그래프 직선을 쓰면 화면과 음성이 서로 달라진다.
    this._path = Array.isArray(path) && path.length > 1
      ? path.map((p, i) => ({
          x: Array.isArray(p) ? p[0] : p.x,
          y: Array.isArray(p) ? p[1] : p.y,
          id: i === 0 ? 'SCENARIO_START'
            : i === path.length - 1 ? route?.exit?.id : undefined,
          name: i === 0 ? '현재 위치'
            : i === path.length - 1 ? (route?.exit?.name || '비상구') : undefined,
          corner: i > 0 && i < path.length - 1,
        }))
      : null;
    this._metersPerUnit = Number.isFinite(metersPerUnit) && metersPerUnit > 0
      ? metersPerUnit : null;
    this._buildWaypoints();
  }

  /**
   * 경로를 **걸어가는 순서의 지점 목록**으로 편다.
   *
   * 지점과 지점을 곧게 잇는 대신 직각으로 꺾고, **그 꺾임점을 지점으로 넣는다.**
   * 그래야 안내가 «우측으로 12미터, 그다음 좌측으로 꺾어 8미터» 가 된다.
   * 곧은 선으로 안내하면 화면에 그린 길과 말이 다른 길을 가리키게 되고,
   * 실제로 이 도면에서 최대 89° 어긋났다.
   *
   * 그리는 쪽(`PositionMap`·관제 지도)과 **같은 함수**를 쓴다. 두 곳에서 따로
   * 꺾으면 또 갈라진다.
   */
  _buildWaypoints() {
    if (this._path) {
      this.path = this._path;
      this.waypoints = pruneForGuidance(this.path);
      return;
    }
    const ids = this.route?.nodes || [];
    const nodes = ids.map(id => this.node(id)).filter(Boolean);
    // 벽이 있으면 격자에서 길을 찾고, 없으면 직각으로 꺾는다. 그리는 쪽과
    // **같은 함수**를 쓰므로 화면의 길과 말하는 길이 갈라지지 않는다.
    //
    // `path` 는 그림용(격자가 준 그대로), `waypoints` 는 안내용(짧은 토막을 합친 것).
    // 같은 길인데 말하는 단위만 다르다 — 「0.2미터 직진」 을 듣고 걸을 수는 없다.
    this.path = planRoute(nodes, { walls: this._walls || undefined });
    this.waypoints = pruneForGuidance(this.path);
  }

  /**
   * 벽을 나중에 받았을 때 다시 편다.
   *
   * 벽이 있으면 덜 뚫는 쪽으로 꺾으므로 꺾임점이 달라진다. 걷는 중에 갈아 끼우면
   * 걸음 수가 어긋나므로 **아직 출발 전일 때만** 바꾼다.
   */
  setWalls(walls) {
    if (this.index !== 0 || this.stepsTaken !== 0) return false;
    this._walls = walls;
    this._buildWaypoints();
    return true;
  }

  get metersPerUnit() { return this._metersPerUnit ?? this.plan.metersPerUnit ?? 1; }
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

  get segmentCount() { return Math.max(0, (this.waypoints?.length ?? 0) - 1); }
  get done() { return this.index >= this.segmentCount; }

  node(id) { return this._node.get(id); }

  /** 지금 구간의 시작·끝 지점. 꺾임점도 지점으로 센다. */
  segment(i = this.index) {
    const w = this.waypoints || [];
    if (i < 0 || i + 1 >= w.length) return null;
    return { from: w[i], to: w[i + 1] };
  }

  /** 지금 향하는 곳이 꺾임점인가 — 화면이 «여기서 꺾습니다» 를 말할 근거 */
  get toCorner() { return Boolean(this.segment()?.to?.corner); }

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
    // 걸음 수를 다시 미터로 환산하면 구간마다 반올림 오차가 붙는다. 도면 축척으로
    // 구한 실제 구간 길이에서 걸은 거리만 빼야 처음 값과 화면의 경로 길이가 같다.
    return Math.max(0, this.segmentMeters() - this.stepsTaken * this.stepLength);
  }

  /** 출구까지 남은 전체 거리(m) — 지금 구간 나머지 + 이후 구간 전부 */
  get totalMetersLeft() {
    let m = this.metersLeft;
    for (let i = this.index + 1; i < this.segmentCount; i++) m += this.segmentMeters(i);
    return m;
  }

  /**
   * 전체 경로 진행률로 안내기를 이동한다.
   *
   * 자동 시나리오에서는 휴대폰 걸음이 아니라 서버의 90초 시계가 위치의 원본이다.
   * 관제와 같은 진행률을 넣어 현재 구간·화살표·남은 거리를 한꺼번에 맞춘다.
   */
  seekProgress(progress01) {
    const progress = Math.max(0, Math.min(1, Number(progress01) || 0));
    if (!this.segmentCount) return false;
    if (progress >= 1) {
      this.index = this.segmentCount;
      this.stepsTaken = 0;
      return true;
    }

    let total = 0;
    for (let i = 0; i < this.segmentCount; i++) total += this.segmentMeters(i);
    let traveled = total * progress;
    for (let i = 0; i < this.segmentCount; i++) {
      const meters = this.segmentMeters(i);
      if (traveled <= meters || i === this.segmentCount - 1) {
        this.index = i;
        // 소수 걸음을 허용한다. 자동 시나리오는 0.25초마다 부드럽게 움직이므로
        // 한 걸음 단위로 끊으면 관제 점과 휴대폰 점이 번갈아 앞서게 된다.
        this.stepsTaken = Math.max(0, traveled / this.stepLength);
        return true;
      }
      traveled -= meters;
    }
    return false;
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
  /**
   * 지금 서 있는 좌표 — 관제 지도에 점을 찍기 위한 것.
   *
   * 안내에는 「어느 구간 몇 걸음」만 있으면 되지만, 화면에 점을 찍으려면 좌표가
   * 필요하다. 구간 양 끝 노드 사이를 걸음 비율만큼 보간한다.
   *
   * 이 값은 **추정치다.** 비콘이 노드를 확정해 주기 전까지는 걸음 수로 민 값이라
   * 실제와 어긋날 수 있고, 그래서 함께 보내는 confidence 가 중요하다.
   */
  position() {
    const s = this.segment();
    if (!s?.from) {
      // 마지막 구간을 끝낸 뒤에는 출발점으로 튀지 않고 경로 끝에 머문다.
      // 사진 시나리오에서는 이 값이 지도 위 파란 현재 위치 점에도 바로 쓰인다.
      const last = this.waypoints?.at?.(-1);
      if (this.done && last) {
        return { x: last.x, y: last.y, edgeId: null,
                 fromNodeId: last.id, toNodeId: last.id, progress: 1 };
      }
      const first = this._node.get(this.route?.nodes?.[0]);
      return first ? { x: first.x, y: first.y, edgeId: null, progress: 0 } : null;
    }
    if (!s.to) return { x: s.from.x, y: s.from.y, edgeId: null, progress: 1 };

    const meters = this.segmentMeters();
    const t = meters > 0
      ? Math.min(1, (this.stepsTaken * this.stepLength) / meters)
      : 1;
    return {
      x: s.from.x + (s.to.x - s.from.x) * t,
      y: s.from.y + (s.to.y - s.from.y) * t,
      edgeId: this.route?.edges?.[Math.min(this.index, (this.route?.edges?.length ?? 1) - 1)] ?? null,
      fromNodeId: s.from.id,
      toNodeId: s.to.id,
      progress: t,
    };
  }

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
