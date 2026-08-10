/**
 * shared/ → frontend/shared/ 복사.
 *
 * 지도 그래프와 경로탐색 알고리즘은 백엔드(권위 계산)와 프론트엔드(오프라인 폴백)
 * 양쪽에서 필요하다. 코드를 복제하는 대신 shared/를 단일 진실 소스로 두고
 * 프론트 번들에 복사한다 — 브라우저는 정적 파일만 import 할 수 있기 때문.
 *
 * 백엔드 dev/start 스크립트가 자동 실행하며, 프론트만 따로 배포할 때도
 * `npm run sync` 로 먼저 돌리면 된다.
 */
import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'shared');
const dest = path.join(root, 'frontend', 'shared');

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`[sync-shared] shared/ → frontend/shared/ 복사 완료`);
