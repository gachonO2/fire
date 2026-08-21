// 기압계 층 판정: 엘리베이터·계단을 공짜 앵커로 만드는 부분.
//
// 실기기로는 재현이 안 되는 검증(같은 날씨 드리프트를 반복)이라 합성 신호로 한다.
// 여기서 제일 중요한 검사는 정확도가 아니라 **날씨를 층 이동으로 오인하지 않는가**다.
// 오인하면 엉뚱한 노드에 앵커가 박히고, 그게 확신도까지 1.0 으로 만든다.
import { FloorPlan } from '../shared/floor-plan.js';
import { Fusion } from '../shared/fusion.js';
import { AltitudeTracker, ALTITUDE_DEFAULTS } from '../shared/altitude.js';
import { FloorChangeAnchor } from '../shared/altitude-anchor.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

const HPA_PER_M = 1 / ALTITUDE_DEFAULTS.metersPerHpa;   // 1m 오르면 이만큼 내려간다
const BASE = 1013.25;
/** 고도(m) → 기압(hPa) */
const hpaAt = m => BASE - m * HPA_PER_M;

/**
 * 합성 기압 시퀀스를 1Hz 로 먹인다.
 * @param {(t:number) => {alt:number, steps:number}} at  경과 초 → 그 시점의 고도·누적걸음
 * @returns 발생한 층 이동 이벤트들
 */
function run(tracker, seconds, at, noise = 0) {
  const events = [];
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let t = 0; t <= seconds; t++) {
    const { alt, steps } = at(t);
    const e = tracker.push(hpaAt(alt) + rnd() * noise, t * 1000, steps);
    if (e) events.push({ ...e, t });
  }
  return events;
}

// ─────────────────────────────────────────── 가만히 있으면 아무 일도 없다
{
  const tr = new AltitudeTracker();
  const ev = run(tr, 300, () => ({ alt: 0, steps: 0 }));
  expect('정지 상태에서는 이벤트 없음', ev.length === 0, `→ ${ev.length}건`);
  expect('이동 중이 아니다', tr.inTransit === false);
}

// ─────────────────────────────────────────── 센서 노이즈만으로는 안 움직인다
{
  const tr = new AltitudeTracker();
  // 폰 기압계 분해능은 0.01~0.06 hPa. 넉넉히 0.05 hPa 흔들어 본다 (≈ 0.4m)
  const ev = run(tr, 600, () => ({ alt: 0, steps: 0 }), 0.05);
  expect('노이즈를 층 이동으로 보지 않는다', ev.length === 0, `→ ${ev.length}건`);
}

// ─────────────────────────────────────────── 날씨 드리프트를 층 이동으로 오인하지 않는다
//
// 이 검사가 이 모듈의 존재 이유다. 기압은 날씨로 시간당 1~3 hPa(8~25m 상당)
// 움직이는데, 한 층은 0.42 hPa 뿐이다. 절대값을 쓰면 하루에 수십 층을 오르내린다.
{
  const tr = new AltitudeTracker();
  // 30분 동안 2 hPa 하강 = 약 16.7m 상당. 실제 날씨보다 빠른 편.
  const ev = run(tr, 1800, t => ({ alt: (t / 1800) * 16.7, steps: 0 }), 0.02);
  expect('30분간 날씨 드리프트를 무시한다', ev.length === 0, `→ ${ev.length}건`);
}

// ─────────────────────────────────────────── 엘리베이터로 한 층
{
  const tr = new AltitudeTracker();
  // 0~20초 대기 → 20~35초 상승(3.5m) → 이후 정지. 걸음은 타기 전 몇 걸음뿐.
  const ev = run(tr, 90, t => ({
    alt: t < 20 ? 0 : t < 35 ? ((t - 20) / 15) * 3.5 : 3.5,
    steps: Math.min(t, 15),          // 엘리베이터 앞까지 15걸음, 그 뒤 정지
  }), 0.02);

  expect('엘리베이터 한 층을 잡는다', ev.length === 1, `→ ${ev.length}건`);
  expect('엘리베이터로 판정', ev[0]?.kind === 'elevator', `→ ${ev[0]?.kind}`);
  expect('한 층 상승', ev[0]?.floors === 1, `→ ${ev[0]?.floors}`);
  expect('이동 중 걸음이 거의 없다', ev[0]?.steps <= 6, `→ ${ev[0]?.steps}걸음`);
}

// ─────────────────────────────────────────── 계단으로 한 층 내려감
{
  const tr = new AltitudeTracker();
  // 20~50초에 걸쳐 3.5m 하강하면서 계속 걷는다
  const ev = run(tr, 110, t => ({
    alt: t < 20 ? 0 : t < 50 ? -((t - 20) / 30) * 3.5 : -3.5,
    steps: t < 20 ? 0 : t < 50 ? (t - 20) * 2 : 60,     // 초당 두 걸음
  }), 0.02);

  expect('계단 한 층을 잡는다', ev.length === 1, `→ ${ev.length}건`);
  expect('계단으로 판정', ev[0]?.kind === 'stair', `→ ${ev[0]?.kind}`);
  expect('한 층 하강', ev[0]?.floors === -1, `→ ${ev[0]?.floors}`);
  expect('이동 중 걸었다', ev[0]?.steps > 6, `→ ${ev[0]?.steps}걸음`);
}

// ─────────────────────────────────────────── 두 층은 두 층으로 센다
{
  const tr = new AltitudeTracker();
  const ev = run(tr, 100, t => ({
    alt: t < 20 ? 0 : t < 45 ? ((t - 20) / 25) * 7.0 : 7.0,
    steps: Math.min(t, 12),
  }), 0.02);
  expect('두 층 상승', ev[0]?.floors === 2, `→ ${ev[0]?.floors}`);
  expect('누적 층 오프셋이 쌓인다', tr.floorOffset === 2, `→ ${tr.floorOffset}`);
}

// ─────────────────────────────────────────── 작은 변화는 무시한다
{
  const tr = new AltitudeTracker();
  // 1.5m — 문 여닫힘·공조·기압 순간 변동 수준. 한 층(3.5m)에 못 미친다.
  const ev = run(tr, 90, t => ({
    alt: t < 20 ? 0 : t < 28 ? ((t - 20) / 8) * 1.5 : 1.5,
    steps: 0,
  }), 0.02);
  expect('한 층에 못 미치는 변화는 무시', ev.length === 0, `→ ${ev.length}건`);
}

// ─────────────────────────────────────────── 이동이 끝난 뒤에 한 번만 낸다
{
  const tr = new AltitudeTracker();
  let duringTransit = false;
  let seed = 7;
  for (let t = 0; t <= 90; t++) {
    const alt = t < 20 ? 0 : t < 35 ? ((t - 20) / 15) * 3.5 : 3.5;
    const e = tr.push(hpaAt(alt), t * 1000, Math.min(t, 10));
    if (t > 22 && t < 33 && tr.inTransit) duringTransit = true;
    if (e && t < 36) failed++, console.log(`❌ 이동 중에 결과를 냈다 (t=${t})`);
  }
  expect('이동 중에는 "이동 중"임을 알린다', duringTransit === true);
  expect('결과는 도착 후에만 나온다', true);
}

// ══════════════════════════════════ 판단 계층 연결 (altitude-anchor.js)

//   R101 ── LOBBY ── ELEV
//                 └─ STAIR
const plan = new FloorPlan({
  id: 'floor-fixture',
  name: '층 이동 시험용',
  metersPerUnit: 1,
  stepLength: 1,
  nodes: [
    { id: 'R101', name: '101호', x: 0, y: 0, type: 'room' },
    { id: 'LOBBY', name: '로비', x: 10, y: 0, type: 'junction' },
    { id: 'ELEV', name: '엘리베이터', x: 20, y: 0, type: 'elevator' },
    { id: 'STAIR', name: '계단', x: 10, y: 10, type: 'stair' },
    { id: 'EXIT', name: '출구', x: 0, y: 10, type: 'exit' },
  ],
  edges: [
    { id: 'A', a: 'R101', b: 'LOBBY' },
    { id: 'B', a: 'LOBBY', b: 'ELEV' },
    { id: 'C', a: 'LOBBY', b: 'STAIR' },
    { id: 'D', a: 'STAIR', b: 'EXIT' },
  ],
});

// ─────────────────────────────────────────── 엘리베이터 이동은 엘리베이터 노드에 앵커
{
  const f = new Fusion(plan);
  const anchor = new FloorChangeAnchor(f, plan);
  f.anchorAt('R101', { kind: 'beacon' });
  for (let i = 0; i < 10; i++) f.step();          // 확신도를 떨어뜨려 둔다
  const before = f.confidence();

  const placed = anchor.apply({ kind: 'elevator', floors: 1, meters: 3.5, steps: 2 });
  expect('엘리베이터 노드에 앵커', placed === 'ELEV', `→ ${placed}`);
  expect('위치가 엘리베이터로', f.position().nodeId === 'ELEV');
  expect('확신도가 회복된다', f.confidence() > before,
    `${before.toFixed(2)} → ${f.confidence().toFixed(2)}`);
  expect('출처가 기압계', f.source() === 'barometer');
}

// ─────────────────────────────────────────── 계단 이동은 계단 노드에 앵커
{
  const f = new Fusion(plan);
  const anchor = new FloorChangeAnchor(f, plan);
  f.anchorAt('R101', { kind: 'beacon' });
  const placed = anchor.apply({ kind: 'stair', floors: -1, meters: -3.5, steps: 40 });
  expect('계단 노드에 앵커', placed === 'STAIR', `→ ${placed}`);
  expect('위치가 계단으로', f.position().nodeId === 'STAIR');
}

// ─────────────────────────────────────────── 해당 종류의 노드가 없으면 아무 일도 없다
{
  const noElev = new FloorPlan({
    ...plan.toJSON(),
    nodes: plan.nodes.filter(n => n.type !== 'elevator'),
    edges: plan.edges.filter(e => e.a !== 'ELEV' && e.b !== 'ELEV'),
  });
  const f = new Fusion(noElev);
  const anchor = new FloorChangeAnchor(f, noElev);
  f.anchorAt('R101', { kind: 'beacon' });
  const placed = anchor.apply({ kind: 'elevator', floors: 1, meters: 3.5, steps: 1 });
  expect('엘리베이터가 없는 도면에서는 앵커하지 않는다', placed === null, `→ ${placed}`);
  expect('위치가 그대로', f.position().nodeId === 'R101');
}

// ─────────────────────────────────────────── 같은 종류가 여럿이면 가까운 쪽을 고른다
{
  const two = new FloorPlan({
    ...plan.toJSON(),
    nodes: [...plan.nodes, { id: 'STAIR2', name: '계단B', x: 30, y: 10, type: 'stair' }],
    edges: [...plan.edges, { id: 'E', a: 'ELEV', b: 'STAIR2' }],
  });
  const f = new Fusion(two);
  const anchor = new FloorChangeAnchor(f, two);
  f.anchorAt('R101', { kind: 'beacon' });         // STAIR 가 STAIR2 보다 가깝다
  const placed = anchor.apply({ kind: 'stair', floors: 1, meters: 3.5, steps: 40 });
  expect('가까운 계단을 고른다', placed === 'STAIR', `→ ${placed}`);

  const g = new Fusion(two);
  const anchorG = new FloorChangeAnchor(g, two);
  g.anchorAt('STAIR2', { kind: 'beacon' });       // 이번엔 STAIR2 근처
  const placedG = anchorG.apply({ kind: 'stair', floors: 1, meters: 3.5, steps: 40 });
  expect('반대편에 있으면 그쪽 계단을 고른다', placedG === 'STAIR2', `→ ${placedG}`);
}

// ─────────────────────────────────────────── 아무것도 모를 때도 앵커가 된다
{
  const f = new Fusion(plan);
  const anchor = new FloorChangeAnchor(f, plan);
  expect('앵커 전에는 위치가 없다', f.position() === null);
  const placed = anchor.apply({ kind: 'elevator', floors: 1, meters: 3.5, steps: 2 });
  expect('믿음이 비어 있어도 앵커가 된다', placed === 'ELEV' && f.position().nodeId === 'ELEV');
}

console.log(failed === 0 ? '\n기압계 층 판정 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
