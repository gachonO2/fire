/**
 * 도면 위 기하 계산.
 *
 * 화재는 통로 위가 아니라 **임의의 지점**에서 난다. 그래서 "이 통로가 불에서
 * 얼마나 떨어져 있나"를 알려면 점과 선분 사이의 최단거리가 필요하다.
 * 통로 양 끝점까지의 거리만 재면, 복도 한가운데에 난 불을 놓치게 된다.
 */

/** 점 P에서 선분 AB까지의 최단거리 */
export function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);

  // 선분 위로 투영한 위치를 0~1로 자른다 (선분 밖이면 가까운 끝점)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 선분 AB 위에서 점 P에 가장 가까운 지점 */
export function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: ax, y: ay };
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * dx, y: ay + t * dy };
}
