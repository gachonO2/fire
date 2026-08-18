// 판단 계층: 확정·이동·참고 세 갈래를 하나의 위치 추정으로 합치는 부분.
//
// 여기서 지키려는 것은 정확도가 아니라 **정직함**이다. 틀리는 것보다 "틀렸는데
// 자신 있는" 상태가 위험하므로, 확신도가 제때 떨어지는지를 정확도만큼 검사한다.
import { FloorPlan } from '../shared/floor-plan.js';
import { Fusion } from '../shared/fusion.js';
import { BeaconLocator } from '../shared/positioning.js';
import { BeaconAnchor } from '../shared/beacon-anchor.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// 복도 하나 + 갈림길 하나.
//
//        FAR (0,30)
//         │  E3
//   R302 ─┴─ J1 ── EXIT          (가로 한 줄, 12m 간격)
//     E1        E2
//
// northOffset 0 = 도면 위쪽이 자북. 그래야 나침반 검사를 할 수 있다.
const plan = new FloorPlan({
  id: 'fusion-fixture',
  name: '판단 계층 시험용 도면',
  metersPerUnit: 1,
  stepLength: 1,          // 1걸음 = 1m — 걸음 수 계산을 눈으로 확인하기 쉽게
  northOffset: 0,
  nodes: [
    { id: 'R302', name: '302호 앞', x: 0, y: 0, type: 'room', beaconId: 'BC-302' },
    { id: 'J1', name: '교차점', x: 12, y: 0, type: 'junction', beaconId: 'BC-J1' },
    { id: 'EXIT', name: '출구', x: 24, y: 0, type: 'exit', beaconId: 'BC-EXIT' },
    { id: 'FAR', name: '반대편 끝', x: 0, y: 30, type: 'room', beaconId: 'BC-FAR' },
  ],
  edges: [
    { id: 'E1', a: 'R302', b: 'J1' },
    { id: 'E2', a: 'J1', b: 'EXIT' },
    { id: 'E3', a: 'R302', b: 'FAR' },
  ],
});

expect('E1 은 12걸음', plan.edgeSteps(plan.getEdge('E1')) === 12);
expect('R302→J1 은 도면 기준 동쪽(90°)', near(plan.bearing('R302', 'J1'), 90));

// ─────────────────────────────────────────── 확정 단서로 시작
{
  const f = new Fusion(plan);
  expect('앵커 전에는 위치가 없다', f.position() === null);
  expect('앵커 전 확신도 0', f.confidence() === 0);

  f.anchorAt('R302', { kind: 'beacon' });
  const p = f.position();
  expect('첫 앵커로 위치가 생긴다', p?.nodeId === 'R302', `→ ${p?.nodeId}`);
  expect('첫 앵커 좌표는 그 노드', near(p.x, 0) && near(p.y, 0), `→ ${p.x},${p.y}`);
  expect('첫 앵커 직후 확신도 1', near(f.confidence(), 1, 1e-9), `→ ${f.confidence()}`);
  expect('출처가 비콘', f.source() === 'beacon');
}

// ─────────────────────────────────────────── 걸으면 전진한다
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  // R302 에서 J1 쪽(동쪽=90°)으로 6걸음
  for (let i = 0; i < 6; i++) f.step({ heading: 90 });

  const p = f.position();
  expect('6걸음 뒤 E1 위', p.edgeId === 'E1', `→ ${p.edgeId}`);
  expect('6걸음 뒤 절반쯤', near(p.progress, 0.5, 0.01), `→ ${p.progress}`);
  expect('6걸음 뒤 좌표 x≈6', near(p.x, 6, 0.2), `→ ${p.x}`);
  expect('출처가 걸음으로 바뀐다', f.source() === 'pdr');
}

// ─────────────────────────────────────────── 확신도는 걸을수록 떨어진다
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  const c0 = f.confidence();

  for (let i = 0; i < 12; i++) f.step({ heading: 90 });
  const c12 = f.confidence();
  for (let i = 0; i < 13; i++) f.step({ heading: 90 });
  const c25 = f.confidence();

  expect('걸을수록 확신도가 떨어진다', c0 > c12 && c12 > c25,
    `${c0.toFixed(2)} → ${c12.toFixed(2)} → ${c25.toFixed(2)}`);
  // halfLifeSteps 25 → 25걸음이면 신선도가 절반. 분기로 집중도도 함께 떨어진다.
  expect('25걸음이면 확신도가 절반 아래', c25 < 0.5, `→ ${c25.toFixed(2)}`);
}

// ─────────────────────────────────────────── 앵커를 만나면 회복된다
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 20; i++) f.step({ heading: 90 });
  const before = f.confidence();

  f.anchorAt('J1', { kind: 'beacon' });
  const after = f.confidence();

  expect('앵커가 확신도를 회복시킨다', after > before,
    `${before.toFixed(2)} → ${after.toFixed(2)}`);
  expect('앵커 후 위치가 그 노드', f.position().nodeId === 'J1');
}

// ─────────────────────────────────────────── 멀리서 온 단발 앵커는 납치하지 못한다
//
// 다중경로 반사로 건물 반대편 비콘이 한 번 세게 잡히는 일이 있다. 그걸 그대로
// 믿으면 위치가 순간이동하고 확신도까지 1.0 이 되는 최악의 상태가 된다.
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 4; i++) f.step({ heading: 90 });

  f.anchorAt('EXIT', { kind: 'beacon' });   // R302 에서 2홉 밖
  const p = f.position();
  expect('먼 곳의 단발 앵커가 위치를 뺏지 못한다', p.nodeId !== 'EXIT', `→ ${p.nodeId}`);
  expect('그래도 후보로는 남는다',
    f.snapshot().some(c => c.to === 'EXIT' || c.from === 'EXIT'));

  // 같은 앵커가 반복해서 들어오면 결국 이겨야 한다 — 비콘이 죽었거나 사용자가
  // 빨리 걸어 중간 노드를 건너뛴 경우가 실제로 있기 때문이다.
  for (let i = 0; i < 6; i++) f.anchorAt('EXIT', { kind: 'beacon' });
  expect('반복되는 앵커는 결국 이긴다', f.position().nodeId === 'EXIT',
    `→ ${f.position().nodeId}`);
}

// ─────────────────────────────────────────── 사람이 알려준 값은 즉시 믿는다
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  f.anchorAt('EXIT', { kind: 'manual', trusted: true });   // QR 스캔
  expect('QR 은 거리 검사 없이 즉시 확정', f.position().nodeId === 'EXIT');
  expect('QR 직후 확신도 1', near(f.confidence(), 1, 1e-9), `→ ${f.confidence()}`);
}

// ─────────────────────────────────────────── 참고 단서는 지우지 않고 깎는다
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 3; i++) f.step();       // 방위 없이 전진 (분기 발생)

  const beforeCount = f.snapshot().length;
  // 완전히 틀린 방위를 계속 먹인다
  for (let i = 0; i < 10; i++) f.observeHeading(270);
  const after = f.snapshot();

  expect('참고 단서만으로는 후보가 사라지지 않는다', after.length === beforeCount,
    `${beforeCount} → ${after.length}`);
  expect('그래도 가중치는 갈린다', after[0].weight > after[after.length - 1].weight);
}

// ─────────────────────────────────────────── 갈림길에서 나침반이 한쪽을 고른다
//
// R302 에는 통로가 둘이다: J1(동쪽 90°) 과 FAR(남쪽 180°).
// 걸음만으로는 어느 쪽인지 모르지만, 나침반이 있으면 갈린다.
{
  const east = new Fusion(plan);
  east.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 3; i++) east.step({ heading: 90 });

  const south = new Fusion(plan);
  south.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 3; i++) south.step({ heading: 180 });

  expect('동쪽으로 걸으면 J1 쪽을 고른다', east.position().to === 'J1',
    `→ ${east.position().to}`);
  expect('남쪽으로 걸으면 FAR 쪽을 고른다', south.position().to === 'FAR',
    `→ ${south.position().to}`);

  const blind = new Fusion(plan);
  blind.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 3; i++) blind.step();
  expect('방위가 없으면 양쪽을 다 들고 있다',
    blind.confidence() < east.confidence(),
    `${blind.confidence().toFixed(2)} < ${east.confidence().toFixed(2)}`);
}

// ─────────────────────────────────────────── northOffset 을 모르면 나침반을 안 쓴다
{
  const noNorth = new FloorPlan({ ...plan.toJSON(), northOffset: undefined });
  const f = new Fusion(noNorth);
  f.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 3; i++) f.step();
  const before = f.snapshot().map(c => c.weight);
  f.observeHeading(270);
  const after = f.snapshot().map(c => c.weight);
  expect('방위 기준을 모르면 아무것도 깎지 않는다',
    before.every((w, i) => near(w, after[i], 1e-9)));
}

// ─────────────────────────────────────────── 후보 수에 상한이 걸린다
{
  const f = new Fusion(plan, { maxCandidates: 8 });
  f.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 80; i++) f.step();
  expect('후보 수가 상한을 넘지 않는다', f.snapshot().length <= 8,
    `→ ${f.snapshot().length}`);
  const sum = f.snapshot().reduce((s, c) => s + c.weight, 0);
  expect('가중치 합은 항상 1', near(sum, 1, 1e-9), `→ ${sum}`);
}

// ─────────────────────────────────────────── 확정 없이 오래 걸으면 안내를 멈출 수준까지 떨어진다
{
  const f = new Fusion(plan);
  f.anchorAt('R302', { kind: 'beacon' });
  for (let i = 0; i < 60; i++) f.step({ heading: 90 });
  expect('60걸음 무앵커면 확신도가 바닥', f.confidence() < 0.25,
    `→ ${f.confidence().toFixed(3)}`);
  expect('그래도 위치는 계속 내놓는다 (안내 중단 판단은 화면 몫)',
    f.position() !== null);
}

// ══════════════════════════════════ 비콘 → 판단 계층 연결 (beacon-anchor.js)

/** 비콘 하나를 t0 부터 ms 동안 먹이며 다리를 돌린다. 마지막 update 결과를 낸다. */
function feed(bridge, locator, beaconId, t0, ms, rssi = -55) {
  let last = null;
  for (let t = t0; t <= t0 + ms; t += 500) {
    locator.addScans([{ beaconId, rssi, ts: t }]);
    last = bridge.update(t);
  }
  return last;
}

// ─────────────────────────────────────────── 실제 수신이 있어야 앵커를 놓는다
{
  const f = new Fusion(plan);
  const loc = new BeaconLocator(plan);
  const bridge = new BeaconAnchor(f, loc);

  expect('스캔이 하나도 없으면 아무 일도 없다', bridge.update(0) === null);
  expect('앵커가 없으니 위치도 없다', f.position() === null);

  const r = feed(bridge, loc, 'BC-302', 0, 2500);
  expect('비콘을 잡으면 그 노드에 앵커', f.position()?.nodeId === 'R302',
    `→ ${f.position()?.nodeId}`);
  expect('수신 중임을 보고한다', r.live === true);
  expect('확정 후 확신도 1', near(f.confidence(), 1, 1e-9), `→ ${f.confidence()}`);
}

// ─────────────────────────────────────────── 같은 노드가 반복돼도 걸음을 지우지 않는다
//
// 비콘 판정은 "가장 가까운 노드"라 그 영역 안을 걷는 동안 계속 같은 답이 나온다.
// 그때마다 앵커를 놓으면 통로 위 진행도가 매번 노드로 되감긴다.
{
  const f = new Fusion(plan);
  const loc = new BeaconLocator(plan);
  const bridge = new BeaconAnchor(f, loc);
  feed(bridge, loc, 'BC-302', 0, 2500);

  let reAnchored = 0;
  for (let i = 0; i < 5; i++) {
    f.step({ heading: 90 });                       // 한 걸음 J1 쪽으로
    loc.addScans([{ beaconId: 'BC-302', rssi: -60, ts: 3000 + i * 500 }]);
    if (bridge.update(3000 + i * 500)?.anchored) reAnchored++;
  }

  expect('같은 노드에는 앵커를 다시 놓지 않는다', reAnchored === 0, `→ ${reAnchored}회`);
  const p = f.position();
  expect('걸어온 진행도가 남아 있다', p.progress > 0.3 && p.progress < 0.5,
    `→ ${p.progress.toFixed(2)}`);
  expect('노드에 되감기지 않았다', !near(p.x, 0, 0.5), `→ x=${p.x.toFixed(1)}`);
}

// ─────────────────────────────────────────── 노드가 바뀌면 앵커를 놓는다
{
  const f = new Fusion(plan);
  const loc = new BeaconLocator(plan);
  const bridge = new BeaconAnchor(f, loc);
  feed(bridge, loc, 'BC-302', 0, 2500);
  for (let i = 0; i < 10; i++) f.step({ heading: 90 });

  const r = feed(bridge, loc, 'BC-J1', 3000, 5000);   // J1 이 확실히 이길 만큼 먹인다
  expect('노드가 바뀌면 앵커', r.anchored === true || f.position().nodeId === 'J1',
    `→ ${f.position().nodeId}`);
  expect('위치가 새 노드로 옮겨간다', f.position().nodeId === 'J1');
}

// ─────────────────────────────────────────── 붙잡아 둔 값에는 앵커를 놓지 않는다
//
// estimate() 는 신호가 전멸해도 마지막 노드를 그대로 돌려준다(안내가 끊기지 않게
// 하려는 의도된 동작). 그걸 앵커로 넣으면 근거 없이 확신도가 1.0 으로 유지된다.
{
  const f = new Fusion(plan);
  const loc = new BeaconLocator(plan);
  const bridge = new BeaconAnchor(f, loc);
  feed(bridge, loc, 'BC-302', 0, 2500);

  // staleMs(6000) 를 넘겨 신호를 끊고, 걸으면서 계속 물어본다
  let anchored = 0;
  for (let i = 0; i < 20; i++) {
    f.step({ heading: 90 });
    const r = bridge.update(20000 + i * 500);
    if (r?.anchored) anchored++;
    if (i === 0) expect('신호가 끊긴 것을 안다', r.live === false);
  }

  expect('붙잡아 둔 값에는 앵커를 놓지 않는다', anchored === 0, `→ ${anchored}회`);
  expect('그래서 확신도가 정직하게 떨어진다', f.confidence() < 0.7,
    `→ ${f.confidence().toFixed(2)}`);
  expect('위치는 계속 내놓는다', f.position() !== null);
}

// ─────────────────────────────────────────── 확정 전에는 앵커를 놓지 않는다
//
// 잠정값을 낮은 신뢰도로 넣어보니 로케이터의 히스테리시스와 판단 계층의 거리
// 검사가 서로 싸웠다. 잠정으로 R302 를 넣은 직후 더 센 J1 이 들어오면, 판단 계층은
// "0걸음 걸었는데 12걸음 떨어진 곳에서 신호"라며 정당하게 거부한다.
// 「확실해질 때까지 기다리기」는 로케이터가 이미 하므로 두 겹으로 하지 않는다.
{
  const f = new Fusion(plan);
  const loc = new BeaconLocator(plan);
  const bridge = new BeaconAnchor(f, loc);

  loc.addScans([{ beaconId: 'BC-302', rssi: -55, ts: 0 }]);
  const r0 = bridge.update(0);
  expect('확정 전에는 앵커를 놓지 않는다', r0.anchored === false && r0.locked === false);
  expect('그래서 아직 위치가 없다', f.position() === null);

  // 확정 전에 더 센 비콘이 들어오면 로케이터가 알아서 갈아탄다
  loc.addScans([{ beaconId: 'BC-J1', rssi: -40, ts: 500 }]);
  bridge.update(500);
  expect('확정 전 판정은 로케이터가 자유롭게 정정한다', loc.nodeId === 'J1',
    `→ ${loc.nodeId}`);
  expect('판단 계층은 아직 비어 있다', f.position() === null);

  // 확정되면 그때 한 번 앵커가 놓인다
  const r = feed(bridge, loc, 'BC-J1', 1000, 2500, -40);
  expect('확정되는 순간 앵커', r.anchored === true || f.position()?.nodeId === 'J1');
  expect('확정 후 위치는 정정된 노드', f.position()?.nodeId === 'J1',
    `→ ${f.position()?.nodeId}`);
}

console.log(failed === 0 ? '\n판단 계층 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
