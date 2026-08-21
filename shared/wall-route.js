/**
 * 벽을 피해 가는 길 — **격자 위에서 찾는다.**
 *
 * ## 왜 꺾는 것만으로는 안 되나
 *
 * 두 지점을 직각으로 꺾어 잇는 방법은 두 가지뿐이다(가로 먼저 / 세로 먼저).
 * 둘 다 벽에 막히면 방법이 없다. 실제로 이 도면의 대피 경로 12개로 재보니
 * 곧게 이었을 때와 꺾었을 때가 **똑같이 12회** 벽을 지났다. 꺾는 것은 모양만
 * 바꿀 뿐 길을 바꾸지 못한다.
 *
 * 길을 바꾸려면 **지날 수 있는 곳과 없는 곳을 알고 찾아야** 한다. 그래서 도면을
 * 격자로 잘라 벽이 지나는 칸을 표시하고, 그 위에서 길을 찾는다. 상하좌우로만
 * 움직이므로 나오는 길은 저절로 직각으로 꺾인다.
 *
 * ## 벽을 넘을 수 없게 하면 방이 막힌다
 *
 * 이 도면의 벽에는 **문이 없다.** 벽을 통짜 선분으로 읽어 놨기 때문에 방은
 * 사방이 막힌 상자다. 벽을 완전히 막아 버리면 방에서 나오는 길이 아예 없어서
 * 길찾기가 실패한다 — 그리고 실패하면 안내가 통째로 멈춘다.
 *
 * 그래서 벽을 **못 넘게 하지 않고 비싸게** 만든다.
 *
 *     비용 = 걸은 거리 + 벽을 넘은 횟수 × 벌점
 *
 * 벽을 안 넘고 갈 수 있으면 그 길이 싸므로 그쪽으로 간다. 방처럼 넘을 수밖에
 * 없으면 **가장 싼 곳 한 번만** 넘는데, 그 자리가 대체로 실제 문이 있는 쪽이다
 * (목적지에서 가장 가까운 벽면이기 때문이다). 문 위치를 모르면서도 문에 가까운
 * 답이 나오는 셈이다.
 *
 * 벌점을 무한대로 두지 않는 이유가 이것이다. **못 찾는 것보다 한 번 넘는 것이
 * 낫다** — 대피 중에 «경로 없음» 은 아무 도움도 안 된다.
 *
 * ## 경로에만 쓴다
 *
 * 배경 통로 45개까지 이 길찾기를 돌리면 화면을 그릴 때마다 45번 찾아야 한다.
 * 배경은 상황을 보여주는 그림이라 싼 방법(`orthogonal.js` 의 꺾기)으로 충분하고,
 * **사람이 따라가는 경로만** 여기서 찾는다. 경로는 서너 구간뿐이라 한 번 찾아
 * 두면 끝이다.
 */

import { routeWaypoints, wallHits } from './orthogonal.js';

export const WALL_ROUTE_DEFAULTS = {
  /** 격자 한 칸의 크기. 작을수록 정밀하지만 칸 수가 제곱으로 는다 */
  cell: 6,
  /**
   * 벽 한 장을 넘는 값. 격자 칸 수로 센다.
   *
   * 뜻은 이렇다 — **한 장을 피하려고 이 거리까지는 돌아간다.** 칸이 6px 이고
   * 이 도면 축척이 1px = 0.107m 이므로 20칸이면 약 13m 다.
   *
   * 값을 훑어보고 정했다(대피 경로 37개):
   *
   *     벌점   벽 뚫음   거리 배수   최대 배수
   *       10      51       1.23       1.44
   *       20      46       1.26       1.61   ← 이것
   *       40      39       1.33       2.61
   *       80      35       1.38       2.61
   *
   * 40부터 «방을 빙 도는» 길이 나온다. DR.CHON 에서 출구까지가 7m 인데 방 벽을
   * 피하느라 18m 를 돌았다. 그런데 그 벽은 **십중팔구 문이다** — 우리 벽 데이터에
   * 문이 없을 뿐이다. 대피 중에 2.6배를 돌게 하는 것이 벽 하나 덜 지나는 것보다
   * 훨씬 나쁘다.
   *
   * 그래서 «가까우면 피하고 멀면 문으로 나간다» 가 되는 20을 쓴다.
   */
  wallPenalty: 20,
  /**
   * 한 번 꺾는 값. 격자 칸 수로 센다.
   *
   * 이게 없으면 길이 **계단 모양**으로 나온다. 상하좌우로만 움직이는 격자에서
   * 비스듬한 방향으로 가는 길은 «오른쪽-아래-오른쪽-아래…» 가 최단이고, A* 는
   * 같은 값이면 아무거나 고르기 때문이다. 실제로 재보니 경로 하나에 다리가
   * 평균 30개 나왔다 — 그대로 안내하면 «1미터 직진» 을 서른 번 말하게 된다.
   *
   * 꺾는 데 값을 매기면 곧게 가는 쪽이 싸져서 계단이 접힌다. 거리가 조금 늘지만
   * 사람이 실제로 걷는 모양(복도를 쭉 가다가 한 번 꺾는다)에 가까워진다.
   */
  turnPenalty: 8,
  /** 이보다 칸이 많아지면 포기하고 꺾기로 돌아간다 (폰에서 멈추면 안 된다) */
  maxCells: 200000,
};

/**
 * 벽을 피해 a 에서 b 로 가는 직각 폴리라인.
 *
 * @param {{x,y}} a 출발
 * @param {{x,y}} b 도착
 * @param {{walls, cell?, wallPenalty?, maxCells?}} opts
 * @returns {Array<{x,y}>|null} 꼭짓점들. 못 찾으면 null (부르는 쪽이 꺾기로 돌아간다)
 */
export function routeThroughWalls(a, b, opts = {}) {
  const o = { ...WALL_ROUTE_DEFAULTS, ...opts };
  const walls = o.walls || [];
  if (!a || !b || !walls.length) return null;

  // 두 점과 벽을 모두 담는 상자. 벽을 피해 «돌아가는» 여유를 조금 둔다.
  const pad = o.cell * 8;
  let minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
  let minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  for (const w of walls) {
    minX = Math.min(minX, w.x1, w.x2); maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2); maxY = Math.max(maxY, w.y1, w.y2);
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const cols = Math.ceil((maxX - minX) / o.cell);
  const rows = Math.ceil((maxY - minY) / o.cell);
  if (cols <= 0 || rows <= 0) return null;
  if (cols * rows > o.maxCells) return null;   // 폰에서 멈추느니 꺾기로 간다

  // 벽이 지나는 칸을 표시한다
  const blocked = new Uint8Array(cols * rows);
  const cx = x => Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / o.cell)));
  const cy = y => Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / o.cell)));
  for (const w of walls) markSegment(blocked, cols, rows, cx(w.x1), cy(w.y1), cx(w.x2), cy(w.y2));

  const sx = cx(a.x), sy = cy(a.y);
  const tx = cx(b.x), ty = cy(b.y);
  const start = sy * cols + sx;
  const goal = ty * cols + tx;
  if (start === goal) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];

  // ── A* — 상하좌우로만 움직이므로 나오는 길이 저절로 직각이다.
  //
  // 칸만이 아니라 **어느 방향으로 들어왔는지**까지 상태로 둔다. 그래야 «꺾었다»
  // 를 알고 값을 매길 수 있고, 계단 모양이 접힌다. 상태 수가 네 배가 되지만
  // 이 크기(수만 칸)에서는 문제되지 않는다 — 재보니 전체 37경로에 39ms 였다.
  const n = cols * rows;
  const S = n * 4;                       // 칸 × 들어온 방향
  const cost = new Float64Array(S).fill(Infinity);
  const from = new Int32Array(S).fill(-1);
  const done = new Uint8Array(S);

  const h = i => Math.abs((i % cols) - tx) + Math.abs(Math.floor(i / cols) - ty);
  const open = new MinHeap();
  // 출발은 방향이 없다 — 네 방향 어느 쪽으로 나가든 꺾은 것이 아니다
  for (let d = 0; d < 4; d++) { cost[start * 4 + d] = 0; open.push(start * 4 + d, h(start)); }

  let goalState = -1;
  while (open.size) {
    const cur = open.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    const cell = cur >> 2;
    const dir = cur & 3;
    if (cell === goal) { goalState = cur; break; }

    const ccol = cell % cols;
    const crow = (cell - ccol) / cols;
    for (let nd = 0; nd < 4; nd++) {
      const [dx, dy] = STEPS[nd];
      const ncol = ccol + dx, nrow = crow + dy;
      if (ncol < 0 || ncol >= cols || nrow < 0 || nrow >= rows) continue;
      const ncell = nrow * cols + ncol;
      const nx = ncell * 4 + nd;
      if (done[nx]) continue;
      // 벽이 있는 칸으로 **들어갈 때** 벌점을 문다. 못 들어가게 하지는 않는다 —
      // 문이 없는 도면에서 막으면 방에 갇혀 길찾기가 통째로 실패한다.
      const turned = cost[cell * 4 + dir] === 0 && cell === start ? 0 : (nd === dir ? 0 : o.turnPenalty);
      const g = cost[cur] + 1 + (blocked[ncell] ? o.wallPenalty : 0) + turned;
      if (g < cost[nx]) {
        cost[nx] = g;
        from[nx] = cur;
        open.push(nx, g + h(ncell));
      }
    }
  }

  if (goalState < 0) return null;

  // 상태를 되짚어 칸으로, 칸을 좌표로
  const cells = [];
  for (let i = goalState; i !== -1; i = from[i]) cells.push(i >> 2);
  cells.reverse();

  const pts = cells.map(i => ({
    x: minX + ((i % cols) + 0.5) * o.cell,
    y: minY + (Math.floor(i / cols) + 0.5) * o.cell,
  }));

  // 실제 시작·끝은 격자 가운데가 아니라 지점 좌표다
  pts[0] = { x: a.x, y: a.y };
  pts[pts.length - 1] = { x: b.x, y: b.y };

  // 정리하다 직각이 깨지면 null 을 낸다 — 부르는 쪽이 꺾기로 돌아간다.
  // 어긋난 길을 내놓느니 덜 좋은 길이 낫다.
  return tidy(simplify(pts));
}

/** 상하좌우 — 대각선을 빼면 나오는 길이 저절로 직각이 된다 */
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 선분이 지나는 칸을 표시 (Bresenham) */
function markSegment(grid, cols, rows, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (x0 >= 0 && x0 < cols && y0 >= 0 && y0 < rows) grid[y0 * cols + x0] = 1;
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

/**
 * 한 줄로 이어지는 칸들을 하나의 토막으로 줄인다.
 *
 * 격자를 그대로 두면 꼭짓점이 수백 개다. 안내 계층은 꼭짓점마다 «구간» 을 만들어
 * 걸음을 세므로, 줄이지 않으면 «1미터 직진» 을 수백 번 말하게 된다.
 */
function simplify(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1], c = pts[i], nx = pts[i + 1];
    const turn = Math.sign(c.x - p.x) !== Math.sign(nx.x - c.x)
      || Math.sign(c.y - p.y) !== Math.sign(nx.y - c.y);
    if (turn) out.push(c);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * 경로를 **걸어갈 지점 목록**으로 편다 — 벽을 피해서.
 *
 * 부르는 쪽이 «길찾기» 와 «꺾기» 를 따로 알 필요가 없게 하나로 묶어 둔다.
 * 안내하는 쪽(`RouteFollower`)과 그리는 쪽(지도)이 **이 함수 하나**를 쓰므로
 * 둘이 갈라질 수 없다. 예전에 지도만 꺾고 안내는 곧게 가서 최대 89° 어긋난 적이
 * 있는데, 같은 함수를 부르면 그런 일이 생기지 않는다.
 */
export function planRoute(nodes = [], opts = {}) {
  return routeWaypoints(nodes, { ...opts, findPath: routeThroughWalls });
}

/**
 * 끝의 삐침을 없앤다.
 *
 * 격자에서 찾은 길은 칸 **가운데**를 잇는다. 그런데 실제 출발·도착은 지점 좌표라
 * 칸 가운데와 어긋나고, 그 차이가 «0.6미터를 345도 방향으로» 같은 짧고 비스듬한
 * 토막으로 남는다. 안내로 읽으면 잡음이고, 무엇보다 **직각이라는 성질이 깨진다.**
 *
 * 두 번째 점을 출발점 쪽으로 당겨 붙이면 사라진다. 다음 토막이 가로면 x 를,
 * 세로면 y 를 맞춘다 — 꺾이는 자리만 조금 옮길 뿐 길은 그대로다.
 */
function tidy(pts) {
  if (pts.length < 2) return pts;

  // 두 점뿐이면 맞출 이웃이 없다. 비스듬하면 직각으로 한 번 꺾어 준다.
  if (pts.length === 2) {
    if (Math.abs(pts[0].x - pts[1].x) < 1e-9 || Math.abs(pts[0].y - pts[1].y) < 1e-9) return pts;
    return [pts[0], { x: pts[1].x, y: pts[0].y }, pts[1]];
  }

  const out = pts.map(p => ({ ...p }));

  // 꼭짓점이 하나뿐이면 앞뒤 규칙이 **같은 점을 서로 당긴다.** 그러면 둘 중
  // 하나만 맞고 나머지 토막이 비스듬해진다. 이때는 꺾이는 자리 두 곳 중
  // 원래 자리에 가까운 쪽을 고른다.
  if (out.length === 3) {
    const a = out[0], b = out[2];
    const c1 = { x: b.x, y: a.y };
    const c2 = { x: a.x, y: b.y };
    const d1 = Math.hypot(out[1].x - c1.x, out[1].y - c1.y);
    const d2 = Math.hypot(out[1].x - c2.x, out[1].y - c2.y);
    out[1] = { ...out[1], ...(d1 <= d2 ? c1 : c2) };
    return out;
  }

  // 앞쪽: 두 번째 점을 첫 점에 맞춘다 (다음 토막이 가로면 x, 세로면 y)
  if (Math.abs(out[2].y - out[1].y) < 1e-9) out[1].x = out[0].x;
  else out[1].y = out[0].y;

  // 뒤쪽: 끝에서 두 번째 점을 마지막 점에 맞춘다
  const n = out.length;
  if (Math.abs(out[n - 3].y - out[n - 2].y) < 1e-9) out[n - 2].x = out[n - 1].x;
  else out[n - 2].y = out[n - 1].y;

  const packed = simplify(out).filter((p, i, arr) =>
    i === 0 || i === arr.length - 1 || !same(p, arr[i - 1]));

  // 그래도 비스듬한 토막이 남았으면 **직각이라는 성질을 지키는 쪽**을 택한다.
  // 이 계층의 약속이 «전부 직각» 이고, 약속이 깨진 값을 내보내면 안내가
  // «몇 도 방향» 을 엉뚱하게 말하게 된다. 부르는 쪽은 꺾기로 돌아간다.
  for (let i = 0; i < packed.length - 1; i++) {
    const dx = Math.abs(packed[i + 1].x - packed[i].x);
    const dy = Math.abs(packed[i + 1].y - packed[i].y);
    if (dx > 1e-6 && dy > 1e-6) return null;
  }
  return packed;
}

function same(a, b) {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
}

/**
 * **안내용**으로 지점을 추린다 — 그림은 건드리지 않는다.
 *
 * 격자에서 찾은 길을 구간마다 이어 붙이면 이음매에 «0.2미터» 짜리 토막이 남는다.
 * 칸 가운데와 지점 좌표가 어긋나서 생기는 삐침이다. 화면에서는 안 보이지만
 * **안내로 읽으면 치명적이다** — 「0.2미터 직진」, 「오른쪽으로 도세요」, 「0.3미터
 * 직진」 을 듣고 걸을 수 있는 사람은 없다.
 *
 * 그렇다고 점을 옮겨서 지우면 **직각이 깨진다.** 짧은 토막을 접으려면 그 뒤의
 * 토막 전체를 밀어야 하는데, 그러면 도면에 있는 지점까지 움직인다. 실제로
 * 그렇게 만들었다가 (0,0)→(102,2) 같은 비스듬한 토막이 나왔다.
 *
 * 그래서 **그림은 격자가 준 그대로 두고, 안내만 굵게 본다.** 짧은 토막은 앞의
 * 토막에 흡수되어 «8.2미터 직진» 한 마디가 된다. 길은 같고 말하는 단위만 다르다.
 *
 * 도면에 있는 지점(`id` 가 있는 것)은 짧아도 남긴다 — 안내가 «SOUTH STREET
 * 교차점을 지납니다» 라고 부르는 자리이기 때문이다.
 */
export function pruneForGuidance(pts = [], minLeg = WALL_ROUTE_DEFAULTS.cell * 1.5) {
  if (pts.length < 3) return pts;
  const d = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

  // 반드시 남기는 자리 — 출발, 도착, 그리고 도면에 있는 지점.
  // 도면에 있는 지점은 안내가 이름으로 부르는 자리라 사라지면 «어디를 지나는지»
  // 를 말할 수 없다.
  const keep = pts.map((p, i) => i === 0 || i === pts.length - 1 || Boolean(p.id));

  // 꺾임점은 **앞뒤 모두와 충분히 떨어져 있을 때만** 남긴다.
  //
  // 앞만 보고 판단하면 이름 있는 지점 바로 앞의 꺾임점이 살아남아, 「…직진」
  // 「오른쪽으로」 「0.2미터 직진」 이 된다. 실제로 그 값이 나왔다.
  let last = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (keep[i]) { last = i; continue; }
    let next = pts.length - 1;
    for (let j = i + 1; j < pts.length; j++) if (keep[j]) { next = j; break; }
    if (d(pts[last], pts[i]) >= minLeg && d(pts[i], pts[next]) >= minLeg) {
      keep[i] = true;
      last = i;
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** 이 길이 벽을 몇 번 지나는가 — 부르는 쪽이 «꺾기보다 나은가» 를 볼 때 쓴다 */
export function routeWallHits(points, walls) {
  return wallHits(points, walls);
}

/** 아주 작은 최소 힙. 격자 A* 에 배열 정렬을 쓰면 칸 수가 늘 때 느려진다. */
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.v[p] <= this.v[i]) break;
      this._swap(p, i); i = p;
    }
  }
  pop() {
    const top = this.k[0];
    const lastK = this.k.pop(), lastV = this.v.pop();
    if (this.k.length) {
      this.k[0] = lastK; this.v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.v.length && this.v[l] < this.v[m]) m = l;
        if (r < this.v.length && this.v[r] < this.v[m]) m = r;
        if (m === i) break;
        this._swap(m, i); i = m;
      }
    }
    return top;
  }
  _swap(a, b) {
    const k = this.k[a]; this.k[a] = this.k[b]; this.k[b] = k;
    const v = this.v[a]; this.v[a] = this.v[b]; this.v[b] = v;
  }
}
