/**
 * 층 도면 모델 — 건물마다 다른 도면·설계도를 주입받아 대피 그래프로 쓴다.
 *
 * 좌표는 "도면 단위"로 저장한다. 도면 이미지를 올린 경우엔 이미지 픽셀 좌표가 되고,
 * 이미지 없이 직접 그린 경우엔 미터가 된다. 실제 거리 계산은 metersPerUnit으로 환산한다.
 * (도면 편집기에서 "이 층의 실제 가로 폭"을 입력하면 자동으로 계산된다)
 *
 * 이 모델이 있기 전에는 지도가 코드에 하드코딩되어 있었다. 이제 백엔드가 저장한
 * 도면을 프론트·백엔드가 모두 이 클래스로 감싸서 쓰므로, 건물을 바꾸려면 도면만 넣으면 된다.
 */

export const NODE_TYPES = ['room', 'junction', 'exit', 'elevator', 'stair'];

export class FloorPlan {
  constructor(plan) {
    this.plan = plan;
    this._nodes = new Map(plan.nodes.map(n => [n.id, n]));
    this._edges = new Map(plan.edges.map(e => [e.id, e]));
  }

  get id() { return this.plan.id; }
  get name() { return this.plan.name; }
  get nodes() { return this.plan.nodes; }
  get edges() { return this.plan.edges; }
  get image() { return this.plan.image || null; }
  get initialHazards() { return this.plan.initialHazards || {}; }

  /** 도면 단위 1 = 몇 미터인가 */
  get metersPerUnit() { return this.plan.metersPerUnit ?? 1; }

  /** 평균 보폭(m) — 걸음 수 환산용 */
  get stepLength() { return this.plan.stepLength ?? 0.7; }

  getNode(id) { return this._nodes.get(id); }
  getEdge(id) { return this._edges.get(id); }

  hasNode(id) { return this._nodes.has(id); }
  hasEdge(id) { return this._edges.has(id); }

  /** 통로 실제 길이(m) */
  edgeLength(edge) {
    const a = this._nodes.get(edge.a);
    const b = this._nodes.get(edge.b);
    if (!a || !b) return Infinity;
    return Math.hypot(b.x - a.x, b.y - a.y) * this.metersPerUnit;
  }

  /** 통로를 지나는 데 필요한 걸음 수 */
  edgeSteps(edge) {
    return Math.max(1, Math.round(this.edgeLength(edge) / this.stepLength));
  }

  /**
   * 도면의 **위쪽이 실제로 몇 도인가**(자북 기준). null 이면 모르는 상태.
   *
   * 도면은 종이에 아무 방향으로나 그려진다 — 위쪽이 북쪽이라는 보장이 전혀 없다.
   * 이 값이 없으면 `bearing()` 은 **도면 안에서만** 참인 각도이고, 나침반과 견줄 수 없다.
   *
   * 좌우 회전 안내("여기서 왼쪽")는 이전 구간과의 **차이**라서 이 값이 없어도 맞는다.
   * 하지만 "폰을 이쪽으로 돌리세요" 같은 **절대 방향 안내**는 이게 있어야 한다.
   */
  get northOffset() {
    const v = this.plan.northOffset;
    return Number.isFinite(v) ? ((v % 360) + 360) % 360 : null;
  }

  /** 실제 나침반 기준 방위. northOffset 을 모르면 null — 모르면 안내하지 않는다. */
  trueBearing(fromId, toId) {
    if (this.northOffset === null) return null;
    return (this.bearing(fromId, toId) + this.northOffset) % 360;
  }

  /** 도면 안에서의 방위각(도): 0=도면 위쪽, 90=오른쪽, 180=아래, 270=왼쪽 */
  bearing(fromId, toId) {
    const a = this._nodes.get(fromId);
    const b = this._nodes.get(toId);
    const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
    return (deg + 360) % 360;
  }

  /** 대피 목표가 되는 출구들 (계단·비상구) */
  exitNodes() {
    return this.plan.nodes.filter(n => n.type === 'exit');
  }

  /**
   * beaconId → nodeId 매핑 — 측위(최근접 비콘 판정)의 유일한 입력.
   * 비콘은 노드에 붙는다: 스캔에서 가장 센 비콘의 노드가 곧 현재 위치다.
   */
  beaconMap() {
    const map = {};
    for (const n of this.plan.nodes) if (n.beaconId) map[n.beaconId] = n.id;
    return map;
  }

  /** 비콘이 붙은 노드들 — 시뮬레이터가 이 노드들에서 신호를 발생시킨다 */
  beaconNodes() {
    return this.plan.nodes.filter(n => n.beaconId);
  }

  /** 특정 노드에 연결된 모든 통로 — 노드 단위 센서가 과열되면 여기를 전부 막는다 */
  edgesAtNode(nodeId) {
    return this.plan.edges.filter(e => e.a === nodeId || e.b === nodeId);
  }

  /** 서버가 엣지를 ID 배열로 보내온 경로를 엣지 객체 경로로 복원 */
  hydrateRoute(route) {
    if (!route) return null;
    return { ...route, edges: route.edges.map(id => this._edges.get(id)).filter(Boolean) };
  }

  toJSON() { return this.plan; }
}

/**
 * 주입된 도면 검증 — 잘못된 도면은 곧바로 오안내로 이어지므로 저장 전에 막는다.
 * @returns {string[]} 오류 목록 (비어 있으면 통과)
 */
export function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['도면 데이터가 없습니다.'];
  if (!plan.name?.trim()) errors.push('도면 이름이 필요합니다.');
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) errors.push('노드가 하나도 없습니다.');
  if (!Array.isArray(plan.edges)) errors.push('통로 목록이 배열이 아닙니다.');
  if (errors.length) return errors;

  const ids = new Set();
  const beaconIds = new Set();
  for (const n of plan.nodes) {
    if (!n.id) { errors.push('id가 없는 노드가 있습니다.'); continue; }
    if (ids.has(n.id)) errors.push(`노드 id가 중복됩니다: ${n.id}`);
    ids.add(n.id);
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) errors.push(`좌표가 잘못된 노드: ${n.id}`);
    if (n.type && !NODE_TYPES.includes(n.type)) errors.push(`알 수 없는 노드 유형: ${n.id} (${n.type})`);
    // 비콘 하나가 두 노드에 붙으면 측위가 두 위치 사이에서 갈팡질팡한다
    if (n.beaconId) {
      if (beaconIds.has(n.beaconId)) errors.push(`비콘 id가 중복됩니다: ${n.beaconId}`);
      beaconIds.add(n.beaconId);
    }
  }

  const edgeIds = new Set();
  for (const e of plan.edges) {
    if (!e.id) { errors.push('id가 없는 통로가 있습니다.'); continue; }
    if (edgeIds.has(e.id)) errors.push(`통로 id가 중복됩니다: ${e.id}`);
    edgeIds.add(e.id);
    if (!ids.has(e.a) || !ids.has(e.b)) errors.push(`존재하지 않는 노드를 잇는 통로: ${e.id}`);
    if (e.a === e.b) errors.push(`시작과 끝이 같은 통로: ${e.id}`);
  }

  // 출구가 없으면 대피 안내 자체가 성립하지 않는다
  if (!plan.nodes.some(n => n.type === 'exit')) {
    errors.push('출구(type: exit) 노드가 최소 1개 필요합니다.');
  }

  if (plan.metersPerUnit != null && !(plan.metersPerUnit > 0)) {
    errors.push('metersPerUnit은 0보다 커야 합니다.');
  }

  // 없어도 저장은 된다(좌우 회전 안내는 여전히 맞으므로). 다만 값이 있다면 각도여야 한다.
  if (plan.northOffset != null && !Number.isFinite(plan.northOffset)) {
    errors.push('northOffset은 각도(숫자)여야 합니다.');
  }

  return errors;
}

/**
 * 출구에 도달할 수 없는 노드를 찾는다 (위험 없는 평상시 기준).
 * 도면을 잘못 그려 통로가 끊긴 곳을 편집기에서 미리 잡아내기 위한 점검이다.
 */
export function findUnreachableNodes(floorPlan) {
  const adj = new Map(floorPlan.nodes.map(n => [n.id, []]));
  for (const e of floorPlan.edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }
  const seen = new Set();
  const queue = floorPlan.exitNodes().map(n => n.id);
  queue.forEach(id => seen.add(id));
  while (queue.length) {
    for (const next of adj.get(queue.shift()) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return floorPlan.nodes.filter(n => !seen.has(n.id)).map(n => n.id);
}
