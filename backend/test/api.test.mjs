/**
 * 백엔드 API 통합 테스트 (인메모리 저장소 기준).
 * 실행: node backend/test/api.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// 운영 데이터를 건드리지 않도록 임시 폴더에 저장한다 (import 보다 먼저 설정)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-test-'));
process.env.FIRE_DATA_DIR = TMP;

const { createApp } = await import('../src/app.js');
const { DEMO_PLAN } = await import('./fixtures/demo-plan.js');

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`[${cond ? '통과' : '실패'}] ${name} ${detail}`);
  if (!cond) failed++;
}

const server = createApp().listen(0);
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;

const api = async (pathname, opts = {}) => {
  const res = await fetch(BASE + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return { status: res.status, body: await res.json() };
};

// 서버는 이제 **빈 상태로 시작한다** — 예제 도면을 심지 않는다.
// 실제 건물을 등록해도 재시작하면 시연용 병원으로 되돌아갔기 때문이다.
// 그래서 테스트가 쓸 도면은 테스트가 직접 넣는다.
await api('/api/plans', { method: 'POST', body: JSON.stringify(DEMO_PLAN) });
await api(`/api/plans/${DEMO_PLAN.id}/activate`, { method: 'PUT' });

// 1) health — 저장소 모드 보고
const health = await api('/api/health');
expect('GET /api/health', health.status === 200 && health.body.ok, `storage=${health.body.storage}`);

// 2) 지도 그래프
const map = await api('/api/map');
expect('GET /api/map', map.body.nodes.length === 11 && map.body.edges.length === 11);

// 3) 초기 위험 상태 = 계단 A 연기
const hz = await api('/api/hazards');
expect('초기 시나리오는 E6 연기', hz.body.E6?.type === 'smoke');

// 4) 초기 경로 → 남쪽 비상구
const r1 = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'N1' }) });
expect('POST /api/route → 남쪽 비상구', r1.body.route?.exit.id === 'N10',
  `${r1.body.route?.nodes.join(' → ')} (${r1.body.ms}ms)`);

// 5) 알 수 없는 노드는 400
const bad = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'ZZZ' }) });
expect('알 수 없는 노드는 400', bad.status === 400);

// 6) 관제가 남쪽 램프 차단 → 계단 B로 우회
await api('/api/hazards/E11', { method: 'PUT', body: JSON.stringify({ type: 'fire' }) });
const r2 = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'N1', kind: 'reroute' }) });
expect('E11 차단 시 계단 B로 재탐색', r2.body.route?.exit.id === 'N8',
  `${r2.body.route?.nodes.join(' → ')}`);

// 7) 재탐색 2초 이내 (가설 ③)
expect('재탐색 2초 이내', r2.body.ms < 2000, `${r2.body.ms} ms`);

// 8) 계단 B까지 차단 → 경로 없음 (안전상태 전환 신호)
await api('/api/hazards/E9', { method: 'PUT', body: JSON.stringify({ type: 'blocked' }) });
const r3 = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'N1', kind: 'reroute' }) });
expect('모든 출구 차단 시 route=null + 사유', r3.body.route === null && Boolean(r3.body.reason));

// 9) 잘못된 위험 유형은 400
const badType = await api('/api/hazards/E1', { method: 'PUT', body: JSON.stringify({ type: 'ㅁㅁ' }) });
expect('잘못된 위험 유형은 400', badType.status === 400);

// 10) 존재하지 않는 통로는 404
const badEdge = await api('/api/hazards/E99', { method: 'PUT', body: JSON.stringify({ type: 'fire' }) });
expect('알 수 없는 통로는 404', badEdge.status === 404);

// 11) 화재수신기 웹훅으로도 위험 설정 가능 (건물 연동 경로)
await api('/api/sensors/fire-panel', {
  method: 'POST',
  body: JSON.stringify({ sensorId: 'SD-301', edgeId: 'E2', type: 'smoke', active: true }),
});
const hz2 = await api('/api/hazards');
expect('화재수신기 웹훅 → hazards 반영', hz2.body.E2?.sensorId === 'SD-301');

// 12) 구조요청 기록
const sos = await api('/api/sos', {
  method: 'POST',
  body: JSON.stringify({ userId: 'u1', nodeId: 'N2', nodeName: '중앙 복도', reason: '테스트', confidence: 0.3 }),
});
const sosList = await api('/api/sos');
expect('POST/GET /api/sos', sos.status === 201 && sosList.body[0].userId === 'u1');

// 13) userId 없는 구조요청은 400
const badSos = await api('/api/sos', { method: 'POST', body: JSON.stringify({}) });
expect('userId 없는 구조요청은 400', badSos.status === 400);

// 14) 위치 보고 (아래 보호자 알림 테스트를 위해 대기 상태로 둔다)
await api('/api/positions/u1', { method: 'PUT', body: JSON.stringify({ nodeId: 'N2', phase: 'idle' }) });
const pos = await api('/api/positions');
expect('PUT/GET /api/positions', pos.body.some(p => p.userId === 'u1'));

// 15) 경로 요청마다 KPI가 자동 기록됨
const metrics = await api('/api/metrics');
// 성공한 경로 요청 3건(r1, r2, r3)이 기록되고, 400으로 거부된 요청은 기록되지 않는다
expect('경로 요청이 metrics에 기록됨', metrics.body.length === 3, `${metrics.body.length}건`);
expect('경로 없음도 found=false로 기록됨', metrics.body.some(m => m.found === false));

// 16) SSE 스트림이 현재 상태를 즉시 내려줌
const sse = await fetch(`${BASE}/api/stream`);
const reader = sse.body.getReader();
const chunk = new TextDecoder().decode((await reader.read()).value);
expect('GET /api/stream 초기 동기화', chunk.includes('event: hazards'), chunk.split('\n')[0]);
await reader.cancel();

// ---------------------------------------------------------------- 보호자 연동
// 17) 보호자 등록 → 공유 코드 발급
const g = await api('/api/guardians', {
  method: 'POST',
  body: JSON.stringify({ userId: 'u1', name: '김보호', contact: '010-1234-5678' }),
});
expect('보호자 등록 → 6자리 코드 발급', g.status === 201 && /^[A-Z0-9]{6}$/.test(g.body.code), g.body.code);
const CODE = g.body.code;

// 18) 이름 없는 등록은 400
const badG = await api('/api/guardians', { method: 'POST', body: JSON.stringify({ userId: 'u9' }) });
expect('보호자 이름 없으면 400', badG.status === 400);

// 19) 재등록해도 코드는 유지 (보호자에게 보낸 링크가 깨지면 안 된다)
const g2 = await api('/api/guardians', {
  method: 'POST',
  body: JSON.stringify({ userId: 'u1', name: '김보호', contact: '010-9999-0000' }),
});
expect('재등록 시 코드 유지·연락처 갱신',
  g2.body.code === CODE && g2.body.contact === '010-9999-0000');

// 20) 잘못된 코드는 404
const badCode = await api('/api/guardian/ZZZZZZ');
expect('잘못된 보호자 코드는 404', badCode.status === 404);

// 21) 대피 시작(phase 전이) → 보호자 알림 자동 생성
await api('/api/positions/u1', {
  method: 'PUT',
  body: JSON.stringify({ nodeId: 'N1', nodeName: '301호 진료실 앞', phase: 'guiding', exitName: '남쪽 비상구 램프' }),
});
const view = await api(`/api/guardian/${CODE}`);
expect('대피 시작 시 보호자 알림 생성',
  view.body.alerts.length === 1 && view.body.alerts[0].phase === 'guiding',
  view.body.alerts[0]?.message);
expect('보호자 화면이 대상자 위치를 받음', view.body.position?.nodeName === '301호 진료실 앞');

// 22) 같은 phase를 반복 보고해도 알림이 중복 생성되지 않음
await api('/api/positions/u1', {
  method: 'PUT',
  body: JSON.stringify({ nodeId: 'N2', nodeName: '중앙 복도 교차점', phase: 'guiding' }),
});
const view2 = await api(`/api/guardian/${CODE}`);
expect('같은 상태 반복 보고 시 알림 중복 없음', view2.body.alerts.length === 1);

// 23) 안전상태 전이 → 새 알림
await api('/api/positions/u1', {
  method: 'PUT',
  body: JSON.stringify({ nodeId: 'N2', nodeName: '중앙 복도 교차점', phase: 'safehold' }),
});
const view3 = await api(`/api/guardian/${CODE}`);
expect('안전상태 전이 시 알림 추가', view3.body.alerts.length === 2);

// 24) 보호자를 등록한 사용자의 구조요청에는 연락처가 붙는다
await api('/api/sos', {
  method: 'POST',
  body: JSON.stringify({ userId: 'u1', nodeId: 'N2', nodeName: '중앙 복도', reason: '확신도 저하' }),
});
const sosWithGuardian = await api('/api/sos');
expect('구조요청에 보호자 연락처 첨부',
  sosWithGuardian.body[0].guardianName === '김보호' &&
  sosWithGuardian.body[0].guardianContact === '010-9999-0000');

// 25) 보호자 스코프 SSE — 대상자 정보만, 운영지표는 제외
await api('/api/positions/other-user', {
  method: 'PUT',
  body: JSON.stringify({ nodeId: 'N3', nodeName: '간호사실 앞', phase: 'guiding' }),
});
const gSse = await fetch(`${BASE}/api/stream?code=${CODE}`);
const gReader = gSse.body.getReader();
let gChunk = '';
while (!gChunk.includes('event: alerts')) {
  gChunk += new TextDecoder().decode((await gReader.read()).value);
}
await gReader.cancel();

const frame = topic => {
  const m = gChunk.match(new RegExp(`event: ${topic}\\ndata: (.*)`));
  return m ? JSON.parse(m[1]) : null;
};
expect('보호자 스트림: 대상자 위치만 전달',
  frame('positions').length === 1 && frame('positions')[0].userId === 'u1');
expect('보호자 스트림: 운영지표(metrics) 미노출', frame('metrics').length === 0);
expect('보호자 스트림: 지도용 위험 상태는 전달', Object.keys(frame('hazards')).length > 0);

// 26) 잘못된 코드로는 스트림 구독 불가
const badStream = await fetch(`${BASE}/api/stream?code=ZZZZZZ`);
expect('잘못된 코드로 스트림 구독 시 404', badStream.status === 404);

// ------------------------------------------------------------- 온도 센서
await api('/api/hazards/reset', { method: 'POST' });

// 27) 상온 판독은 통행에 영향 없음
const cool = await api('/api/sensors/temperature', {
  method: 'POST',
  body: JSON.stringify({ sensorId: 'T-E11', edgeId: 'E11', celsius: 24 }),
});
expect('상온 판독은 위험 아님', cool.status === 201 && cool.body.hazard === null,
  `임계값 warn ${cool.body.thresholds?.warn}°C / block ${cool.body.thresholds?.block}°C`);

const coolRoute = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'N1' }) });
expect('상온이면 최단 경로 그대로', coolRoute.body.route?.exit.id === 'N10');

// 28) 과열 → 자동으로 통행 불가 + 경로 우회
const hot = await api('/api/sensors/temperature', {
  method: 'POST',
  body: JSON.stringify({ sensorId: 'T-E11', edgeId: 'E11', celsius: 78 }),
});
expect('임계값 초과 판독은 통행 불가 판정', hot.body.hazard === 'heat' && hot.body.blocked === true);

const hotHazards = await api('/api/hazards');
expect('온도 위험이 hazards에 자동 반영', hotHazards.body.E11?.type === 'heat', hotHazards.body.E11?.label);

const hotRoute = await api('/api/route', {
  method: 'POST', body: JSON.stringify({ from: 'N1', kind: 'reroute' }),
});
expect('과열 통로를 피해 계단 B로 우회', hotRoute.body.route?.exit.id === 'N8',
  `→ ${hotRoute.body.route?.nodes.join(' → ')} (${hotRoute.body.ms}ms)`);
expect('온도 반영 재탐색도 2초 이내', hotRoute.body.ms < 2000, `${hotRoute.body.ms} ms`);

// 29) 온도가 내려가면 원래 경로로 복귀
await api('/api/sensors/temperature', {
  method: 'POST', body: JSON.stringify({ sensorId: 'T-E11', edgeId: 'E11', celsius: 26 }),
});
const backRoute = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'N1' }) });
expect('온도 정상화 후 최단 경로 복귀', backRoute.body.route?.exit.id === 'N10');

// 30) 지점 센서 과열 → 연결된 통로 전부 차단
await api('/api/sensors/temperature', {
  method: 'POST', body: JSON.stringify({ sensorId: 'T-N9', nodeId: 'N9', celsius: 85 }),
});
const nodeHot = await api('/api/hazards');
expect('지점 과열 시 연결 통로 전부 차단',
  ['E7', 'E8', 'E11'].every(id => nodeHot.body[id]?.type === 'heat'));

// 31) 센서 모니터는 임계 판정과 노후 여부를 함께 알려준다
const sensorList = await api('/api/sensors');
expect('센서 목록에 판정 결과 포함',
  sensorList.body.sensors.find(s => s.sensorId === 'T-N9')?.hazard === 'heat' &&
  sensorList.body.thresholds.block === 60);

// 32) 잘못된 센서 입력 방어
const badTemp = await api('/api/sensors/temperature', {
  method: 'POST', body: JSON.stringify({ sensorId: 'X', edgeId: 'E1', celsius: 'hot' }),
});
expect('숫자가 아닌 온도는 400', badTemp.status === 400);
const badTarget = await api('/api/sensors/temperature', {
  method: 'POST', body: JSON.stringify({ sensorId: 'X', edgeId: 'E999', celsius: 50 }),
});
expect('도면에 없는 통로는 404', badTarget.status === 404);

await api('/api/sensors/reset', { method: 'POST' });
expect('센서 초기화', (await api('/api/sensors')).body.sensors.length === 0);

// ------------------------------------------------------------- 도면 주입
// 33) 다른 건물 도면을 주입하고 그 도면으로 안내
const schoolPlan = {
  id: 'school-2f',
  name: '학교 2층',
  metersPerUnit: 0.05,
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
};
const saved = await api('/api/plans', { method: 'POST', body: JSON.stringify(schoolPlan) });
expect('도면 주입 성공', saved.status === 201 && saved.body.plan.id === 'school-2f');
expect('연결 끊김 경고 없음', saved.body.warnings.length === 0);

// 34) 잘못된 도면은 거부 (출구 없음)
const badPlan = await api('/api/plans', {
  method: 'POST',
  body: JSON.stringify({ id: 'bad', name: '출구없음', nodes: [{ id: 'A', x: 0, y: 0, type: 'room' }], edges: [] }),
});
expect('출구 없는 도면은 400', badPlan.status === 400 && badPlan.body.details.some(d => d.includes('출구')));

// 35) 고립된 지점은 경고로 알려준다 (저장은 허용)
const withIsland = await api('/api/plans', {
  method: 'POST',
  body: JSON.stringify({ ...schoolPlan, id: 'school-2f-wip',
    nodes: [...schoolPlan.nodes, { id: 'ISO', name: '창고', x: 900, y: 700, type: 'room' }] }),
});
expect('고립 지점은 경고로 통과', withIsland.status === 201 && withIsland.body.warnings.length === 1,
  withIsland.body.warnings[0]);

// 36) 활성화 → 이후 경로 계산이 새 도면 기준
await api('/api/plans/school-2f/activate', { method: 'PUT' });
const newMap = await api('/api/map');
expect('활성 도면이 교체됨', newMap.body.id === 'school-2f' && newMap.body.nodes.length === 4);

const schoolRoute = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'A' }) });
expect('새 도면으로 경로 계산', schoolRoute.body.route?.exit.id === 'D',
  `→ ${schoolRoute.body.route?.nodes.join(' → ')}`);

// 37) 이전 도면의 노드는 더 이상 유효하지 않다
const oldNode = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'N1' }) });
expect('이전 도면 노드는 400', oldNode.status === 400);

// 38) 새 도면에서도 온도 회피가 그대로 동작
await api('/api/sensors/temperature', {
  method: 'POST', body: JSON.stringify({ sensorId: 'S-X3', edgeId: 'X3', celsius: 90 }),
});
const schoolReroute = await api('/api/route', {
  method: 'POST', body: JSON.stringify({ from: 'A', kind: 'reroute' }),
});
expect('주입 도면에서도 과열 회피', schoolReroute.body.route?.exit.id === 'C',
  `→ ${schoolReroute.body.route?.nodes.join(' → ')}`);

// 38-1) 장소 설명이 저장·조회에서 그대로 유지되는지 (사용자 음성 안내의 원천)
const described = {
  ...schoolPlan,
  id: 'school-2f-desc',
  nodes: schoolPlan.nodes.map(n => n.id === 'A'
    ? { ...n, description: '교실 뒷문 앞입니다.', landmark: '왼쪽 벽에 사물함이 있습니다.' }
    : n),
};
await api('/api/plans', { method: 'POST', body: JSON.stringify(described) });
const fetched = await api('/api/plans/school-2f-desc');
const placeA = fetched.body.nodes.find(n => n.id === 'A');
expect('장소 설명이 저장 후에도 유지됨',
  placeA.description === '교실 뒷문 앞입니다.' && placeA.landmark === '왼쪽 벽에 사물함이 있습니다.');

// 38-2) 너무 긴 설명은 거부 (음성으로 읽히므로)
const tooLong = await api('/api/plans', {
  method: 'POST',
  body: JSON.stringify({ ...described, id: 'too-long',
    nodes: described.nodes.map(n => n.id === 'A' ? { ...n, description: '가'.repeat(201) } : n) }),
});
expect('200자 넘는 장소 설명은 400', tooLong.status === 400,
  tooLong.body.details?.[0]);

// 38-3) 3D 도면 샘플이 서버 기동 시 자동 등록되고 장소 설명까지 들어 있는지
const gachon = await api('/api/plans/gachon-3f');
expect('가천관 3층 샘플 도면 자동 등록', gachon.status === 200 && gachon.body.nodes.length === 5,
  `장소 ${gachon.body.nodes?.length}곳`);
expect('샘플 도면 5곳 모두 설명 저장됨',
  gachon.body.nodes.every(n => n.description?.trim() && n.landmark?.trim()));
const gachonImg = await api('/api/plans/gachon-3f/image');
expect('샘플 3D 도면 이미지 등록됨',
  gachonImg.body.dataUri?.startsWith('data:image/svg+xml;base64,'),
  `${Math.round((gachonImg.body.dataUri?.length ?? 0) / 1024)}KB`);

// 38-4) 테스트 공간용 도면 5개와 각 도면의 테스트 위치 5곳
const testPlanList = (await api('/api/plans')).body.filter(p => p.id.startsWith('test-'));
expect('테스트 전용 도면 5개 자동 등록', testPlanList.length === 5,
  testPlanList.map(p => p.name).join(', '));
for (const summary of testPlanList) {
  const detail = await api(`/api/plans/${summary.id}`);
  const places = detail.body.nodes.filter(n => n.type !== 'exit' && n.type !== 'elevator');
  expect(`${summary.name}: 테스트 위치 5곳 저장`,
    places.length === 5 && places.every(n => n.description?.trim() && n.landmark?.trim()));
  const blueprint = await api(`/api/plans/${summary.id}/image`);
  expect(`${summary.name}: 현실형 설계도 배경 저장`,
    blueprint.body.dataUri?.startsWith('data:image/svg+xml;base64,'));
}

// 39) 사용 중인 도면은 삭제 불가
const delActive = await api('/api/plans/school-2f', { method: 'DELETE' });
expect('사용 중인 도면 삭제는 409', delActive.status === 409);

// 40) 도면 목록
const plans = await api('/api/plans');
expect('도면 목록에 활성 표시', plans.body.find(p => p.id === 'school-2f')?.active === true,
  `${plans.body.length}개 등록됨`);

// 41) 도면 이미지 등록·조회
const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgPut = await api('/api/plans/school-2f/image', { method: 'PUT', body: JSON.stringify({ dataUri: tinyPng }) });
expect('도면 이미지 저장', imgPut.status === 200);
expect('도면 이미지 조회', (await api('/api/plans/school-2f/image')).body.dataUri === tinyPng);

const badImg = await api('/api/plans/school-2f/image', { method: 'PUT', body: JSON.stringify({ dataUri: 'not-an-image' }) });
expect('이미지가 아닌 데이터는 400', badImg.status === 400);

// ------------------------------------------------- 임의 지점 화재 → 회피 경로
// 가천관 3층으로 옮겨 실제 시나리오를 재현한다
await api('/api/plans/gachon-3f/activate', { method: 'PUT' });

const calm = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'G1' }) });
expect('평상시에는 서편 계단이 최단', calm.body.route?.exit.id === 'G5');

// 41-1) 통로가 아니라 도면 좌표를 찍어서 불을 낸다
const fire = await api('/api/fires', {
  method: 'POST', body: JSON.stringify({ x: 450, y: 280, radius: 3 }),
});
expect('임의 좌표에 화재 발생', fire.status === 201 && fire.body.fire.id,
  `차단 통로 ${fire.body.blockedEdges.join(', ')}`);
expect('그 자리 통로만 차단됨', fire.body.blockedEdges.join() === 'GL4');

const escaped = await api('/api/route', {
  method: 'POST', body: JSON.stringify({ from: 'G1', kind: 'reroute' }),
});
expect('화재 지점을 피해 동편으로 회피', escaped.body.route?.exit.id === 'G4',
  `→ ${escaped.body.route?.nodes.join(' → ')} (${escaped.body.ms}ms)`);
expect('화재 회피 재탐색도 2초 이내', escaped.body.ms < 2000, `${escaped.body.ms} ms`);

// 41-2) 불이 번지면(반경 확대) 결국 갈 곳이 없다 → 안전상태
await api(`/api/fires/${fire.body.fire.id}`, { method: 'PUT', body: JSON.stringify({ radius: 20 }) });
const trapped = await api('/api/route', {
  method: 'POST', body: JSON.stringify({ from: 'G1', kind: 'reroute' }),
});
expect('불이 번져 교차점을 삼키면 경로 없음',
  trapped.body.route === null && Boolean(trapped.body.reason));

// 41-3) 진화하면 원래 경로로 복귀
await api(`/api/fires/${fire.body.fire.id}`, { method: 'DELETE' });
const recovered = await api('/api/route', { method: 'POST', body: JSON.stringify({ from: 'G1' }) });
expect('진화 후 원래 경로 복귀', recovered.body.route?.exit.id === 'G5');

// 41-4) 잘못된 입력 방어
const noCoord = await api('/api/fires', { method: 'POST', body: JSON.stringify({ radius: 5 }) });
expect('좌표 없는 화재는 400', noCoord.status === 400);
const hugeRadius = await api('/api/fires', {
  method: 'POST', body: JSON.stringify({ x: 100, y: 100, radius: 999 }),
});
expect('비현실적인 반경은 400', hugeRadius.status === 400);

await api('/api/fires/reset', { method: 'POST' });
expect('화재 전체 진화', (await api('/api/fires')).body.length === 0);

// 도면을 바꿀 때 이전 도면 좌표의 화재가 새 도면에 남으면 안 된다.
await api('/api/fires', {
  method: 'POST', body: JSON.stringify({ x: 450, y: 280, radius: 3 }),
});

// 42) 원래 도면으로 복귀 + 시나리오 초기화
await api('/api/plans/hospital-3f/activate', { method: 'PUT' });
expect('도면 전환 시 이전 테스트 화재 제거', (await api('/api/fires')).body.length === 0);
const hz3 = await api('/api/hazards');
expect('도면 복귀 후 시나리오 초기화 → E6만 남음', Object.keys(hz3.body).join() === 'E6');

server.close();
process.exit(failed ? 1 : 0);
