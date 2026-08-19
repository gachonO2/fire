import { Router } from 'express';
import { getRepo } from '../repositories/index.js';

export const telemetryRoutes = Router();

// ------------------------------------------------------------------- SOS
telemetryRoutes.get('/sos', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.getSOS());
});

/** 구조 요청. body: { userId, nodeId, nodeName, reason, confidence } */
telemetryRoutes.post('/sos', async (req, res) => {
  const { userId, nodeId, nodeName, reason, confidence } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId가 필요합니다.' });

  const repo = await getRepo();
  // 구조대·관제가 보호자에게 바로 연락할 수 있도록 등록된 연락처를 함께 남긴다
  const guardian = await repo.getGuardian(userId);
  const doc = await repo.addSOS({
    userId, nodeId, nodeName, reason, confidence,
    guardianName: guardian?.name || null,
    guardianContact: guardian?.contact || null,
  });
  console.warn(`[SOS] ${userId} @ ${nodeName ?? nodeId} — ${reason}`);
  res.status(201).json(doc);
});

// -------------------------------------------------------------- positions
telemetryRoutes.get('/positions', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.getPositions());
});

/**
 * 위치 보고. 상태(phase)가 바뀌는 순간 보호자에게 알림을 만든다 —
 * 화재로 대피가 시작되면 보호자 화면에 즉시 뜨게 하는 것이 목적이다.
 */
const ALERT_PHASES = {
  guiding: '대피를 시작했습니다.',
  safehold: '이동을 멈추고 구조를 요청했습니다.',
  arrived: '대피를 완료했습니다.',
};

telemetryRoutes.put('/positions/:userId', async (req, res) => {
  const { userId } = req.params;
  const payload = req.body || {};
  const repo = await getRepo();

  const prev = (await repo.getPositions()).find(p => p.userId === userId);
  await repo.setPosition(userId, payload);

  if (payload.phase !== prev?.phase && ALERT_PHASES[payload.phase]) {
    const guardian = await repo.getGuardian(userId);
    if (guardian) {
      await repo.addAlert({
        userId,
        guardianName: guardian.name,
        phase: payload.phase,
        message: ALERT_PHASES[payload.phase],
        nodeName: payload.nodeName || null,
        exitName: payload.exitName || null,
      });
    }
  }

  res.json({ ok: true });
});

/**
 * 위치를 지운다 — 관제에서 유령을 치운다.
 *
 *   DELETE /api/positions/:userId      한 사람
 *   DELETE /api/positions?olderThan=60 60초 넘게 소식 없는 사람 전부
 *   DELETE /api/positions              전부
 *
 * 앱은 새로 띄울 때마다 새 아이디를 만들었고 옛 아이디를 지울 길이 없었다.
 * 그래서 한 명이 걷는데 화면에는 열다섯 명이 있었다 — 시연에서 «건물 안 인원»
 * 이 그대로 틀린 숫자가 된다.
 */
telemetryRoutes.delete('/positions/:userId', async (req, res) => {
  const repo = await getRepo();
  const n = await repo.removePosition(req.params.userId);
  res.json({ ok: true, removed: n });
});

telemetryRoutes.delete('/positions', async (req, res) => {
  const sec = Number(req.query.olderThan);
  const repo = await getRepo();
  const n = await repo.removePosition(null, {
    olderThanMs: Number.isFinite(sec) && sec > 0 ? sec * 1000 : null,
  });
  res.json({ ok: true, removed: n });
});

telemetryRoutes.get('/alerts', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.getAlerts());
});

// ---------------------------------------------------------------- metrics
telemetryRoutes.get('/metrics', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.getMetrics());
});

telemetryRoutes.post('/metrics', async (req, res) => {
  const repo = await getRepo();
  res.status(201).json(await repo.addMetric(req.body || {}));
});
