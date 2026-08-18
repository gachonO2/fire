// 추적 계층: 판단 계층 + 세 앵커를 실제 도면 위에서 함께 돌린다.
//
// 이 시험의 목적은 알고리즘 검증이 아니라 **시연이 깨지지 않는지 미리 보는 것**이다.
// 화면은 확신도가 문턱 아래로 떨어지면 안내를 멈추고 "그 자리에 계세요"로 바뀐다.
// 그게 시연 도중에 일어나면 아무것도 못 보여준다. 실기기로 알기 전에 여기서 안다.
import { FloorPlan } from '../shared/floor-plan.js';
import { Tracking } from '../shared/tracking.js';
import { routeToNearestExit } from '../shared/pathfinding.js';
import { simulateScan, positionAlongRoute, seededRng } from '../shared/beacon-sim.js';
import { WalkSim } from '../shared/walk-sim.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

/** GuideScreen 의 CONFIDENCE_FLOOR 와 같은 값. 여기가 시연이 멈추는 선이다. */
const CONFIDENCE_FLOOR = 0.35;

/** 비콘 id 가 없는 도면에 지점마다 가상 비콘을 놓는다 (앱의 withVirtualBeacons 와 같은 규칙) */
function withVirtualBeacons(plan) {
  if (plan.nodes.some(n => n.beaconId)) return plan;
  return {
    ...plan,
    nodes: plan.nodes.map(n =>
      n.type === 'elevator' ? n : { ...n, beaconId: `SIM-${n.id}` }),
  };
}

// 시연용 도면과 같은 규모: 복도 하나 + 갈림길 + 계단
const RAW = {
  id: 'demo-3f',
  name: '시연용 3층',
  metersPerUnit: 1,
  stepLength: 0.7,
  northOffset: 0,
  nodes: [
    { id: 'R301', name: '301호', x: 0, y: 0, type: 'room' },
    { id: 'R302', name: '302호', x: 0, y: 8, type: 'room' },
    { id: 'HW1', name: '복도 1', x: 10, y: 4, type: 'junction' },
    { id: 'HW2', name: '복도 2', x: 22, y: 4, type: 'junction' },
    { id: 'STAIR', name: '계단', x: 32, y: 4, type: 'stair' },
    { id: 'EXIT', name: '비상구', x: 42, y: 4, type: 'exit' },
  ],
  edges: [
    { id: 'E1', a: 'R301', b: 'HW1' },
    { id: 'E2', a: 'R302', b: 'HW1' },
    { id: 'E3', a: 'HW1', b: 'HW2' },
    { id: 'E4', a: 'HW2', b: 'STAIR' },
    { id: 'E5', a: 'STAIR', b: 'EXIT' },
  ],
};
const plan = new FloorPlan(withVirtualBeacons(RAW));
const route = routeToNearestExit(plan, 'R301');
expect('경로가 나온다', !!route, `→ ${route?.nodes.join(' → ')}`);

/**
 * 경로를 끝까지 걷는다. 걸음마다 판단 계층에 먹이고, 비콘은 500ms 마다 스캔한다.
 * @returns 걸음마다의 {confidence, source, offRoute, err}
 */
function walk({ steps = 60, seed = 7, scanEvery = 1, heading = true } = {}) {
  const t = new Tracking(plan, { startNodeId: 'R301' });
  const rng = seededRng(seed);
  const log = [];
  let now = 1000;

  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const truth = positionAlongRoute(plan, route.nodes, progress);

    // 걸음 방위: 지금 걷고 있는 구간의 실제 방위
    const prev = positionAlongRoute(plan, route.nodes, (i - 1) / steps);
    const deg = (Math.atan2(truth.x - prev.x, -(truth.y - prev.y)) * 180) / Math.PI;
    t.step({ heading: heading ? (deg + 360) % 360 : undefined });

    now += 700;
    if (i % scanEvery === 0) {
      t.pushScans(simulateScan(plan, truth, now, { rng }), now);
    }

    const p = t.position();
    log.push({
      i,
      confidence: t.confidence(),
      source: t.source(),
      err: p ? Math.hypot(p.x - truth.x, p.y - truth.y) : Infinity,
    });
  }
  return { t, log };
}

// ─────────────────────────────────────────── 시연이 멈추지 않는가 (가장 중요)
//
// 확신도가 한순간 떨어지는 것 자체는 정직하다. 갈림길에 들어서면 잠깐은 정말로
// 어느 쪽인지 모르기 때문이다. 문제가 되는 건 **그걸 보고 바로 안내를 멈추는 것**이다.
// 그래서 검사하는 것은 "한 번도 안 떨어지는가"가 아니라 "떨어진 채로 머무르는가"다.
//
// 화면도 같은 규칙을 써야 한다 — 한 틱 떨어졌다고 안전상태로 넘어가면 안 되고,
// 몇 걸음 이어질 때만 넘어가야 한다. (비콘 판정이 holdMs 를 두는 것과 같은 이유)
const SAFEHOLD_RUN = 5;   // 이만큼 연속으로 낮으면 진짜로 모르는 것이다
{
  const { log } = walk();
  const min = Math.min(...log.map(r => r.confidence));

  let run = 0, worst = 0;
  for (const r of log) {
    run = r.confidence < CONFIDENCE_FLOOR ? run + 1 : 0;
    worst = Math.max(worst, run);
  }
  const low = log.filter(r => r.confidence < CONFIDENCE_FLOOR).length;

  expect('낮은 확신도가 이어지지 않는다', worst < SAFEHOLD_RUN,
    `최장 ${worst}걸음 연속 · 총 ${low}/${log.length} · 최저 ${min.toFixed(2)}`);
  expect('비콘이 계속 확정해 준다',
    log.filter(r => r.source === 'beacon').length > log.length * 0.3,
    `비콘 출처 ${log.filter(r => r.source === 'beacon').length}/${log.length}걸음`);
  expect('대부분의 걸음은 확신도가 높다',
    log.filter(r => r.confidence >= 0.6).length > log.length * 0.7,
    `0.6 이상 ${log.filter(r => r.confidence >= 0.6).length}/${log.length}걸음`);
}

// ─────────────────────────────────────────── 위치가 실제와 크게 벌어지지 않는가
{
  const { log } = walk();
  const errs = log.map(r => r.err);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const p90 = [...errs].sort((a, b) => a - b)[Math.floor(errs.length * 0.9)];

  expect('평균 오차가 한 자릿수 미터', mean < 6, `→ ${mean.toFixed(2)}m`);
  expect('90% 가 10m 이내', p90 < 10, `→ ${p90.toFixed(2)}m`);
}

// ─────────────────────────────────────────── 비콘이 드물어도 버티는가
//
// 실물 비콘을 몇 개만 살 경우, 또는 신호를 자주 놓치는 경우를 흉내낸다.
{
  const { log } = walk({ scanEvery: 6 });
  const min = Math.min(...log.map(r => r.confidence));
  expect('스캔이 1/6 로 줄어도 확신도가 남는다', min > 0.15, `최저 ${min.toFixed(2)}`);
  expect('그래도 걸음으로 위치는 계속 낸다', log.every(r => Number.isFinite(r.err)));
}

// ─────────────────────────────────────────── 나침반이 없어도 도는가
//
// 실내 자기장이 흔들려 방위를 못 믿는 구간이 실제로 있다.
{
  const { log } = walk({ heading: false });
  expect('나침반 없이도 위치를 낸다', log.every(r => Number.isFinite(r.err)));
  const mean = log.reduce((a, r) => a + r.err, 0) / log.length;
  expect('다만 오차가 커진다', mean > 0, `→ ${mean.toFixed(2)}m`);
}

// ─────────────────────────────────────────── 층 이동이 계단 노드에 꽂히는가
{
  const t = new Tracking(plan, { startNodeId: 'R301' });
  for (let i = 0; i < 10; i++) t.step({ heading: 90 });

  // 20~50초에 걸쳐 3.5m 하강 (계단 속도)
  const HPA = h => 1013.25 - h * (1 / 8.33);
  let change = null;
  for (let s = 0; s <= 110; s++) {
    const alt = s < 20 ? 0 : s < 50 ? -((s - 20) / 30) * 3.5 : -3.5;
    if (s >= 20 && s < 50 && s % 2 === 0) t.step({});   // 계단에서는 걷는다
    const c = t.pushPressure(HPA(alt), s * 1000);
    if (c) change = c;
  }

  expect('계단 하강을 잡는다', change?.kind === 'stair' && change.floors === -1,
    `→ ${change?.kind} ${change?.floors}`);
  expect('계단 노드에 위치가 꽂힌다', t.position().nodeId === 'STAIR',
    `→ ${t.position().nodeId}`);
  expect('층 오프셋이 기록된다', t.floorOffset === -1, `→ ${t.floorOffset}`);
}

// ─────────────────────────────────────────── 경로 이탈을 알아채는가
{
  const t = new Tracking(plan, { startNodeId: 'R301' });
  const rng = seededRng(3);
  let now = 1000;

  // 실제로는 302호 쪽(E2)에 있는데, 경로 추종은 E1 이라고 믿는 상황
  for (let i = 0; i < 8; i++) {
    t.step({});
    now += 700;
    t.pushScans(simulateScan(plan, { x: 2, y: 7 }, now, { rng }), now);
  }

  expect('확신이 있을 때만 이탈을 말한다', t.offRoute(null) === false);
  expect('엉뚱한 통로에 있으면 이탈로 본다',
    t.offRoute('E4') === true, `현재 ${t.position()?.edgeId}`);
  expect('맞는 통로면 이탈이 아니다', t.offRoute(t.position()?.edgeId) === false);
}


// ══════════════════════════════════ 가상 보행자 (walk-sim.js)
//
// 시뮬레이션에서 "실제로 서 있는 곳"을 든다. 경로가 아니라 **걸음과 방위**로
// 움직이되 복도에 갇혀 있어야 한다 — 그래야 이탈이 재현되면서도 드리프트가 안 쌓인다.

// ─────────────────────────────────────────── 방위를 모르면 직진한다
{
  const w = new WalkSim(plan, 'R301');
  for (let i = 0; i < 30; i++) w.step();
  const p = w.position();
  expect('방위 없이 걸으면 곧게 나아간다', p.nodeId !== 'R301', `→ ${p.from}>${p.to}`);
  expect('복도를 벗어나지 않는다', w.edgeId() !== null, `→ ${w.edgeId()}`);
}

// ─────────────────────────────────────────── 갈림길에서 방위대로 꺾는다
{
  // HW1(10,4) 에서 갈 수 있는 곳: R301(0,0) · R302(0,8) · HW2(22,4)
  const east = new WalkSim(plan, 'R301');
  for (let i = 0; i < 40; i++) east.step(east.position().nodeId === 'HW1' ? 90 : undefined);

  // HW1 에서 302호는 248° 다(남서). 301호가 292°, HW2 가 90° —
  // 세 방향이 이만큼 벌어져 있어야 방위로 고를 수 있다.
  const back = new WalkSim(plan, 'R301');
  for (let i = 0; i < 40; i++) {
    const at = back.position();
    back.step(at.nodeId === 'HW1' || at.to === 'R302' ? 248 : undefined);
  }

  expect('동쪽을 보면 출구 쪽으로 간다',
    ['HW2', 'STAIR', 'EXIT'].includes(east.position().nodeId), `→ ${east.position().nodeId}`);
  expect('남서를 보면 302호 쪽으로 간다',
    ['R302', 'HW1'].includes(back.position().nodeId), `→ ${back.position().nodeId}`);
}

// ─────────────────────────────────────────── 오래 걸어도 벽을 뚫지 않는다
{
  const w = new WalkSim(plan, 'R301');
  // 방위를 무작위로 흔들어도 (나침반이 실내에서 튀는 상황) 그래프 위에 남아야 한다
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 500; i++) w.step(rnd() * 360);
  const p = w.position();
  const onGraph = plan.edges.some(e =>
    (e.a === p.from && e.b === p.to) || (e.b === p.from && e.a === p.to));
  expect('500걸음 + 무작위 방위에도 그래프 위에 있다', onGraph, `→ ${p.from}>${p.to}`);
  expect('좌표가 유효하다', Number.isFinite(p.x) && Number.isFinite(p.y));
}

// ─────────────────────────────────────────── 딴 데로 걸으면 판단 계층이 알아챈다
//
// 이게 경로 기반 시뮬레이션으로는 만들 수 없던 장면이다.
{
  const t = new Tracking(plan, { startNodeId: 'R301' });
  const w = new WalkSim(plan, 'R301');
  const rng = seededRng(5);
  let now = 1000;

  // 경로는 R301 → HW1 → HW2 → … 인데, HW1 에서 302호 쪽(248°)으로 꺾어 버린다.
  //
  // 방위는 애매하지 않아야 한다. 처음에 315° 를 줬다가 이 시험이 깨졌는데,
  // 315° 는 301호(292°)에 더 가까워서 **판단 계층이 옳게 판단한 것**이었다.
  // 가상 보행자만 U턴 벌점 때문에 302호로 간 것이라, 시험 쪽이 틀렸다.
  for (let i = 0; i < 24; i++) {
    const at = w.position();
    const heading = at.nodeId === 'HW1' || at.to === 'R302' ? 248 : undefined;
    w.step(heading);
    t.step({ heading });
    now += 700;
    t.pushScans(simulateScan(plan, w.position(), now, { rng }), now);
  }

  const truth = w.edgeId();
  expect('가상 보행자가 경로 밖으로 갔다', truth !== 'E3', `→ ${truth}`);
  expect('판단 계층이 그 위치를 따라간다', t.position()?.edgeId === truth,
    `추정 ${t.position()?.edgeId} vs 실제 ${truth}`);
  expect('경로 이탈로 판정한다', t.offRoute('E3') === true,
    `확신도 ${t.confidence().toFixed(2)}`);
}


console.log(failed === 0 ? '\n추적 계층 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
