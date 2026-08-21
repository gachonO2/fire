import { asyncRouter } from './async-router.js';
import { routeToNearestExit } from '../../../shared/pathfinding.js';
import { activeFloorPlan, currentHazards } from '../floor.js';
import { getRepo } from '../repositories/index.js';

export const evacuationRoutes = asyncRouter();

/** 현재 활성 도면 — 프론트도 오프라인용 사본을 갖지만, 여기가 단일 진실 소스다. */
evacuationRoutes.get('/map', async (req, res) => {
  const floorPlan = await activeFloorPlan();
  // 도면이 없으면 404. 빈 도면을 주면 앱이 "안내 가능"으로 착각한다.
  if (!floorPlan) return res.status(404).json({ error: '등록된 도면이 없습니다. 먼저 피난안내도를 등록하고 활성화해주세요.' });
  res.json(floorPlan.toJSON());
});

/**
 * 대피 경로 계산 (서버 권위).
 * 관제가 지정한 위험과 온도 센서 판독값을 함께 반영해 접근 가능한 최단 출구까지의
 * 경로를 돌려주고, 계산 소요시간을 metrics에 자동 기록한다
 * (가설 ③ 재탐색 2초 이내 검증용).
 *
 * body: { from: nodeId, kind?: 'initial'|'reroute', userId?: string }
 */
evacuationRoutes.post('/route', async (req, res) => {
  const { from, kind = 'initial', userId } = req.body || {};

  const floorPlan = await activeFloorPlan();
  if (!floorPlan) return res.status(404).json({ error: '등록된 도면이 없습니다. 먼저 피난안내도를 등록하고 활성화해주세요.' });
  if (!floorPlan.hasNode(from)) {
    return res.status(400).json({ error: `알 수 없는 시작 노드: ${from}` });
  }

  const hazards = await currentHazards(floorPlan);

  const t0 = performance.now();
  const route = routeToNearestExit(floorPlan, from, hazards);
  const ms = Math.round((performance.now() - t0) * 100) / 100;

  const repo = await getRepo();
  await repo.addMetric({ kind, ms, from, userId, found: Boolean(route) });

  if (!route) {
    // 모든 출구가 차단됨 — 프론트는 이 응답을 받으면 안전상태로 전환한다.
    return res.json({ route: null, ms, reason: '접근 가능한 대피 경로가 없습니다.' });
  }

  res.json({
    route: {
      nodes: route.nodes,
      edges: route.edges.map(e => e.id),
      distance: route.distance,
      exit: route.exit,
    },
    ms,
  });
});
