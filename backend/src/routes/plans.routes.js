import { Router } from 'express';
import { validatePlan, FloorPlan, findUnreachableNodes } from '../../../shared/floor-plan.js';
import { getRepo } from '../repositories/index.js';
import { requireAdmin } from '../middleware/auth.js';

export const planRoutes = Router();

/** 도면 이미지 상한 — Firestore 문서 1MB 제한을 고려한 값 (편집기가 미리 축소해 보낸다) */
const MAX_IMAGE_BYTES = 900_000;

planRoutes.get('/plans', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.listPlans());
});

planRoutes.get('/plans/:planId', async (req, res) => {
  const repo = await getRepo();
  const plan = await repo.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '도면을 찾을 수 없습니다.' });
  res.json(plan);
});

/**
 * 도면 주입 — 건물의 설계도를 그래프로 등록한다.
 * 도면 편집기에서 그린 결과나, 다른 도구에서 내보낸 JSON을 그대로 받는다.
 *
 * 잘못된 도면은 곧바로 오안내가 되므로 저장 전에 검증한다.
 * 출구에 닿지 못하는 노드는 경고로 알려주되 저장은 허용한다 (편집 중일 수 있으므로).
 */
planRoutes.post('/plans', requireAdmin, async (req, res) => {
  const plan = req.body || {};
  if (!plan.id?.trim()) return res.status(400).json({ error: '도면 id가 필요합니다.' });

  const errors = validatePlan(plan);
  if (errors.length) return res.status(400).json({ error: '도면 검증 실패', details: errors });

  const repo = await getRepo();
  const saved = await repo.savePlan({
    id: plan.id.trim(),
    name: plan.name.trim(),
    metersPerUnit: plan.metersPerUnit ?? 1,
    stepLength: plan.stepLength ?? 0.7,
    image: plan.image ?? null,
    nodes: plan.nodes,
    edges: plan.edges,
    initialHazards: plan.initialHazards || {},
  });

  const unreachable = findUnreachableNodes(new FloorPlan(saved));
  res.status(201).json({
    plan: saved,
    warnings: unreachable.length
      ? [`출구까지 이어지지 않는 지점이 있습니다: ${unreachable.join(', ')}`]
      : [],
  });
});

/** 이 도면으로 안내를 시작한다 (활성화) */
planRoutes.put('/plans/:planId/activate', requireAdmin, async (req, res) => {
  const repo = await getRepo();
  const plan = await repo.activatePlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '도면을 찾을 수 없습니다.' });
  res.json({ ok: true, plan });
});

planRoutes.delete('/plans/:planId', requireAdmin, async (req, res) => {
  const repo = await getRepo();
  const active = await repo.getActivePlan();
  if (active.id === req.params.planId) {
    return res.status(409).json({ error: '사용 중인 도면은 삭제할 수 없습니다.' });
  }
  await repo.deletePlan(req.params.planId);
  res.json({ ok: true });
});

// ------------------------------------------------------------- 도면 이미지
planRoutes.get('/plans/:planId/image', async (req, res) => {
  const repo = await getRepo();
  const dataUri = await repo.getPlanImage(req.params.planId);
  if (!dataUri) return res.status(404).json({ error: '등록된 도면 이미지가 없습니다.' });
  res.json({ dataUri });
});

/** body: { dataUri } — 편집기가 축소·압축해서 보낸 도면 이미지 */
planRoutes.put('/plans/:planId/image', requireAdmin, async (req, res) => {
  const { dataUri } = req.body || {};
  if (!dataUri?.startsWith('data:image/')) {
    return res.status(400).json({ error: '이미지 데이터 URI가 필요합니다.' });
  }
  if (dataUri.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error: `도면 이미지가 너무 큽니다 (${Math.round(dataUri.length / 1024)}KB). ${Math.round(MAX_IMAGE_BYTES / 1024)}KB 이하로 줄여주세요.`,
    });
  }

  const repo = await getRepo();
  if (!(await repo.getPlan(req.params.planId))) {
    return res.status(404).json({ error: '도면을 먼저 저장하세요.' });
  }
  await repo.setPlanImage(req.params.planId, dataUri);
  res.json({ ok: true, bytes: dataUri.length });
});
