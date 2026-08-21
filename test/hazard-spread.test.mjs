/**
 * 불의 번짐 — **시간이 지나면 커지고, 넘치지는 않는다.**
 *
 * 화면에서 «커지고 있다» 를 말하는 유일한 근거가 이 함수라, 두 성질을 못
 * 박아 둔다. 커져야 하고(단조 증가), 도면을 다 먹으면 안 된다(상한).
 */

import { strict as assert } from 'node:assert';
import { SPREAD, spreadLabel, spreadProgress, spreadRadius } from '../shared/hazard-spread.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
/** 지수함수라 r0 이 정확히 떨어지지 않는다 — 뜻은 «자란 게 없다» 이다 */
const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why ?? ''} ${a} ≠ ${b}`);

test('막 났을 때는 r0 이다', () => {
  near(spreadRadius(0, 'fire'), SPREAD.fire.r0);
  near(spreadRadius(0, 'smoke'), SPREAD.smoke.r0);
});

test('시간이 지나면 반드시 커진다', () => {
  let prev = -Infinity;
  for (let s = 0; s <= 600; s += 5) {
    const r = spreadRadius(s * 1000, 'fire');
    assert.ok(r > prev, `${s}초에서 줄었다: ${prev} → ${r}`);
    prev = r;
  }
});

test('아무리 오래 둬도 rMax 를 넘지 않는다', () => {
  // 도면을 통째로 덮는 그림이 나오면 관제가 아무것도 못 읽는다.
  for (const type of ['fire', 'smoke', 'crowd', 'temp']) {
    const r = spreadRadius(24 * 3600_000, type);
    assert.ok(r <= SPREAD[type].rMax + 1e-9, `${type} 가 상한을 넘었다: ${r}`);
  }
});

test('연기가 불보다 크고 빠르다', () => {
  // 사람을 먼저 잡는 것은 연기다. 화면에서도 그래야 한다.
  assert.ok(SPREAD.smoke.rMax > SPREAD.fire.rMax);
  assert.ok(SPREAD.smoke.tauMs < SPREAD.fire.tauMs);
  assert.ok(spreadRadius(30_000, 'smoke') > spreadRadius(30_000, 'fire'));
});

test('혼잡은 사실상 안 번진다', () => {
  const grew = spreadRadius(10 * 60_000, 'crowd') - spreadRadius(0, 'crowd');
  assert.ok(grew < 1, `혼잡이 ${grew} 만큼 번졌다`);
});

test('음수·쓰레기 시간은 0초로 본다', () => {
  // 서버와 브라우저 시계가 어긋나면 elapsed 가 음수로 온다. 그때 반지름이
  // NaN 이 되면 SVG 가 통째로 안 그려져 «불이 사라진» 화면이 된다.
  for (const bad of [-5000, NaN, undefined, null, 'x']) {
    near(spreadRadius(bad, 'fire'), SPREAD.fire.r0, `${bad}`);
  }
});

test('모르는 종류는 불로 본다', () => {
  near(spreadRadius(0, '없는종류'), SPREAD.fire.r0);
});

test('시연 시간 안에 눈에 띄게 커진다', () => {
  // τ 를 고른 이유가 이것이다 — 발표하며 말하는 30초 사이에 변화가 보여야 한다.
  const r0 = spreadRadius(0, 'fire');
  const r30 = spreadRadius(30_000, 'fire');
  assert.ok(r30 > r0 * 1.4, `30초에 ${(r30 / r0).toFixed(2)}배밖에 안 컸다`);
});

test('진행률은 0 에서 시작해 1 로 수렴한다', () => {
  assert.equal(spreadProgress(0, 'fire'), 0);
  assert.ok(spreadProgress(60_000, 'fire') > 0.15);
  assert.ok(spreadProgress(60 * 60_000, 'fire') > 0.99);
  assert.ok(spreadProgress(60 * 60_000, 'fire') <= 1);
});

test('글씨가 분·초를 사람이 읽는 대로 쓴다', () => {
  assert.match(spreadLabel(12_000, 'fire'), /^12초째 · 번지는 중$/);
  assert.match(spreadLabel(192_000, 'fire'), /^3분 12초째/);
  assert.match(spreadLabel(60 * 60_000, 'fire'), /확산 멈춤$/);
  assert.match(spreadLabel(60 * 60_000, 'crowd'), /유지$/);
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✅ ${name}`); pass++; }
  catch (err) { console.error(`❌ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
console.log(`\n번짐: ${pass}/${tests.length}`);
