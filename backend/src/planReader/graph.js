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
 * 기호가 이미지 가로에서 차지할 수 있는 최대 비율.
 *
 * 피난안내도의 비상구 픽토그램은 **도면 전체 대비 아주 작다** — 한 층에 10~30개가
 * 흩어져 있으니 그럴 수밖에 없다. 실측(853px 사진)에서 진짜 픽토그램은 12~26px,
 * 즉 가로의 1.4~3% 였다.
 *
 * 이 문턱이 없으면 상단의 초록 제목 띠와 큰 글씨가 통째로 "비상구"로 잡힌다.
 * 실제로 그랬다 — 한 장에서 61~117px 짜리 가짜 비상구가 9개 나왔고, 편집기에는
 * 도면 바깥 허공에 비상구가 찍혔다. 크기만 봐도 걸러낼 수 있는 것들이다.
 */
const MAX_SYMBOL_RATIO = 0.06;

/** 크기 문턱을 적용할 클래스 — 실(room)은 크므로 뺀다 */
const SYMBOL_CLASSES = new Set([
  'exit', 'stair', 'elevator', 'extinguisher', 'hydrant', 'you_are_here', 'door',
]);

/**
 * 범례(凡例) 판정 기준.
 *
 * 범례는 "이 그림이 비상구입니다"를 설명하는 표지, 즉 **실제 위치가 아니다.**
 * 그런데 범례 아이콘은 도면 안 픽토그램보다 크고 선명해서 모델이 **더 잘 잡는다** —
 * 실측에서 확신도가 0.86 으로 가장 높았다. 걸러내지 않으면 대피 경로의 출구가
 * 범례 상자 안에 생기고, 시각장애인이 벽 앞 안내판으로 안내된다.
 *
 * 판별은 배치로 한다. 범례는 좁은 세로 띠 안에 **여러 종류의 기호가 줄지어** 있고,
 * 도면 안에서는 그런 배치가 나오지 않는다(같은 종류가 한 곳에 몰리는 일은 있어도,
 * 비상구·소화기·소화전이 한 줄로 정렬되지는 않는다).
 */
const LEGEND_X_TOL = 0.05;    // 가로 위치가 이 안이면 같은 줄로 본다
const LEGEND_MIN_ITEMS = 3;   // 이만큼 쌓여야 목록으로 본다
const LEGEND_MIN_KINDS = 2;   // 종류가 이만큼 섞여야 범례로 본다
const LEGEND_PAD = 0.02;      // 판정된 범례 상자를 이만큼 넓혀 주변까지 제외

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

  // 도면에 실제로 있는 기호만 남긴다. 아래 두 걸름망이 없으면 편집기에
  // 제목 글씨와 범례 아이콘이 "비상구"로 찍힌다 — 실측에서 5개 중 4개가 그랬다.
  const { kept, oversized, inLegend } = screenDetections(detections);
  if (oversized.length) {
    warnings.push(`기호로 보기엔 너무 큰 탐지 ${oversized.length}개를 버렸습니다(제목 글씨·초록 띠를 비상구로 오인한 것). 도면에 실제로 있는 픽토그램이 빠졌다면 직접 찍어주세요.`);
  }
  if (inLegend.length) {
    warnings.push(`범례(기호 설명란)에서 잡힌 ${inLegend.length}개를 버렸습니다. 범례는 실제 위치가 아니라 설명이기 때문입니다.`);
  }

  // 확신이 높은 것부터 자리를 잡는다. 겹치는 탐지가 있을 때 남는 쪽이
  // 더 확실한 쪽이 되도록 — 뒤에 오는 흐린 탐지는 병합되어 사라진다.
  const sorted = [...kept].sort((a, b) => b.confidence - a.confidence);

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

// ------------------------------------------------------------- 걸름망

/**
 * 탐지 결과에서 **도면 위의 실제 기호가 아닌 것**을 걸러낸다.
 *
 * 모델은 초록 픽토그램을 찾도록 학습됐고 실제로 잘 찾는다. 문제는 도면에는
 * 픽토그램처럼 생긴 것이 세 군데 있다는 점이다.
 *
 *   1. 도면 안       ← 우리가 원하는 것. 실제 비상구 위치.
 *   2. 범례          "■ 비상구 방향" 같은 설명. 실제 위치가 아니다.
 *   3. 제목·초록 띠   상단 헤더. 초록 바탕이라 통째로 비상구로 잡힌다.
 *
 * 2·3 은 모델이 못 배운 것이 아니라 **아무도 가르친 적이 없는** 구분이다.
 * 재학습으로도 고칠 수 있지만, 여기서 걸러내면 지금 가진 가중치 그대로 나아진다.
 *
 * @returns {{kept, oversized, inLegend}} 버린 것도 돌려준다 — 사람에게 알려야 하므로
 */
function screenDetections(detections) {
  const oversized = [];
  const sized = [];

  // 3. 크기 — 픽토그램은 도면 대비 작다. 큰 것은 기호가 아니라 배경이다.
  for (const d of detections) {
    if (SYMBOL_CLASSES.has(d.className) && (d.box[2] - d.box[0]) > MAX_SYMBOL_RATIO) {
      oversized.push(d);
    } else {
      sized.push(d);
    }
  }

  // 2. 범례 — 좁은 세로 띠에 여러 종류가 줄지어 있으면 설명란이다
  const zones = findLegendZones(sized);
  const inLegend = [];
  const kept = [];
  for (const d of sized) {
    const cx = (d.box[0] + d.box[2]) / 2;
    const cy = (d.box[1] + d.box[3]) / 2;
    (zones.some(z => cx >= z.x1 && cx <= z.x2 && cy >= z.y1 && cy <= z.y2)
      ? inLegend : kept).push(d);
  }
  return { kept, oversized, inLegend };
}

/**
 * 범례로 보이는 영역들을 찾는다.
 *
 * 가로 위치가 거의 같은 기호들을 한 묶음으로 모으고, 그 묶음이
 * **여러 종류가 섞인 세로 목록**이면 범례로 본다. 도면 안에서는 비상구·소화기·
 * 소화전이 한 줄로 정렬되는 일이 없다 — 그런 배치는 설명란에서만 나온다.
 */
function findLegendZones(detections) {
  const symbols = detections
    .filter(d => SYMBOL_CLASSES.has(d.className))
    .map(d => ({ ...d, cx: (d.box[0] + d.box[2]) / 2, cy: (d.box[1] + d.box[3]) / 2 }))
    .sort((a, b) => a.cx - b.cx);

  const zones = [];
  let group = [];
  const flush = () => {
    if (group.length >= LEGEND_MIN_ITEMS
        && new Set(group.map(g => g.className)).size >= LEGEND_MIN_KINDS) {
      const ys = group.map(g => g.cy);
      const xs = group.map(g => g.cx);
      const height = Math.max(...ys) - Math.min(...ys);
      const width = Math.max(...xs) - Math.min(...xs);
      // 가로로 늘어선 건 범례가 아니다 — 복도를 따라 놓인 실제 기호일 수 있다
      if (height > width) {
        zones.push({
          x1: Math.min(...xs) - LEGEND_PAD, x2: Math.max(...xs) + LEGEND_PAD,
          y1: Math.min(...ys) - LEGEND_PAD, y2: Math.max(...ys) + LEGEND_PAD,
        });
      }
    }
    group = [];
  };

  for (const s of symbols) {
    if (group.length && s.cx - group[group.length - 1].cx > LEGEND_X_TOL) flush();
    group.push(s);
  }
  flush();
  return zones;
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

export const _internal = { segmentIntersectsBox, nearestEdgeMidpoint, crossesAnyRoom, screenDetections, findLegendZones };
