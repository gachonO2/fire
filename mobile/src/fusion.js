/**
 * 판단 계층 — 여러 신호를 하나의 위치 추정으로 합친다.
 *
 * ## 왜 따로 두는가
 *
 * 지금까지 비콘(`positioning.js`)과 걸음(`odometry.js`)은 따로 놀았고, 둘을 합치는
 * 일은 화면(`GuideScreen`)이 임시로 했다. 여기에 기압계·지자기·지오펜스를 더 붙이면
 * "비콘은 있는데 지자기가 다르고 기압은 안 변했으면…" 같은 조건문이 폭발한다.
 *
 * 그래서 **모든 신호가 들어오는 문을 넷으로 고정**하고, 위치는 여기서만 결정한다.
 * 새 센서를 붙이는 일이 넷 중 하나를 고르는 일이 된다.
 *
 *   즉시 확정  anchorAt()      비콘·지오펜스·기압계·QR. 서 있어도 1~2초
 *   누적 확정  anchorAt()      지자기. 시퀀스가 쌓여야 부를 수 있다 (같은 문을 쓴다)
 *   이동      step()          걸음. 모든 후보를 한 걸음 전진
 *   참고      observe*()      나침반. 안 맞는 후보를 **감점**한다
 *
 * ## 후보를 하나로 두지 않는 이유
 *
 * "지금 여기"를 하나만 들고 있으면 틀렸을 때 되돌아올 방법이 없다. 갈림길에서
 * 잘못 고르면 그 뒤 모든 안내가 어긋난 채로 이어진다. 그래서 **가능한 위치를 여럿
 * 들고 각각에 가중치**를 준다. 신호가 들어올 때마다 가중치가 갈리고, 틀린 후보는
 * 저절로 죽는다.
 *
 * ## 참고 단서는 지우지 않고 깎는다
 *
 * 예전에 나침반이 정답 후보를 **제거**해서 영영 위치를 못 찾은 적이 있다. 경로가
 * 꺾이는 지점에서 이전 구간의 방위가 다음 후보에 딸려 왔고, 나침반이 70° 틀어져
 * 있어서 "북"을 "동"으로 읽었다. 실내 자기장은 철골 때문에 휘므로 **참고 단서는
 * 틀릴 수 있다.** 그래서 곱셈 하한(`observeFloor`)을 두어, 계속 틀리는 후보는
 * 시간이 지나며 죽되 한 번의 오판으로 정답이 사라지지는 않게 한다.
 *
 * ## 시간을 부르지 않는다
 *
 * 이 계층은 `Date.now()` 를 쓰지 않고 **걸음 수**로만 시간을 센다. 테스트가 시간을
 * 감을 수 있어야 확신도 감쇠를 검증할 수 있기 때문이다. (`shared/positioning.js`
 * 가 같은 이유로 `now` 를 인자로 받는 것과 같은 원칙이다.)
 */

export const FUSION_DEFAULTS = {
  /** 이보다 많아지면 가중치 낮은 후보부터 버린다 (갈림길마다 분기하므로 상한이 필요) */
  maxCandidates: 60,
  /** 이보다 가벼운 후보는 버린다 */
  minWeight: 1e-4,

  /** 앵커 종류별 신뢰도 — 이 비율만큼 해당 위치로 믿음을 모은다 */
  anchorTrust: {
    beacon: 0.90,
    geofence: 0.95,
    barometer: 0.90,
    magnetic: 0.70,   // 누적 확정. 시퀀스가 맞아야 부르므로 낮지 않다
    manual: 1.00,     // QR·사용자 확인 — 사람이 직접 알려준 것
  },

  /**
   * 앵커가 그럴듯한 범위 = `anchorSlackSteps + 마지막 앵커 이후 걸음 × anchorSlackFactor`
   *
   * 다중경로 반사로 멀리 있는 비콘이 한 번 세게 잡히는 일이 있다. 그걸 그대로
   * 믿으면 위치가 건물 반대편으로 순간이동하고, 확신도까지 1.0이 되어 **틀렸는데
   * 자신 있는** 최악의 상태가 된다.
   *
   * 판정 기준을 홉 수가 아니라 **걸음 거리**로 두는 이유: 작은 건물에서는 거의 모든
   * 노드가 2홉 안이라 홉 수로는 아무것도 못 거른다. 반면 "4걸음 걸었는데 20걸음
   * 떨어진 곳에서 신호가 왔다"는 물리적으로 불가능하고, 이건 건물 크기와 무관하게
   * 성립한다.
   *
   * 멀면 후보로만 추가한다. 진짜라면 다음 스캔에도 또 들어와서 결국 이긴다 —
   * 비콘이 죽었거나 사용자가 빨리 걸어 중간 노드를 건너뛴 경우가 실제로 있다.
   */
  anchorSlackSteps: 6,
  anchorSlackFactor: 1.5,
  /** 범위 밖 앵커를 후보로 넣을 때 주는 비중. 반복되면 누적되어 결국 이긴다 */
  farAnchorWeight: 0.35,

  /** 참고 단서가 후보를 깎을 수 있는 하한. 0이면 제거가 되므로 절대 0으로 두지 않는다 */
  observeFloor: 0.55,

  /** 앵커 없이 이만큼 걸으면 확신도가 절반이 된다 */
  halfLifeSteps: 25,

  /**
   * 확신도를 잴 때 "같은 자리"로 볼 반경(m).
   *
   * 후보가 몇 개인지가 아니라 **얼마나 넓게 퍼져 있는지**를 재려는 것이다.
   * 후보 셋이 전부 2m 안에 몰려 있으면 위치는 사실상 아는 것이고, 셋이 복도
   * 양쪽으로 갈라져 있으면 모르는 것이다. 개수로 세면 이 둘이 같게 나온다.
   *
   * 우리가 필요한 해상도가 지점 단위("302호 앞")라 그보다 조금 좁게 잡았다.
   */
  sameSpotM: 4,

  /** 갈림길에서 왔던 길로 되돌아가는 후보에 주는 벌점 (U턴은 드물다) */
  reversePenalty: 0.35,
};

export class Fusion {
  /**
   * @param {FloorPlan} floorPlan
   * @param {Object} opts FUSION_DEFAULTS 덮어쓰기
   */
  constructor(floorPlan, opts = {}) {
    this.opts = { ...FUSION_DEFAULTS, ...opts, anchorTrust: { ...FUSION_DEFAULTS.anchorTrust, ...(opts.anchorTrust || {}) } };
    this.setFloorPlan(floorPlan);
    this.reset();
  }

  setFloorPlan(floorPlan) {
    this.plan = floorPlan;
    this.adjacent = new Map(floorPlan.nodes.map(n => [n.id, []]));
    for (const e of floorPlan.edges) {
      this.adjacent.get(e.a)?.push({ edge: e, other: e.b });
      this.adjacent.get(e.b)?.push({ edge: e, other: e.a });
    }
  }

  reset() {
    /** @type {Map<string, {from, to, step, steps, w}>} */
    this.cands = new Map();
    this.stepsSinceAnchor = 0;
    this.lastSource = null;
    this.totalSteps = 0;
  }

  // ─────────────────────────────────────────────── 확정 단서

  /**
   * "여기다" — 믿음을 nodeId 쪽으로 모은다. 즉시 확정과 누적 확정이 같은 문을 쓴다.
   * 둘의 차이는 **누가 언제 부르느냐**이지 하는 일이 아니다.
   *
   * @param {string} nodeId
   * @param {Object} o
   * @param {string} o.kind    'beacon' | 'geofence' | 'barometer' | 'magnetic' | 'manual'
   * @param {boolean} o.trusted 사람이 직접 알려준 값 — 거리 검사 없이 그대로 믿는다
   * @param {number} [o.trust] 이번 건만 신뢰도를 따로 준다
   * @param {boolean} [o.physical] 그래프와 무관한 물리 증거 — 거리 검사를 건너뛴다.
   *
   * 거리 검사는 "반사로 잡힌 먼 비콘"을 막으려는 것이다. 그런데 **고도가 3.5m
   * 변했다**는 사실은 그래프와 무관하게 참이고, 층이 바뀌었으면 엘리베이터나
   * 계단을 지난 것 말고는 설명이 없다. 이런 증거까지 "0걸음 걸었는데 20걸음
   * 떨어진 곳"이라며 깎으면, 맞는 신호를 틀렸다고 우기는 꼴이 된다.
   */
  anchorAt(nodeId, { kind = 'beacon', trusted = false, trust: override, physical = false } = {}) {
    if (!this.plan.hasNode(nodeId)) return;
    const trust = trusted ? 1
      : Number.isFinite(override) ? Math.max(0, Math.min(1, override))
      : (this.opts.anchorTrust[kind] ?? 0.8);

    // 아직 아무것도 모르거나, 사람이 직접 알려줬으면 그대로 확정한다
    if (trusted || this.cands.size === 0) {
      this._collapseTo(nodeId);
      this._afterAnchor(kind);
      return;
    }

    let eff;
    if (physical) {
      eff = trust;   // 거리 검사 없음 — 증거가 그래프에 기대지 않는다
    } else {
      // 걸어온 만큼으로 닿을 수 있는 거리인가 — 그 안에 있는 믿음의 비중
      const dist = this._stepDistancesFrom(nodeId);
      const budget = this.opts.anchorSlackSteps
        + this.stepsSinceAnchor * this.opts.anchorSlackFactor;
      let reachable = 0;
      for (const c of this.cands.values()) {
        if (this._candDistance(c, dist) <= budget) reachable += c.w;
      }
      // 믿음의 일부만 닿는다면 그만큼 덜 믿는다. 전부 닿으면 신뢰도 그대로.
      eff = reachable <= 0
        ? trust * this.opts.farAnchorWeight
        : trust * (0.4 + 0.6 * reachable);
    }

    this._scaleAll(1 - eff);
    this._addNodeCandidates(nodeId, eff);

    this._normalize();
    this._afterAnchor(kind);
  }

  /**
   * **통로 위 한 점**을 확정한다. 노드가 아니라.
   *
   * 지자기는 "어느 노드"가 아니라 "어디쯤"을 안다. 지문이 통로 한가운데와 맞았는데
   * 그 통로의 끝 노드에 앵커를 놓으면 남은 절반을 순간이동해 버린다. 실제로 그렇게
   * 짰다가 갈림길 시험에서 사람이 통로 끝으로 튀었다.
   *
   * 거리 검사는 하지 않는다 — 이 위치는 **이미 우리가 들고 있던 후보 중 하나**라서
   * 정의상 도달 가능하다.
   *
   * @param {{from,to,step,steps}} pos
   */
  anchorAtPosition(pos, { kind = 'magnetic', trust = 0.8 } = {}) {
    if (!this.plan.hasNode(pos?.from) || !this.plan.hasNode(pos?.to)) return;
    const eff = Math.max(0, Math.min(1, trust));
    this._scaleAll(1 - eff);
    this._merge(this.cands, { from: pos.from, to: pos.to, step: pos.step, steps: pos.steps, w: eff });
    this._normalize();
    this._afterAnchor(kind);
  }

  /**
   * **확인** — "지금 믿는 곳이 맞다"는 증거가 들어왔다. 위치는 그대로 두고
   * 신선도만 되살린다.
   *
   * 앵커와 다르다. 앵커는 믿음을 옮기고, 확인은 믿음을 유지한 채 시계만 되돌린다.
   *
   * 이게 없으면 정보를 버리게 된다. 비콘은 "가장 가까운 노드"를 계속 말해 주는데,
   * 노드가 안 바뀌면 앵커를 놓지 않으므로(놓으면 걸음이 지워진다) 그 신호가
   * 통째로 무시됐다. 실제로 60걸음 걷는 동안 확신도가 다섯 번 문턱 아래로
   * 떨어졌는데, **그 내내 비콘은 맞는 답을 계속 보내고 있었다.**
   *
   * 확신도의 신선도는 "얼마나 오래 아무 증거가 없었나"를 재는 값이다.
   * 증거가 계속 들어오고 있으면 떨어질 이유가 없다.
   */
  confirm(kind = 'beacon') {
    if (this.cands.size === 0) return;
    this.stepsSinceAnchor = 0;
    this.lastSource = kind;
  }

  /** 이 노드가 지금 믿는 위치와 맞아떨어지나 — 확인을 놓아도 되는지 판단용 */
  agreesWith(nodeId) {
    const c = this.best();
    return !!c && (c.from === nodeId || c.to === nodeId);
  }

  _afterAnchor(kind) {
    this.stepsSinceAnchor = 0;
    this.lastSource = kind;
  }

  // ─────────────────────────────────────────────── 이동

  /**
   * 한 걸음 — 모든 후보를 전진시킨다. 노드에 닿은 후보는 그 노드의 통로들로 분기한다.
   * @param {Object} o
   * @param {number} [o.heading] 이 걸음의 진행 방위(도, 자북). 주면 분기 직후 바로 걸러낸다.
   */
  step({ heading } = {}) {
    if (this.cands.size === 0) return;
    const next = new Map();

    for (const c of this.cands.values()) {
      if (c.step < c.steps) {
        this._merge(next, { ...c, step: c.step + 1 });
        continue;
      }
      // 노드 `to` 에 도착해 있다 — 여기서 갈 수 있는 통로로 나뉜다
      const links = this.adjacent.get(c.to) || [];
      if (links.length === 0) { this._merge(next, c); continue; }
      for (const { edge, other } of links) {
        const back = other === c.from;
        const steps = this.plan.edgeSteps(edge);
        this._merge(next, {
          from: c.to, to: other, step: 1, steps,
          w: c.w * (back ? this.opts.reversePenalty : 1) / links.length,
        });
      }
    }

    this.cands = next;
    this.stepsSinceAnchor++;
    this.totalSteps++;
    this.lastSource = 'pdr';
    if (Number.isFinite(heading)) this.observeHeading(heading);
    this._normalize();
    this._prune();
  }

  // ─────────────────────────────────────────────── 참고 단서

  /**
   * 임의의 참고 단서. fn 이 후보마다 0~1 을 돌려주면 그만큼 곱한다.
   * **하한이 걸리므로 후보가 사라지지는 않는다.**
   * @param {(c: {from, to, step, steps}) => number} fn
   */
  observe(fn) {
    if (this.cands.size === 0) return;
    const floor = this.opts.observeFloor;
    for (const c of this.cands.values()) {
      const raw = fn({ from: c.from, to: c.to, step: c.step, steps: c.steps });
      const m = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1;
      c.w *= floor + (1 - floor) * m;
    }
    this._normalize();
  }

  /**
   * 나침반 — 진행 방위와 어긋나는 후보를 깎는다.
   *
   * 도면의 `northOffset` 을 모르면 **아무것도 하지 않는다.** 도면 안에서의 각도와
   * 나침반 각도는 기준이 달라서, 모르는 채로 비교하면 전부 틀린 값으로 깎게 된다.
   */
  observeHeading(deg) {
    if (!Number.isFinite(deg) || this.plan.northOffset === null) return;
    this.observe(c => {
      const expected = this.plan.trueBearing(c.from, c.to);
      if (expected === null) return 1;
      const d = ((expected - deg + 540) % 360) - 180;
      return (Math.cos((d * Math.PI) / 180) + 1) / 2;   // 같은 방향 1, 반대 0
    });
  }

  // ─────────────────────────────────────────────── 출력

  /** 가장 그럴듯한 후보 하나 */
  best() {
    let top = null;
    for (const c of this.cands.values()) if (!top || c.w > top.w) top = c;
    return top;
  }

  /**
   * 지금 위치. 후보들의 평균이 아니라 **1등 후보**를 그대로 낸다 —
   * 서로 떨어진 후보를 평균 내면 아무도 없는 지점이 나오기 때문이다.
   */
  position() {
    const c = this.best();
    if (!c) return null;
    const a = this.plan.getNode(c.from);
    const b = this.plan.getNode(c.to);
    const t = c.steps > 0 ? c.step / c.steps : 1;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      from: c.from,
      to: c.to,
      progress: t,
      nodeId: t < 0.5 ? c.from : c.to,
      edgeId: this._edgeIdBetween(c.from, c.to),
    };
  }

  /**
   * 확신도 0~1 = **집중도 × 신선도**.
   *
   *   집중도  믿음이 한 곳에 모여 있나 (후보가 흩어져 있으면 낮다)
   *   신선도  마지막 확정 단서로부터 얼마나 걸었나 (오래 걸으면 낮다)
   *
   * 둘을 곱하는 이유: 후보가 하나뿐이어도 30걸음째 확정 없이 걸었다면 그 하나가
   * 맞다는 근거가 없다. 집중도만 보면 그때도 100% 가 나오는데, 그것이 이 시스템에서
   * 가장 위험한 상태다 — **틀렸는데 자신 있는 상태.**
   */
  confidence() {
    if (this.cands.size === 0) return 0;

    // 집중도 = **1등 자리 주변에 모인 믿음의 비율.**
    //
    // 처음에는 후보 개수로 쟀다(1/perplexity). 그런데 그 방식은 후보가 어디에
    // 있는지를 안 본다. 후보 셋이 전부 1m 안에 몰려 있어도, 복도 양쪽 끝으로
    // 갈라져 있어도 똑같이 "셋"으로 센다.
    //
    // 실제로 그렇게 재보니 위치 오차가 평균 1.6m 인데 확신도가 0.4 로 나왔다.
    // 잘 맞히고 있으면서 스스로를 못 믿는 상태다 — 그러면 화면이 멀쩡한 안내를
    // 멈춘다. 확신도는 "몇 개인가"가 아니라 **"얼마나 좁은가"**여야 한다.
    const best = this.best();
    const p0 = this._xy(best);
    const r = this.opts.sameSpotM;
    let near = 0;
    for (const c of this.cands.values()) {
      const p = this._xy(c);
      if (Math.hypot(p.x - p0.x, p.y - p0.y) * this.plan.metersPerUnit <= r) near += c.w;
    }

    const freshness = Math.pow(0.5, this.stepsSinceAnchor / this.opts.halfLifeSteps);
    return Math.max(0, Math.min(1, near * freshness));
  }

  /** 무엇으로 알았나 — 화면에 "비콘이 확정" / "걸음 수로 추정 중"을 구분해 보여준다 */
  source() { return this.lastSource; }

  /** 디버그·관제용: 후보 목록 (가중치 내림차순) */
  snapshot() {
    return [...this.cands.values()]
      .sort((a, b) => b.w - a.w)
      .map(c => ({ from: c.from, to: c.to, step: c.step, steps: c.steps, weight: c.w }));
  }

  // ─────────────────────────────────────────────── 내부

  /** 노드에 서 있는 상태를 후보로 만든다 — 그 노드로 들어오는 모든 방향을 편다 */
  _addNodeCandidates(nodeId, weight) {
    const links = this.adjacent.get(nodeId) || [];
    if (links.length === 0) return;
    const each = weight / links.length;
    for (const { edge, other } of links) {
      // "other 에서 nodeId 로 걸어와 막 도착했다" — step === steps
      const steps = this.plan.edgeSteps(edge);
      this._merge(this.cands, { from: other, to: nodeId, step: steps, steps, w: each });
    }
  }

  _collapseTo(nodeId) {
    this.cands = new Map();
    this._addNodeCandidates(nodeId, 1);
    this._normalize();
  }

  _merge(map, c) {
    const key = `${c.from}>${c.to}@${c.step}`;
    const prev = map.get(key);
    if (prev) prev.w += c.w;
    else map.set(key, { ...c });
  }

  _scaleAll(f) { for (const c of this.cands.values()) c.w *= f; }

  _normalize() {
    let sum = 0;
    for (const c of this.cands.values()) sum += c.w;
    if (sum <= 0) { this.cands.clear(); return; }
    for (const c of this.cands.values()) c.w /= sum;
  }

  _prune() {
    if (this.cands.size <= this.opts.maxCandidates) {
      for (const [k, c] of this.cands) if (c.w < this.opts.minWeight) this.cands.delete(k);
      this._normalize();
      return;
    }
    const keep = [...this.cands.entries()]
      .sort((a, b) => b[1].w - a[1].w)
      .slice(0, this.opts.maxCandidates);
    this.cands = new Map(keep);
    this._normalize();
  }

  /** 후보의 도면 좌표 */
  _xy(c) {
    const a = this.plan.getNode(c.from);
    const b = this.plan.getNode(c.to);
    const t = c.steps > 0 ? c.step / c.steps : 1;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  }

  /** nodeId 에서 각 노드까지의 걸음 거리 (다익스트라, 엣지 무게 = 걸음 수) */
  _stepDistancesFrom(nodeId) {
    const dist = new Map([[nodeId, 0]]);
    const queue = [[0, nodeId]];
    while (queue.length) {
      queue.sort((p, q) => p[0] - q[0]);
      const [d, n] = queue.shift();
      if (d > (dist.get(n) ?? Infinity)) continue;
      for (const { edge, other } of this.adjacent.get(n) || []) {
        const nd = d + this.plan.edgeSteps(edge);
        if (nd < (dist.get(other) ?? Infinity)) {
          dist.set(other, nd);
          queue.push([nd, other]);
        }
      }
    }
    return dist;
  }

  /** 후보가 앵커에서 몇 걸음 떨어져 있나 — 양쪽 끝 중 가까운 쪽으로 잰다 */
  _candDistance(c, dist) {
    const viaFrom = (dist.get(c.from) ?? Infinity) + c.step;
    const viaTo = (dist.get(c.to) ?? Infinity) + (c.steps - c.step);
    return Math.min(viaFrom, viaTo);
  }

  _edgeIdBetween(a, b) {
    const link = (this.adjacent.get(a) || []).find(l => l.other === b);
    return link ? link.edge.id : null;
  }
}
