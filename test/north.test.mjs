// 북쪽 보정: **도면 위쪽이 실제 몇 도인가.**
//
// 이 값 하나가 없어서 방향 안내 전체(진동·삐 소리·"왼쪽으로 도세요")가 한 번도
// 돌지 않았다. 재는 계산이 틀리면 이번엔 **반대로 안내한다** — 없는 것보다 나쁘다.
import { northFromWalk, planBearing, circularMean, spreadDeg } from '../shared/north.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

const A = { x: 0, y: 0 };

// 도면 좌표는 아래로 갈수록 y 가 커진다 — 위쪽이 0° 여야 한다
expect('도면 위쪽이 0°', planBearing(A, { x: 0, y: -10 }) === 0);
expect('도면 오른쪽이 90°', planBearing(A, { x: 10, y: 0 }) === 90);
expect('도면 아래쪽이 180°', planBearing(A, { x: 0, y: 10 }) === 180);

// 359° 와 1° 의 평균은 0° 지 180° 가 아니다
{
  const m = circularMean([359, 1, 0]);
  expect('경계를 넘는 각도의 평균', m > 359.5 || m < 0.5, `${m.toFixed(1)}°`);
  expect('흩어짐도 경계를 넘는다', spreadDeg([359, 1]) <= 1.1, `${spreadDeg([359, 1]).toFixed(1)}°`);
}

// 도면 위쪽으로 걸었는데 나침반이 동쪽(90°)을 가리켰다 → 도면 위쪽이 곧 동쪽
{
  const r = northFromWalk(Array(20).fill(90), A, { x: 0, y: -10 });
  expect('도면 위쪽 = 동쪽으로 나온다', Math.abs(r.offset - 90) < 0.5, `${r.offset?.toFixed(1)}°`);
}

// 도면 오른쪽(90°)으로 걸었는데 나침반이 북(0°) → 도면 위쪽은 서쪽(270°)
{
  const r = northFromWalk(Array(20).fill(0), A, { x: 10, y: 0 });
  expect('반대편도 맞게 나온다', Math.abs(r.offset - 270) < 0.5, `${r.offset?.toFixed(1)}°`);
}

// 실제 측정은 흔들린다 — 잡음이 섞여도 평균은 맞아야 한다
{
  const noisy = Array.from({ length: 40 }, (_, i) => 90 + ((i * 7919) % 21) - 10);
  const r = northFromWalk(noisy, A, { x: 0, y: -10 });
  expect('잡음이 섞여도 평균이 맞는다', Math.abs(r.offset - 90) < 6, `${r.offset?.toFixed(1)}°`);
}

// 두리번거리며 걸었으면 값을 주면 안 된다 — 틀린 값이 박히는 게 제일 나쁘다
{
  const wobbly = Array.from({ length: 30 }, (_, i) => (i * 37) % 360);
  const r = northFromWalk(wobbly, A, { x: 0, y: -10 });
  expect('두리번거리면 거부한다', !!r.error, r.error || `${r.offset}°`);
}

// 표본이 모자라면 거부한다
{
  const r = northFromWalk([90, 91, 89], A, { x: 0, y: -10 });
  expect('표본이 적으면 거부한다', !!r.error, r.error);
}

// 같은 지점을 고르면 거부한다
{
  const r = northFromWalk(Array(20).fill(90), A, { x: 0, y: 0 });
  expect('같은 지점은 거부한다', !!r.error, r.error);
}

console.log(failed === 0 ? '\n북쪽 보정 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
