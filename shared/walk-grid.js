/**
 * 걸을 수 있는 칸 위에서 **길을 찾는다.**
 *
 * ## 왜 필요한가
 *
 * 두 지점을 곧게 잇거나 ㄱ자로 꺾는 것으로는 벽을 못 피한다. ㄱ자는 두 가지를
 * 시도할 뿐이라 둘 다 막히면 방법이 없다 — 이 도면에서 45개 통로 중 9개만
 * 나아졌다. 나머지는 그대로 벽을 지났고, 그림에서 «길이 벽을 뚫는» 것으로
 * 보였다.
 *
 * 사람은 복도를 따라 돈다. 그러니 **어디를 밟을 수 있나**를 먼저 정하고 그
 * 위에서 길을 찾아야 한다. `scripts/extract-walls.py` 가 도면 사진에서 그
 * 격자를 만든다 — 건물 안이고 벽 위가 아니면 밟을 수 있다.
 *
 * NORTH STREET·SOUTH STREET 같은 복도는 도면에서 **빈 칸의 띠**다. 그래서
 * 글자를 읽지 않아도 길이 저절로 그리로 흐른다.
 *
 * ## 대각선을 허용하되 모서리는 자르지 않는다
 *
 * 대각선을 막으면 길이 계단처럼 각져서 실제 걸음과 안 맞는다. 반대로 아무
 * 대각선이나 허용하면 **벽 모서리를 스치듯 지나간다** — 격자에서는 통과지만
 * 현실에서는 벽이다.
 *
 * 그래서 **양옆 중 하나는 열려 있어야** 한다. 둘 다 요구했더니 이 도면의
 * NORTH STREET(대각선 복도)가 통째로 막혔다 — 대각선으로만 갈 수 있고 양옆은
 * 벽인 복도다. 하나만 요구하면 그런 복도는 지나가고, 두 벽이 X 로 만나는
 * 꼭짓점은 여전히 못 지난다.
 */

/** 격자 문자열(`"0101…"`)을 다루는 얇은 껍데기 */
export class WalkGrid {
  /** @param {{w:number,h:number,cells:string}} grid @param {{width:number,height:number}} size */
  constructor(grid, size) {
    this.w = grid?.w ?? 0;
    this.h = grid?.h ?? 0;
    this.cells = grid?.cells ?? '';
    /** 복도만 표시한 칸. 방에서 «문으로 나가는» 한 걸음을 위해 따로 든다. */
    this.corr = grid?.corridor ?? '';
    /** 도면이 초록 화살표로 그려 둔 길. 여기를 훨씬 싸게 지나간다. */
    this.marked = grid?.marked ?? '';
    this.sx = this.w ? (size?.width || this.w) / this.w : 1;
    this.sy = this.h ? (size?.height || this.h) / this.h : 1;
  }

  get ok() { return this.w > 0 && this.h > 0 && this.cells.length === this.w * this.h; }

  open(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    return this.cells.charCodeAt(cy * this.w + cx) === 49;   // '1'
  }

  /** 복도인가 — 방 안이 아니면서 걸을 수 있는 칸 */
  corridor(cx, cy) {
    if (!this.corr) return this.open(cx, cy);
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    return this.corr.charCodeAt(cy * this.w + cx) === 49;
  }

  /** 도면이 그린 길 위인가 */
  onRoute(cx, cy) {
    if (!this.marked) return false;
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    return this.marked.charCodeAt(cy * this.w + cx) === 49;
  }

  /** 가장 가까운 **복도** 칸. 방에서 나오는 문이 여기 있다고 본다. */
  nearestCorridor(cx, cy, max = 40) {
    if (this.corridor(cx, cy)) return [cx, cy];
    for (let r = 1; r <= max; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.corridor(cx + dx, cy + dy)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }

  toCell(x, y) {
    return [Math.max(0, Math.min(this.w - 1, Math.round(x / this.sx))),
      Math.max(0, Math.min(this.h - 1, Math.round(y / this.sy)))];
  }

  toXY(cx, cy) { return [(cx + 0.5) * this.sx, (cy + 0.5) * this.sy]; }

  /**
   * 막힌 칸에 떨어진 지점을 가까운 열린 칸으로 옮긴다.
   *
   * 지점 좌표는 언어모델이 눈대중으로 찍은 값이라 벽 위에 놓이는 일이 흔하다.
   * 그대로 길찾기를 시작하면 «출발점이 벽 안» 이라 아무 길도 못 찾는다.
   */
  nearestOpen(cx, cy, max = 12) {
    if (this.open(cx, cy)) return [cx, cy];
    for (let r = 1; r <= max; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.open(cx + dx, cy + dy)) return [cx + dx, cy + dy];
        }
      }
    }
    return null;
  }
}

/**
 * 두 좌표 사이의 길. 못 찾으면 `null` — **곧은 선으로 대신하지 않는다.**
 * 대신 그리면 벽을 뚫는 그림이 다시 나오고, 그건 없는 길을 있다고 말하는 것이다.
 *
 * @returns {Array<[number,number]>|null} 도면 좌표들
 */
export function findPath(grid, from, to, { maxNodes = 120000, offRoute = OFF_ROUTE_COST } = {}) {
  if (!grid?.ok) return null;

  // **방에서는 문으로 한 번 나간다.**
  //
  // 이 도면에는 문이 안 그려져 있다 — 방이 완전히 닫힌 사각형이라 격자만으로는
  // 방에서 복도로 나갈 틈이 없다(45개 중 35개가 길찾기 실패였다).
  //
  // 그래서 방 안 지점은 **가장 가까운 복도 칸까지 곧게 한 걸음** 두고, 그
  // 다음부터 복도를 따라 푼다. 그 한 걸음이 곧 문이다. 실제 문 위치는
  // 모르지만 «제일 가까운 복도로 나온다» 는 가정은 거의 맞고, 무엇보다
  // 벽을 가로질러 방과 방을 잇는 것보다 훨씬 낫다.
  const s = grid.nearestCorridor(...grid.toCell(from.x, from.y))
    ?? grid.nearestOpen(...grid.toCell(from.x, from.y));
  const g = grid.nearestCorridor(...grid.toCell(to.x, to.y))
    ?? grid.nearestOpen(...grid.toCell(to.x, to.y));
  if (!s || !g) return null;

  const W = grid.w;
  const idx = (x, y) => y * W + x;
  const start = idx(s[0], s[1]);
  const goal = idx(g[0], g[1]);
  // 시작·끝의 «문 한 걸음» 을 앞뒤에 붙인다
  const lead = [[from.x, from.y]];
  const tail = [[to.x, to.y]];
  if (start === goal) return [...lead, grid.toXY(...s), ...tail];

  const came = new Map();
  const gScore = new Map([[start, 0]]);
  // 작은 격자라 이진 힙 없이 배열로 충분하다 — 220×117 에서 최악도 수 ms 다
  const openSet = [[heur(s, g), start]];
  let seen = 0;

  while (openSet.length) {
    let best = 0;
    for (let i = 1; i < openSet.length; i++) if (openSet[i][0] < openSet[best][0]) best = i;
    const [, cur] = openSet.splice(best, 1)[0];
    if (cur === goal) return [...lead, ...rebuild(came, cur, grid, W), ...tail];
    // 한도를 넘으면 포기한다. 비용을 매기면 A* 가 훨씬 넓게 살피므로
    // 예전 한도(20000)로는 먼 구간이 통째로 실패했다 — 격자가 25740칸이라
    // 한 번쯤 다 훑을 여유는 줘야 한다.
    if (++seen > maxNodes) return null;

    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      // 복도만 밟는다. 방을 가로지르면 «남의 방을 통과하는 길» 이 나온다.
      if (!grid.corridor(nx, ny)) continue;
      // **대각선을 막지 않는다.**
      //
      // 처음에는 «양옆이 둘 다 열려야» 로 두었다(모서리 스치기 방지). 그런데
      // 이 도면의 NORTH STREET 는 격자에서 **대각선 한 칸 폭**이라 매 걸음
      // 양옆이 벽이다. 그 규칙이 그 복도를 통째로 막아, 출발 칸에서 한 발도
      // 못 나가고 8개 구간이 길을 못 찾았다(«훑은 칸 1개»).
      //
      // 벽은 이미 부풀려 두었으므로(격자를 만들 때 3px 팽창) 대각선이 진짜
      // 벽을 뚫을 여지는 작다. 막아서 복도를 잃는 것보다, 열어 두고 **벽을
      // 지나는 수를 재서** 판단하는 편이 낫다.
      // **도면이 그린 길을 훨씬 싸게 지나간다.**
      //
      // 값을 안 매겼더니 «벽도 방도 아닌 곳» 이면 어디든 같은 값이라, 바깥
      // 벽과 방 사이의 얇은 틈이 지름길이면 그리로 갔다 — 화면에서는 건물
      // 바깥으로 도는 길, 창문으로 나가는 꼴이었다.
      //
      // 초록이 그려진 칸은 1, 아닌 칸은 6. 여섯 배면 «조금 돌더라도 복도로»
      // 가 되고, 초록이 안 그려진 구간(방 앞 짧은 목)은 여전히 지나갈 수 있다.
      const base = grid.onRoute(nx, ny) ? 1 : offRoute;
      const step = (dx && dy ? 1.41421 : 1) * base;
      const ni = idx(nx, ny);
      const tentative = gScore.get(cur) + step;
      if (tentative < (gScore.get(ni) ?? Infinity)) {
        came.set(ni, cur);
        gScore.set(ni, tentative);
        openSet.push([tentative + heur([nx, ny], g), ni]);
      }
    }
  }
  return null;
}

/** 도면이 그린 길 밖으로 나갈 때의 벌점. 클수록 초록 화살표에 붙는다. */
export const OFF_ROUTE_COST = 6;

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const heur = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function rebuild(came, cur, grid, W) {
  const cells = [cur];
  while (came.has(cur)) { cur = came.get(cur); cells.push(cur); }
  cells.reverse();
  // 같은 방향으로 이어지는 칸은 하나로 접는다 — 점 수백 개를 그리면 느리고,
  // 무엇보다 «어디서 꺾는가» 가 안 보인다.
  const pts = cells.map(i => { const x = i % W; return grid.toXY(x, (i - x) / W); });
  return simplify(pts);
}

/** 거의 일직선인 점을 뺀다 (Ramer–Douglas–Peucker 의 값싼 판) */
function simplify(pts, tol = 1.2) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = out[out.length - 1];
    const [bx, by] = pts[i];
    const [cx, cy] = pts[i + 1];
    const cross = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
    const len = Math.hypot(cx - ax, cy - ay) || 1;
    if (cross / len > tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
