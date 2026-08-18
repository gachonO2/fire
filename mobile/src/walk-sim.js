/**
 * 가상 보행자 — 시뮬레이션에서 **"실제로 서 있는 곳"** 을 든다.
 *
 * ## 왜 필요한가
 *
 * 가상 비콘은 어딘가에서 신호를 만들어야 하는데, 그 "어딘가"를 무엇으로 두느냐가
 * 시뮬레이션의 정직함을 정한다.
 *
 * 처음에는 **계획된 경로 위 위치**를 썼다. 그러면 절대 안 깨지지만, 사용자가 어디로
 * 걷든 가상 위치는 경로를 따라간다. 즉 **경로 이탈을 재현할 수 없고**, 비콘과 걸음이
 * 어긋나는 장면도 안 나온다. 둘 다 같은 값에서 나오니 서로 동의할 수밖에 없다.
 *
 * 반대로 순수 추측항법(걸음×방위를 그대로 더하기)은 방향을 틀면 진짜로 틀어지지만
 * **오차가 무한정 쌓인다.** 나침반이 5° 틀어져 있으면 20m 에 1.7m 어긋나고, 계속
 * 커져서 벽을 뚫고 나간다. 똑바로 걸어도 시연이 깨진다.
 *
 * ## 그래서 그래프에 가둔다
 *
 * 사람은 건물 안에서 복도를 따라 걷는다. 벽을 뚫고 갈 수 없다.
 *
 *   복도 안에서   걸음 수만큼 전진
 *   갈림길에서    나침반이 가리키는 쪽 복도로 꺾는다
 *
 * 이러면 안내대로 걸을 때는 경로를 따라가고(시연이 안 깨지고), 갈림길에서 딴 쪽으로
 * 꺾으면 진짜로 그쪽으로 간다(이탈이 재현되고), 오래 걸어도 복도에 갇혀 있어
 * 드리프트가 안 쌓인다.
 *
 * ## 시뮬레이션의 원리적 한계
 *
 * 이걸로도 "실제로 몇 미터 틀리나"는 못 낸다. 정답을 재는 것으로부터 만들고 있어서다.
 *
 *     현실:  진짜 위치 → 신호 → 추정        (비교 가능)
 *     여기:  걸음·방위 → 진짜 위치 → 신호 → 추정   (순환)
 *
 * 배관과 반응은 검증되지만 정확도는 실물 비콘을 달아야 안다. 이 파일은 그 한계
 * 안에서 **가장 현실에 가까운** 구조일 뿐이다.
 */

import { FloorPlan } from './floor-plan.js';

export class WalkSim {
  /**
   * @param {Object} plan 도면(평범한 객체 또는 FloorPlan)
   * @param {string} startNodeId 출발 지점
   */
  constructor(plan, startNodeId) {
    this.plan = plan instanceof FloorPlan ? plan : new FloorPlan(plan);
    this.adjacent = new Map(this.plan.nodes.map(n => [n.id, []]));
    for (const e of this.plan.edges) {
      this.adjacent.get(e.a)?.push({ edge: e, other: e.b });
      this.adjacent.get(e.b)?.push({ edge: e, other: e.a });
    }
    this.reset(startNodeId);
  }

  reset(startNodeId) {
    const start = this.plan.hasNode(startNodeId)
      ? startNodeId
      : this.plan.nodes[0]?.id;
    const first = (this.adjacent.get(start) || [])[0];
    if (!first) { this.at = null; return; }
    // "start 에 서 있고, 아직 어느 통로에도 들어서지 않았다"
    this.at = {
      from: start,
      to: first.other,
      step: 0,
      steps: this.plan.edgeSteps(first.edge),
    };
    this.totalSteps = 0;
  }

  /**
   * 한 걸음.
   * @param {number} [heading] 진행 방위(도, 자북). 갈림길에서 어느 쪽으로 갈지 정한다.
   *   모르면 **직진**한다 — 사람은 이유 없이 꺾지 않는다.
   */
  step(heading) {
    if (!this.at) return;
    this.totalSteps++;

    if (this.at.step < this.at.steps) {
      // 갈림길에 들어서기 전, 아직 노드에 서 있는 상태라면 방위로 통로를 고른다
      if (this.at.step === 0) this._chooseEdge(this.at.from, null, heading);
      this.at.step++;
      return;
    }

    // 통로 끝에 닿았다 — 다음 통로를 고른다
    this._chooseEdge(this.at.to, this.at.from, heading);
    this.at.step = 1;
  }

  /**
   * `node` 에서 나갈 통로를 고른다.
   * @param {string} node
   * @param {string|null} cameFrom 방금 지나온 노드 (되돌아가기를 덜 고르게 한다)
   * @param {number|undefined} heading 자북 기준 방위
   */
  _chooseEdge(node, cameFrom, heading) {
    const links = this.adjacent.get(node) || [];
    if (links.length === 0) return;

    const useHeading = Number.isFinite(heading) && this.plan.northOffset !== null;
    // 방위를 모르면 직진 — 지나온 방향과 가장 비슷한 쪽으로 이어 간다
    const ref = useHeading
      ? heading
      : (cameFrom !== null ? this.plan.trueBearing(cameFrom, node) : null);

    let best = links[0];
    if (ref !== null && ref !== undefined) {
      let bestScore = Infinity;
      for (const l of links) {
        const b = this.plan.trueBearing(node, l.other);
        if (b === null) continue;
        let d = Math.abs(((b - ref + 540) % 360) - 180);
        // 되돌아가기는 사람이 잘 안 한다. 방위가 확실히 뒤를 가리킬 때만 고른다.
        if (l.other === cameFrom) d += 60;
        if (d < bestScore) { bestScore = d; best = l; }
      }
    }

    this.at = {
      from: node,
      to: best.other,
      step: 0,
      steps: this.plan.edgeSteps(best.edge),
    };
  }

  /** 지금 서 있는 좌표 — 가상 비콘이 여기서 신호를 만든다 */
  position() {
    if (!this.at) return null;
    const a = this.plan.getNode(this.at.from);
    const b = this.plan.getNode(this.at.to);
    const t = this.at.steps > 0 ? this.at.step / this.at.steps : 0;
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      from: this.at.from,
      to: this.at.to,
      progress: t,
      nodeId: t < 0.5 ? this.at.from : this.at.to,
    };
  }

  /** 지금 있는 통로 id — 이탈 판정의 정답지 */
  edgeId() {
    if (!this.at) return null;
    const l = (this.adjacent.get(this.at.from) || []).find(x => x.other === this.at.to);
    return l ? l.edge.id : null;
  }
}
