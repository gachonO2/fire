/**
 * 기준층 도면 — **건축 도면의 치수를 그대로 옮긴다.**
 *
 * ## 왜 손으로 짓나
 *
 * 도면 판독기(`backend/src/planReader.js`)는 사진을 받아 지점을 뽑는다.
 * 그런데 가진 것은 건축 CAD 도면이라 사진과 성질이 다르다 — 방 이름과
 * 치수가 **글자로 또박또박 적혀 있고** 벽이 선으로 정확히 그려져 있다.
 * 사진에서 되짚어 추정할 필요가 없다. 읽어서 옮겨 적는 편이 더 정확하다.
 *
 * 각 층 피난안내도 **사진**을 찍어 올리면 그때 판독기가 이 자리를 대신한다.
 *
 * ## 도면에서 읽은 값
 *
 *     전체         75,600 × 33,600mm (긴 쐐기꼴)
 *     기둥 간격    X방향 8,400mm × 9칸
 *     강의실       84.00㎡ 표준 (8.4m × 10m)
 *     계단식강의실  168.00 / 166.00㎡ (동쪽 블록 위아래)
 *     계단         28.00㎡ · 휴게공간 62.00㎡ · 스터디 아룸파 120.00㎡
 *
 * **축척이 실측이라 `metersPerUnit` 이 추정값이 아니다.** 대피 거리
 * (「출구까지 23m」)가 진짜 미터가 된다 — 6층은 걸어서 잰 값이었는데
 * 이 층들은 도면이 직접 말해 준다.
 *
 * ## 이 건물의 구조
 *
 *     ┌──────────── 북쪽 강의실 1.01~1.09 (대각선) ────────┬────┐
 *     │  북쪽 복도                                          │ 동 │
 *     │    ░ 오픈 ░   스터디 아룸파   ░ 오픈 ░   [코어]      │ 쪽 │
 *     │  남쪽 복도                                          │ 블 │
 *     │  남쪽 강의실 1.12~1.24 (수평) · 사이에 계단 2곳       │ 록 │
 *     └─────────────────────────────────────────────────────┴────┘
 *
 * 가운데는 **뚫려 있다**(하부 오픈). 두 복도는 양 끝에서만 만난다 —
 * 5층만 예외로 중앙 연결다리가 있고, 그것이 대피 거리를 가른다.
 */

import { writeFileSync } from 'node:fs';

const BASE = process.env.API || 'http://localhost:8080/api';

// ── 실측 치수(m)와 화면 좌표(px)
const M_W = 75.6;
const M_H = 33.6;
/** 1m 를 몇 px 로 그릴 것인가. 20 이면 1512×672 — 6층 도면과 비슷한 크기다. */
const PPM = 20;
const W = Math.round(M_W * PPM);
const H = Math.round(M_H * PPM);
/** 도면 한 칸이 몇 m 인가. **추정이 아니라 도면에서 읽은 값이다.** */
const METERS_PER_UNIT = 1 / PPM;

const m = v => Math.round(v * PPM);

/**
 * 건물 외곽선.
 *
 * 남쪽과 동쪽은 직각, 북쪽은 대각선, 서쪽 끝은 한 번 꺾이며 좁아진다.
 * 도면의 통심선(X1~X10, Y1~Y6)에서 읽었다.
 */
const N_EAST = [M_W, 1.2];      // 대각선 동쪽 끝 (오른쪽 위)
const N_WEST = [9.0, 21.0];     // 대각선 서쪽 끝 (서쪽 계단 위)
const FOOT_M = [
  N_EAST, N_WEST,
  [4.0, 25.6],
  [4.0, M_H], [M_W, M_H],
];
const FOOT = FOOT_M.map(([x, y]) => [m(x), m(y)]);

// ── 북쪽 대각선의 방향과 **안쪽** 법선
const dx = N_WEST[0] - N_EAST[0];
const dy = N_WEST[1] - N_EAST[1];
const len = Math.hypot(dx, dy);
/**
 * 안쪽은 아래(+y). `(-dy, dx)` 는 위를 가리키므로 뒤집는다.
 *
 * 부호를 눈으로 고르면 틀린다 — 실제로 한 번 틀려서 북쪽 강의실이 통째로
 * 건물 밖(y = −69)에 놓였고, 화면에는 방들이 외벽을 뚫고 허공에 걸린 것으로
 * 나왔다. 그래서 여기서 확인하고 넘어간다.
 */
const nx = dy / len;
const ny = -dx / len;
if (N_EAST[1] + ny * 5 <= 0) throw new Error('법선이 건물 밖을 향한다');

/** 대각선 위 비율 t(0=동쪽)에서 안쪽으로 d 미터 들어간 점 (px) */
const onDiag = (t, d) => [
  m(N_EAST[0] + dx * t + nx * d),
  m(N_EAST[1] + dy * t + ny * d),
];

const node = (id, type, name, x, y, extra = {}) => ({ id, type, name, x, y, ...extra });

/**
 * 기준층 하나.
 *
 * @param {number} floor
 * @param {{bridge?: boolean, half?: boolean}} opts
 *   `bridge` 5층의 중앙 연결다리 · `half` 1층은 동쪽 절반만
 */
function standardFloor(floor, opts = {}) {
  const nodes = [];
  const edges = [];
  const rooms = [];
  const link = (a, b) => edges.push({ id: `e${edges.length + 1}`, a, b, wall: null });
  const put = pts => rooms.push(pts.map(([x, y]) => [m(x), m(y)]));

  // 외벽 → 방(10m) → 복도(12.6m) 순서라야 방문이 복도로 난다.
  const D_ROOM = 10.0;
  const D_CORR = 12.6;
  const EAST_X = 62.0;          // 동쪽 블록 왼쪽 벽

  // ── 북쪽 강의실 1.01~1.09 — 대각선 외벽에 붙어 연속
  //
  // 84㎡ = 8.4m(기둥 간격) × 10m(깊이). 도면의 방 아홉 개가 그대로 아홉 칸이다.
  const N_ROOMS = opts.half ? 4 : 9;
  // **동쪽 끝에서 바로 시작하지 않는다.**
  //
  // 대각선의 동쪽 끝은 동쪽 외벽 모서리다. 거기서 안쪽으로 12.6m 들어가면
  // x 가 79.2m 가 되어 건물(75.6m)을 넘는다 — 법선이 +x 성분을 갖기 때문이다.
  // 실제 도면에서도 북쪽 강의실은 동쪽 블록 앞에서 끝난다. 그 자리를 계산해
  // 시작점으로 삼는다.
  const tStart = Math.max(0, (N_EAST[0] + nx * D_CORR - EAST_X) / -dx);
  const tEnd = opts.half ? tStart + 0.32 : 0.96;
  const nCorr = [];
  for (let i = 0; i <= N_ROOMS; i++) {
    const t = tStart + ((tEnd - tStart) * i) / N_ROOMS;
    const [cx, cy] = onDiag(t, D_CORR);
    const id = `N${i}`;
    nodes.push(node(id, 'junction', `북쪽 복도 ${i + 1}`, cx, cy));
    nCorr.push(id);
    if (i > 0) link(nCorr[i - 1], id);
    if (i === N_ROOMS) break;

    const t2 = tStart + ((tEnd - tStart) * (i + 1)) / N_ROOMS;
    const [rx, ry] = onDiag((t + t2) / 2, D_ROOM / 2);
    const name = `${floor}.0${i + 1} 강의실`;
    nodes.push(node(`NR${i}`, 'room', name, rx, ry, { area: 84 }));
    link(id, `NR${i}`);
    // 이웃과 변을 맞댄 사다리꼴 — 떨어뜨리면 «허공에 뜬 상자» 가 된다
    rooms.push([onDiag(t, 0), onDiag(t2, 0), onDiag(t2, D_ROOM), onDiag(t, D_ROOM)]);
  }

  // ── 남쪽 강의실과 계단 — 남쪽 외벽에 붙어 연속
  //
  // 도면대로 **계단이 사이에 끼어 있다.** 강의실만 죽 늘어놓으면 남쪽에서
  // 대피할 길이 양 끝뿐인데, 실제로는 가운데에도 계단이 둘 있다.
  const S_BAND = opts.half
    ? ['room', 'room', 'exit', 'room']
    : ['room', 'room', 'room', 'room', 'room', 'room', 'exit',
      'room', 'room', 'room', 'room', 'room', 'room', 'exit'];
  const sFrom = opts.half ? 34.0 : 5.0;
  const sTo = EAST_X - 0.4;
  const sCorr = [];
  let roomNo = 12;
  let stairNo = 0;
  for (let i = 0; i <= S_BAND.length; i++) {
    const x = sFrom + ((sTo - sFrom) * i) / S_BAND.length;
    const id = `S${i}`;
    nodes.push(node(id, 'junction', `남쪽 복도 ${i + 1}`, m(x), m(M_H - D_CORR)));
    sCorr.push(id);
    if (i > 0) link(sCorr[i - 1], id);
    if (i === S_BAND.length) break;

    const kind = S_BAND[i];
    const x2 = sFrom + ((sTo - sFrom) * (i + 1)) / S_BAND.length;
    const isStair = kind === 'exit';
    const name = isStair ? `남쪽 계단 ${++stairNo}` : `${floor}.${roomNo++} 강의실`;
    nodes.push(node(`SR${i}`, kind, name,
      m((x + x2) / 2), m(M_H - D_ROOM / 2), isStair ? { area: 28 } : { area: 84 }));
    link(id, `SR${i}`);
    put([[x, M_H - D_ROOM], [x2, M_H - D_ROOM], [x2, M_H], [x, M_H]]);
  }

  // ── 동쪽 블록 — 계단식강의실 둘과 강의실 셋.
  //
  // 도면에서 제일 큰 덩어리다. 1.25(168㎡)와 1.29(166㎡)가 위아래를 차지하고
  // 그 사이에 84㎡ 강의실 셋이 들어간다.
  const EAST = [
    ['EL1', `${floor}.25 계단식강의실`, 1.2, 8.0, 168],
    ['ER1', `${floor}.26 강의실`, 8.0, 13.6, 84],
    ['ER2', `${floor}.27 강의실`, 13.6, 19.2, 84],
    ['ER3', `${floor}.28 강의실`, 19.2, 24.8, 84],
    ['EL2', `${floor}.29 계단식강의실`, 24.8, M_H, 166],
  ];
  nodes.push(node('E_HALL', 'junction', '동쪽 홀', m(EAST_X - 2.4), m(17.0)));
  link('E_HALL', nCorr[0]);
  link('E_HALL', sCorr[S_BAND.length]);
  for (const [id, name, y0, y1, area] of EAST) {
    nodes.push(node(id, 'room', name, m((EAST_X + M_W) / 2), m((y0 + y1) / 2), { area }));
    link('E_HALL', id);
    put([[EAST_X, y0], [M_W, y0], [M_W, y1], [EAST_X, y1]]);
  }

  // 코어 — 계단·엘리베이터·화장실. 동쪽 홀 바로 옆이다.
  nodes.push(node('EXIT_E', 'exit', '동쪽 계단', m(EAST_X - 5.6), m(12.0), { area: 28 }));
  nodes.push(node('ELEV', 'elevator', '엘리베이터', m(EAST_X - 5.6), m(16.4)));
  nodes.push(node('WC', 'room', '화장실', m(EAST_X - 5.6), m(21.0), { area: 40 }));
  for (const id of ['EXIT_E', 'ELEV', 'WC']) link('E_HALL', id);
  put([[EAST_X - 8.4, 9.6], [EAST_X, 9.6], [EAST_X, 23.4], [EAST_X - 8.4, 23.4]]);

  // ── 가운데 — 스터디 아룸파(120㎡). 나머지는 하부 오픈이라 방이 아니다.
  if (!opts.half) {
    const mid = Math.round(sCorr.length / 2);
    nodes.push(node('STUDY', 'room', '스터디 아룸파', m(34.0), m(19.0), { area: 120 }));
    link(sCorr[mid], 'STUDY');
    put([[29.0, 15.5], [41.0, 15.5], [41.0, 22.5], [29.0, 22.5]]);
  }

  // ── 서쪽 끝 — 계단(28㎡)과 휴게공간(62㎡)
  if (!opts.half) {
    nodes.push(node('EXIT_W', 'exit', '서쪽 계단', m(7.4), m(23.0), { area: 28 }));
    link('EXIT_W', nCorr[N_ROOMS]);
    link('EXIT_W', sCorr[0]);
    put([[4.6, 20.4], [10.4, 20.4], [10.4, 25.4], [4.6, 25.4]]);

    nodes.push(node('LOUNGE', 'room', '휴게공간', m(8.0), m(28.6), { area: 62 }));
    link('LOUNGE', sCorr[0]);
    put([[4.2, 25.6], [12.0, 25.6], [12.0, M_H - D_ROOM], [4.2, M_H - D_ROOM]]);
  } else {
    // 1층은 서쪽이 지반에 묻혀 있어 서쪽 계단이 없다 — 대피가 동쪽으로만 열린다
    link(nCorr[N_ROOMS], sCorr[0]);
  }

  // ── 5층만 있는 중앙 연결다리.
  //
  // **이 한 줄이 5층과 나머지 층의 대피를 가른다.** 가운데가 뚫려 있어 두
  // 복도는 양 끝에서만 만나는데, 5층만 가운데를 가로지를 수 있다.
  if (opts.bridge) {
    const nm = Math.round(N_ROOMS / 2);
    const sm = Math.round(sCorr.length / 2);
    const a = nodes.find(n => n.id === nCorr[nm]);
    const b = nodes.find(n => n.id === sCorr[sm]);
    nodes.push(node('BRIDGE', 'junction', '중앙 연결다리',
      Math.round((a.x + b.x) / 2), Math.round((a.y + b.y) / 2)));
    link(nCorr[nm], 'BRIDGE');
    link('BRIDGE', sCorr[sm]);
  }

  return { nodes, edges, rooms };
}

/** 옥탑 — 옥상으로 나가는 층. 계단과 기계실뿐이다. */
function penthouse() {
  const nodes = [
    node('PH_HALL', 'junction', '옥탑 복도', m(64.0), m(17.0)),
    node('PH_MACH', 'room', '기계실', m(69.0), m(9.5), { area: 90 }),
    node('EXIT_ROOF', 'exit', '옥상 출구 (운동장 방향)', m(70.0), m(24.0)),
    node('ELEV', 'elevator', '엘리베이터', m(58.0), m(16.4)),
  ];
  const edges = [
    { id: 'e1', a: 'PH_HALL', b: 'PH_MACH', wall: null },
    { id: 'e2', a: 'PH_HALL', b: 'EXIT_ROOF', wall: null },
    { id: 'e3', a: 'PH_HALL', b: 'ELEV', wall: null },
  ];
  return {
    nodes, edges,
    rooms: [[[m(62), m(5)], [m(M_W), m(5)], [m(M_W), m(14)], [m(62), m(14)]]],
  };
}

/**
 * 벽·방·걸을 수 있는 칸.
 *
 * 관제는 세 가지를 따로 받는다 — 지점 그래프(경로용), 벽·방(그림용),
 * 격자(선이 벽을 안 뚫게). 지점만 올리면 화면이 텅 빈 판이 된다.
 */
function shell(nodes, edges, roomPolys) {
  const rooms = [];
  const walls = [];
  const seen = new Set();
  // **같은 벽을 두 번 긋지 않는다.** 방이 서로 변을 맞대므로 네 변을 다
  // 그으면 칸막이가 두 겹이 되고, 세워 놓으면 z-파이팅으로 깜빡인다.
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
      cx: p.reduce((s, q) => s + q[0], 0) / p.length,
      cy: p.reduce((s, q) => s + q[1], 0) / p.length,
    });
  }
  for (let i = 0; i < FOOT.length; i++) push(FOOT[i], FOOT[(i + 1) % FOOT.length]);

  const GW = 240, GH = 108;
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
    // 복도끼리 잇는 통로만 «복도» 로 친다. 방으로 들어가는 목은 걸을 수는
    // 있되 복도가 아니다 — 그래야 경로가 남의 방을 가로지르지 않는다.
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

console.log(`  건물 ${M_W}m × ${M_H}m · 축척 ${METERS_PER_UNIT} m/unit (도면 실측)`);
for (const p of PLANS) {
  const { nodes, edges, rooms: roomPolys = [] } = p.build();
  // 도면 밖으로 나간 지점이 하나라도 있으면 멈춘다 — 화면에서 «벽을 뚫은»
  // 것으로 보이는 그 상태다. 눈으로 찾지 말고 여기서 잡는다.
  const outside = nodes.filter(n => n.x < 0 || n.y < 0 || n.x > W || n.y > H);
  if (outside.length) throw new Error(`${p.name}: 도면 밖 지점 ${outside.map(n => n.id)}`);

  const plan = {
    id: p.id,
    name: p.name,
    metersPerUnit: METERS_PER_UNIT,
    stepLength: 0.7,
    image: { width: W, height: H },
    nodes,
    edges,
  };
  const r = await post('/plans', plan);
  const sh = shell(nodes, edges, roomPolys);
  writeFileSync(new URL(`../backend/data/walls-${p.id}.json`, import.meta.url),
    JSON.stringify(sh));

  const exits = nodes.filter(n => n.type === 'exit').length;
  console.log(`  ${p.name.padEnd(20)} 지점 ${String(nodes.length).padStart(3)}`
    + ` · 통로 ${String(edges.length).padStart(3)} · 출구 ${exits}`
    + ` · 벽 ${String(sh.walls.length).padStart(3)} · 방 ${String(sh.rooms.length).padStart(2)}`
    + `${r.warnings?.length ? `  ⚠ ${r.warnings.join(', ')}` : ''}`);
}
