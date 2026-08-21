/**
 * 층 이동 판정 → 판단 계층 연결.
 *
 * `AltitudeTracker` 가 "엘리베이터로 한 층 올라갔다"를 내면, 이 파일이 그것을
 * 도면의 어느 노드에 놓을지 정한다. `beacon-anchor.js` 와 같은 역할이다 —
 * 신호 쪽 모듈과 판단 계층이 서로를 모른 채로 있게 한다.
 *
 * ## 어느 노드에 놓는가
 *
 * 층 이동의 종류가 곧 노드 유형이다. 엘리베이터로 올라갔으면 지금 서 있는 곳은
 * `elevator` 노드다 — 다른 곳일 수가 없다. 그래서 이 앵커는 비콘만큼 확실하다.
 *
 * 한 층에 같은 유형이 여럿이면(계단 A·B) **지금 믿고 있는 곳에서 가까운 쪽**을
 * 고른다. 방금 전까지 로비 근처에 있었다면 로비 옆 계단이지 건물 반대편 계단이
 * 아니다. 판단 계층이 이미 걸음 거리를 재고 있으므로 그걸 쓴다.
 *
 * ## 층이 바뀌면 도면도 바뀌어야 한다
 *
 * 지금 `FloorPlan` 은 한 층짜리다. 층 이동을 감지해도 **새 층의 도면으로 갈아
 * 끼우는 일은 앱이 해야 한다** — `floors` 를 같이 돌려주는 이유다.
 * 도면을 안 바꾸면 "3층 엘리베이터"를 2층 도면의 엘리베이터로 잡게 된다.
 * (여러 층을 한 그래프로 잇는 것은 다음 단계다.)
 */

/** 층 이동 종류 → 도면 노드 유형 */
const NODE_TYPE = { elevator: 'elevator', stair: 'stair' };

export class FloorChangeAnchor {
  /**
   * @param {Fusion} fusion
   * @param {FloorPlan} floorPlan
   */
  constructor(fusion, floorPlan) {
    this.fusion = fusion;
    this.setFloorPlan(floorPlan);
  }

  setFloorPlan(floorPlan) { this.plan = floorPlan; }

  /**
   * 층 이동 결과를 앵커로 놓는다.
   * @param {{kind:'elevator'|'stair', floors:number}} change AltitudeTracker.push() 결과
   * @returns {string|null} 앵커를 놓은 노드 id. 해당 유형의 노드가 없으면 null.
   */
  apply(change) {
    if (!change) return null;
    const type = NODE_TYPE[change.kind];
    if (!type) return null;

    const targets = this.plan.nodes.filter(n => n.type === type);
    if (targets.length === 0) return null;   // 도면에 그 유형이 없다 — 조용히 넘어간다

    // 층에 그 유형이 하나뿐이면 다른 곳일 수가 없다 — 사람이 알려준 것만큼 확실하다.
    // 여럿이면 가까운 쪽을 고르되, 고른 게 틀렸을 여지를 남긴다.
    //
    // 어느 쪽이든 **거리 검사는 건너뛴다**(`physical`). 고도가 3.5m 변했다는 것은
    // 그래프와 무관하게 참이라, "0걸음 걸었는데 20걸음 떨어진 곳"이라며 깎으면
    // 맞는 신호를 틀렸다고 우기게 된다.
    if (targets.length === 1) {
      this.fusion.anchorAt(targets[0].id, { kind: 'barometer', trusted: true });
      return targets[0].id;
    }
    const nodeId = this._nearest(targets);
    this.fusion.anchorAt(nodeId, { kind: 'barometer', physical: true });
    return nodeId;
  }

  /** 지금 믿고 있는 위치에서 걸음 거리가 가장 가까운 후보 */
  _nearest(targets) {
    const best = this.fusion.best();
    if (!best) return targets[0].id;
    let pick = targets[0].id;
    let min = Infinity;
    for (const t of targets) {
      const dist = this.fusion._stepDistancesFrom(t.id);
      const d = this.fusion._candDistance(best, dist);
      if (d < min) { min = d; pick = t.id; }
    }
    return pick;
  }
}
