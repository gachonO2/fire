/**
 * 통로를 **직각으로 꺾이는 직선**으로 그린다.
 *
 * ## 왜 필요한가
 *
 * 지점 사이를 곧은 선으로 이으면 **벽을 뚫고 지나간다.** 지점 좌표는 도면 사진을
 * AI 가 읽어 찍은 근사값이라 격자에 안 맞는다 — 이 도면은 통로 45개 중 축에
 * 붙은 것이 15개뿐이고 22개가 15° 넘게 기울어 있다. 그 상태로 곧게 이으면
 * 선이 벽을 가로지른다.
 *
 * 대피 경로가 화면에서 벽을 뚫고 가면, 보는 사람은 그 안내를 믿지 않는다.
 * 발표에서 심사위원이 제일 먼저 볼 것도 그것이다.
 *
 * ## 무엇을 하나
 *
 * 실제 건물의 복도는 직각으로 만난다. 그래서 두 지점을 잇는 선을 **가로와 세로
 * 두 토막**으로 나눈다.
 *
 *     지금        고친 뒤
 *      A                A
 *       ＼               │
 *        ＼              │
 *         B              └──B
 *     (벽을 가로지름)   (복도를 따라감)
 *
 * **긴 축을 먼저 간다.** 복도를 쭉 따라가다가 방 앞에서 꺾는 모양이 되기 때문이다.
 * 반대로 하면 방 안쪽을 먼저 가로지르는 꼴이 된다.
 *
 * ## 이것이 하지 않는 일
 *
 * 벽 위치를 모르므로 **벽을 피한다고 보장하지 않는다.** 직각으로 꺾는 것이
 * 대각선보다 복도를 따를 확률이 높을 뿐이다. 진짜로 보장하려면 도면에서 벽을
 * 읽어내야 하고, 그건 별개의 일이다.
 *
 * 그리고 이것은 **그리는 방법일 뿐 경로 계산이 아니다.** 거리·걸음 수는 여전히
 * 지점 사이의 곧은 거리로 잰다. 그리는 길이와 걷는 길이를 다르게 두는 것이
 * 이상해 보일 수 있지만, 걸음 수는 실제로 사람이 걷는 거리에 맞춰 보정된
 * 값이고(현장 측정) 여기서 바꾸면 그 보정이 어긋난다.
 *
 * ## 앱과 관제가 같은 것을 쓴다
 *
 * 두 곳에서 따로 그리면 갈라진다. 실제로 관제 지도와 앱 지도가 같은 통로를
 * 다르게 그리고 있었다. 기하는 여기 한 곳에 둔다.
 */

/**
 * 두 선분이 만나는가. 벽을 뚫는지 볼 때 쓴다.
 *
 * 끝점만 스치는 경우(문틀에 닿는 것)는 교차로 세지 않는다 — 지점이 벽에 붙어
 * 있으면 어떻게 그려도 «스침» 이 나와서, 그걸 세면 판단이 무의미해진다.
 */
export function crosses(p1, p2, p3, p4) {
  const d = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d1 = d(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
  const d2 = d(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);
  const d3 = d(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  const d4 = d(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  // 부호가 서로 다를 때만 «가로지른다». 0(닿음)은 세지 않는다.
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
      && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 이 폴리라인이 벽을 몇 번 뚫는가 */
export function wallHits(points, walls = []) {
  if (!walls.length) return 0;
  let n = 0;
  for (let i = 0; i < points.length - 1; i++) {
    for (const w of walls) {
      if (crosses(points[i], points[i + 1], { x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 })) n++;
    }
  }
  return n;
}

/**
 * 두 점을 잇는 **직각 폴리라인**의 꼭짓점들.
 *
 * 꺾이는 방향은 두 가지다 — 가로 먼저 가거나 세로 먼저 가거나. **벽을 주면
 * 둘 중 덜 뚫는 쪽을 고른다.** 벽이 없으면 긴 축을 먼저 가는 쪽으로 둔다.
 *
 * 벽을 세어 고르는 것이 추측보다 낫다: 이 도면에는 서버에 벽 62개가 이미 있고
 * (`GET /api/plans/:id/walls`), 그걸 안 쓰고 «복도는 대개 직각이겠지» 로 그리면
 * 여전히 뚫는 선이 남는다.
 *
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {{walls?: Array<{x1,y1,x2,y2}>}} opts
 * @returns {Array<{x:number,y:number}>} 2개(곧은 선) 또는 3개(한 번 꺾임)
 */
export function elbow(a, b, { walls } = {}) {
  if (!a || !b) return [];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  // 한쪽이 0이면 이미 직각이다
  if (ax === 0 || ay === 0) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];

  // **예외를 두지 않는다.**
  //
  // 처음에는 «4° 안쪽이면 꺾지 말자» 는 규칙을 뒀다. 눈에 안 보이는 토막이
  // 생기는 게 지저분해 보였기 때문이다. 그런데 그러면 3° 기운 선이 그대로
  // 남아 «전부 직각» 이 거짓말이 된다. 실제로 시험이 그걸 잡았다.
  //
  // 3px 짜리 꺾임은 화면에서 곧은 선과 구별되지 않으므로 잃는 것이 없고,
  // 얻는 것은 «이 도면의 모든 선은 직각이다» 라는 성질이다. 성질이 예외 없이
  // 성립해야 시험으로 지킬 수 있다.

  // **긴 축을 먼저.** 복도를 따라가다 방 앞에서 꺾는 모양이 된다.
  const longFirst = ax >= ay ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
  const shortFirst = ax >= ay ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  const make = c => [{ x: a.x, y: a.y }, c, { x: b.x, y: b.y }];

  if (!walls?.length) return make(longFirst);

  // 벽을 알면 세어 보고 덜 뚫는 쪽으로 간다. 같으면 긴 축 먼저(복도 모양).
  const A = make(longFirst);
  const B = make(shortFirst);
  return wallHits(B, walls) < wallHits(A, walls) ? B : A;
}

/**
 * SVG `points` 속성에 넣을 문자열.
 * @returns {string} "x1,y1 x2,y2 x3,y3"
 */
export function elbowPoints(a, b, opts) {
  return elbow(a, b, opts).map(p => `${round(p.x)},${round(p.y)}`).join(' ');
}

/**
 * 여러 지점을 잇는 경로 전체의 꼭짓점들. 이어지는 토막의 겹치는 점은 하나로 친다.
 *
 * @param {Array<{x:number,y:number}>} nodes 지나가는 지점들
 */
export function elbowPath(nodes = [], opts) {
  const out = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const seg = elbow(nodes[i], nodes[i + 1], opts);
    for (const p of seg) {
      const last = out[out.length - 1];
      if (last && last.x === p.x && last.y === p.y) continue;
      out.push(p);
    }
  }
  if (!out.length && nodes.length === 1) out.push(nodes[0]);
  return out;
}

/**
 * 경로를 **걸어가는 순서의 지점 목록**으로 편다 — 꺾임점을 정식 지점으로 넣는다.
 *
 * ## 왜 필요한가
 *
 * 지도에만 직각으로 그리고 안내는 곧은 선을 그대로 쓰면, 화면은 «위로 갔다가
 * 왼쪽» 이라고 그리는데 음성은 «285° 쪽으로» 라고 말한다. 실제로 재보니 최대
 * 89° 어긋났다. 그림과 안내가 다른 길을 말하는 셈이다.
 *
 * 꺾임점을 **경로의 지점으로 넣으면** 그 문제가 통째로 사라진다. 안내 계층은
 * 지점과 지점 사이를 안내할 뿐이므로, 꺾임점이 지점이 되는 순간 저절로
 * «우측으로 12미터, 그다음 좌측으로 꺾어 8미터» 가 된다. 실제로 사람이 복도를
 * 걷는 모양이기도 하다 — 대각선으로 가로지르는 사람은 없다.
 *
 * ## 꺾임점에는 이름이 없다
 *
 * 도면에 없는 자리라 id 가 없다. 목적지 이름을 물려받아 «SOUTH STREET 교차점
 * 방향으로» 라고 말하게 한다. 이름이 없으면 «다음 지점» 이라고만 말하게 되는데,
 * 시각장애인에게 그건 아무 정보가 아니다.
 *
 * ## 벽이 있으면 길을 찾고, 없으면 꺾는다
 *
 * 벽을 주면 `wall-route.js` 의 격자 길찾기가 **지날 수 있는 곳으로** 길을 낸다.
 * 한 번 꺾는 것만으로는 벽을 못 피한다 — 꺾는 방법이 두 가지뿐이라 둘 다 막히면
 * 방법이 없고, 실제로 대피 경로 37개에서 곧게 60회 · 꺾어서 51회로 거의 안 줄었다.
 * 길찾기를 쓰면 46회로 준다.
 *
 * 못 찾거나 벽이 없으면 꺾기로 돌아간다. **안내가 멈추는 것보다 낫다.**
 *
 * @param nodes 경로가 지나는 지점들 ({id, name, x, y})
 * @param opts  { walls, findPath } walls 가 있고 findPath 가 주어지면 길찾기를 쓴다
 * @returns 걸어갈 순서의 지점들. 꺾임점은 `corner: true`
 */
export function routeWaypoints(nodes = [], opts = {}) {
  const out = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (!a || !b) continue;
    if (!out.length) out.push({ ...a, corner: false });

    // 벽을 알면 찾아서 가고, 아니면 꺾어서 간다
    const found = opts.walls?.length && opts.findPath
      ? opts.findPath(a, b, opts)
      : null;
    const pts = found && found.length >= 2 ? found : elbow(a, b, opts);
    for (let k = 1; k < pts.length; k++) {
      const isCorner = k < pts.length - 1;
      out.push(isCorner
        // 꺾임점 — 도면에 없는 자리다. 이름은 가는 곳의 것을 물려받는다.
        ? { id: null, name: b.name, x: pts[k].x, y: pts[k].y, corner: true }
        : { ...b, corner: false });
    }
  }
  if (!out.length && nodes.length === 1) out.push({ ...nodes[0], corner: false });
  return out;
}

/** 이 폴리라인의 길이. 직각으로 도니 곧은 거리보다 길다 */
export function pathLength(points = []) {
  let d = 0;
  for (let i = 0; i < points.length - 1; i++) {
    d += Math.abs(points[i + 1].x - points[i].x) + Math.abs(points[i + 1].y - points[i].y);
  }
  return d;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
