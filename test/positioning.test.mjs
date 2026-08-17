// 비콘 측위: 최근접 판정 + 스무딩 + 히스테리시스 + 그래프 제약
// 실기기로는 재현이 안 되는 검증(같은 노이즈 시퀀스 반복)이라 시뮬레이터로 한다.
import { FloorPlan, validatePlan } from '../shared/floor-plan.js';
import { BeaconLocator } from '../shared/positioning.js';
import { simulateScan, positionAlongRoute, seededRng } from '../shared/beacon-sim.js';
import { routeToNearestExit } from '../shared/pathfinding.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

// 데모 구성과 같은 복도 하나: [302호]──[교차점]──[출구]  (비콘 3개)
const plan = new FloorPlan({
  id: 'demo-corridor',
  name: '데모 복도',
  metersPerUnit: 1, // 좌표 = 미터
  stepLength: 0.7,
  nodes: [
    { id: 'R302', name: '302호 앞', x: 0, y: 0, type: 'room', beaconId: 'BC-302' },
    { id: 'J1', name: '복도 교차점', x: 12, y: 0, type: 'junction', beaconId: 'BC-J1' },
    { id: 'EXIT', name: '출구', x: 24, y: 0, type: 'exit', beaconId: 'BC-EXIT' },
    { id: 'FAR', name: '반대편 끝', x: 0, y: 30, type: 'room', beaconId: 'BC-FAR' }, // 비인접
  ],
  edges: [
    { id: 'E1', a: 'R302', b: 'J1' },
    { id: 'E2', a: 'J1', b: 'EXIT' },
    { id: 'E3', a: 'R302', b: 'FAR' },
  ],
});

// ------------------------------------------------------------ 매핑·검증
expect('beaconMap 생성', plan.beaconMap()['BC-302'] === 'R302',
  JSON.stringify(plan.beaconMap()));
expect('비콘 노드 4개', plan.beaconNodes().length === 4);
expect('비콘 id 중복은 거부', validatePlan({
  name: 'x',
  nodes: [
    { id: 'A', x: 0, y: 0, type: 'exit', beaconId: 'BC-1' },
    { id: 'B', x: 1, y: 1, type: 'room', beaconId: 'BC-1' },
  ],
  edges: [],
}).some(e => e.includes('비콘')));

// ------------------------------------------------------------ 기본 판정
{
  const loc = new BeaconLocator(plan);
  loc.addScans([{ beaconId: 'BC-302', rssi: -55, ts: 1000 }]);
  const est = loc.estimate(1000);
  expect('첫 신호로 즉시 위치 확정', est?.nodeId === 'R302', `→ ${est?.nodeId}`);

  loc.addScans([{ beaconId: 'BC-UNKNOWN', rssi: -30, ts: 1100 }]);
  expect('모르는 비콘은 무시', loc.estimate(1100)?.nodeId === 'R302');
}

/** holdMs 동안 한 비콘만 먹여 초기 위치를 잠근다 — 이후 단계가 히스테리시스 검증 대상 */
function lockAt(loc, beaconId, untilMs = 2000) {
  for (let t = 0; t <= untilMs; t += 500) {
    loc.addScans([{ beaconId, rssi: -55, ts: t }]);
    loc.estimate(t);
  }
}

// ------------------------------------------------ 초기 잠금: 오답에 안 갇힌다
{
  // 첫 스캔에서 가까운 비콘 패킷이 유실돼 먼 비콘만 잡힌 상황.
  // 잠정값은 틀려도 되지만, 다음 스캔에서 즉시 정정되어야 한다(잠기지 않았으므로).
  const loc = new BeaconLocator(plan);
  loc.addScans([{ beaconId: 'BC-EXIT', rssi: -90, ts: 0 }]);
  expect('유일한 신호는 잠정 채택', loc.estimate(0)?.nodeId === 'EXIT');
  loc.addScans([
    { beaconId: 'BC-302', rssi: -55, ts: 500 },
    { beaconId: 'BC-EXIT', rssi: -90, ts: 500 },
  ]);
  expect('확정 전이면 즉시 정정', loc.estimate(500)?.nodeId === 'R302');
}

// ------------------------------------------------ 히스테리시스: 깜빡임 방지
{
  // 노드 경계: 두 비콘이 ±3dB 안에서 엎치락뒤치락 — 위치가 흔들리면 안 된다
  const loc = new BeaconLocator(plan);
  const rng = seededRng(42);
  lockAt(loc, 'BC-302');

  let flips = 0;
  let prev = 'R302';
  for (let t = 2500; t <= 22000; t += 500) {
    loc.addScans([
      { beaconId: 'BC-302', rssi: -60 + (rng() * 6 - 3), ts: t },
      { beaconId: 'BC-J1', rssi: -60 + (rng() * 6 - 3), ts: t },
    ]);
    const est = loc.estimate(t);
    if (est.nodeId !== prev) { flips++; prev = est.nodeId; }
  }
  expect('경계 노이즈(±3dB)에서 위치 전환 없음', flips === 0, `전환 ${flips}회`);
}

// ------------------------------------------------ 확실한 이동은 따라간다
{
  const loc = new BeaconLocator(plan);
  lockAt(loc, 'BC-302');

  // J1이 17dB 더 세게, 지속적으로 — 실제로 이동한 상황
  let at4s, at7s;
  for (let t = 2500; t <= 7000; t += 500) {
    loc.addScans([
      { beaconId: 'BC-302', rssi: -72, ts: t },
      { beaconId: 'BC-J1', rssi: -55, ts: t },
    ]);
    const est = loc.estimate(t);
    if (t === 4000) at4s = est.nodeId;
    if (t === 7000) at7s = est.nodeId;
  }
  expect('역전 직후에는 아직 전환 안 함(유지시간 미달)', at4s === 'R302', `1.5초 경과 → ${at4s}`);
  expect('확실한 신호 역전은 holdMs 뒤 전환', at7s === 'J1', `4.5초 경과 → ${at7s}`);

  // 전환 직후 0.5초짜리 스파이크 — 무시해야 한다
  loc.addScans([{ beaconId: 'BC-EXIT', rssi: -40, ts: 7500 }]);
  expect('짧은 스파이크는 무시', loc.estimate(7500)?.nodeId === 'J1');
}

// ------------------------------------------ 그래프 제약: 순간이동 억제
{
  const loc = new BeaconLocator(plan);
  lockAt(loc, 'BC-J1');

  // J1과 이어지지 않은 FAR가 갑자기 최강 — 다중경로 반사 같은 허상 가정.
  // 인접 전환(2초)보다 오래(4초) 버텨야만 인정된다.
  let at3s, at7s;
  for (let t = 2500; t <= 7000; t += 500) {
    loc.addScans([
      { beaconId: 'BC-J1', rssi: -70, ts: t },
      { beaconId: 'BC-FAR', rssi: -50, ts: t },
    ]);
    const est = loc.estimate(t);
    if (t === 5000) at3s = est.nodeId;   // 도전 2.5초 경과 — 인접이었다면 이미 전환됐을 시점
    if (t === 7000) at7s = est.nodeId;   // 도전 4.5초 경과
  }
  expect('비인접 노드로는 2초에 안 넘어감', at3s === 'J1', `2.5초 경과 → ${at3s}`);
  expect('비인접도 오래 지속되면 결국 수용', at7s === 'FAR', `4.5초 경과 → ${at7s}`);
}

// ------------------------------------------------ 신호 전멸 시 위치 유지
{
  const loc = new BeaconLocator(plan);
  lockAt(loc, 'BC-J1');
  const est = loc.estimate(12000); // 10초간 아무 신호 없음
  expect('신호 전멸 시 마지막 위치 유지(안내 유지)', est?.nodeId === 'J1');
}

// -------------------------------- 시뮬레이터 통합: 걸어가며 전체 파이프라인
{
  // 302호 앞에 5초 서 있다가(초기 잠금) 출구까지 40초간 걷는다.
  // 시뮬레이터 노이즈(±6dB)와 패킷 유실을 견디며 R302 → J1 → EXIT
  // 순서로만 전환해야 한다.
  const loc = new BeaconLocator(plan);
  const rng = seededRng(7);
  const walk = ['R302', 'J1', 'EXIT'];
  const visited = [];
  for (let t = 0; t <= 45000; t += 500) {
    const progress = Math.max(0, (t - 5000) / 40000);
    const pos = positionAlongRoute(plan, walk, progress);
    loc.addScans(simulateScan(plan, pos, t, { rng }));
    const est = loc.estimate(t);
    if (!loc.locked) continue; // 잠금 전 잠정값은 흔들려도 된다 — 확정 후가 계약이다
    if (est && visited[visited.length - 1] !== est.nodeId) visited.push(est.nodeId);
  }
  expect('보행 시뮬레이션: 경로 순서대로만 전환',
    visited.join('→') === 'R302→J1→EXIT', `실제: ${visited.join('→')}`);

  // 판정된 위치가 곧 경로탐색의 fromId가 된다 — 측위→경로 연결 확인
  const route = routeToNearestExit(plan, visited[visited.length - 1], {});
  expect('판정 위치로 경로 계산(출구 위 = 거리 0)', route?.distance === 0);
}

// ---------------------------------- 시뮬레이터 자체 성질
{
  const rng = seededRng(1);
  const scans = simulateScan(plan, { x: 0, y: 0 }, 0, { rng, dropRate: 0 });
  const at302 = scans.find(s => s.beaconId === 'BC-302');
  const atExit = scans.find(s => s.beaconId === 'BC-EXIT');
  expect('가까운 비콘이 더 세다', at302.rssi > atExit.rssi,
    `BC-302 ${at302.rssi} vs BC-EXIT ${atExit.rssi}`);
  const far = simulateScan(plan, { x: 100, y: 100 }, 0, { rng, dropRate: 0 });
  expect('수신 범위 밖 비콘은 안 잡힘', far.length === 0);
}

process.exit(failed ? 1 : 0);
