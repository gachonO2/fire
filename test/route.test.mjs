// 경로탐색 시나리오: 도면 기반 그래프 + 위험 회피 + 온도 센서 반영
import { routeToNearestExit } from '../shared/pathfinding.js';
import { FloorPlan, validatePlan, findUnreachableNodes } from '../shared/floor-plan.js';
import { DEFAULT_PLAN } from '../shared/default-plan.js';
import { GACHON_3F_PLAN } from '../shared/gachon-plan.js';
import { TEST_PLANS } from '../shared/test-plans.js';
import { levelForError } from '../frontend/js/direction-scan.js';
import { EvacuationSession } from '../frontend/js/evacuation.js';
import {
  automaticEvacuationAction, alarmHazardKeys, hasNewFire, hasNewSetValue,
} from '../frontend/js/auto-evacuation.js';
import { hazardsFromSensors, hazardsFromFires, nodesInFire, mergeHazards, TEMP } from '../shared/hazard-rules.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`[${cond ? '통과' : '실패'}] ${name} ${detail}`);
  if (!cond) failed++;
}

const plan = new FloorPlan(DEFAULT_PLAN);
const smoke = { E6: { type: 'smoke' } };

// 위치를 확인하지 않은 사용자는 화재 경보만 받고 자동 경로 안내나 SOS로 전환하지 않는다.
expect('화재 감지 전에는 자동 대피 전환 없음', automaticEvacuationAction({
  armed: true, alarmHandled: false, phase: 'idle', fireActive: false, hasVerifiedPlace: false,
}) === 'ignore');
expect('현재 위치 미확인 시 경보만 제공', automaticEvacuationAction({
  armed: true, alarmHandled: false, phase: 'idle', fireActive: true, hasVerifiedPlace: false,
}) === 'alert-only');
expect('현재 위치 확인 후에만 자동 대피 시작', automaticEvacuationAction({
  armed: true, alarmHandled: false, phase: 'idle', fireActive: true, hasVerifiedPlace: true,
}) === 'start');
expect('이미 처리한 화재는 화면을 다시 전환하지 않음', automaticEvacuationAction({
  armed: true, alarmHandled: true, phase: 'idle', fireActive: true, hasVerifiedPlace: false,
}) === 'ignore');
const existingFireIds = new Set(['F27']);
expect('접속할 때 이미 있던 화재는 새 화재가 아님',
  !hasNewFire(existingFireIds, [{ id: 'F27' }]));
expect('접속 후 추가된 화재만 새 사건으로 판정',
  hasNewFire(existingFireIds, [{ id: 'F27' }, { id: 'F28' }]));
const baselineAlarmKeys = alarmHazardKeys({ E6: { type: 'smoke' } }, DEFAULT_PLAN.initialHazards);
expect('도면의 초기 연기는 새 화재 경보에서 제외', baselineAlarmKeys.size === 0);
const liveAlarmKeys = alarmHazardKeys({
  E6: { type: 'smoke' }, E2: { type: 'smoke', sensorId: 'SD-301' },
}, DEFAULT_PLAN.initialHazards);
expect('새 센서 경보는 사건으로 판정', hasNewSetValue(baselineAlarmKeys, liveAlarmKeys));

// ----------------------------------------------------------------- 경로탐색
const r1 = routeToNearestExit(plan, 'N1', smoke);
expect('초기 경로는 남쪽 비상구', r1?.exit.id === 'N10', `→ ${r1?.nodes.join(' → ')}`);

const r2 = routeToNearestExit(plan, 'N1', { ...smoke, E11: { type: 'fire' } });
expect('E11 차단 시 계단 B로 우회', r2?.exit.id === 'N8', `→ ${r2?.nodes.join(' → ')}`);

const r3 = routeToNearestExit(plan, 'N1', { ...smoke, E11: { type: 'fire' }, E9: { type: 'blocked' } });
expect('모든 접근가능 출구 차단 시 null', r3 === null);

const r4 = routeToNearestExit(plan, 'N1', { ...smoke, E11: { type: 'crowd' } });
expect('E11 혼잡 시 계단 B 선택(패널티 회피)', r4?.exit.id === 'N8', `→ ${r4?.exit.name}`);

const r5 = routeToNearestExit(plan, 'EV', {});
expect('엘리베이터 노드에서는 경로 없음(화재 모드 제외)', r5 === null);

expect('알 수 없는 시작 노드는 null', routeToNearestExit(plan, 'ZZZ', {}) === null);

// ------------------------------------------------------ 테스트 전용 도면 5개
expect('테스트 도면 5개 준비됨', TEST_PLANS.length === 5, `${TEST_PLANS.length}개`);
for (const testPlan of TEST_PLANS) {
  const floor = new FloorPlan(testPlan);
  const testPlaces = floor.nodes.filter(node => node.type !== 'exit' && node.type !== 'elevator');
  expect(`${testPlan.name}: 도면 검증 통과`, validatePlan(testPlan).length === 0,
    validatePlan(testPlan).join(' / '));
  expect(`${testPlan.name}: 테스트 위치 5곳`, testPlaces.length === 5, `${testPlaces.length}곳`);
  expect(`${testPlan.name}: 위치 설명·촉각 단서 저장`,
    testPlaces.every(node => node.description?.trim() && node.landmark?.trim()));
  expect(`${testPlan.name}: 모든 위치에서 출구 도달`, findUnreachableNodes(floor).length === 0);
}

// 테스트 화면에서 사람을 임의 좌표로 옮기면 좌표는 그대로 표시하고,
// 경로는 가장 가까운 저장 위치에서 다시 계산한다.
const relocationFloor = new FloorPlan(TEST_PLANS[0]);
const relocationApi = {
  floorPlan: relocationFloor,
  async computeRoute(from) {
    const found = routeToNearestExit(relocationFloor, from, {});
    return {
      route: found && { ...found, edges: found.edges.map(edge => edge.id) },
      ms: 0, offline: false, reason: null,
    };
  },
  updatePosition() {},
  sendSOS() {},
};
const relocationGuidance = {
  onAnnounce: null,
  speak(text) { this.onAnnounce?.(text); },
  cmdDanger() {}, cmdSOS() {}, cmdStraight() {}, cmdTurn() {}, cmdArrive() {},
  cmdStop(text) { this.onAnnounce?.(`멈추세요. ${text}`); },
  cmdWrongWay(text) { this.onAnnounce?.(`멈추세요. ${text}`); },
};
const relocation = new EvacuationSession({
  api: relocationApi, guidance: relocationGuidance, userId: 'test-person',
});
await relocation.relocateTo('OP2', { x: 17.25, y: 21.5 });
expect('테스트 인물은 지도 임의 좌표로 이동',
  relocation.position().x === 17.25 && relocation.position().y === 21.5);
relocation.phase = 'guiding';
await relocation.relocateTo('OP5', { x: 31.2, y: 13.4 });
expect('대피 중 인물 이동 시 새 위치에서 경로 재계산',
  relocation.route?.nodes[0] === 'OP5' && relocation.phase === 'guiding');

await relocation.relocateTo('OP5', { x: 30, y: 12 });
const freeMoveOffRoute = relocation.moveFreelyTo(29.3, 12);
expect('자유 이동은 설정 경로 밖으로도 한 걸음 이동',
  freeMoveOffRoute.status === 'off-route' && relocation.position().x === 29.3);
expect('경로 이탈 시 직진 대신 복귀 안내',
  relocation.recovery?.distanceMeters > 0 && relocation.lastCommand.includes('경로에서 벗어났습니다'));
const recoveryTarget = { x: relocation.recovery.x, y: relocation.recovery.y };
const freeMoveRecovered = relocation.moveFreelyTo(recoveryTarget.x, recoveryTarget.y);
expect('복귀 지점으로 이동하면 경로 안내 복원',
  freeMoveRecovered.status === 'on-route' && relocation.recovery === null);
relocation.moveFreelyTo(31.4, 10.2);
const freeMoveBackward = relocation.moveFreelyTo(30.97, 10.75);
expect('경로 위라도 반대 방향으로 걸으면 직진 안내 중단',
  freeMoveBackward.status === 'wrong-direction' && relocation.lastCommand.includes('진행 방향이 잘못되었습니다'));

const t0 = performance.now();
for (let i = 0; i < 100; i++) routeToNearestExit(plan, 'N1', smoke);
const avg = (performance.now() - t0) / 100;
expect('재탐색 평균 2초 이내', avg < 2000, `평균 ${avg.toFixed(3)} ms`);

// -------------------------------------------------------------- 도면 기하
expect('E1(진료실→복도) 걸음 수 산출',
  plan.edgeSteps(plan.getEdge('E1')) === 9, `${plan.edgeSteps(plan.getEdge('E1'))}걸음`);
expect('N1→N2 방위는 북(0도)', plan.bearing('N1', 'N2') === 0);
expect('N2→N3 방위는 동(90도)', plan.bearing('N2', 'N3') === 90);

// 축척이 바뀌면 거리·걸음 수도 따라 바뀐다 (도면 픽셀 좌표 대응)
const halfScale = new FloorPlan({ ...DEFAULT_PLAN, metersPerUnit: 0.5 });
expect('metersPerUnit 0.5면 걸음 수 절반',
  halfScale.edgeSteps(halfScale.getEdge('E1')) === 4,
  `${halfScale.edgeSteps(halfScale.getEdge('E1'))}걸음`);

// -------------------------------------------------------------- 도면 검증
expect('기본 도면은 검증 통과', validatePlan(DEFAULT_PLAN).length === 0);
expect('출구 없는 도면은 거부', validatePlan({
  name: 'x', nodes: [{ id: 'A', x: 0, y: 0, type: 'room' }], edges: [],
}).some(e => e.includes('출구')));
expect('없는 노드를 잇는 통로는 거부', validatePlan({
  name: 'x',
  nodes: [{ id: 'A', x: 0, y: 0, type: 'exit' }],
  edges: [{ id: 'E1', a: 'A', b: 'ZZZ' }],
}).some(e => e.includes('존재하지 않는')));
expect('노드 id 중복은 거부', validatePlan({
  name: 'x',
  nodes: [{ id: 'A', x: 0, y: 0, type: 'exit' }, { id: 'A', x: 1, y: 1, type: 'room' }],
  edges: [],
}).some(e => e.includes('중복')));

const island = new FloorPlan({
  ...DEFAULT_PLAN,
  nodes: [...DEFAULT_PLAN.nodes, { id: 'ISO', name: '고립된 방', x: 50, y: 50, type: 'room' }],
});
expect('출구에 닿지 않는 지점 탐지', findUnreachableNodes(island).join() === 'ISO');

// -------------------------------------------------------------- 장소 저장
expect('저장된 장소 설명을 음성 문장으로 조립',
  plan.describePlace('N2') === '여기는 중앙 복도 교차점입니다. 복도가 좌우로 갈라지는 곳입니다. 바닥의 점자블록이 십자 모양으로 바뀝니다.',
  plan.describePlace('N2'));

expect('설명이 없어도 이름은 읽어준다',
  new FloorPlan({ ...DEFAULT_PLAN, nodes: [{ id: 'X', name: '창고 앞', x: 0, y: 0, type: 'room' }, ...DEFAULT_PLAN.nodes] })
    .describePlace('X') === '여기는 창고 앞입니다.');

expect('없는 장소는 null', plan.describePlace('ZZZ') === null);

expect('설명이 저장된 장소만 골라낸다',
  plan.describedPlaces().length === DEFAULT_PLAN.nodes.length,
  `${plan.describedPlaces().length}곳`);

expect('설명이 너무 길면 도면 저장 거부', validatePlan({
  ...DEFAULT_PLAN,
  nodes: [{ ...DEFAULT_PLAN.nodes[0], description: '가'.repeat(201) }, ...DEFAULT_PLAN.nodes.slice(1)],
}).some(e => e.includes('너무 깁니다')));

expect('설명이 문자열이 아니면 거부', validatePlan({
  ...DEFAULT_PLAN,
  nodes: [{ ...DEFAULT_PLAN.nodes[0], landmark: 123 }, ...DEFAULT_PLAN.nodes.slice(1)],
}).some(e => e.includes('문자열')));

// ---------------------------------------------------------- 온도 센서 반영
const now = Date.now();
const hot = hazardsFromSensors(
  [{ sensorId: 'T1', edgeId: 'E11', celsius: 75, ts: now }], plan, now);
expect(`${TEMP.BLOCK}°C 이상은 통행 불가(heat)`, hot.E11?.type === 'heat', hot.E11?.label);

const warm = hazardsFromSensors(
  [{ sensorId: 'T2', edgeId: 'E11', celsius: 50, ts: now }], plan, now);
expect(`${TEMP.WARN}°C 이상은 우회 권고(warm)`, warm.E11?.type === 'warm', warm.E11?.label);

const cool = hazardsFromSensors(
  [{ sensorId: 'T3', edgeId: 'E11', celsius: 22, ts: now }], plan, now);
expect('상온은 위험 아님', Object.keys(cool).length === 0);

const stale = hazardsFromSensors(
  [{ sensorId: 'T4', edgeId: 'E11', celsius: 90, ts: now - TEMP.STALE_MS - 1000 }], plan, now);
expect('오래된 판독값은 무시', Object.keys(stale).length === 0);

// 지점 센서 과열 → 그 지점에 연결된 모든 통로 차단
const nodeHot = hazardsFromSensors(
  [{ sensorId: 'T5', nodeId: 'N9', celsius: 80, ts: now }], plan, now);
expect('지점 과열 시 연결된 통로 전부 차단',
  ['E7', 'E8', 'E11'].every(id => nodeHot[id]?.type === 'heat'),
  Object.keys(nodeHot).join(', '));

// 실제 경로에 반영되는지
const tempRoute = routeToNearestExit(plan, 'N1', mergeHazards(smoke, hot));
expect('E11 과열 시 계단 B로 우회', tempRoute?.exit.id === 'N8', `→ ${tempRoute?.nodes.join(' → ')}`);

// N9(서쪽 복도)가 막혀도 동쪽 복도를 크게 돌아 계단 B로 갈 수 있어야 한다
const blockedByNode = routeToNearestExit(plan, 'N1', mergeHazards(smoke, nodeHot));
expect('N9 과열 시 동쪽 복도로 크게 우회',
  blockedByNode?.exit.id === 'N8' && blockedByNode.nodes.includes('N4'),
  `→ ${blockedByNode?.nodes.join(' → ')}`);

// 그 우회로마저 막히면 갈 곳이 없다
const allBlocked = routeToNearestExit(plan, 'N1',
  mergeHazards(smoke, nodeHot, { E10: { type: 'fire' } }));
expect('우회로까지 막히면 경로 없음 → 안전상태', allBlocked === null);

// 더 심각한 위험이 이긴다
const merged = mergeHazards({ E11: { type: 'crowd' } }, { E11: { type: 'heat' } });
expect('위험 병합은 심각한 쪽 채택', merged.E11.type === 'heat');
const merged2 = mergeHazards({ E11: { type: 'fire' } }, { E11: { type: 'warm' } });
expect('센서 정상이어도 관제 화재가 우선', merged2.E11.type === 'fire');

// ------------------------------------------------------ 주입한 도면으로 안내
// 건물이 바뀌어도 같은 로직이 동작하는지 (도면 주입의 핵심)
const otherBuilding = new FloorPlan({
  id: 'school-2f',
  name: '학교 2층',
  metersPerUnit: 0.05, // 도면 픽셀 좌표
  stepLength: 0.7,
  image: { width: 1200, height: 800 },
  nodes: [
    { id: 'A', name: '2학년 1반', x: 100, y: 400, type: 'room' },
    { id: 'B', name: '복도 중앙', x: 600, y: 400, type: 'junction' },
    { id: 'C', name: '동쪽 계단', x: 1100, y: 400, type: 'exit' },
    { id: 'D', name: '서쪽 계단', x: 100, y: 100, type: 'exit' },
  ],
  edges: [
    { id: 'X1', a: 'A', b: 'B', wall: 'right' },
    { id: 'X2', a: 'B', b: 'C', wall: 'right' },
    { id: 'X3', a: 'A', b: 'D', wall: 'left' },
  ],
});
expect('주입한 도면 검증 통과', validatePlan(otherBuilding.toJSON()).length === 0);
const school = routeToNearestExit(otherBuilding, 'A', {});
expect('주입한 도면으로 경로 계산', school?.exit.id === 'D', `→ ${school?.exit.name}`);
expect('주입한 도면의 축척 반영',
  Math.round(otherBuilding.edgeLength(otherBuilding.getEdge('X1'))) === 25,
  `X1 = ${otherBuilding.edgeLength(otherBuilding.getEdge('X1')).toFixed(1)}m`);

const schoolHot = hazardsFromSensors(
  [{ sensorId: 'S1', edgeId: 'X3', celsius: 88, ts: now }], otherBuilding, now);
const schoolReroute = routeToNearestExit(otherBuilding, 'A', schoolHot);
expect('주입한 도면에서도 온도 회피 동작',
  schoolReroute?.exit.id === 'C', `→ ${schoolReroute?.exit.name}`);

// ------------------------------------------- 3D 도면 기반 샘플 (가천관 3층)
const gachon = new FloorPlan(GACHON_3F_PLAN);

expect('가천관 도면 검증 통과', validatePlan(GACHON_3F_PLAN).length === 0,
  validatePlan(GACHON_3F_PLAN).join(' / '));
expect('저장된 장소 5곳', gachon.nodes.length === 5);
expect('5곳 모두 설명이 저장됨', gachon.describedPlaces().length === 5);
expect('출구까지 끊긴 장소 없음', findUnreachableNodes(gachon).length === 0);

expect('도면 축척 반영 — GL1은 약 11m',
  Math.abs(gachon.edgeLength(gachon.getEdge('GL1')) - 10.8) < 0.1,
  `${gachon.edgeLength(gachon.getEdge('GL1')).toFixed(1)}m / ${gachon.edgeSteps(gachon.getEdge('GL1'))}걸음`);

const gRoute = routeToNearestExit(gachon, 'G1', {});
expect('312호에서 서편 계단이 최단', gRoute?.exit.id === 'G5',
  `→ ${gRoute?.nodes.map(id => gachon.getNode(id).name).join(' → ')}`);

const gHot = hazardsFromSensors(
  [{ sensorId: 'T-GL4', edgeId: 'GL4', celsius: 77, ts: now }], gachon, now);
const gReroute = routeToNearestExit(gachon, 'G1', gHot);
expect('서편 통로 과열 시 동편으로 우회', gReroute?.exit.id === 'G4',
  `→ ${gReroute?.exit.name}`);

expect('장소 설명이 음성 문장으로 조립됨',
  gachon.describePlace('G3').startsWith('여기는 북측 복도 교차점입니다.'),
  gachon.describePlace('G3'));

// ----------------------------------- 임의 지점 화재 → 회피 경로 (핵심 시나리오)
// 서편 통로(GL4) 한가운데에 불이 난다. 통로 목록에서 고른 게 아니라 도면 좌표를 찍은 것이다.
const fireNearWest = [{ id: 'F1', x: 450, y: 280, radius: 3 }];

const fireHazards = hazardsFromFires(fireNearWest, gachon);
expect('임의 지점 화재가 그 자리 통로만 막음',
  fireHazards.GL4?.type === 'fire' && !fireHazards.GL3 && !fireHazards.GL1,
  `막힌 통로: ${Object.keys(fireHazards).join(', ')}`);

const beforeFire = routeToNearestExit(gachon, 'G1', {});
const afterFire = routeToNearestExit(gachon, 'G1', fireHazards);
expect('화재 전에는 서편이 최단', beforeFire?.exit.id === 'G5');
expect('화재 후에는 동편으로 회피', afterFire?.exit.id === 'G4',
  `→ ${afterFire?.nodes.map(id => gachon.getNode(id).name).join(' → ')}`);

// 불에서 멀리 떨어진 곳은 영향 없다
const farFire = hazardsFromFires([{ id: 'F2', x: 100, y: 850, radius: 5 }], gachon);
expect('멀리 떨어진 화재는 통로에 영향 없음', Object.keys(farFire).length === 0);

// 반경을 키우면 더 많은 통로가 막힌다 (화재 확산)
const small = hazardsFromFires([{ id: 'F3', x: 700, y: 280, radius: 3 }], gachon);
const big = hazardsFromFires([{ id: 'F3', x: 700, y: 280, radius: 18 }], gachon);
expect('반경을 키우면 차단 통로가 늘어남',
  Object.keys(big).length > Object.keys(small).length,
  `${Object.keys(small).length}개 → ${Object.keys(big).length}개`);

// 교차점을 통째로 삼키면 갈 곳이 없다 → 안전상태
const engulf = hazardsFromFires([{ id: 'F4', x: 700, y: 280, radius: 20 }], gachon);
expect('교차점이 화염에 갇히면 경로 없음',
  routeToNearestExit(gachon, 'G1', engulf) === null);

// 화재 반경 안에 들어간 장소 탐지
expect('화재 반경 안의 장소를 찾아냄',
  nodesInFire([{ id: 'F5', x: 700, y: 280, radius: 5 }], gachon).join() === 'G3');

// 복도 한가운데 화재는 양 끝점만 재면 놓친다 — 선분 거리로 재는지 확인
const midCorridor = hazardsFromFires([{ id: 'F6', x: 950, y: 280, radius: 4 }], gachon);
expect('복도 한가운데 화재도 그 통로를 막음', midCorridor.GL3?.type === 'fire',
  `GL3(북측→동편) 차단 여부: ${midCorridor.GL3?.type ?? '없음'}`);



// ------------------------------------------- 방향 스캔 (금속탐지기식 신호)
// 각도 → 진동 등급 매핑. "진동이 끊기지 않는 쪽"이 실제로 맞는 방향이어야 한다.
expect('정확한 방향(0도)은 연속 진동',
  levelForError(0).id === 'lock' && levelForError(0).continuous === true);
expect('8도까지는 연속 진동 유지', levelForError(8).id === 'lock');
expect('9도부터는 끊김이 생김',
  levelForError(9).id === 'near' && !levelForError(9).continuous);
expect('30도는 뚝뚝 끊김', levelForError(30).id === 'far');
expect('60도는 드문 신호', levelForError(60).id === 'edge');
expect('90도는 무신호', levelForError(90).pattern === null);
expect('좌우 대칭 (부호 무관)',
  levelForError(-30).id === levelForError(30).id);
expect('정반대(180도)도 무신호', levelForError(180).pattern === null);

// 벗어날수록 진동은 짧아지고 쉬는 시간은 길어져야 한다
const gaps = [0, 15, 30, 60].map(d => {
  const l = levelForError(d);
  return l.pattern ? (l.pattern[1] ?? 0) : Infinity;
});
expect('벗어날수록 진동 간격이 길어짐',
  gaps[0] < gaps[1] && gaps[1] < gaps[2] && gaps[2] < gaps[3],
  gaps.join(' → '));

const ons = [0, 15, 30, 60].map(d => levelForError(d).pattern?.[0] ?? 0);
expect('벗어날수록 진동 길이가 짧아짐',
  ons[0] > ons[1] && ons[1] > ons[2] && ons[2] > ons[3], ons.join(' → '));

// 실제 경로에 대입 — 가천관 3층 312호에서 첫 구간 방위
const firstBearing = gachon.bearing('G1', 'G2');
expect('첫 구간을 정면으로 향하면 잠김',
  levelForError(firstBearing - firstBearing).id === 'lock', `목표 ${firstBearing}도`);
expect('90도 틀어 서면 신호 없음',
  levelForError(firstBearing - (firstBearing + 90)).pattern === null);



// ------------------------------------------- 화재 위치를 사람 말로 설명하기
// 자동 대피 안내가 "어디에 불이 났는지" 말하려면 좌표를 장소 이름으로 바꿔야 한다
const nearFire = gachon.nearestPlace(700, 300);
expect('화재 좌표 → 가장 가까운 장소',
  nearFire.node.id === 'G3', `${nearFire.node.name} (${nearFire.meters.toFixed(1)}m)`);

const nearWest = gachon.nearestPlace(330, 290);
expect('다른 좌표는 다른 장소로', nearWest.node.id === 'G5', nearWest.node.name);

expect('가장 가까운 장소까지 거리도 함께',
  Math.abs(nearFire.meters - 0.6) < 0.1, `${nearFire.meters.toFixed(2)}m`);

// 사용자와 화재 사이 거리 — "약 몇 미터 앞" 안내의 근거
const away = gachon.straightDistance('G1', 'G3');
expect('사용자~화재 지점 직선거리',
  Math.round(away) === 15, `${away.toFixed(1)}m`);
expect('없는 장소는 null', gachon.straightDistance('G1', 'ZZZ') === null);

process.exit(failed ? 1 : 0);
