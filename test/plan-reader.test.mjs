/**
 * 탐지 결과 → 경로 그래프 변환 검증.
 *
 * 여기서 지키려는 것은 정확도가 아니라 **안전 성질**이다. 탐지 모델이 무엇을
 * 찾아오든, 아래 두 가지는 절대 깨지면 안 된다.
 *
 *   1. 소화기·소화전을 대피 지점으로 만들지 않는다 (경로가 소화기로 안내하면 안 된다)
 *   2. 실(방)을 관통하는 통로를 만들지 않는다 (시각장애인이 벽으로 걸어간다)
 *
 * 모델 정확도는 사진마다 다르고 여기서 잴 수 없다. 하지만 위 두 성질은
 * 어떤 탐지 결과가 들어와도 코드가 지켜야 하는 것이고, 그래서 테스트한다.
 */
import { nodesFromDetections, inferCorridorEdges, _internal } from '../backend/src/planReader/graph.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`[${cond ? '통과' : '실패'}] ${name} ${detail}`);
  if (!cond) failed++;
}

const det = (className, x1, y1, x2, y2, confidence = 0.9) =>
  ({ className, confidence, box: [x1, y1, x2, y2] });

// ─────────────────────────────────────────────── 클래스 → 지점 유형

{
  const { nodes } = nodesFromDetections([
    det('exit', 0.90, 0.45, 0.96, 0.55),
    det('stair', 0.04, 0.45, 0.10, 0.55),
    det('elevator', 0.48, 0.60, 0.54, 0.68),
    det('room', 0.20, 0.10, 0.35, 0.30),
    det('door', 0.27, 0.30, 0.29, 0.32),
    det('you_are_here', 0.50, 0.45, 0.52, 0.47),
    det('extinguisher', 0.60, 0.40, 0.62, 0.42),
    det('hydrant', 0.70, 0.40, 0.72, 0.42),
  ]);

  const types = nodes.map(n => n.type);
  expect('소화기·소화전은 지점이 되지 않는다',
    nodes.length === 6, `지점 ${nodes.length}개 (기대 6)`);
  expect('비상구는 exit', types.filter(t => t === 'exit').length === 2, '비상구 + 계단');
  expect('계단은 exit 으로 승격된다 (대피 목표는 exit 뿐)',
    nodes.find(n => n.detectedAs === 'stair')?.type === 'exit');
  expect('엘리베이터는 elevator 로 남는다',
    nodes.find(n => n.detectedAs === 'elevator')?.type === 'elevator');
  expect('실은 room', nodes.find(n => n.detectedAs === 'room')?.type === 'room');
  expect('문·현 위치는 junction',
    nodes.filter(n => ['door', 'you_are_here'].includes(n.detectedAs)).every(n => n.type === 'junction'));

  // 좌표는 상자 한가운데
  const room = nodes.find(n => n.detectedAs === 'room');
  expect('지점 좌표는 탐지 상자의 한가운데',
    Math.abs(room.x - 0.275) < 1e-9 && Math.abs(room.y - 0.20) < 1e-9,
    `(${room.x}, ${room.y})`);
}

// ─────────────────────────────────────────────── 중복 탐지 병합

{
  // 두 모델이 같은 비상구를 각각 잡은 상황
  const { nodes } = nodesFromDetections([
    det('exit', 0.900, 0.450, 0.960, 0.550, 0.91),
    det('exit', 0.903, 0.452, 0.958, 0.548, 0.62),
  ]);
  expect('같은 자리의 중복 탐지는 하나로 합쳐진다', nodes.length === 1, `${nodes.length}개`);
  expect('남는 쪽은 확신이 높은 탐지', nodes[0].confidence === 0.91);
}

// ─────────────────────────────────────────────── 경고

{
  const { warnings } = nodesFromDetections([det('room', 0.2, 0.1, 0.35, 0.3)]);
  expect('번호 이름은 바꾸라고 알린다',
    warnings.some(w => w.includes('실제 호실 이름')));

  const { warnings: w2 } = nodesFromDetections([det('stair', 0.04, 0.45, 0.10, 0.55)]);
  expect('계단을 출구로 올렸다고 알린다',
    w2.some(w => w.includes('계단') && w.includes('출구로 표시')));

  // "출구가 없다"·"방이 없다"는 planReader.js 의 sanitize 가 말한다.
  // 여기서도 말하면 표현만 다른 같은 경고가 두 줄 뜬다.
  expect('출구·방 없음 경고는 여기서 내지 않는다',
    !warnings.some(w => w.includes('찾지 못')) && !w2.some(w => w.includes('찾지 못')),
    [...warnings, ...w2].filter(w => w.includes('찾지 못')).join(' / '));
}

// ─────────────────────────────────────────────── 선분–사각형 교차

{
  const box = [0.4, 0.4, 0.6, 0.6];
  const cross = _internal.segmentIntersectsBox;
  expect('사각형을 가로지르는 선분은 교차',
    cross({ x: 0.3, y: 0.5 }, { x: 0.7, y: 0.5 }, box));
  expect('사각형을 비켜가는 선분은 교차 아님',
    !cross({ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.2 }, box));
  expect('한 끝이 사각형 안이면 교차',
    cross({ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.9 }, box));
  expect('사각형 바깥을 스치는 선분은 교차 아님',
    !cross({ x: 0.0, y: 0.0 }, { x: 0.0, y: 1.0 }, box));
}

// ─────────────────────────────────────────────── 통로 추론

{
  // 가운데 복도를 두고 위아래로 방이 늘어선, 가장 흔한 층 배치.
  //   위:  R1(0.1~0.3) R2(0.4~0.6) R3(0.7~0.9)  y 0.05~0.40
  //   복도: y ≈ 0.5
  //   아래: R4 R5 R6                            y 0.60~0.95
  const detections = [
    det('room', 0.10, 0.05, 0.30, 0.40), det('room', 0.40, 0.05, 0.60, 0.40),
    det('room', 0.70, 0.05, 0.90, 0.40), det('room', 0.10, 0.60, 0.30, 0.95),
    det('room', 0.40, 0.60, 0.60, 0.95), det('room', 0.70, 0.60, 0.90, 0.95),
    det('exit', 0.02, 0.47, 0.07, 0.53),
    det('exit', 0.93, 0.47, 0.98, 0.53),
    det('you_are_here', 0.49, 0.48, 0.51, 0.52),
  ];
  const { nodes, roomBoxes } = nodesFromDetections(detections);
  const { nodes: all, edges, warnings } = inferCorridorEdges(nodes, roomBoxes);

  const byId = new Map(all.map(n => [n.id, n]));
  const boxes = new Map(roomBoxes.map(r => [r.id, r.box]));

  expect('실마다 문 앞 지점이 생긴다',
    all.filter(n => n.inferred).length === 6, `${all.filter(n => n.inferred).length}개`);

  // 문 앞 지점은 복도(가운데)를 향한 변에 놓여야 한다
  const gateOfR1 = all.find(n => n.id === 'G_ROOM1');
  expect('위쪽 실의 문 앞 지점은 아래(복도 쪽) 변에 놓인다',
    gateOfR1 && Math.abs(gateOfR1.y - 0.40) < 1e-9, `y=${gateOfR1?.y}`);

  // 핵심 안전 성질: 어떤 통로도 자기 실이 아닌 실을 관통하지 않는다
  const violations = edges.filter(e => {
    const a = byId.get(e.a), b = byId.get(e.b);
    const own = new Set([e.a, e.b].map(id => (id.startsWith('G_') ? id.slice(2) : id)));
    return [...boxes].some(([id, box]) =>
      !own.has(id) && _internal.segmentIntersectsBox(a, b, box));
  });
  expect('실을 관통하는 통로를 만들지 않는다',
    violations.length === 0,
    violations.map(e => `${e.a}-${e.b}`).join(', '));

  // 모든 지점이 출구까지 이어져야 안내를 시작할 수 있다
  const adj = new Map(all.map(n => [n.id, []]));
  for (const e of edges) { adj.get(e.a).push(e.b); adj.get(e.b).push(e.a); }
  const seen = new Set(['EXIT1']);
  const queue = ['EXIT1'];
  while (queue.length) {
    for (const next of adj.get(queue.pop()) || []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  expect('모든 지점이 출구까지 이어진다',
    seen.size === all.length, `${seen.size}/${all.length}`);

  // 트리만 남기면 한 통로가 막혔을 때 갈 곳이 없다
  expect('우회로가 생긴다 (간선 수 > 지점 수 - 1)',
    edges.length > all.length - 1, `간선 ${edges.length} · 지점 ${all.length}`);

  expect('통로가 추정이라는 사실을 알린다',
    warnings.some(w => w.includes('추정')));
}

console.log(failed ? `\n${failed}건 실패` : '\n도면 판독 그래프 테스트 통과');
process.exit(failed ? 1 : 0);
