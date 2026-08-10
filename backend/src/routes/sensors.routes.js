import { Router } from 'express';
import { TEMP, temperatureHazard, isStale, HAZARD_RULES } from '../../../shared/hazard-rules.js';
import { activeFloorPlan } from '../floor.js';
import { getRepo } from '../repositories/index.js';

export const sensorRoutes = Router();

/**
 * 온도 센서 판독값 수집.
 * 실제 건물에서는 센서 게이트웨이·BMS가 주기적으로 이 엔드포인트를 호출한다.
 * 판독값은 저장만 하고, 위험 판정(임계값 초과 → 통로 차단)은 경로를 계산하는
 * 시점에 shared/hazard-rules.js 가 수행한다 — 임계값 기준을 한 곳에만 두기 위해서다.
 *
 * body: { sensorId, edgeId | nodeId, celsius }
 */
sensorRoutes.post('/sensors/temperature', async (req, res) => {
  const { sensorId, edgeId, nodeId, celsius } = req.body || {};

  if (!sensorId) return res.status(400).json({ error: 'sensorId가 필요합니다.' });
  if (!Number.isFinite(celsius)) return res.status(400).json({ error: 'celsius는 숫자여야 합니다.' });
  if (!edgeId && !nodeId) return res.status(400).json({ error: 'edgeId 또는 nodeId가 필요합니다.' });

  const floorPlan = await activeFloorPlan();
  if (edgeId && !floorPlan.hasEdge(edgeId)) {
    return res.status(404).json({ error: `현재 도면에 없는 통로입니다: ${edgeId}` });
  }
  if (nodeId && !floorPlan.hasNode(nodeId)) {
    return res.status(404).json({ error: `현재 도면에 없는 지점입니다: ${nodeId}` });
  }

  const repo = await getRepo();
  const reading = await repo.setSensorReading({ sensorId, edgeId: edgeId || null, nodeId: nodeId || null, celsius });

  const hazardType = temperatureHazard(celsius);
  if (hazardType === 'heat') {
    console.warn(`[온도경보] ${sensorId} ${edgeId || nodeId} ${celsius}°C — 통행 불가로 전환`);
  }

  res.status(201).json({
    reading,
    hazard: hazardType,
    blocked: hazardType ? !HAZARD_RULES[hazardType].passable : false,
    thresholds: { warn: TEMP.WARN, block: TEMP.BLOCK },
  });
});

/** 현재 판독값 목록 — 관제 모니터용. 오래된 값은 stale로 표시한다. */
sensorRoutes.get('/sensors', async (req, res) => {
  const repo = await getRepo();
  const now = Date.now();
  const sensors = (await repo.getSensors()).map(s => ({
    ...s,
    hazard: temperatureHazard(s.celsius),
    stale: isStale(s, now),
  }));
  res.json({ sensors, thresholds: { warn: TEMP.WARN, block: TEMP.BLOCK, staleMs: TEMP.STALE_MS } });
});

sensorRoutes.delete('/sensors/:sensorId', async (req, res) => {
  const repo = await getRepo();
  await repo.removeSensor(req.params.sensorId);
  res.json({ ok: true });
});

sensorRoutes.post('/sensors/reset', async (req, res) => {
  const repo = await getRepo();
  await repo.clearSensors();
  res.json({ ok: true });
});
