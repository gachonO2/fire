/**
 * 로컬 경로탐색 — 서버에 닿지 못할 때만 쓰는 예비 계산.
 *
 * ## "앱은 계산하지 않는다"와 어긋나지 않는가
 *
 * 원칙은 그대로다: **서버가 닿으면 서버가 정답이다.** 판단을 두 곳에 두면
 * 관제 화면과 앱이 다른 말을 하게 되고 대피 중에 그건 치명적이다.
 *
 * 다만 "서버가 죽었을 때 안내를 통째로 멈춘다"는 그보다 나쁘다. 불이 난
 * 순간에 망이 먼저 죽는 일이 흔하고, 그때 시각장애인은 아무 안내도 못 받는다.
 * 그래서 **닿을 때는 서버, 못 닿을 때만 여기**라는 순서를 지킨다.
 * (웹 앱도 같은 구조다 — `../fire/frontend/js/api.js` 의 오프라인 폴백)
 *
 * `../fire/shared/pathfinding.js` 를 옮겨 온 것이다. 두 프로젝트가 npm 으로
 * 이어져 있지 않아 복사했다. **경로 규칙을 고칠 일이 생기면 양쪽을 함께 고칠 것.**
 * 서버 응답과 같은 모양을 돌려주므로(엣지는 id 배열) 부르는 쪽은 구분할 필요가 없다.
 */

/** 위험 등급 — 서버(`shared/hazard-rules.js`)와 같은 기준을 쓴다 */
const RULES = {
  fire: { passable: false },
  smoke: { passable: false },
  heat: { passable: false },
  blocked: { passable: false },
  warm: { passable: true, penalty: 4 },
  crowd: { passable: true, penalty: 3 },
};

function nodeMap(plan) {
  return new Map((plan.nodes || []).map(n => [n.id, n]));
}

function edgeMeters(plan, edge, nodes) {
  const a = nodes.get(edge.a);
  const b = nodes.get(edge.b);
  if (!a || !b) return Infinity;
  return Math.hypot(b.x - a.x, b.y - a.y) * (plan.metersPerUnit ?? 1);
}

/** 인접 리스트. 화재 모드에서는 엘리베이터 구간을 통째로 뺀다. */
function buildGraph(plan, hazards = {}) {
  const nodes = nodeMap(plan);
  const adj = {};
  for (const n of plan.nodes || []) adj[n.id] = [];

  for (const edge of plan.edges || []) {
    if (edge.elevator) continue;               // 화재 시 엘리베이터 금지
    const hazard = hazards[edge.id];
    let weight = edgeMeters(plan, edge, nodes);
    if (hazard) {
      const rule = RULES[hazard.type] || RULES.blocked;
      if (!rule.passable) continue;
      weight *= rule.penalty ?? 1;
    }
    adj[edge.a]?.push({ to: edge.b, edgeId: edge.id, weight });
    adj[edge.b]?.push({ to: edge.a, edgeId: edge.id, weight });
  }
  return adj;
}

/** Dijkstra. 경로가 없으면 null */
function shortestPath(adj, fromId, toId) {
  if (!adj[fromId]) return null;
  const dist = {};
  const prev = {};
  const visited = new Set();
  for (const id in adj) dist[id] = Infinity;
  dist[fromId] = 0;

  // 지점 수십 개 규모라 배열 큐로 충분하다
  const queue = [{ id: fromId, d: 0 }];
  while (queue.length > 0) {
    queue.sort((a, b) => a.d - b.d);
    const { id } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === toId) break;

    for (const { to, edgeId, weight } of adj[id]) {
      const nd = dist[id] + weight;
      if (nd < dist[to]) {
        dist[to] = nd;
        prev[to] = { from: id, edgeId };
        queue.push({ id: to, d: nd });
      }
    }
  }

  if (!Number.isFinite(dist[toId])) return null;

  const nodes = [toId];
  const edges = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev[cur];
    edges.unshift(p.edgeId);
    nodes.unshift(p.from);
    cur = p.from;
  }
  return { nodes, edges, distance: dist[toId] };
}

/**
 * 접근 가능한 가장 가까운 출구까지의 경로.
 * @returns {{nodes, edges, distance, exit}|null} 모든 출구가 막혔으면 null —
 *          억지로 안내하지 않는다. 그건 안내를 안 하느니만 못하다.
 */
export function routeToNearestExit(plan, fromId, hazards = {}) {
  if (!plan?.nodes?.some(n => n.id === fromId)) return null;

  const adj = buildGraph(plan, hazards);
  const exits = plan.nodes.filter(n => n.type === 'exit');
  let best = null;

  for (const exit of exits) {
    if (exit.id === fromId) return { nodes: [fromId], edges: [], distance: 0, exit };
    const path = shortestPath(adj, fromId, exit.id);
    if (path && (!best || path.distance < best.distance)) best = { ...path, exit };
  }
  return best;
}
