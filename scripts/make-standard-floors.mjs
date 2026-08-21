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

import { writeFileSync } from 'node:fs';

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
/**
 * 대각선에서 건물 **안쪽**을 향하는 단위 법선.
 *
 * 부호를 한 번 틀려서 북쪽 복도 전체가 건물 밖(y = −69)에 놓였다. 화면에는
 * 방들이 외벽을 뚫고 허공에 걸린 것으로 나왔다.
 *
 * 이 건물의 대각선은 동북쪽(1239,44)에서 서남쪽(43,414)으로 내려가고,
 * **안쪽은 아래(+y)** 다. `(-dy, dx)` 는 위를 가리키므로 뒤집는다.
 * 부호를 눈으로 고르지 말고 아래 `assert` 로 확인한다.
 */
const nx = dy / len;
const ny = -dx / len;
// 안쪽으로 100 들어간 점은 반드시 도면 안(y > 0)이라야 한다
if (N0[1] + ny * 100 <= 0) throw new Error('법선이 건물 밖을 향한다');

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
/**
 * 기준층 하나.
 *
 * ## 도면을 다시 읽고 고친 것
 *
 * 처음에는 지점만 찍고 방을 «지점을 감싸는 사각형» 으로 그렸다. 그랬더니
 * 방들이 서로 떨어져 **허공에 뜬 상자 스무 개**가 됐다. 실제 도면은
 * 그렇지 않다 — 방은 서로 벽을 맞대고 붙어 있고, 바깥쪽은 건물 외벽에
 * 닿아 있다.
 *
 *     ┌────────────────────────────────────┐
 *     │ 북쪽 강의실 (대각선 외벽에 붙어 연속) │
 *     │   북쪽 복도                          │
 *     │        ░ 가운데 보이드 ░      ┌──────┤
 *     │   남쪽 복도                   │ 동쪽 │
 *     │ 남쪽 강의실 (남쪽 외벽에 붙어) │ 블록 │
 *     └───────────────────────────────┴──────┘
 *
 * 동쪽 블록은 계단·엘리베이터·화장실이 모인 곳이다. 도면에서 제일 눈에
 * 띄는 덩어리인데 처음엔 통째로 빠져 있었다.
 */
function standardFloor(floor, opts = {}) {
  const nodes = [];
  const edges = [];
  const link = (a, b, extra = {}) =>
    edges.push({ id: `e${edges.length + 1}`, a, b, wall: null, ...extra });
  /** 방 폴리곤 — 지점과 함께 낸다. 나중에 되짚지 않으려고 여기서 같이 만든다. */
  const rooms = [];

  // 1층은 동쪽 절반만. 서쪽은 지반에 묻혀 있다.
  const tTo = opts.half ? 0.44 : 0.9;
  const SPANS = opts.half ? 5 : 11;
  const xFrom = opts.half ? 690 : 60;
  const xTo = 1140;                       // 동쪽 블록 앞에서 멈춘다

  // 외벽(0) → 방(78) → 복도(112). 복도가 방보다 안쪽이라야 방문이 복도로 난다.
  const D_ROOM = 78;
  const D_CORR = 112;

  // ── 북쪽 — 대각선 외벽에 붙은 연속된 강의실
  const nCorr = [];
  for (let i = 0; i <= SPANS; i++) {
    const t = (tTo * i) / SPANS;
    const [cx, cy] = onDiag(t, D_CORR);
    const id = `N${i}`;
    nodes.push(node(id, 'junction', `북쪽 복도 ${i + 1}`, cx, cy));
    nCorr.push(id);
    if (i > 0) link(nCorr[i - 1], id);
    if (i === SPANS) break;

    const t2 = (tTo * (i + 1)) / SPANS;
    const [rx, ry] = onDiag((t + t2) / 2, D_ROOM / 2 + 6);
    const rid = `NR${i}`;
    nodes.push(node(rid, 'room', `${floor}${String(i + 1).padStart(2, '0')}호`, rx, ry));
    link(id, rid);
    // 대각선을 따라 이웃과 변을 맞댄 사다리꼴
    rooms.push([onDiag(t, 6), onDiag(t2, 6),
      onDiag(t2, D_ROOM + 6), onDiag(t, D_ROOM + 6)]);
  }

  // ── 남쪽 — 남쪽 외벽에 붙은 연속된 강의실
  const S_WALL = 711;
  const sCorr = [];
  for (let i = 0; i <= SPANS; i++) {
    const cx = Math.round(xFrom + (xTo - xFrom) * (i / SPANS));
    const id = `S${i}`;
    nodes.push(node(id, 'junction', `남쪽 복도 ${i + 1}`, cx, S_WALL - D_CORR));
    sCorr.push(id);
    if (i > 0) link(sCorr[i - 1], id);
    if (i === SPANS) break;

    const x2 = Math.round(xFrom + (xTo - xFrom) * ((i + 1) / SPANS));
    const rid = `SR${i}`;
    nodes.push(node(rid, 'room', `${floor}${String(20 + i).padStart(2, '0')}호`,
      Math.round((cx + x2) / 2), S_WALL - D_ROOM / 2 - 6));
    link(id, rid);
    rooms.push([[cx, S_WALL - D_ROOM - 6], [x2, S_WALL - D_ROOM - 6],
      [x2, S_WALL - 6], [cx, S_WALL - 6]]);
  }

  // ── 동쪽 블록 — 계단·엘리베이터·화장실. 도면에서 제일 큰 덩어리다.
  const EX0 = 1160;
  const EX1 = 1340;
  const EAST = [
    ['EAST_STAIR', 'exit', '동쪽 계단', 120, 230],
    ['ELEV', 'elevator', '엘리베이터', 250, 360],
    ['EAST_WC', 'room', '화장실', 380, 500],
    ['EAST_LEC', 'room', '계단식 강의실', 520, 690],
  ];
  const eastHall = 'E_HALL';
  nodes.push(node(eastHall, 'junction', '동쪽 홀', EX0 - 26, 430));
  link(eastHall, nCorr[0]);
  link(eastHall, sCorr[SPANS]);
  for (const [id, type, name, y0, y1] of EAST) {
    nodes.push(node(id, type, name, Math.round((EX0 + EX1) / 2), Math.round((y0 + y1) / 2)));
    link(eastHall, id);
    rooms.push([[EX0, y0], [EX1, y0], [EX1, y1], [EX0, y1]]);
  }

  // ── 서쪽 끝에서 두 복도가 만난다. **가운데는 뚫려 있다.**
  if (!opts.half) {
    nodes.push(node('EXIT_W', 'exit', '서쪽 계단', 96, 470));
    link('EXIT_W', nCorr[SPANS]);
    link('EXIT_W', sCorr[0]);
  }

  // ── 5층만 있는 중앙 연결다리.
  //
  // 이 한 줄이 5층과 나머지 층의 대피를 가른다 — 가운데가 막힌 층은 같은
  // 자리에서 불이 나도 양 끝까지 돌아가야 한다.
  if (opts.bridge) {
    const mid = Math.round(SPANS / 2);
    const a = nodes.find(n => n.id === nCorr[mid]);
    const b = nodes.find(n => n.id === sCorr[mid]);
    nodes.push(node('BRIDGE', 'junction', '중앙 연결다리',
      Math.round((a.x + b.x) / 2), Math.round((a.y + b.y) / 2)));
    link(nCorr[mid], 'BRIDGE');
    link('BRIDGE', sCorr[mid]);
  }

  // 중앙 계단 — 남쪽 복도 한가운데
  if (!opts.half) {
    const mid = Math.round(SPANS / 2);
    const m = nodes.find(n => n.id === sCorr[mid]);
    nodes.push(node('EXIT_M', 'exit', '중앙 계단', m.x, m.y - 44));
    link('EXIT_M', sCorr[mid]);
  }

  return { nodes, edges, rooms };
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

/**
 * 도면에서 **벽과 방과 걸을 수 있는 칸**을 만든다.
 *
 * ## 왜 필요한가
 *
 * 관제는 세 가지를 따로 받는다 — 지점 그래프(경로용), 벽·방(그림용),
 * 걸을 수 있는 격자(선을 벽 안 뚫게). 지점만 올리면 화면이 **텅 빈 판에
 * 감지기만 뜬 모습**이 된다. 6층은 사진에서 뽑아 뒀지만(`extract-walls.py`)
 * 기준층은 사진이 없다.
 *
 * 그런데 우리는 이 층을 **직접 지었으므로** 방이 어디고 복도가 어딘지 이미
 * 안다. 사진에서 되짚을 필요 없이 그대로 내면 된다.
 *
 * ## 방은 지점을 감싸는 사각형
 *
 * 강의실 지점 하나가 방 하나다. 복도 쪽으로 열리는 방향을 알고 있으므로
 * 그 반대편으로 방을 펼친다. 실제 방 크기는 모르지만 — 이건 «사진에서 잰
 * 도면» 이 아니라 «구조를 옮겨 적은 도면» 이고, 관제에 필요한 것은 어느
 * 방이 어디쯤 있나까지다.
 */
function shell(nodes, edges, roomPolys) {
  const rooms = [];
  const walls = [];
  const seen = new Set();
  // **같은 벽을 두 번 긋지 않는다.** 방이 서로 변을 맞대고 있으므로 네 변을
  // 다 그으면 칸막이가 겹쳐 두 겹이 되고, 세워 놓으면 z-파이팅으로 깜빡인다.
  const push = (a, b) => {
    const k = [a, b].map(p => p.map(Math.round).join(',')).sort().join('|');
    if (seen.has(k)) return;
    seen.add(k);
    walls.push({ x1: Math.round(a[0]), y1: Math.round(a[1]),
      x2: Math.round(b[0]), y2: Math.round(b[1]) });
  };

  for (const pts of roomPolys) {
    const p = pts.map(([x, y]) => [Math.round(x), Math.round(y)]);
    let a2 = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      a2 += p[i][0] * q[1] - q[0] * p[i][1];
      push(p[i], q);
    }
    rooms.push({
      points: p, area: Math.abs(a2) / 2,
      cx: p.reduce((s2, q) => s2 + q[0], 0) / p.length,
      cy: p.reduce((s2, q) => s2 + q[1], 0) / p.length,
    });
  }

  // 건물 외곽 — 6층과 같은 건물이므로 같은 외곽선을 쓴다
  const FOOT = [[1351, 0], [1243, 0], [1239, 44], [210, 357], [198, 366],
    [43, 414], [0, 414], [0, 717], [1351, 717]];
  for (let i = 0; i < FOOT.length; i++) push(FOOT[i], FOOT[(i + 1) % FOOT.length]);

  // ── 걸을 수 있는 칸.
  //
  // 통로를 따라 띠를 칠한다. 방은 «걸을 수 있지만 복도는 아님» 으로 두어,
  // 경로가 남의 방을 가로지르지 않게 한다(`shared/walk-grid.js`).
  const GW = 220, GH = 117;
  const sx = W / GW, sy = H / GH;
  const cells = new Uint8Array(GW * GH);
  const corr = new Uint8Array(GW * GH);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const paint = (arr, x, y, r) => {
    const cx = Math.round(x / sx), cy = Math.round(y / sy);
    for (let j = -r; j <= r; j++) {
      for (let i = -r; i <= r; i++) {
        const gx = cx + i, gy = cy + j;
        if (gx >= 0 && gx < GW && gy >= 0 && gy < GH) arr[gy * GW + gx] = 1;
      }
    }
  };
  for (const e of edges) {
    const a = byId.get(e.a), b = byId.get(e.b);
    if (!a || !b) continue;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4);
    const isCorr = a.type !== 'room' && b.type !== 'room';
    for (let i = 0; i <= steps; i++) {
      const x = a.x + (b.x - a.x) * (i / steps);
      const y = a.y + (b.y - a.y) * (i / steps);
      paint(cells, x, y, 2);
      if (isCorr) paint(corr, x, y, 2);
    }
  }
  for (const r of rooms) paint(cells, r.cx, r.cy, 5);

  const str = a => Array.from(a, v => (v ? '1' : '0')).join('');
  return {
    width: W, height: H, walls, rooms, footprint: FOOT,
    grid: { w: GW, h: GH, cells: str(cells), corridor: str(corr), marked: str(corr) },
  };
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
  const { nodes, edges, rooms: roomPolys = [] } = p.build();
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

  // 벽·방·격자를 파일로 낸다. 관제가 `/api/plans/:id/walls` 로 읽는 그 파일이다.
  const sh = shell(nodes, edges, roomPolys);
  writeFileSync(new URL(`../backend/data/walls-${p.id}.json`, import.meta.url),
    JSON.stringify(sh));

  const exits = nodes.filter(n => n.type === 'exit').length;
  console.log(`  ${p.name.padEnd(20)} 지점 ${String(nodes.length).padStart(3)}`
    + ` · 통로 ${String(edges.length).padStart(3)} · 출구 ${exits}`
    + ` · 벽 ${String(sh.walls.length).padStart(3)} · 방 ${String(sh.rooms.length).padStart(2)}`
    + `${r.warnings?.length ? `  ⚠ ${r.warnings.join(', ')}` : ''}`);
}
