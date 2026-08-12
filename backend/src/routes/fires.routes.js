import { Router } from 'express';
import { FIRE, hazardsFromFires, nodesInFire } from '../../../shared/hazard-rules.js';
import { activeFloorPlan } from '../floor.js';
import { getRepo } from '../repositories/index.js';

export const fireRoutes = Router();

const MAX_RADIUS = 60; // m — 한 층 규모를 넘는 값은 입력 실수로 본다

/**
 * 화재 발생 — 도면의 **임의 지점**에 불이 났다고 알린다.
 *
 * 통로를 지정하는 게 아니라 좌표를 찍는다. 실제 화재는 복도 한가운데나 방 안에서
 * 나지, 우리가 그려 둔 통로 선 위에서 나지 않기 때문이다.
 * 어떤 통로가 막히는지는 shared/hazard-rules.js 가 반경으로 판정한다.
 *
 * body: { x, y, radius?(m), label? }  — x, y는 도면 좌표
 */
fireRoutes.post('/fires', async (req, res) => {
  const { x, y, radius = FIRE.DEFAULT_RADIUS, label } = req.body || {};

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: 'x, y 좌표가 필요합니다.' });
  }
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_RADIUS) {
    return res.status(400).json({ error: `반경은 0보다 크고 ${MAX_RADIUS}m 이하여야 합니다.` });
  }

  const floorPlan = await activeFloorPlan();
  const repo = await getRepo();
  const fire = await repo.addFire({ x, y, radius, label: label || '화재 발생' });

  // 이 불로 실제로 막히는 통로를 응답에 담아 준다 (관제가 즉시 확인할 수 있도록)
  const blocked = hazardsFromFires([fire], floorPlan);
  const trapped = nodesInFire([fire], floorPlan);

  console.warn(`[화재] ${fire.id} (${Math.round(x)}, ${Math.round(y)}) 반경 ${radius}m — 통로 ${Object.keys(blocked).length}개 영향`);

  res.status(201).json({
    fire,
    blockedEdges: Object.entries(blocked)
      .filter(([, h]) => h.type === 'fire').map(([id]) => id),
    heatEdges: Object.entries(blocked)
      .filter(([, h]) => h.type === 'warm').map(([id]) => id),
    nodesInFire: trapped,
  });
});

fireRoutes.get('/fires', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.getFires());
});

/** 반경 변경 — 불이 번지는 상황을 관제에서 조절한다 */
fireRoutes.put('/fires/:fireId', async (req, res) => {
  const { radius } = req.body || {};
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_RADIUS) {
    return res.status(400).json({ error: `반경은 0보다 크고 ${MAX_RADIUS}m 이하여야 합니다.` });
  }
  const repo = await getRepo();
  const fire = await repo.updateFire(req.params.fireId, { radius });
  if (!fire) return res.status(404).json({ error: '화재 지점을 찾을 수 없습니다.' });
  res.json({ ok: true, fire });
});

fireRoutes.delete('/fires/:fireId', async (req, res) => {
  const repo = await getRepo();
  await repo.removeFire(req.params.fireId);
  res.json({ ok: true });
});

fireRoutes.post('/fires/reset', async (req, res) => {
  const repo = await getRepo();
  await repo.clearFires();
  res.json({ ok: true });
});
