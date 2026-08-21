/**
 * 화재감지기 — **실제 설비가 하는 방식대로.**
 *
 * 여기서 지키는 것은 셋이다.
 *
 *   ① 넘자마자 화재로 확정하지 않는다 (축적).  오보 하나에 대피로가 끊기면
 *      아무도 이 시스템을 안 믿는다.
 *   ② 소식이 없으면 «정상» 이 아니라 «모름» 이다.  죽은 감지기를 정상으로
 *      세면 못 보고 있으면서 다 보고 있다고 착각한다.
 *   ③ 연기가 열보다 먼저 운다.  실제 화재가 그렇고, 그래야 대피 시간이 는다.
 */

import { strict as assert } from 'node:assert';
import {
  DETECTOR, Detector, FAULT_MS, SPEC, STATE, VERIFY_MS, panelSummary,
} from '../shared/detectors.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const make = (kind, id = 'D1') => new Detector({
  id, kind, nodeId: 'J_SS2', address: 'L1-001',
});

test('평상시는 정상', () => {
  const d = make(DETECTOR.SMOKE);
  d.push(SPEC.smoke.base, 1000);
  assert.equal(d.state, STATE.NORMAL);
});

test('문턱을 넘어도 곧바로 화재가 아니다 — 예비경보', () => {
  // 담배 연기 한 모금, 문 여닫는 바람, 수증기에 감지기는 흔히 한 번 튄다.
  const d = make(DETECTOR.SMOKE);
  d.push(30, 1000);
  assert.equal(d.state, STATE.PRE_ALARM);
});

test('지속되면 화재로 확정한다', () => {
  const d = make(DETECTOR.SMOKE);
  d.push(30, 1000);
  d.push(30, 1000 + VERIFY_MS - 1);
  assert.equal(d.state, STATE.PRE_ALARM, '축적 시간 전에 확정했다');
  d.push(30, 1000 + VERIFY_MS);
  assert.equal(d.state, STATE.ALARM);
});

test('잠깐 튄 것은 화재가 되기 전에 사라진다', () => {
  // 이게 축적 기능의 값어치 전부다.
  const d = make(DETECTOR.SMOKE);
  d.push(30, 1000);                       // 담배 연기
  d.push(30, 1000 + VERIFY_MS / 2);
  d.push(SPEC.smoke.base, 1000 + VERIFY_MS / 2 + 500);
  assert.equal(d.state, STATE.NORMAL);
  // 다시 넘으면 축적을 처음부터 센다 — 반쯤 찬 상태로 이어지면 안 된다
  d.push(30, 20_000);
  assert.equal(d.state, STATE.PRE_ALARM);
  d.push(30, 20_000 + VERIFY_MS - 1);
  assert.equal(d.state, STATE.PRE_ALARM);
});

test('값이 안 들어와도 시간이 가면 확정된다', () => {
  // 감지기가 30초에 한 번 보내도 축적은 시계로 흘러야 한다.
  const d = make(DETECTOR.SMOKE);
  d.push(30, 1000);
  d.tick(1000 + VERIFY_MS);
  assert.equal(d.state, STATE.ALARM);
});

test('소식이 끊기면 «정상» 이 아니라 «통신불량»', () => {
  const d = make(DETECTOR.HEAT);
  d.push(23, 1000);
  assert.equal(d.state, STATE.NORMAL);
  d.tick(1000 + FAULT_MS + 1);
  assert.equal(d.state, STATE.FAULT);
});

test('한 번도 안 받았으면 통신불량', () => {
  // 켜자마자 «정상 10대» 라고 말하면 안 된다 — 아직 아무것도 못 들었다.
  const d = make(DETECTOR.HEAT);
  d.tick(1000);
  assert.equal(d.state, STATE.FAULT);
});

test('연기가 열보다 먼저 운다', () => {
  // 실제 화재가 그렇다. 열이 먼저 우는 시스템은 대피 시간을 깎는다.
  const smoke = make(DETECTOR.SMOKE, 'S');
  const heat = make(DETECTOR.HEAT, 'H');
  // 불난 지 얼마 안 된 시점 — 연기는 이미 자욱하고 온도는 아직 낮다
  smoke.push(22, 1000);
  heat.push(34, 1000);
  assert.equal(smoke.state, STATE.PRE_ALARM);
  assert.equal(heat.state, STATE.NORMAL, '온도 34℃ 에 열감지기가 울었다');
});

test('정온식 공칭작동온도는 70℃', () => {
  // 국내 정온식 감지기의 공칭작동온도 범위(60~150℃) 안이라야 «실제 기준» 이다.
  assert.ok(SPEC.heat.alarm >= 60 && SPEC.heat.alarm <= 150);
  const d = make(DETECTOR.HEAT);
  d.push(69, 1000); d.push(69, 1000 + VERIFY_MS);
  assert.equal(d.state, STATE.PRE_ALARM, '69℃ 에 화재로 확정했다');
  d.push(71, 60_000); d.push(71, 60_000 + VERIFY_MS);
  assert.equal(d.state, STATE.ALARM);
});

test('차동식 — 빠르게 오르면 70℃ 전에도 작동한다', () => {
  // 화재 초기에 절대온도보다 먼저 나타나는 신호가 상승률이다.
  const d = make(DETECTOR.HEAT);
  d.push(24, 0);
  d.push(50, 60_000);                       // 1분에 26℃ — 기준 15℃/분을 넘는다
  assert.ok(d.risePerMin >= SPEC.heat.riseAlarmPerMin, `${d.risePerMin}℃/min`);
  d.push(52, 60_000 + VERIFY_MS);
  assert.equal(d.state, STATE.ALARM, '빠르게 오르는데 확정 안 됐다');
});

test('천천히 오르면 차동식으로는 안 운다', () => {
  // 난방이나 햇빛으로도 온도는 오른다. 그걸 화재로 세면 안 된다.
  const d = make(DETECTOR.HEAT);
  d.push(24, 0);
  d.push(30, 60 * 60_000);                  // 한 시간에 6℃
  assert.ok(d.risePerMin < SPEC.heat.riseAlarmPerMin);
  assert.equal(d.state, STATE.NORMAL);
});

test('연기감지기 작동 감광률은 15%/m', () => {
  // 광전식 스포트형 2종의 기준값.
  assert.equal(SPEC.smoke.alarm, 15);
  assert.equal(SPEC.smoke.unit, '%/m');
});

test('확정까지 남은 시간을 말할 수 있다', () => {
  const d = make(DETECTOR.SMOKE);
  d.push(30, 1000);
  assert.equal(d.verifyLeftMs(1000), VERIFY_MS);
  assert.equal(d.verifyLeftMs(1000 + VERIFY_MS / 2), VERIFY_MS / 2);
  d.push(30, 1000 + VERIFY_MS);
  assert.equal(d.verifyLeftMs(1000 + VERIFY_MS), 0, '확정된 뒤에도 남은 시간이 있다');
});

test('수신기 요약 — 화재가 하나라도 있으면 그것이 이긴다', () => {
  const alarm = { state: STATE.ALARM };
  const pre = { state: STATE.PRE_ALARM };
  const fault = { state: STATE.FAULT };
  const ok = { state: STATE.NORMAL };
  assert.equal(panelSummary([ok, ok, ok]).headline, '정상');
  assert.equal(panelSummary([ok, fault]).headline, '점검 필요');
  assert.equal(panelSummary([ok, fault, pre]).headline, '예비경보');
  assert.equal(panelSummary([ok, fault, pre, alarm]).headline, '화재');
});

test('수신기 요약이 숫자를 안 흘린다', () => {
  const list = [
    { state: STATE.ALARM }, { state: STATE.PRE_ALARM },
    { state: STATE.FAULT }, { state: STATE.NORMAL }, { state: STATE.NORMAL },
  ];
  const s = panelSummary(list);
  assert.equal(s.total, 5);
  assert.equal(s.alarm + s.pre + s.fault + s.normal, s.total);
});

test('모르는 종류는 열감지기로 본다', () => {
  const d = new Detector({ id: 'X', kind: '없는것', nodeId: 'A', address: 'L1-9' });
  assert.equal(d.kind, DETECTOR.HEAT);
});

test('쓰레기 값은 무시하고 직전 값을 지킨다', () => {
  // 회선 잡음으로 NaN 이 오는 일이 있다. 그때 값이 무너지면 판정이 통째로 죽는다.
  const d = make(DETECTOR.HEAT);
  d.push(30, 1000);
  d.push(NaN, 2000);
  assert.equal(d.value, 30);
  d.push(undefined, 3000);
  assert.equal(d.value, 30);
});

let pass = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`✅ ${name}`); pass++; }
  catch (err) { console.error(`❌ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
console.log(`\n화재감지기: ${pass}/${tests.length}`);
