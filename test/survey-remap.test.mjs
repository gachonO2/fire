/**
 * 답사 재연결 — 도면을 다시 판독해도 걸어서 만든 값이 살아남는가.
 *
 * 시연이 «도면 인식» 으로 시작하므로, 그 장면이 어제 걸어서 만든 답사를
 * 지우면 뒤가 다 무너진다. 여기서 그 성질을 못 박는다.
 */

import { strict as assert } from 'node:assert';
import { remapSurvey } from '../shared/survey-remap.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** 같은 건물을 두 번 판독한 상황 — 좌표는 거의 같고 id 만 다르다 */
const oldPlan = {
  image: { width: 1000, height: 500 },
  nodes: [
    { id: 'R_ACCEL', x: 100, y: 100 },
    { id: 'R_OFFICE', x: 400, y: 120 },
    { id: 'EXIT_A', x: 900, y: 300 },
  ],
};
const reread = {
  image: { width: 1000, height: 500 },
  nodes: [
    { id: 'R_ACCELLAB', x: 104, y: 97 },     // 같은 자리, 새 id
    { id: 'R_OFFICE_N', x: 398, y: 124 },
    { id: 'EXIT_SOUTH', x: 903, y: 298 },
  ],
};
const surveyed = {
  'ble:aa': 'R_ACCEL', 'ble:bb': 'R_ACCEL',
  'ble:cc': 'R_OFFICE', 'ble:dd': 'EXIT_A',
};
const spotXY = { R_ACCEL: [100, 100], R_OFFICE: [400, 120], EXIT_A: [900, 300] };

test('같은 도면이면 그대로 쓴다', () => {
  const r = remapSurvey(oldPlan, surveyed, spotXY);
  assert.equal(r.kept, 4);
  assert.equal(r.remapped, 0);
  assert.equal(r.mapping['ble:aa'], 'R_ACCEL');
});

test('다시 판독해 id 가 바뀌어도 좌표로 이어진다', () => {
  const r = remapSurvey(reread, surveyed, spotXY);
  assert.equal(r.dropped, 0, '버려진 신호가 없어야 한다');
  assert.equal(r.remapped, 4);
  assert.equal(r.mapping['ble:aa'], 'R_ACCELLAB');
  assert.equal(r.mapping['ble:cc'], 'R_OFFICE_N');
  assert.equal(r.mapping['ble:dd'], 'EXIT_SOUTH');
});

test('다른 층이면 아무것도 잇지 않는다', () => {
  // 6층 답사를 3층 도면에 갖다 붙이면 엉뚱한 방에 신호가 붙는다.
  // 짝이 없으면 비워 두는 편이 낫다.
  const other = {
    image: { width: 1000, height: 500 },
    nodes: [{ id: 'F3_A', x: 900, y: 40 }, { id: 'F3_B', x: 950, y: 480 }],
  };
  const r = remapSurvey(other, surveyed, spotXY);
  assert.equal(Object.keys(r.mapping).length, 0);
  assert.equal(r.dropped, 4);
});

test('멀리 떨어진 지점에는 억지로 안 붙인다', () => {
  const shifted = {
    image: { width: 1000, height: 500 },
    // 60px 밖 — 허용치(1000 × 5% = 50px) 를 넘는다
    nodes: [{ id: 'X', x: 165, y: 100 }],
  };
  const r = remapSurvey(shifted, { 'ble:aa': 'R_ACCEL' }, spotXY);
  assert.equal(r.dropped, 1);
  assert.equal(Object.keys(r.mapping).length, 0);
});

test('허용치 안이면 붙인다', () => {
  const shifted = {
    image: { width: 1000, height: 500 },
    nodes: [{ id: 'X', x: 140, y: 100 }],    // 40px — 허용치 안
  };
  const r = remapSurvey(shifted, { 'ble:aa': 'R_ACCEL' }, spotXY);
  assert.equal(r.mapping['ble:aa'], 'X');
});

test('좌표 기록이 없으면 잇지 않는다', () => {
  // 좌표를 남기기 전에 만든 옛 답사. 추측해서 붙이면 틀린 자리에 붙는다.
  const r = remapSurvey(reread, { 'ble:zz': 'R_UNKNOWN' }, {});
  assert.equal(r.dropped, 1);
  assert.equal(Object.keys(r.mapping).length, 0);
});

test('도면이 비어 있으면 빈 매핑', () => {
  const r = remapSurvey({ nodes: [] }, surveyed, spotXY);
  assert.equal(Object.keys(r.mapping).length, 0);
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✅ ${name}`); pass++; }
  catch (err) { console.error(`❌ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
console.log(`\n답사 재연결: ${pass}/${tests.length}`);
