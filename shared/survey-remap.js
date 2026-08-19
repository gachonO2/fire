/**
 * 답사를 **좌표로 다시 잇는다.**
 *
 * ## 왜 필요한가
 *
 * 도면을 다시 판독하면 같은 방이라도 지점 id 가 새로 붙는다
 * (`R_ACCEL` → `R_ACCELLAB`). 답사는 `비콘 → 지점 id` 로 저장되므로, 그 순간
 * 가리키는 지점이 도면에 없어지고 위치 판정이 통째로 죽는다 — 건물을 다시
 * 걸어야 한다.
 *
 * 시연은 «도면 인식» 부터 시작한다. 그 자리에서 사진을 찍어 판독하는 장면이
 * 이 시스템의 첫 장인데, 그것을 하는 순간 어제 걸어서 만든 답사가 사라지면
 * 뒤에 남은 것이 없다.
 *
 * ## 좌표는 살아남는다
 *
 * 지점 이름과 id 는 판독할 때마다 달라지지만, **좌표는 같은 사진에서 나온다.**
 * 302호 앞은 다시 읽어도 사진의 같은 자리다. 그래서 답사할 때 좌표를 함께
 * 남겨 두고, 도면이 바뀌면 그 좌표에서 가장 가까운 새 지점으로 옮긴다.
 *
 * ## 억지로 잇지 않는다
 *
 * 너무 멀면(도면 크기의 5% 밖) 옮기지 않고 뺀다. 다른 층 도면을 열었을 때는
 * 짝이 하나도 없는 게 정상이고, 그때 가장 가까운 지점에 갖다 붙이면 6층
 * 신호가 3층 방에 붙는다. **모르는 것은 비워 두는 편이 낫다.**
 */

/** 도면 크기 대비 이 비율 안쪽이라야 «같은 자리» 로 본다 */
export const REMAP_TOLERANCE = 0.05;

/**
 * @param {Object} plan 지금 도면 (`nodes`, 있으면 `image`)
 * @param {Object<string,string>} surveyed 비콘 id → 지점 id (저장본)
 * @param {Object<string,[number,number]>} spotXY 지점 id → 답사 당시 좌표
 * @returns {{mapping: Object<string,string>, kept: number, remapped: number, dropped: number}}
 */
export function remapSurvey(plan, surveyed = {}, spotXY = {}) {
  const nodes = plan?.nodes || [];
  const empty = { mapping: {}, kept: 0, remapped: 0, dropped: 0 };
  if (!nodes.length) return empty;

  const byId = new Map(nodes.map(n => [n.id, n]));
  const span = Math.max(plan.image?.width || 0, plan.image?.height || 0)
    || Math.max(...nodes.map(n => Math.max(n.x, n.y)), 1);
  const limit = span * REMAP_TOLERANCE;

  // 같은 지점을 여러 비콘이 가리키므로 지점당 한 번만 계산한다
  const resolved = new Map();
  const mapping = {};
  let kept = 0, remapped = 0, dropped = 0;

  for (const [beaconId, nodeId] of Object.entries(surveyed)) {
    if (byId.has(nodeId)) { mapping[beaconId] = nodeId; kept++; continue; }

    if (!resolved.has(nodeId)) {
      const xy = spotXY[nodeId];
      let best = null;
      let bestD = Infinity;
      if (xy) {
        for (const n of nodes) {
          const d = Math.hypot(n.x - xy[0], n.y - xy[1]);
          if (d < bestD) { bestD = d; best = n; }
        }
      }
      resolved.set(nodeId, best && bestD <= limit ? best.id : null);
    }
    const to = resolved.get(nodeId);
    if (to) { mapping[beaconId] = to; remapped++; }
    else dropped++;
  }
  return { mapping, kept, remapped, dropped };
}
