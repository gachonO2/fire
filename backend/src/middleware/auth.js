import { config } from '../config.js';

/**
 * 관제(위험 상태 변경) API 보호.
 * ADMIN_TOKEN이 비어 있으면 통과시킨다 — 해커톤 데모 편의를 위한 것이고,
 * 실서비스에서는 반드시 토큰(또는 Firebase Auth 커스텀 클레임)을 설정해야 한다.
 * 잘못된 위험 정보 주입은 곧바로 오안내 → 인명위험으로 이어지기 때문이다.
 */
export function requireAdmin(req, res, next) {
  if (!config.adminToken) return next();
  if (req.get('x-admin-token') === config.adminToken) return next();
  res.status(401).json({ error: '관제 권한이 필요합니다.' });
}
