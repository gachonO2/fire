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
  // 기호 크기는 실측을 따른다 — 853px 사진에서 픽토그램은 12~26px, 즉 가로 1.4~3%.
  // 이보다 크면 걸름망이 "기호가 아니다"로 버린다(제목 띠 오탐을 막는 규칙).
  const { nodes } = nodesFromDetections([
    det('exit', 0.900, 0.450, 0.925, 0.475),
    det('stair', 0.040, 0.450, 0.065, 0.475),
    det('elevator', 0.480, 0.600, 0.505, 0.625),
    det('room', 0.200, 0.100, 0.350, 0.300),
    det('door', 0.270, 0.300, 0.290, 0.320),
    det('you_are_here', 0.500, 0.450, 0.520, 0.470),
    det('extinguisher', 0.600, 0.400, 0.620, 0.420),
    det('hydrant', 0.700, 0.400, 0.720, 0.420),
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
    det('exit', 0.900, 0.450, 0.925, 0.475, 0.91),
    det('exit', 0.903, 0.452, 0.923, 0.473, 0.62),
  ]);
  expect('같은 자리의 중복 탐지는 하나로 합쳐진다', nodes.length === 1, `${nodes.length}개`);
  expect('남는 쪽은 확신이 높은 탐지', nodes[0].confidence === 0.91);
}

// ─────────────────────────────────────────────── 경고

{
  const { warnings } = nodesFromDetections([det('room', 0.2, 0.1, 0.35, 0.3)]);
  expect('번호 이름은 바꾸라고 알린다',
    warnings.some(w => w.includes('실제 호실 이름')));

  const { warnings: w2 } = nodesFromDetections([det('stair', 0.040, 0.450, 0.065, 0.475)]);
  expect('계단을 출구로 올렸다고 알린다',
    w2.some(w => w.includes('계단') && w.includes('출구로 표시')));

  // "출구가 없다"·"방이 없다"는 planReader.js 의 sanitize 가 말한다.
  // 여기서도 말하면 표현만 다른 같은 경고가 두 줄 뜬다.
  expect('출구·방 없음 경고는 여기서 내지 않는다',
    !warnings.some(w => w.includes('찾지 못')) && !w2.some(w => w.includes('찾지 못')),
    [...warnings, ...w2].filter(w => w.includes('찾지 못')).join(' / '));
}

// ─────────────────────────────────────────────── 걸름망: 크기·범례

{
  // 실측(draft-1-1.jpg)에서 나온 배치를 그대로 옮겼다.
  // 상단 초록 제목 띠가 통째로 "비상구"로 잡히고, 왼쪽 범례의 아이콘들이
  // 도면 안 픽토그램보다 **더 높은 확신도**로 잡혔다.
  const { nodes, warnings } = nodesFromDetections([
    // 제목/헤더 — 가로 16%, 8%. 픽토그램일 수 없는 크기
    det('exit', 0.30, 0.02, 0.46, 0.10, 0.77),
    det('exit', 0.66, 0.03, 0.74, 0.11, 0.75),
    // 범례 — 같은 가로 위치에 여러 종류가 세로로 줄지어 있음
    det('exit',         0.13, 0.56, 0.16, 0.59, 0.86),
    det('exit',         0.13, 0.64, 0.15, 0.67, 0.79),
    det('hydrant',      0.13, 0.68, 0.15, 0.71, 0.72),
    det('extinguisher', 0.13, 0.72, 0.15, 0.75, 0.66),
    // 도면 안 진짜 픽토그램
    det('exit', 0.52, 0.44, 0.545, 0.465, 0.79),
    det('exit', 0.71, 0.79, 0.727, 0.807, 0.79),
    det('room', 0.55, 0.55, 0.66, 0.68, 0.60),
  ]);

  const exits = nodes.filter(n => n.type === 'exit');
  expect('제목 띠(큰 초록 영역)를 비상구로 만들지 않는다',
    !exits.some(n => n.y < 0.15), exits.map(n => n.y.toFixed(2)).join(','));
  expect('범례 아이콘을 비상구로 만들지 않는다',
    !exits.some(n => n.x < 0.20), exits.map(n => n.x.toFixed(2)).join(','));
  expect('도면 안 진짜 픽토그램은 남긴다',
    exits.length === 2, `${exits.length}개`);
  expect('무엇을 왜 버렸는지 알린다',
    warnings.some(w => w.includes('너무 큰')) && warnings.some(w => w.includes('범례')));
}

{
  // 복도를 따라 가로로 늘어선 기호는 범례가 아니다 — 지워버리면 안 된다
  const { nodes } = nodesFromDetections([
    det('exit',    0.20, 0.50, 0.22, 0.52, 0.8),
    det('exit',    0.40, 0.50, 0.42, 0.52, 0.8),
    det('hydrant', 0.60, 0.50, 0.62, 0.52, 0.8),
    det('exit',    0.80, 0.50, 0.82, 0.52, 0.8),
  ]);
  expect('가로로 늘어선 기호는 범례로 오해하지 않는다',
    nodes.filter(n => n.type === 'exit').length === 3,
    `${nodes.filter(n => n.type === 'exit').length}개`);
}

{
  // 실(room)은 크므로 크기 문턱을 적용하지 않는다
  const { nodes } = nodesFromDetections([det('room', 0.2, 0.2, 0.6, 0.7, 0.7)]);
  expect('실은 커도 버리지 않는다', nodes.filter(n => n.type === 'room').length === 1);
}

{
  // 한 기호를 소화기로도 소화전으로도 잡는 일이 실제로 있다 — 중복 정리는
  // 탐지기가 클래스별로만 하기 때문이다. 그 둘을 별개로 세면 기호 하나가
  // "2개 · 2종류"가 되어 범례 판정의 두 조건을 혼자 채우고, 근처의 진짜
  // 비상구까지 가짜 범례 안에 들어가 버려진다. 실측 도면에서 그렇게 됐다.
  const overlapping = [
    det('hydrant',      0.416, 0.510, 0.436, 0.530, 0.42),
    det('extinguisher', 0.417, 0.509, 0.437, 0.529, 0.51),  // 같은 자리
    det('exit',         0.455, 0.598, 0.475, 0.618, 0.79),  // 도면 안 진짜 비상구
  ];

  expect('같은 자리 탐지는 범례 판정에서 하나로 센다',
    _internal.collapseSameSpot(overlapping).length === 2,
    `${_internal.collapseSameSpot(overlapping).length}개`);
  expect('겹친 탐지 셋은 범례가 아니다',
    _internal.findLegendZones(overlapping).length === 0);

  const { nodes } = nodesFromDetections(overlapping);
  expect('겹친 탐지 옆의 진짜 비상구를 버리지 않는다',
    nodes.some(n => n.type === 'exit'),
    nodes.map(n => n.type).join(','));
}

{
  // 위 규칙이 진짜 범례까지 풀어주면 안 된다. 실제 범례는 좁은 세로 띠에
  // 서로 겹치지 않게 줄지어 있으므로 합쳐지지 않고 그대로 범례로 잡힌다.
  const legend = [
    det('exit',    0.135, 0.575, 0.155, 0.595, 0.86),
    det('exit',    0.135, 0.603, 0.155, 0.623, 0.55),
    det('exit',    0.135, 0.658, 0.155, 0.678, 0.79),
    det('hydrant', 0.135, 0.714, 0.155, 0.734, 0.46),
  ];

  expect('줄지어 선 범례는 여전히 범례로 잡는다',
    _internal.findLegendZones(legend).length === 1);
  expect('범례 안의 비상구는 지점이 되지 않는다',
    !nodesFromDetections(legend).nodes.some(n => n.type === 'exit'));
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
    det('exit', 0.020, 0.480, 0.045, 0.505),
    det('exit', 0.955, 0.480, 0.980, 0.505),
    det('you_are_here', 0.490, 0.485, 0.510, 0.505),
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
