import { Router } from 'express';
import { activeFloorPlan, currentHazards } from '../floor.js';
import { getRepo } from '../repositories/index.js';
import { requireAdmin } from '../middleware/auth.js';

export const hazardRoutes = Router();

const VALID_TYPES = ['fire', 'smoke', 'crowd', 'blocked'];
const LABELS = { fire: '화재 발생', smoke: '연기 감지', crowd: '혼잡', blocked: '통로 차단' };

/**
 * 현재 위험 상태 — 관제가 지정한 것과 온도 센서가 자동 판정한 것을 합친 결과.
 * 경로탐색이 실제로 보는 값과 동일하므로, 지도에 그대로 그리면 된다.
 */
hazardRoutes.get('/hazards', async (req, res) => {
  res.json(await currentHazards());
});

/** 관제가 직접 지정한 위험만 (센서 판정 제외) — 디버깅·감사용 */
hazardRoutes.get('/hazards/manual', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.getHazards());
});

/** 통로 위험 설정. body: { type: 'fire'|'smoke'|'crowd'|'blocked', label? } */
hazardRoutes.put('/hazards/:edgeId', requireAdmin, async (req, res) => {
  const { edgeId } = req.params;
  const { type, label } = req.body || {};

  const floorPlan = await activeFloorPlan();
  if (!floorPlan.hasEdge(edgeId)) return res.status(404).json({ error: `알 수 없는 통로: ${edgeId}` });
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: `type은 ${VALID_TYPES.join(', ')} 중 하나여야 합니다.` });
  }

  const repo = await getRepo();
  await repo.setHazard(edgeId, { type, label: label || LABELS[type] });
  res.json({ ok: true, edgeId, type });
});

hazardRoutes.delete('/hazards/:edgeId', requireAdmin, async (req, res) => {
  const { edgeId } = req.params;
  const floorPlan = await activeFloorPlan();
  if (!floorPlan.hasEdge(edgeId)) return res.status(404).json({ error: `알 수 없는 통로: ${edgeId}` });

  const repo = await getRepo();
  await repo.clearHazard(edgeId);
  res.json({ ok: true, edgeId });
});

/** 시나리오 초기화 — 도면에 정의된 초기 위험 상태로 되돌린다. */
hazardRoutes.post('/hazards/reset', requireAdmin, async (req, res) => {
  const repo = await getRepo();
  await repo.resetHazards();
  await repo.clearSensors();
  await repo.clearFires();
  res.json({ ok: true, hazards: await currentHazards() });
});

/**
 * 화재수신기·BMS 웹훅 자리.
 * 실제 건물 연동 시 수신기 프로토콜(예: 접점·Modbus·자체 API)을 이 어댑터에서
 * 통로(edge) 단위 위험 상태로 변환한다. MVP에서는 동일 스키마의 모의 입력만 받는다.
 * 온도 센서는 별도로 POST /api/sensors/temperature 를 쓴다.
 *
 * body: { sensorId, edgeId, type, active }
 */
hazardRoutes.post('/sensors/fire-panel', async (req, res) => {
  const { sensorId, edgeId, type = 'smoke', active = true } = req.body || {};
  const floorPlan = await activeFloorPlan();
  if (!floorPlan.hasEdge(edgeId)) return res.status(404).json({ error: `알 수 없는 통로: ${edgeId}` });

  const repo = await getRepo();
  if (active) await repo.setHazard(edgeId, { type, label: LABELS[type] || '센서 감지', sensorId });
  else await repo.clearHazard(edgeId);

  res.json({ ok: true, sensorId, edgeId, active });
});
