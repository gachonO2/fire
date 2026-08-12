import { useFirestore } from '../config.js';
import { MemoryRepo } from './memory-repo.js';
import { seedSamplePlans } from '../seed.js';

let repo = null;

/**
 * 저장소 싱글턴. FIREBASE_PROJECT_ID가 있으면 Firestore, 없으면 인메모리.
 * Firestore 초기화가 실패해도 서버는 데모 모드로 계속 뜬다 —
 * 시연 도중 자격증명 문제로 전체가 멈추는 상황을 피하기 위해서다.
 */
export async function getRepo() {
  if (repo) return repo;

  if (useFirestore()) {
    try {
      const { FirestoreRepo } = await import('./firestore-repo.js');
      repo = new FirestoreRepo();
      await repo.init();
      await seedSamplePlans(repo);
      console.log('[repo] Firestore 연결됨');
      return repo;
    } catch (err) {
      console.error('[repo] Firestore 초기화 실패 — 인메모리 데모 모드로 전환:', err.message);
    }
  }

  repo = new MemoryRepo();
  await repo.init();
  await seedSamplePlans(repo);
  console.log('[repo] 인메모리 데모 모드');
  return repo;
}
