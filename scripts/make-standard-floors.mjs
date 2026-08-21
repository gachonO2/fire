/**
 * 기준층 도면을 만든다 — **2·3·4·5·7층과 옥탑, 그리고 반쪽짜리 1층.**
 *
 * ## 왜 손으로 짓나
 *
 * 도면 판독기(`backend/src/planReader.js`)는 사진을 받아 지점을 뽑는다.
 * 그런데 지금 가진 것은 건축 CAD 를 화면 캡처한 저해상도 이미지라, 판독기에
 * 넣으면 방 이름도 못 읽고 벽도 뭉개진다. 그 결과를 «도면» 이라고 올리면
 * 관제가 없는 방을 그리게 된다.
 *
 * 그래서 **도면에서 읽은 구조를 사람이 옮겨 적는다.** 각 층 실사진을 찍어
 * 올리면 그때 판독기가 이 자리를 대신한다.
 *
 * ## 이 건물의 기준층 구조
 *
 * 긴 쐐기꼴이다. 남쪽은 수평, 북쪽은 대각선. 그 사이가 복도이고 양쪽에
 * 강의실이 붙는다. 가운데는 **뚫려 있다** — 건물 중간을 관통하는 보이드다.
 *
 *     ┌─────────────── 북쪽 강의실 (대각선) ───────────────┐
 *     │  북쪽 복도                                          │
 *     │        ░░░ 가운데 보이드 (뚫림) ░░░                 │
 *     │  남쪽 복도                                          │
 *     └─────────────── 남쪽 강의실 (수평) ─────────────────┘
 *
 * ## 5층만 다르다 — 중앙 연결다리
 *
 * 5층에는 보이드를 가로지르는 다리가 있고 나머지 층에는 없다. 이것이
 * **대피에서 진짜 차이를 만든다** —
 *
 *   5층    남쪽 복도에서 북쪽으로 가운데를 가로질러 간다
 *   나머지  가운데가 막혀 있어 **양 끝까지 돌아가야** 한다
 *
 * 같은 자리에 불이 나도 5층 사람과 4층 사람의 대피 거리가 달라진다.
 * 층마다 도면이 필요한 이유가 정확히 이것이다.
 *
 * ## 1층은 반쪽
 *
 * 1층은 건물의 동쪽 절반만 쓴다(원형 강의실이 있는 쪽). 서쪽은 지반에
 * 묻혀 있다. 그래서 서쪽 계단이 없고 대피 방향이 동쪽으로만 열린다.
 */

const BASE = process.env.API || 'http://localhost:8080/api';
const W = 1352;
const H = 718;

/** 북쪽 대각선 — 외곽선에서 그대로 가져온 두 점 */
const N0 = [1239, 44];
const N1 = [43, 414];
/** 남쪽 수평선 */
const S_Y = 700;

const dx = N1[0] - N0[0];
const dy = N1[1] - N0[1];
const len = Math.hypot(dx, dy);
/** 대각선에서 건물 **안쪽**을 향하는 단위 법선 */
const nx = -dy / len;
const ny = dx / len;

/** 대각선 위 비율 t(0=동쪽 끝, 1=서쪽 끝)에서 안쪽으로 d 만큼 들어간 점 */
const onDiag = (t, d) => [
  Math.round(N0[0] + dx * t + nx * d),
  Math.round(N0[1] + dy * t + ny * d),
];

const node = (id, type, name, x, y, extra = {}) =>
  ({ id, type, name, x, y, ...extra });

/**
 * 기준층 하나를 만든다.
 * @param {number} floor
 * @param {{bridge?: boolean, half?: boolean}} opts
 */
function standardFloor(floor, opts = {}) {
  const nodes = [];
  const edges = [];
  const link = (a, b, extra = {}) =>
    edges.push({ id: `e${edges.length + 1}`, a, b, wall: null, ...extra });

  // 1층은 동쪽 절반만. 서쪽은 지반에 묻혀 있다.
  const tFrom = opts.half ? 0 : 0;
  const tTo = opts.half ? 0.42 : 0.86;
  const SPANS = opts.half ? 5 : 10;

  // ── 북쪽: 대각선을 따라 복도와 강의실
  const nCorr = [];
  for (let i = 0; i <= SPANS; i++) {
    const t = tFrom + (tTo - tFrom) * (i / SPANS);
    const [cx, cy] = onDiag(t, 108);
    const id = `N${i}`;
    nodes.push(node(id, 'junction', `북쪽 복도 ${i + 1}`, cx, cy));
    nCorr.push(id);
    if (i > 0) link(nCorr[i - 1], id);

    if (i < SPANS) {
      const tm = tFrom + (tTo - tFrom) * ((i + 0.5) / SPANS);
      const [rx, ry] = onDiag(tm, 46);
      const rid = `NR${i}`;
      nodes.push(node(rid, 'room', `${floor}0${i + 1}호 강의실`, rx, ry));
      link(id, rid);
    }
  }

  // ── 남쪽: 수평 복도와 강의실
  const xFrom = opts.half ? 700 : 90;
  const xTo = 1290;
  const sCorr = [];
  for (let i = 0; i <= SPANS; i++) {
    const cx = Math.round(xFrom + (xTo - xFrom) * (i / SPANS));
    const id = `S${i}`;
    nodes.push(node(id, 'junction', `남쪽 복도 ${i + 1}`, cx, 612));
    sCorr.push(id);
    if (i > 0) link(sCorr[i - 1], id);

    if (i < SPANS) {
      const rx = Math.round(xFrom + (xTo - xFrom) * ((i + 0.5) / SPANS));
      const rid = `SR${i}`;
      nodes.push(node(rid, 'room', `${floor}${String(20 + i).padStart(2, '0')}호 강의실`, rx, 672));
      link(id, rid);
    }
  }

  // ── 양 끝에서 두 복도가 만난다. **가운데는 뚫려 있다.**
  link(nCorr[0], sCorr[SPANS]);              // 동쪽 끝
  if (!opts.half) link(nCorr[SPANS], sCorr[0]);   // 서쪽 끝 (반쪽 층에는 없다)

  // ── 5층만 있는 중앙 연결다리.
  //
  // 이 한 줄이 5층과 나머지 층의 대피를 가른다 — 가운데가 막힌 층은 같은
  // 자리에서 불이 나도 양 끝까지 돌아가야 한다.
  if (opts.bridge) {
    const mid = Math.round(SPANS / 2);
    nodes.push(node('BRIDGE', 'junction', '중앙 연결다리',
      Math.round((nodes.find(n => n.id === nCorr[mid]).x
        + nodes.find(n => n.id === sCorr[mid]).x) / 2),
      Math.round((nodes.find(n => n.id === nCorr[mid]).y
        + nodes.find(n => n.id === sCorr[mid]).y) / 2)));
    link(nCorr[mid], 'BRIDGE');
    link('BRIDGE', sCorr[mid]);
  }

  // ── 계단·비상구. 동쪽 계단은 모든 층에 있다(엘리베이터와 나란히).
  nodes.push(node('EXIT_E', 'exit', '동쪽 계단', 1300, 380));
  link('EXIT_E', nCorr[0]);
  link('EXIT_E', sCorr[SPANS]);

  nodes.push(node('ELEV', 'elevator', '엘리베이터', 1240, 300));
  link('ELEV', nCorr[0]);

  if (!opts.half) {
    nodes.push(node('EXIT_W', 'exit', '서쪽 계단', 70, 520));
    link('EXIT_W', nCorr[SPANS]);
    link('EXIT_W', sCorr[0]);

    const mid = Math.round(SPANS / 2);
    nodes.push(node('EXIT_M', 'exit', '중앙 계단', nodes.find(n => n.id === sCorr[mid]).x, 560));
    link('EXIT_M', sCorr[mid]);
  }

  return { nodes, edges };
}

/** 옥탑 — 옥상으로 나가는 층. 방이 거의 없고 계단과 기계실뿐이다. */
function penthouse() {
  const nodes = [
    node('PH_HALL', 'junction', '옥탑 복도', 1180, 330),
    node('PH_MACH', 'room', '기계실', 1100, 250),
    node('EXIT_ROOF', 'exit', '옥상 출구 (운동장 방향)', 1300, 380),
    node('ELEV', 'elevator', '엘리베이터', 1240, 300),
  ];
  const edges = [
    { id: 'e1', a: 'PH_HALL', b: 'PH_MACH', wall: null },
    { id: 'e2', a: 'PH_HALL', b: 'EXIT_ROOF', wall: null },
    { id: 'e3', a: 'PH_HALL', b: 'ELEV', wall: null },
  ];
  return { nodes, edges };
}

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${d.error || r.status} ${JSON.stringify(d.details || '')}`);
  return d;
}

const PLANS = [
  { id: 'ai-1f', name: 'AI공학관 1층', build: () => standardFloor(1, { half: true }) },
  { id: 'ai-2f', name: 'AI공학관 2층', build: () => standardFloor(2) },
  { id: 'ai-3f', name: 'AI공학관 3층', build: () => standardFloor(3) },
  { id: 'ai-4f', name: 'AI공학관 4층', build: () => standardFloor(4) },
  { id: 'ai-5f', name: 'AI공학관 5층', build: () => standardFloor(5, { bridge: true }) },
  { id: 'ai-7f', name: 'AI공학관 7층', build: () => standardFloor(7) },
  { id: 'ai-ph', name: 'AI공학관 8층 (옥탑)', build: penthouse },
];

for (const p of PLANS) {
  const { nodes, edges } = p.build();
  const plan = {
    id: p.id,
    name: p.name,
    metersPerUnit: 0.1087,      // 6층 실측값과 같은 축척 — 같은 건물이다
    stepLength: 0.7,
    image: { width: W, height: H },
    nodes,
    edges,
  };
  const r = await post('/plans', plan);
  const exits = nodes.filter(n => n.type === 'exit').length;
  console.log(`  ${p.name.padEnd(20)} 지점 ${String(nodes.length).padStart(3)}`
    + ` · 통로 ${String(edges.length).padStart(3)} · 출구 ${exits}`
    + `${r.warnings?.length ? `  ⚠ ${r.warnings.join(', ')}` : ''}`);
}
