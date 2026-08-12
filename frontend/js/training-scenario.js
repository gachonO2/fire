import { routeToNearestExit } from '../shared/pathfinding.js';

const VIRTUAL_FIRE = Object.freeze({
  type: 'fire',
  label: '가상 화재',
  training: true,
});

function signature(route) {
  return route?.edges?.map(edge => edge.id).join(',') ?? '';
}

function scenarioForEdge(plan, edge, baseHazards, normalRoute, changesRoute) {
  const hazards = {
    ...baseHazards,
    [edge.id]: VIRTUAL_FIRE,
  };
  const safeRoute = routeToNearestExit(plan, normalRoute.nodes[0], hazards);
  if (!safeRoute) return null;

  const a = plan.getNode(edge.a);
  const b = plan.getNode(edge.b);
  if (!a || !b) return null;
  const x = (a.x + b.x) / 2;
  const y = (a.y + b.y) / 2;
  const near = plan.nearestPlace(x, y)?.node;

  return {
    hazards: { [edge.id]: VIRTUAL_FIRE },
    where: near?.name || `${a.name}과 ${b.name} 사이 통로`,
    fire: { id: 'virtual-training-fire', x, y, radius: 2, training: true },
    route: safeRoute,
    changesRoute,
  };
}

/**
 * 훈련 화재를 배치하되 사용자가 출구까지 갈 수 있는 경우만 반환한다.
 * 최단 경로를 막아 우회할 수 있으면 우회 훈련을 만들고, 이미 위험이 많아
 * 우회가 불가능하면 현재 안전 경로 밖의 통로에 불을 배치한다.
 */
export function createSafeTrainingScenario(plan, startNodeId, baseHazards = {}) {
  const normalRoute = routeToNearestExit(plan, startNodeId, baseHazards);
  if (!normalRoute?.edges?.length) return null;

  const normalSignature = signature(normalRoute);
  for (const edge of normalRoute.edges) {
    const scenario = scenarioForEdge(plan, edge, baseHazards, normalRoute, true);
    if (scenario && signature(scenario.route) !== normalSignature) return scenario;
  }

  const normalEdgeIds = new Set(normalRoute.edges.map(edge => edge.id));
  for (const edge of plan.edges) {
    if (normalEdgeIds.has(edge.id) || baseHazards[edge.id]) continue;
    const scenario = scenarioForEdge(plan, edge, baseHazards, normalRoute, false);
    if (scenario) return scenario;
  }

  return null;
}
