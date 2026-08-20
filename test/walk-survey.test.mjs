/**
 * 한 번 걸어서 만드는 답사.
 *
 * 여기서 지켜야 할 성질은 둘이다. **걸음 비율만으로 지점이 갈리는가**,
 * 그리고 **못 쓸 기기를 안 넣는가.** 뒤엣것이 더 중요하다 — 어디서나
 * 비슷하게 들리는 기기를 매핑에 넣으면 판정이 그 기기 때문에 흐려지고,
 * 그러면 «답사를 했는데 왜 위치가 틀리지» 가 된다.
 */

import { strict as assert } from 'node:assert';
import { bakeWalk, nodeAtProgress, routeMetrics } from '../shared/walk-survey.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** 100단위 간격으로 늘어선 복도 — 진행률과 지점이 딱 떨어지게 만든다 */
const ROUTE = [
  { id: 'A', x: 0, y: 0 },
  { id: 'B', x: 100, y: 0 },
  { id: 'C', x: 200, y: 0 },
  { id: 'D', x: 300, y: 0 },
];

test('누적 거리를 잰다', () => {
  const { cum, total } = routeMetrics(ROUTE);
  assert.deepEqual(cum, [0, 100, 200, 300]);
  assert.equal(total, 300);
});

test('진행률이 지점으로 바뀐다', () => {
  assert.equal(nodeAtProgress(ROUTE, 0).id, 'A');
  assert.equal(nodeAtProgress(ROUTE, 1).id, 'D');
  assert.equal(nodeAtProgress(ROUTE, 0.34).id, 'B');
  assert.equal(nodeAtProgress(ROUTE, 0.66).id, 'C');
});

test('지점 구역이 절반씩 나뉜다', () => {
  // A 와 B 사이 한가운데(1/6)보다 앞이면 A, 뒤면 B 여야 한다.
  assert.equal(nodeAtProgress(ROUTE, 0.15).id, 'A');
  assert.equal(nodeAtProgress(ROUTE, 0.18).id, 'B');
});

test('범위를 벗어난 진행률도 양끝으로 잡는다', () => {
  // 걸음이 예상보다 더 나오는 일은 흔하다. 거기서 NaN 이 나오면 답사가
  // 통째로 죽으므로 끝으로 눌러 둔다.
  assert.equal(nodeAtProgress(ROUTE, -0.5).id, 'A');
  assert.equal(nodeAtProgress(ROUTE, 3).id, 'D');
});

/** 지점마다 «그 지점에서만 세게 들리는» 기기를 하나씩 둔 걷기 */
function walkSamples() {
  const at = (steps, strongAt) => ({
    steps,
    readings: ['A', 'B', 'C', 'D'].map(n => ({
      beaconId: `dev-${n}`,
      rssi: n === strongAt ? -45 : -88,
    })),
  });
  const out = [];
  for (const [steps, node] of [[0, 'A'], [4, 'A'], [8, 'A'],
    [40, 'B'], [44, 'B'], [48, 'B'],
    [80, 'C'], [84, 'C'], [88, 'C'],
    [116, 'D'], [118, 'D'], [120, 'D']]) out.push(at(steps, node));
  return out;
}

test('걷기 한 번으로 네 지점이 갈린다', () => {
  const r = bakeWalk(ROUTE, walkSamples());
  assert.equal(r.kept, 4, JSON.stringify(r.dropped));
  assert.equal(r.mapping['dev-A'], 'A');
  assert.equal(r.mapping['dev-B'], 'B');
  assert.equal(r.mapping['dev-C'], 'C');
  assert.equal(r.mapping['dev-D'], 'D');
});

test('보폭이 달라도 결과가 같다 — 비율만 쓰기 때문', () => {
  // 같은 길을 종종걸음으로 두 배 많이 걸은 사람.
  const doubled = walkSamples().map(s => ({ ...s, steps: s.steps * 2 }));
  const a = bakeWalk(ROUTE, walkSamples());
  const b = bakeWalk(ROUTE, doubled);
  assert.deepEqual(b.mapping, a.mapping);
});

test('어디서나 비슷하게 들리는 기기는 안 넣는다', () => {
  // 건물 전체에 걸친 공유기 — 지점을 못 가르므로 매핑에 있으면 해롭다.
  const flat = walkSamples().map(s => ({
    ...s,
    readings: [...s.readings, { beaconId: 'dev-EVERYWHERE', rssi: -70 }],
  }));
  const r = bakeWalk(ROUTE, flat);
  assert.equal(r.mapping['dev-EVERYWHERE'], undefined);
  assert.ok(r.dropped.some(d => d.beaconId === 'dev-EVERYWHERE' && d.why === 'flat'));
});

test('표본이 모자란 기기는 안 넣는다', () => {
  const once = [{ steps: 0, readings: [{ beaconId: 'dev-BLIP', rssi: -50 }] }];
  const r = bakeWalk(ROUTE, once);
  assert.equal(r.kept, 0);
  assert.equal(r.dropped[0].why, 'few-samples');
});

test('너무 약한 기기는 안 넣는다', () => {
  const weak = [0, 40, 80].map(steps => ({
    steps, readings: [{ beaconId: 'dev-FAR', rssi: -99 }],
  }));
  const r = bakeWalk(ROUTE, weak);
  assert.equal(r.kept, 0);
  assert.equal(r.dropped[0].why, 'too-weak');
});

test('한 지점에서만 들린 기기는 통과시킨다', () => {
  // 대비를 잴 상대가 없다. 그 지점에서만 들렸다는 것은 오히려 잘 가른다는 뜻이다.
  // (걷기 자체는 끝까지 갔고, 이 기기만 A 근처에서 끊긴 상황)
  const walk = walkSamples().map(s =>
    (s.steps <= 8
      ? { ...s, readings: [...s.readings, { beaconId: 'dev-ONLY', rssi: -52 }] }
      : s));
  const r = bakeWalk(ROUTE, walk);
  assert.equal(r.mapping['dev-ONLY'], 'A');
});

test('한 자리에 서 있었으면 그 지점 답사가 된다', () => {
  // 걸음이 0이라 진행률이 0/0 이 된다. NaN 으로 통째로 죽으면 안 된다.
  const still = [0, 0, 0].map(() => ({
    steps: 0, readings: [{ beaconId: 'dev-HERE', rssi: -48 }],
  }));
  const r = bakeWalk(ROUTE, still);
  assert.equal(r.mapping['dev-HERE'], 'A');
  assert.equal(r.steps, 0);
});

test('빈 걷기는 빈 답사', () => {
  const r = bakeWalk(ROUTE, []);
  assert.equal(r.kept, 0);
  assert.equal(r.devices, 0);
});

test('경로가 비어도 안 죽는다', () => {
  const r = bakeWalk([], walkSamples());
  assert.equal(r.kept, 0);
});

test('이상치 하나에 안 끌려간다', () => {
  // A 에서 한 번 튀어 -40 이 찍혔지만 나머지는 전부 약하다. 평균이면
  // A 로 끌려가고, 중앙값이면 안 끌려간다.
  const s = [
    { steps: 0, readings: [{ beaconId: 'x', rssi: -40 }] },
    { steps: 4, readings: [{ beaconId: 'x', rssi: -90 }] },
    { steps: 8, readings: [{ beaconId: 'x', rssi: -90 }] },
    { steps: 116, readings: [{ beaconId: 'x', rssi: -60 }] },
    { steps: 118, readings: [{ beaconId: 'x', rssi: -58 }] },
    { steps: 120, readings: [{ beaconId: 'x', rssi: -59 }] },
  ];
  assert.equal(bakeWalk(ROUTE, s).mapping.x, 'D');
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✅ ${name}`); pass++; }
  catch (err) { console.error(`❌ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
console.log(`\n걷기 답사: ${pass}/${tests.length}`);
