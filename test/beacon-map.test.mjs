// 비콘 지도: 걸으면서 비콘이 어디 있는지 알아내는 부분.
//
// 폰 위치(추정치)로 비콘을 놓는 구조라, 잘못 놓으면 그 뒤로 계속 틀린 곳을
// 가리키게 된다. 그래서 "언제 안 받아들이는가"를 정확도만큼 검사한다.
import { FloorPlan } from '../shared/floor-plan.js';
import { BeaconMapper } from '../shared/beacon-map.js';
import { simulateScan, seededRng } from '../shared/beacon-sim.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

// 일자 복도. 비콘은 R301·J1·EXIT 에 있다고 치고 신호를 만든다.
const plan = new FloorPlan({
  id: 'map-fixture', name: '지도 시험용', metersPerUnit: 1, stepLength: 1,
  nodes: [
    { id: 'R301', name: '301호', x: 0, y: 0, type: 'room', beaconId: 'B-301' },
    { id: 'J1', name: '교차점', x: 15, y: 0, type: 'junction', beaconId: 'B-J1' },
    { id: 'EXIT', name: '출구', x: 30, y: 0, type: 'exit', beaconId: 'B-EXIT' },
  ],
  edges: [{ id: 'E1', a: 'R301', b: 'J1' }, { id: 'E2', a: 'J1', b: 'EXIT' }],
});

/** 복도를 왕복하며 관측을 먹인다 */
function walk(mapper, { conf = 1, passes = 2, jitter = 0, seed = 4 } = {}) {
  const rng = seededRng(seed);
  let now = 1000;
  for (let p = 0; p < passes; p++) {
    for (let i = 0; i <= 60; i++) {
      const t = p % 2 === 0 ? i / 60 : 1 - i / 60;
      const truth = { x: t * 30, y: 0 };
      now += 500;
      const scans = simulateScan(plan, truth, now, { rng });
      // 폰이 말하는 위치에는 오차가 섞인다
      const told = { x: truth.x + (rng() - 0.5) * 2 * jitter, y: truth.y };
      mapper.observe(told, scans.map(s => ({ beaconId: s.beaconId, rssi: s.rssi })), conf);
    }
  }
}

// ─────────────────────────────────────────── 걸으면 비콘 자리가 나온다
{
  const m = new BeaconMapper(plan);
  walk(m);
  const est = m.estimates().filter(e => e.ready);
  expect('세 비콘을 모두 찾는다', est.length === 3, `→ ${est.length}개`);

  const by = Object.fromEntries(est.map(e => [e.beaconId, e]));
  expect('B-301 을 301호에 놓는다', by['B-301']?.nodeId === 'R301', `→ ${by['B-301']?.nodeId}`);
  expect('B-J1 을 교차점에 놓는다', by['B-J1']?.nodeId === 'J1', `→ ${by['B-J1']?.nodeId}`);
  expect('B-EXIT 을 출구에 놓는다', by['B-EXIT']?.nodeId === 'EXIT', `→ ${by['B-EXIT']?.nodeId}`);

  const err = Math.abs(by['B-J1'].x - 15);
  expect('좌표 오차가 작다', err < 4, `교차점 추정 x=${by['B-J1'].x.toFixed(1)} (실제 15)`);
}

// ─────────────────────────────────────────── 도면에 넣을 매핑이 바로 나온다
{
  const m = new BeaconMapper(plan);
  walk(m);
  const map = m.mapping();
  expect('매핑 세 줄', Object.keys(map).length === 3, `→ ${JSON.stringify(map)}`);
  expect('도면의 beaconMap 과 같은 모양', map['B-J1'] === 'J1');
}

// ─────────────────────────────────────────── 폰이 못 믿을 때는 안 받는다
//
// 쓰레기 위치로 비콘을 놓으면 그 뒤로 계속 틀린 곳을 가리킨다. 안 만드느니만 못하다.
{
  const m = new BeaconMapper(plan);
  walk(m, { conf: 0.2 });
  expect('확신도가 낮으면 표본을 안 쌓는다', m.estimates().length === 0,
    `→ ${m.estimates().length}개`);

  walk(m, { conf: 0.9 });
  expect('확신도가 돌아오면 다시 쌓는다', m.estimates().filter(e => e.ready).length === 3);
}

// ─────────────────────────────────────────── 표본이 적으면 답을 안 낸다
{
  const m = new BeaconMapper(plan);
  m.observe({ x: 0, y: 0 }, [{ beaconId: 'B-301', rssi: -50 }], 1);
  m.observe({ x: 1, y: 0 }, [{ beaconId: 'B-301', rssi: -52 }], 1);
  const e = m.estimates()[0];
  expect('두 표본으로는 답하지 않는다', e.ready === false, `표본 ${e.samples}개`);
  expect('그래도 몇 개 모였는지는 알려준다', e.samples === 2);
}

// ─────────────────────────────────────────── 폰 위치가 흔들리면 흩어짐이 커진다
{
  const clean = new BeaconMapper(plan); walk(clean, { jitter: 0 });
  const noisy = new BeaconMapper(plan); walk(noisy, { jitter: 8 });
  const cs = clean.estimates().find(e => e.beaconId === 'B-J1').spreadM;
  const ns = noisy.estimates().find(e => e.beaconId === 'B-J1').spreadM;
  expect('위치가 흔들린 만큼 흩어짐이 커진다', ns > cs,
    `${cs.toFixed(1)}m → ${ns.toFixed(1)}m`);

  const strict = noisy.mapping(2);
  expect('흩어짐이 크면 매핑에서 뺀다', Object.keys(strict).length < 3,
    `→ ${Object.keys(strict).length}개만 통과`);
}

// ─────────────────────────────────────────── 아주 약한 신호는 안 받는다
{
  const m = new BeaconMapper(plan);
  for (let i = 0; i < 20; i++) m.observe({ x: 0, y: 0 }, [{ beaconId: 'FAR', rssi: -99 }], 1);
  expect('건물 반대편에서 스친 값은 버린다', m.estimates().length === 0);
}

console.log(failed === 0 ? '\n비콘 지도 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
