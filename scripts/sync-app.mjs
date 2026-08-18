/**
 * shared/ 측위 계층 → ../fireapp/src/ 복사.
 *
 * ## 왜 필요한가
 *
 * 측위·경로 코드는 웹(`fire`)과 네이티브 앱(`fireapp`) 양쪽에서 돈다. 두 레포가
 * npm 으로 이어져 있지 않아 지금까지 **손으로 복사**해 왔는데, 이미 갈라졌다 —
 * `positioning.js` 는 두 곳의 주석이 다르고 메서드 이름도 하나 다르다
 * (`setFloorPlan` vs `setPlan`). 같은 판정을 두 벌 들고 있으면서 서로 다른 것은
 * 대피 안내에서 특히 나쁘다. 관제와 폰이 다른 말을 하게 된다.
 *
 * 그래서 **새로 만드는 것부터는 한 방향으로만 흐르게** 한다:
 * `fire/shared` 가 원본이고 `fireapp/src` 는 사본이다. 사본을 고치면 다음 동기화에
 * 덮인다.
 *
 * ## 이미 갈라진 파일은 건드리지 않는다
 *
 * `positioning.js`, `pathfinding.js` 는 손으로 갈라진 상태라 그냥 덮으면 앱이
 * 깨진다(`setPlan` 호출부가 있다). 합치는 일은 따로 해야 하므로 여기서는 뺀다.
 *
 * 앱 레포가 없으면 조용히 넘어간다 — 웹만 받은 사람도 `npm test` 가 돌아야 한다.
 */
import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'shared');
const dest = path.resolve(root, '..', 'fireapp', 'src');

/** 원본이 fire/shared 인 파일들. 앱에서 고치지 말 것. */
const FILES = [
  'floor-plan.js',      // fusion 이 쓰는 도면 모델 (앱에는 원래 없었다)
  'fusion.js',          // 판단 계층
  'beacon-anchor.js',   // 비콘 → 판단 계층
  'altitude.js',        // 기압 → 층 이동
  'altitude-anchor.js', // 층 이동 → 판단 계층
  'magnetic.js',        // 지자기 지문
  'magnetic-anchor.js', // 지자기 → 판단 계층
  'tracking.js',        // 판단 계층 + 세 앵커 묶음 (화면이 쓰는 입구)
  'walk-sim.js',        // 가상 보행자 — 시뮬레이션의 '실제 위치'
  'beacon-map.js',      // 걸으면서 비콘 위치 알아내기
];

try {
  await access(dest);
} catch {
  console.log('[sync-app] ../fireapp 없음 — 건너뜀');
  process.exit(0);
}

await mkdir(dest, { recursive: true });
for (const f of FILES) {
  await copyFile(path.join(src, f), path.join(dest, f));
}
console.log(`[sync-app] shared/ → ../fireapp/src/  ${FILES.length}개 복사`);
