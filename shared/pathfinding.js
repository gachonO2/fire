/**
 * Dijkstra 경로탐색 — Anyplace의 utils/Dijkstra.scala(MIT)를 JS로 포팅.
 * 원본: 양방향 엣지 그래프에서 PriorityQueue 기반 최단경로.
 *
 * 확장: 재난 상황 반영 —
 *   · 차단(화재·연기·과열·통제) 통로 제외
 *   · 통행은 가능하나 위험한 통로(온도 상승·혼잡)는 가중치를 올려 회피
 *   · 화재 모드에서 엘리베이터 제외
 *
 * 지도는 인자로 받는다 (FloorPlan). 건물마다 다른 도면을 주입해 쓰기 위해서다.
 */

import { HAZARD_RULES } from './hazard-rules.js';

/**
 * @param {FloorPlan} floorPlan
 * @param {Object} hazards  edgeId -> { type } 활성 위험 맵
 * @param {Object} opts     { fireMode: 엘리베이터 제외 여부 }
 * @returns 인접 리스트 { nodeId: [{to, edge, weight}] }
 */
export function buildGraph(floorPlan, hazards = {}, opts = { fireMode: true }) {
  const adj = {};
  for (const n of floorPlan.nodes) adj[n.id] = [];

  for (const edge of floorPlan.edges) {
    if (opts.fireMode && edge.elevator) continue; // 화재 시 엘리베이터 금지

    const hazard = hazards[edge.id];
    let weight = floorPlan.edgeLength(edge);
    if (hazard) {
      const rule = HAZARD_RULES[hazard.type] || HAZARD_RULES.blocked;
      if (!rule.passable) continue;
      weight *= rule.penalty ?? 1;
    }
    adj[edge.a].push({ to: edge.b, edge, weight });
    adj[edge.b].push({ to: edge.a, edge, weight });
  }
  return adj;
}

/** Anyplace computePath 포팅: 최단경로. 경로 없으면 null */
export function shortestPath(adj, fromId, toId) {
  const dist = {};
  const prev = {};
  const visited = new Set();
  for (const id in adj) dist[id] = Infinity;
  if (dist[fromId] === undefined) return null;
  dist[fromId] = 0;

  // 소규모 그래프이므로 배열 기반 우선순위 큐로 충분
  const queue = [{ id: fromId, d: 0 }];
  while (queue.length > 0) {
    queue.sort((a, b) => a.d - b.d);
    const { id } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === toId) break;

    for (const { to, edge, weight } of adj[id]) {
      const nd = dist[id] + weight;
      if (nd < dist[to]) {
        dist[to] = nd;
        prev[to] = { from: id, edge };
        queue.push({ id: to, d: nd });
      }
    }
  }

  if (dist[toId] === Infinity || dist[toId] === undefined) return null;

  const nodes = [toId];
  const edges = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev[cur];
    edges.unshift(p.edge);
    nodes.unshift(p.from);
    cur = p.from;
  }
  return { nodes, edges, distance: dist[toId] };
}

/**
 * 접근 가능한 가장 가까운 출구까지의 경로.
 * @param {FloorPlan} floorPlan
 * @returns { nodes, edges, distance, exit } 또는 null(모든 출구 차단)
 */
export function routeToNearestExit(floorPlan, fromId, hazards = {}) {
  if (!floorPlan.hasNode(fromId)) return null;

  const adj = buildGraph(floorPlan, hazards, { fireMode: true });
  let best = null;
  for (const exit of floorPlan.exitNodes()) {
    if (exit.id === fromId) return { nodes: [fromId], edges: [], distance: 0, exit };
    const path = shortestPath(adj, fromId, exit.id);
    if (path && (!best || path.distance < best.distance)) {
      best = { ...path, exit };
    }
  }
  return best;
}
