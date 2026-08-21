import { asyncRouter } from './async-router.js';
import { getRepo } from '../repositories/index.js';

export const guardianRoutes = asyncRouter();

/**
 * 보호자 등록 — 사용자가 대피 전에 미리 설정해 둔다.
 * 발급된 공유 코드로 보호자가 guardian.html 에서 위치를 지켜볼 수 있다.
 *
 * body: { userId, name, contact }
 */
guardianRoutes.post('/guardians', async (req, res) => {
  const { userId, name, contact } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId가 필요합니다.' });
  if (!name?.trim()) return res.status(400).json({ error: '보호자 이름이 필요합니다.' });

  const repo = await getRepo();
  const guardian = await repo.setGuardian(userId, { name: name.trim(), contact: contact?.trim() || '' });
  res.status(201).json(guardian);
});

guardianRoutes.get('/guardians/:userId', async (req, res) => {
  const repo = await getRepo();
  const guardian = await repo.getGuardian(req.params.userId);
  if (!guardian) return res.status(404).json({ error: '등록된 보호자가 없습니다.' });
  res.json(guardian);
});

/**
 * 보호자 화면 진입 — 코드로 대상자를 확인하고 현재 상태를 한 번에 내려준다.
 * 이후 변경은 /api/stream?code=... (SSE)로 받는다.
 */
guardianRoutes.get('/guardian/:code', async (req, res) => {
  const repo = await getRepo();
  const guardian = await repo.getGuardianByCode(req.params.code);
  if (!guardian) return res.status(404).json({ error: '유효하지 않은 보호자 코드입니다.' });

  const positions = await repo.getPositions();
  const alerts = await repo.getAlerts();
  const sos = await repo.getSOS();

  res.json({
    guardian: { name: guardian.name, contact: guardian.contact, code: guardian.code },
    userId: guardian.userId,
    position: positions.find(p => p.userId === guardian.userId) || null,
    alerts: alerts.filter(a => a.userId === guardian.userId),
    sos: sos.filter(s => s.userId === guardian.userId),
    hazards: await repo.getHazards(),
  });
});
