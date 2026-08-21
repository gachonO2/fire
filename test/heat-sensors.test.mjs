/**
 * 열감지기 — **불이 났다는 것을 기계가 먼저 안다.**
 *
 * 여기서 지켜야 할 것은 셋이다. 아무 일 없으면 평상 온도일 것,
 * 불 옆이면 차단 문턱을 넘을 것, 그리고 **멀면 안 넘을 것.**
 * 마지막이 제일 중요하다 — 멀리 있는 불에도 감지기가 반응하면 층 전체가
 * 차단되고, 그건 대피 안내를 못 하게 만든다.
 */

import { strict as assert } from 'node:assert';
import { detectorSpots, heatAt } from '../backend/src/heatSensors.js';
import { TEMP, temperatureHazard } from '../shared/hazard-rules.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const HERE = { x: 100, y: 100 };
/** 도면 폭 1352 기준의 배율 — 실제 COCONE 6층과 같게 둔다 */
const U = 1352 / 400;
/** 통로는 선분이다. 점으로 시험하면 실제와 다른 것을 재게 된다. */
const fire = (x, y, elapsedMs = 120_000, type = 'fire') =>
  ({ ax: x, ay: y, bx: x, by: y, type, elapsedMs, unit: U });
/** 긴 복도가 통째로 타는 경우 */
const corridor = (ax, ay, bx, by, elapsedMs = 120_000) =>
  ({ ax, ay, bx, by, type: 'fire', elapsedMs, unit: U });

test('아무 일 없으면 평상 온도', () => {
  const c = heatAt(HERE, []);
  assert.ok(c >= 22 && c <= 25, `${c}℃`);
  assert.equal(temperatureHazard(c), null);
});

test('바로 옆에서 난 불은 차단 문턱을 넘긴다', () => {
  const c = heatAt(HERE, [fire(105, 100)]);
  assert.ok(c >= TEMP.BLOCK, `${c}℃ 가 ${TEMP.BLOCK}℃ 를 못 넘었다`);
  assert.equal(temperatureHazard(c), 'heat');
});

test('먼 불에는 안 반응한다', () => {
  // 이게 무너지면 불 하나에 층 전체가 차단돼 안내할 길이 없어진다.
  const c = heatAt(HERE, [fire(900, 600)]);
  assert.ok(c < 30, `${c}℃ — 먼 불에 반응했다`);
  assert.equal(temperatureHazard(c), null);
});

test('갓 난 불은 옆 분기점을 아직 못 데운다', () => {
  // 0초짜리 불이 곧바로 통로를 끊으면 «번지는 중» 이라는 화면과 어긋난다.
  const young = heatAt(HERE, [fire(160, 100, 0)]);
  const old = heatAt(HERE, [fire(160, 100, 300_000)]);
  assert.ok(old > young, `${young}℃ → ${old}℃ 로 안 올랐다`);
});

test('조금 떨어진 감지기도 1분 안에 차단을 넘는다', () => {
  // 이게 몇 분씩 걸리면 시연에서 못 쓴다. 실제로도 천장 열기류는 구획을
  // 1분 안에 훑는다 — 불꽃이 번지는 속도와 다른 값이다.
  const d57 = heatAt(HERE, [fire(157, 100, 60_000)]);
  assert.ok(d57 >= TEMP.BLOCK, `57px 떨어진 감지기가 1분에 ${d57}℃ 였다`);
  const at30 = heatAt(HERE, [fire(157, 100, 30_000)]);
  assert.ok(at30 >= TEMP.WARN, `57px 떨어진 감지기가 30초에 ${at30}℃ 였다`);
});

test('시간이 지날수록 뜨거워진다', () => {
  let prev = -Infinity;
  for (const t of [0, 30_000, 60_000, 120_000, 300_000]) {
    const c = heatAt(HERE, [fire(150, 100, t)]);
    assert.ok(c >= prev, `${t}ms 에서 식었다: ${prev} → ${c}`);
    prev = c;
  }
});

test('불을 넣는 순간에는 아직 안 뜨겁다', () => {
  // 거리만 보면 감지기가 분기점에 있고 통로 끝이 곧 그 분기점이라 거리가 0 —
  // 넣자마자 240℃ 가 되어 통로 일곱 개가 동시에 끊겼다. 화면의 불은 아직
  // 점만 한데 말이다.
  const c = heatAt(HERE, [fire(100, 100, 0)]);
  assert.ok(c < TEMP.WARN, `발화 즉시 ${c}℃ 가 됐다`);
});

test('불난 통로 위의 감지기는 빨리 운다', () => {
  // 거리 0 — 감지기가 타는 복도에 붙어 있다. 여기가 느리면 감지기를 단
  // 의미가 없다. 반대로 0초에 우는 것도 안 된다(위 시험이 그걸 지킨다).
  const at15 = heatAt(HERE, [fire(100, 100, 15_000)]);
  assert.ok(at15 >= TEMP.BLOCK, `15초에 ${at15}℃ — 차단을 못 넘었다`);
});

test('연기는 뜨겁지 않지만 경고는 넘길 수 있다', () => {
  const c = heatAt(HERE, [fire(102, 100, 900_000, 'smoke')]);
  assert.ok(c < TEMP.BLOCK, `연기가 차단 문턱을 넘었다: ${c}℃`);
  assert.ok(c >= TEMP.WARN, `연기가 경고 문턱도 못 넘었다: ${c}℃`);
});

test('혼잡은 온도를 안 올린다', () => {
  const c = heatAt(HERE, [fire(101, 100, 300_000, 'crowd')]);
  assert.ok(c < 26, `사람이 몰렸다고 ${c}℃ 가 됐다`);
});

test('불이 둘이어도 더해지지 않는다', () => {
  // 더하면 멀리 있는 불 두 개가 합쳐져 아무 일 없는 복도를 차단한다.
  const one = heatAt(HERE, [fire(400, 100)]);
  const two = heatAt(HERE, [fire(400, 100), fire(100, 400)]);
  assert.ok(two <= Math.max(one, heatAt(HERE, [fire(100, 400)])) + 0.01,
    `${one}℃ 두 개가 ${two}℃ 로 합쳐졌다`);
});

test('긴 복도가 타면 그 복도의 감지기가 운다', () => {
  // 통로를 가운데 한 점으로 줄이면 NORTH STREET 처럼 긴 복도는 양끝
  // 분기점이 259px 밖이라 감지기가 하나도 안 울렸다 — 단 의미가 없어진다.
  const c = heatAt(HERE, [corridor(90, 100, 900, 100)]);
  assert.ok(c >= TEMP.BLOCK, `복도 끝 감지기가 ${c}℃ 밖에 안 됐다`);
});

/** 기준층을 흉내낸 작은 도면 — 분기점 둘, 출구 하나, 엘리베이터 하나, 방 둘 */
const PLAN = {
  nodes: [
    { id: 'J1', type: 'junction', name: '복도 1', x: 100, y: 100 },
    { id: 'J2', type: 'junction', name: '복도 2', x: 200, y: 100 },
    { id: 'E1', type: 'exit', name: '계단', x: 300, y: 100 },
    { id: 'EV', type: 'elevator', name: '엘리베이터', x: 250, y: 60 },
    { id: 'R1', type: 'room', name: '501호', x: 100, y: 180 },
    { id: 'R2', type: 'room', name: '502호', x: 200, y: 180 },
  ],
};

test('감지기는 분기점·비상구·엘리베이터 앞에 단다', () => {
  // 방 안에만 달면 그 방 하나만 못 쓰게 되고 경로는 그대로다. 분기점이라야
  // «여기가 막히면 저쪽으로» 가 성립한다.
  const spots = detectorSpots(PLAN);
  const nodes = [...new Set(spots.map(s => s.nodeId))].sort();
  assert.deepEqual(nodes, ['E1', 'EV', 'J1', 'J2']);
  assert.ok(!nodes.includes('R1'), '방에 달았다');
});

test('한 자리에 연기와 열을 같이 단다', () => {
  // 연기는 빨리 울지만 수증기·먼지에 잘 속고, 열은 느리지만 거의 안 속는다.
  // 둘이 같이 울면 확실하다 — 실제 설비의 교차회로 구성이다.
  const spots = detectorSpots(PLAN);
  for (const n of [...new Set(spots.map(s => s.nodeId))]) {
    const kinds = spots.filter(s => s.nodeId === n).map(s => s.kind).sort();
    assert.deepEqual(kinds, ['heat', 'smoke'], `${n} 에 한 종류만 있다`);
  }
});

test('회선 주소가 겹치지 않는다', () => {
  // 주소가 겹치면 수신기가 두 기기를 한 기기로 보고, 하나가 울어도
  // 다른 하나의 값으로 덮인다.
  const spots = detectorSpots(PLAN);
  assert.equal(new Set(spots.map(s => s.address)).size, spots.length);
  assert.equal(new Set(spots.map(s => s.id)).size, spots.length);
  assert.ok(spots.every(s => s.id.startsWith('SIM-')),
    '시뮬레이션 감지기는 SIM- 으로 표시해야 실물과 구분된다');
});

test('**어느 층 도면이든** 감지기가 붙는다', () => {
  // 예전에는 6층 지점 id 를 박아 뒀다. 그래서 다른 층을 열면 한 대도 안
  // 붙었고, 감지기가 6층에만 있는 것처럼 보였다.
  const other = { nodes: [
    { id: 'N0', type: 'junction', name: '북쪽 복도 1', x: 10, y: 10 },
    { id: 'EXIT_E', type: 'exit', name: '동쪽 계단', x: 90, y: 10 },
  ] };
  assert.equal(detectorSpots(other).length, 4);   // 두 자리 × 두 종류
});

test('도면이 없으면 감지기도 없다', () => {
  assert.equal(detectorSpots(null).length, 0);
  assert.equal(detectorSpots({ nodes: [] }).length, 0);
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✅ ${name}`); pass++; }
  catch (err) { console.error(`❌ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
console.log(`\n열감지기: ${pass}/${tests.length}`);
