/**
 * 비상계단 하강 — **비상구는 도착이 아니다.**
 *
 * 여기서 지키는 성질은 하나로 요약된다: **밖으로 나가기 전에는 「대피 완료」
 * 라고 말하지 않는다.** 6층 계단참에서 완료라고 말하면 사용자는 거기 서
 * 있게 되고, 계단실은 연기가 굴뚝처럼 오르는 곳이다.
 */

import { strict as assert } from 'node:assert';
import {
  AI_HALL_EXIT_LEVELS, DESCENT_PHASE, GROUND_FLOOR, StairDescent, floorOf,
} from '../shared/stair-descent.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const stair = (floors = -1) => ({ kind: 'stair', floors });

test('도면 이름에서 층을 읽는다', () => {
  assert.equal(floorOf('AI공학관 6층 (COCONE)'), 6);
  assert.equal(floorOf('Ai 공학관 6충'), null);   // 오타는 못 읽는다 — 추측 안 한다
  assert.equal(floorOf('3 층'), 3);
});

test('층을 못 읽으면 null — 추측하지 않는다', () => {
  // 틀린 층수를 확신에 차서 말하면 2층에서 문을 찾는 사람이 생긴다.
  assert.equal(floorOf('코코네 스쿨'), null);
  assert.equal(floorOf(''), null);
  assert.equal(floorOf(null), null);
});

test('비상구에 닿아도 «도착» 이 아니다', () => {
  const d = new StairDescent(6);
  const r = d.reachExit('비상구 (CREATIVE WORKSPACE 옆)');
  assert.equal(r.phase, DESCENT_PHASE.AT_EXIT);
  assert.ok(!d.done, '비상구에서 끝났다고 했다');
  assert.match(r.say, /계단으로 내려가세요/);
  assert.match(r.say, /5개 층/);            // 6층 → 1층
  assert.match(r.say, /엘리베이터는 타지 마세요/);
});

test('한 층씩 내려가며 지금 몇 층인지 알린다', () => {
  // 벽의 층 번호를 눈으로 못 읽으므로, 이것이 «내가 어디쯤인가» 의 유일한 통로다.
  const d = new StairDescent(6);
  d.reachExit();
  const said = [];
  for (let i = 0; i < 4; i++) said.push(d.push(stair(-1)).say);
  assert.match(said[0], /^5층입니다\. 4개 층 남았습니다\.$/);
  assert.match(said[3], /^2층입니다\. 1개 층 남았습니다\.$/);
  assert.equal(d.phase, DESCENT_PHASE.DESCENDING);
  assert.ok(!d.done);
});

test('1층에 닿으면 «밖으로 나가세요» — 아직 완료가 아니다', () => {
  const d = new StairDescent(6);
  d.reachExit();
  let last;
  for (let i = 0; i < 5; i++) last = d.push(stair(-1));
  assert.equal(d.phase, DESCENT_PHASE.GROUND);
  assert.equal(d.floorsLeft, 0);
  assert.match(last.say, /1층입니다\. 건물 밖으로 나가세요/);
  assert.ok(!d.done, '1층에 닿았다고 대피 완료라고 했다');
});

test('밖으로 나가야 대피 완료다', () => {
  const d = new StairDescent(6);
  d.reachExit();
  for (let i = 0; i < 5; i++) d.push(stair(-1));
  const r = d.markOut();
  assert.equal(r.phase, DESCENT_PHASE.OUT);
  assert.ok(d.done);
  assert.match(r.say, /대피 완료/);
});

test('1층 아래로는 안 내려간다', () => {
  // 계단이 지하까지 이어져 있어도 대피 목적지는 지상이다.
  const d = new StairDescent(6);
  d.reachExit();
  for (let i = 0; i < 9; i++) d.push(stair(-1));
  assert.equal(d.floor, GROUND_FLOOR);
  assert.equal(d.floorsLeft, 0);
});

test('엘리베이터를 타면 내리라고 한다', () => {
  // 화재 시 엘리베이터는 정전으로 갇히고 승강로가 연기를 빨아올린다.
  // 눈이 안 보이면 계단인지 엘리베이터인지 헷갈릴 수 있다.
  const d = new StairDescent(6);
  d.reachExit();
  const r = d.push({ kind: 'elevator', floors: -1 });
  assert.ok(r.alarm, '엘리베이터인데 경보가 아니다');
  assert.match(r.say, /엘리베이터/);
  assert.match(r.say, /내려 계단으로/);
});

test('엘리베이터 경고는 한 번만 한다', () => {
  // 매 층 반복하면 정작 들어야 할 층 안내를 덮는다.
  const d = new StairDescent(6);
  d.reachExit();
  assert.ok(d.push({ kind: 'elevator', floors: -1 }).say);
  assert.equal(d.push({ kind: 'elevator', floors: -1 }).say, undefined);
});

test('엘리베이터로 내려간 층은 안 센다', () => {
  // 타면 안 되는 것으로 내려간 것을 진척으로 세면, 내리라고 해 놓고
  // «잘 가고 있다» 고 말하는 꼴이 된다.
  const d = new StairDescent(6);
  d.reachExit();
  d.push({ kind: 'elevator', floors: -2 });
  assert.equal(d.floor, 6);
});

test('기압계가 없으면 층수를 말하지 않는다', () => {
  // 걸음이나 시간으로 층을 추측하지 않는다 — 계단 한 층의 걸음 수는
  // 건물마다 다르고, 틀리면 2층에서 문을 찾게 된다.
  const d = new StairDescent(6, { hasBarometer: false });
  const r = d.reachExit();
  assert.ok(!/개 층/.test(r.say), `층수를 말했다: ${r.say}`);
  assert.match(r.say, /1층까지 내려가야 합니다/);
});

test('층을 모르는 도면에서도 안내는 한다', () => {
  const d = new StairDescent(null);
  const r = d.reachExit();
  assert.match(r.say, /계단으로 내려가세요/);
  assert.equal(d.floorsLeft, null);
  const step = d.push(stair(-1));
  assert.match(step.say, /한 층 내려왔습니다/);
  assert.ok(!d.done);
});

test('기계가 못 세면 사람이 알릴 수 있다', () => {
  // 못 세는 것과 못 끝내는 것은 다른 문제다.
  const d = new StairDescent(null, { hasBarometer: false });
  d.reachExit();
  const r = d.markGround();
  assert.equal(r.phase, DESCENT_PHASE.GROUND);
  assert.match(r.say, /건물 밖으로/);
  assert.ok(!d.done);
  d.markOut();
  assert.ok(d.done);
});

test('올라가는 것은 대피가 아니다', () => {
  // 옥상으로 올라가는 것은 이 안내의 목적지가 아니다(고립될 수 있다).
  const d = new StairDescent(6);
  d.reachExit();
  d.push(stair(-1));          // 5층
  d.push(stair(+1));          // 다시 6층
  assert.equal(d.floor, 6);
  assert.equal(d.floorsLeft, 5);
});

test('아무 변화가 없으면 아무 말도 안 한다', () => {
  // 계단참에 서 있는 동안 계속 말하면 정작 필요한 안내를 덮는다.
  const d = new StairDescent(6);
  d.reachExit();
  assert.equal(d.push(null).say, undefined);
  assert.equal(d.push({ kind: 'stair', floors: 0 }).say, undefined);
});

/* ── 경사지 건물 — 지상이 두 군데다 ─────────────────────────
 *
 * 이 건물은 옥상이 운동장과 이어지고 엘리베이터와 직결된다. 그러면 옥상은
 * «최후의 피난처» 가 아니라 또 하나의 지상 출입구다. 위층 사람에게는 위로
 * 한 층이 아래로 일곱 층보다 짧고, 연기가 굴뚝처럼 오르는 계단실을 덜
 * 지난다. */
const HILL = { exitLevels: AI_HALL_EXIT_LEVELS };   // [1, 8] — 1층과 옥상

test('경사지 건물 — 위층은 옥상으로 보낸다', () => {
  const d = new StairDescent(7, HILL);
  assert.equal(d.target, 8);
  assert.ok(d.goingUp);
  assert.equal(d.floorsLeft, 1, '7층에서 옥상까지 한 층이다');
  const r = d.reachExit();
  assert.match(r.say, /올라가세요/);
  assert.match(r.say, /1개 층/);
});

test('위로 보낼 때는 «왜» 를 말한다', () => {
  // 「불났는데 올라가라고?」 는 사람이 안 따르는 안내이고, 안 따르면 안내가 아니다.
  const r = new StairDescent(7, HILL).reachExit();
  assert.match(r.say, /옥상이 운동장과 이어져/);
});

test('경사지 건물 — 아래층은 그대로 1층으로', () => {
  const d = new StairDescent(3, HILL);
  assert.equal(d.target, 1);
  assert.ok(!d.goingUp);
  assert.equal(d.floorsLeft, 2);
  assert.match(d.reachExit().say, /내려가세요/);
});

test('한가운데 층은 가까운 쪽으로 — 여기서는 아래', () => {
  // 4층: 1층까지 3개 층, 옥상까지 4개 층. 아래가 가깝다.
  const d = new StairDescent(4, HILL);
  assert.equal(d.target, 1);
});

test('옥상으로 올라가면 층수가 줄어든다', () => {
  const d = new StairDescent(7, HILL);
  d.reachExit();
  const r = d.push({ kind: 'stair', floors: +1 });
  assert.equal(d.floor, 8);
  assert.equal(d.floorsLeft, 0);
  assert.equal(d.phase, DESCENT_PHASE.GROUND);
  assert.match(r.say, /옥상입니다/);
  assert.ok(!d.done, '옥상에 닿았다고 대피 완료라고 했다');
  d.markOut();
  assert.ok(d.done);
});

test('목표를 지나쳐 세지 않는다', () => {
  // 1층으로 내려가는 사람이 지하로 더 내려가도 «남은 층수 음수» 가 되면 안 된다.
  const d = new StairDescent(3, HILL);
  d.reachExit();
  for (let i = 0; i < 6; i++) d.push({ kind: 'stair', floors: -1 });
  assert.equal(d.floor, 1);
  assert.equal(d.floorsLeft, 0);
});

test('확인 안 된 건물은 옥상을 출구로 안 친다', () => {
  // **이게 기본값이어야 한다.** 옥상 연결은 건물마다 사람이 확인해야 하는
  // 값이고, 틀리면 사람을 막다른 옥상으로 올려보낸다.
  const d = new StairDescent(7);
  assert.equal(d.target, GROUND_FLOOR);
  assert.ok(!d.goingUp);
  assert.match(d.reachExit().say, /내려가세요/);
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✅ ${name}`); pass++; }
  catch (err) { console.error(`❌ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
console.log(`\n계단 하강: ${pass}/${tests.length}`);
