import { useFirestore } from '../config.js';
import { MemoryRepo } from './memory-repo.js';

let repo = null;
let pending = null;   // 초기화 중인 약속 — 동시에 들어온 요청이 저장소를 두 벌 만들지 않도록

/**
 * 저장소 싱글턴. FIREBASE_PROJECT_ID가 있으면 Firestore, 없으면 인메모리.
 * Firestore 초기화가 실패해도 서버는 데모 모드로 계속 뜬다 —
 * 시연 도중 자격증명 문제로 전체가 멈추는 상황을 피하기 위해서다.
 *
 * 초기화가 끝나기 전에 다른 요청이 또 부를 수 있다(init 안에 await 가 있다).
 * 그때 각자 저장소를 만들면 Firestore onSnapshot 구독이 두 벌 붙어 SSE 로
 * 같은 변경이 두 번 나가고, 인메모리 모드에서는 한쪽이 통째로 버려진다.
 * 그래서 **만드는 중인 약속을 공유한다.**
 */
export async function getRepo() {
  if (repo) return repo;
  if (pending) return pending;
  pending = createRepo().finally(() => { pending = null; });
  return pending;
}

async function createRepo() {
  // 다 만들어진 뒤에야 repo 에 넣는다. 중간에 넣으면 init 이 도는 동안 들어온
  // 요청이 아직 준비되지 않은 저장소를 받아 간다.
  if (useFirestore()) {
    try {
      const { FirestoreRepo } = await import('./firestore-repo.js');
      const firestore = new FirestoreRepo();
      await firestore.init();
      console.log('[repo] Firestore 연결됨');
      return (repo = firestore);
    } catch (err) {
      console.error('[repo] Firestore 초기화 실패 — 인메모리 데모 모드로 전환:', err.message);
    }
  }

  const memory = new MemoryRepo();
  await memory.init();
  console.log('[repo] 인메모리 데모 모드');
  return (repo = memory);
}
