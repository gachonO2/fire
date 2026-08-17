/**
 * 탐지 상자 → 경로 그래프.
 *
 * 탐지기는 "여기 비상구가 있다"까지만 안다. 대피 안내에 필요한 건 그 다음,
 * **"거기까지 어떻게 가는가"**다. 이 파일이 그 간극을 메운다.
 *
 * ## 통로를 지어내는 일의 위험
 *
 * 지점 좌표는 모델이 사진에서 본 것이지만, 통로는 아무도 본 적이 없는 **추측**이다.
 * 두 점 사이에 벽이 있는지 사진만 보고 확실히 알 수는 없다. 그래서 여기서 만든
 * 통로는 전부 초안이고, 편집기가 "통로는 추정입니다"라고 크게 말해야 한다.
 *
 * 대신 확실히 틀린 것만은 만들지 않는다: **실(방) 사각형을 가로지르는 연결은
 * 거부한다.** 방은 벽으로 둘러싸인 공간이라 그 안을 관통하는 복도는 없다.
 * 이 규칙 하나로 "눈에는 가까워 보여서 이었는데 사이에 교실이 있는" 연결이 걸러진다.
 *
 * ## 언어모델이 있으면 이 파일은 좌표만 담당한다
 *
 * 통로 연결은 언어모델이 훨씬 낫다 — 도면에 그려진 초록 화살표와 복도 선을
 * 읽을 수 있기 때문이다. planReader.js 는 키가 있으면 여기서 만든 지점만 쓰고
 * 통로는 언어모델에게 맡긴다. 여기 통로 추론은 **키가 없을 때의 대비책**이다.
 */

/** 탐지 클래스 → 도면 노드 유형. 여기 없는 클래스는 대피 경로와 무관해서 버린다. */
const TYPE_BY_CLASS = {
  exit: 'exit',
  stair: 'exit',        // 아래 승격 규칙 참고
  elevator: 'elevator',
  room: 'room',
  door: 'junction',
  you_are_here: 'junction',
  // extinguisher·hydrant 는 대피 경로와 무관하다 (소화기 위치로 안내하지 않는다)
};

/** 사람이 읽을 이름의 밑바탕. 탐지기는 글자를 못 읽으므로 번호로 구분한다. */
const LABEL = {
  exit: '비상구', stair: '계단', elevator: '엘리베이터',
  room: '실', door: '출입문 앞', you_are_here: '현 위치',
};

/** 두 지점이 이보다 가까우면 같은 곳으로 본다 (도면 대각선 기준 비율) */
const MERGE_RATIO = 0.02;

/** 최소신장트리 뒤에 덧붙일 우회로의 길이 상한 (트리 평균 간선 길이의 배수) */
const EXTRA_EDGE_FACTOR = 1.4;

/**
 * 탐지 결과를 지점 목록으로 바꾼다.
 *
 * @param detections  [{className, confidence, box:[x1,y1,x2,y2]}] — 0~1 정규화
 * @returns {{nodes, roomBoxes, warnings}} nodes 좌표도 0~1 이다
 */
export function nodesFromDetections(detections) {
  const warnings = [];
  const counters = {};
  const nodes = [];
  const roomBoxes = [];

  // 확신이 높은 것부터 자리를 잡는다. 겹치는 탐지가 있을 때 남는 쪽이
  // 더 확실한 쪽이 되도록 — 뒤에 오는 흐린 탐지는 병합되어 사라진다.
  const sorted = [...detections].sort((a, b) => b.confidence - a.confidence);

  for (const d of sorted) {
    const type = TYPE_BY_CLASS[d.className];
    if (!type) continue;

    const [x1, y1, x2, y2] = d.box;
    const x = (x1 + x2) / 2;
    const y = (y1 + y2) / 2;

    // 같은 기호를 두 모델이 각각 잡아 두 지점이 되는 일을 막는다.
    // 지점이 둘로 갈리면 경로가 그 사이를 왔다 갔다 하는 안내가 나온다.
    const dup = nodes.find(n => n.type === type && dist(n, { x, y }) < MERGE_RATIO);
    if (dup) continue;

    const kind = d.className;
    counters[kind] = (counters[kind] || 0) + 1;
    const node = {
      id: `${kind.toUpperCase().slice(0, 4)}${counters[kind]}`,
      name: `${LABEL[kind]} ${counters[kind]}`,
      x, y, type,
      detectedAs: kind,
      confidence: d.confidence,
    };
    nodes.push(node);
    if (type === 'room') roomBoxes.push({ id: node.id, box: d.box });
  }

  // 계단은 exit 으로 올려 둔다 — 대피 목표가 되는 건 exit 뿐이라(shared/floor-plan.js
  // 의 exitNodes) stair 로 두면 그 계단이 대피로에서 통째로 빠진다. 다만 옥상
  // 전용 계단처럼 대피에 못 쓰는 것이 섞일 수 있어 **반드시 알린다.**
  const stairs = nodes.filter(n => n.detectedAs === 'stair');
  if (stairs.length) {
    warnings.push(`계단 ${stairs.length}곳을 출구로 표시했습니다. 대피에 쓸 수 없는 계단(옥상 전용 등)이면 유형을 바꿔주세요.`);
  }
  // "출구가 없다"·"방이 없다"는 여기서 말하지 않는다 — planReader.js 의 sanitize 가
  // 어느 엔진으로 읽었든 똑같이 검사한다. 양쪽에서 말하면 표현만 다른 같은 경고가
  // 두 줄 뜨고, 목록이 길어지면 진짜 문제가 묻힌다.
  if (nodes.some(n => n.type === 'room')) {
    warnings.push('장소 이름은 번호로만 붙였습니다(실 1, 실 2…). 탐지기는 글자를 읽지 못하므로, 도면에 적힌 실제 호실 이름으로 바꿔주세요 — 시각장애인이 대피를 시작할 때 이 이름 목록에서 고릅니다.');
  }

  return { nodes, roomBoxes, warnings };
}

/**
 * 지점들을 통로로 잇는다 — **언어모델이 없을 때만** 쓰는 대비책.
 *
 * 세 단계다.
 *  1. 실은 복도에 직접 붙이지 않고 **문 앞 지점**을 하나 만들어 거기 붙인다.
 *     실 사각형의 네 변 중 도면 중심에 가까운 변의 한가운데다 — 한국 건물에서
 *     복도는 대개 층 한가운데를 지나므로, 실의 출입문도 그쪽을 향한다.
 *  2. 복도 지점끼리 최소신장트리로 잇는다. 실 사각형을 가로지르는 연결은 뺀다.
 *  3. 트리만 남기면 통로가 하나뿐이라 한 곳이 막히면 갈 곳이 없어진다.
 *     짧은 연결을 몇 개 더 얹어 우회로를 만든다.
 *
 * @returns {{nodes, edges, warnings}}
 */
export function inferCorridorEdges(nodes, roomBoxes) {
  const warnings = [];
  const rooms = nodes.filter(n => n.type === 'room');
  const boxOf = new Map(roomBoxes.map(r => [r.id, r.box]));

  // 복도 지점: 실이 아닌 모든 지점 (문·현 위치·비상구·계단·엘리베이터)
  const corridor = nodes.filter(n => n.type !== 'room').map(n => ({ ...n }));
  const extraNodes = [];
  const edges = [];
  let edgeSeq = 1;
  const addEdge = (a, b) => edges.push({ id: `E${edgeSeq++}`, a, b, wall: null });

  // 1. 실마다 문 앞 지점
  const center = centroidOf(nodes);
  for (const room of rooms) {
    const box = boxOf.get(room.id);
    const front = box ? nearestEdgeMidpoint(box, center) : { x: room.x, y: room.y };

    // 이미 문이 탐지된 자리면 그걸 쓴다 — 탐지된 문은 추측이 아니라 본 것이다
    const existing = corridor.find(n => dist(n, front) < MERGE_RATIO * 2);
    if (existing) {
      addEdge(room.id, existing.id);
      continue;
    }
    const gate = {
      id: `G_${room.id}`, name: `${room.name} 앞`,
      x: front.x, y: front.y, type: 'junction', inferred: true,
    };
    extraNodes.push(gate);
    corridor.push(gate);
    addEdge(room.id, gate.id);
  }

  if (corridor.length < 2) {
    warnings.push('이을 지점이 모자라 통로를 만들지 못했습니다. 편집기에서 직접 연결해주세요.');
    return { nodes: [...nodes, ...extraNodes], edges, warnings };
  }

  // 2. 실을 관통하지 않는 후보만 모아 최소신장트리
  const candidates = [];
  for (let i = 0; i < corridor.length; i++) {
    for (let j = i + 1; j < corridor.length; j++) {
      const a = corridor[i], b = corridor[j];
      if (crossesAnyRoom(a, b, roomBoxes)) continue;
      candidates.push({ a, b, d: dist(a, b) });
    }
  }
  candidates.sort((p, q) => p.d - q.d);

  const parent = new Map(corridor.map(n => [n.id, n.id]));
  const find = id => (parent.get(id) === id ? id : (parent.set(id, find(parent.get(id))), parent.get(id)));
  const tree = [];
  for (const c of candidates) {
    const ra = find(c.a.id), rb = find(c.b.id);
    if (ra === rb) continue;
    parent.set(ra, rb);
    tree.push(c);
    addEdge(c.a.id, c.b.id);
  }

  // 3. 우회로 — 트리 간선 평균 길이의 EXTRA_EDGE_FACTOR 배 안쪽인 나머지 연결
  if (tree.length) {
    const avg = tree.reduce((s, c) => s + c.d, 0) / tree.length;
    const inTree = new Set(tree.map(c => key(c.a.id, c.b.id)));
    for (const c of candidates) {
      if (inTree.has(key(c.a.id, c.b.id))) continue;
      if (c.d > avg * EXTRA_EDGE_FACTOR) break;   // 정렬돼 있으므로 여기서 끝
      addEdge(c.a.id, c.b.id);
    }
  }

  // 실 사각형이 길을 다 막아 섬이 생겼을 수 있다. 벽을 뚫어 잇지는 **않는다** —
  // 없는 통로를 만들면 시각장애인이 벽으로 걸어간다. 대신 어디가 끊겼는지 알린다.
  const groups = new Set(corridor.map(n => find(n.id)));
  if (groups.size > 1) {
    warnings.push(`통로가 ${groups.size}덩어리로 끊겼습니다. 실 사이를 지나는 복도를 편집기에서 이어주세요.`);
  }
  warnings.push('통로는 지점 위치로 **추정**한 것입니다. 도면과 대조해 벽을 가로지르는 연결이 없는지 확인하세요.');

  return { nodes: [...nodes, ...extraNodes], edges, warnings };
}

// ------------------------------------------------------------------ 기하

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function centroidOf(nodes) {
  if (!nodes.length) return { x: 0.5, y: 0.5 };
  return {
    x: nodes.reduce((s, n) => s + n.x, 0) / nodes.length,
    y: nodes.reduce((s, n) => s + n.y, 0) / nodes.length,
  };
}

/** 사각형의 네 변 한가운데 중 target 에 가장 가까운 점 */
function nearestEdgeMidpoint([x1, y1, x2, y2], target) {
  const mids = [
    { x: (x1 + x2) / 2, y: y1 },  // 위
    { x: (x1 + x2) / 2, y: y2 },  // 아래
    { x: x1, y: (y1 + y2) / 2 },  // 왼
    { x: x2, y: (y1 + y2) / 2 },  // 오른
  ];
  return mids.reduce((best, m) => (dist(m, target) < dist(best, target) ? m : best));
}

/**
 * 선분이 어떤 실 사각형이든 **관통**하는가.
 *
 * 양 끝 지점이 속한 실은 예외다 — 그 방에서 나오는 길은 당연히 그 방을 지난다.
 * 문 앞 지점(G_<실id>)은 그 실에 속한 것으로 본다.
 */
function crossesAnyRoom(a, b, roomBoxes) {
  const own = new Set([roomIdOf(a), roomIdOf(b)]);
  return roomBoxes.some(r => !own.has(r.id) && segmentIntersectsBox(a, b, r.box));
}

function roomIdOf(node) {
  return node.id.startsWith('G_') ? node.id.slice(2) : node.id;
}

/** 선분–사각형 교차. 끝점이 안에 있어도 교차로 본다. */
function segmentIntersectsBox(p, q, [x1, y1, x2, y2]) {
  if (inside(p, x1, y1, x2, y2) || inside(q, x1, y1, x2, y2)) return true;
  const corners = [
    [{ x: x1, y: y1 }, { x: x2, y: y1 }],
    [{ x: x2, y: y1 }, { x: x2, y: y2 }],
    [{ x: x2, y: y2 }, { x: x1, y: y2 }],
    [{ x: x1, y: y2 }, { x: x1, y: y1 }],
  ];
  return corners.some(([c, d]) => segmentsCross(p, q, c, d));
}

const inside = (p, x1, y1, x2, y2) => p.x > x1 && p.x < x2 && p.y > y1 && p.y < y2;

function segmentsCross(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);

export const _internal = { segmentIntersectsBox, nearestEdgeMidpoint, crossesAnyRoom };
