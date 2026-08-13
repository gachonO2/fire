// 경로탐색 시나리오: 도면 기반 그래프 + 위험 회피 + 온도 센서 반영
import { routeToNearestExit } from '../shared/pathfinding.js';
import { FloorPlan, validatePlan, findUnreachableNodes } from '../shared/floor-plan.js';
import { DEMO_PLAN as DEFAULT_PLAN } from '../backend/test/fixtures/demo-plan.js';
import { hazardsFromSensors, mergeHazards, TEMP } from '../shared/hazard-rules.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

const plan = new FloorPlan(DEFAULT_PLAN);
const smoke = { E6: { type: 'smoke' } };

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

process.exit(failed ? 1 : 0);
