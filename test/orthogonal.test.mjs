// 직각 그리기: **선이 벽을 뚫고 가지 않게 보이도록.**
//
// 대피 경로가 화면에서 벽을 가로지르면 보는 사람은 그 안내를 믿지 않는다.
// 실제 벽 위치는 모르지만, 복도가 직각으로 만나는 건물에서는 직각으로 꺾는 편이
// 대각선보다 복도를 따를 확률이 높다.
import { elbow, elbowPath, elbowPoints, pathLength, wallHits, crosses, routeWaypoints } from '../shared/orthogonal.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

/** 모든 토막이 가로 또는 세로인가 */
function allAxisAligned(points) {
  for (let i = 0; i < points.length - 1; i++) {
    const dx = Math.abs(points[i + 1].x - points[i].x);
    const dy = Math.abs(points[i + 1].y - points[i].y);
    if (dx > 1e-9 && dy > 1e-9) return false;
  }
  return true;
}

// 기울어진 통로는 꺾어서 직각 두 토막이 된다
{
  const p = elbow({ x: 0, y: 0 }, { x: 100, y: 60 });
  expect('기울어진 통로가 꺾인다', p.length === 3, `점 ${p.length}개`);
  expect('모든 토막이 직각', allAxisAligned(p));
  expect('시작과 끝은 그대로', p[0].x === 0 && p[0].y === 0 && p[2].x === 100 && p[2].y === 60);
  expect('긴 축(가로)을 먼저 간다', p[1].x === 100 && p[1].y === 0,
    `꺾이는 점 (${p[1].x}, ${p[1].y})`);
}

// 세로가 길면 세로를 먼저
{
  const p = elbow({ x: 0, y: 0 }, { x: 40, y: 200 });
  expect('세로가 길면 세로를 먼저', p[1].x === 0 && p[1].y === 200,
    `꺾이는 점 (${p[1].x}, ${p[1].y})`);
}

// 예외를 두지 않는다 — 조금 기운 것도 꺾는다.
//
// «4° 안쪽은 그냥 두자» 는 규칙을 뒀다가, 3° 기운 선이 남아서 «전부 직각» 이
// 거짓이 됐다. 3px 짜리 꺾임은 화면에서 안 보이므로 잃는 것이 없다.
{
  const straight = elbow({ x: 0, y: 0 }, { x: 100, y: 0 });
  expect('이미 수평인 통로는 두 점 그대로', straight.length === 2);

  const nearly = elbow({ x: 0, y: 0 }, { x: 100, y: 3 });   // 1.7°
  expect('1.7° 만 기울어도 꺾는다', nearly.length === 3 && allAxisAligned(nearly),
    `점 ${nearly.length}개`);

  const tilted = elbow({ x: 0, y: 0 }, { x: 100, y: 20 });  // 11.3°
  expect('11° 도 물론 꺾는다', tilted.length === 3, `점 ${tilted.length}개`);
}

// 여러 구간을 이어도 겹치는 점이 생기지 않는다
{
  const path = elbowPath([{ x: 0, y: 0 }, { x: 100, y: 60 }, { x: 100, y: 200 }]);
  expect('이어붙인 경로도 전부 직각', allAxisAligned(path));
  const dup = path.some((p, i) => i > 0 && p.x === path[i - 1].x && p.y === path[i - 1].y);
  expect('겹치는 점이 없다', !dup, `점 ${path.length}개`);
  expect('마지막 점이 목적지', path[path.length - 1].x === 100 && path[path.length - 1].y === 200);
}

// SVG 에 넣을 문자열
{
  const s = elbowPoints({ x: 0, y: 0 }, { x: 100, y: 60 });
  expect('SVG points 문자열', s === '0,0 100,0 100,60', s);
}

// 직각으로 돌면 곧은 거리보다 길다 — 걸음 수를 이걸로 재면 안 되는 이유
{
  const p = elbow({ x: 0, y: 0 }, { x: 30, y: 40 });   // 곧은 거리 50
  const len = pathLength(p);
  expect('직각 길이는 곧은 거리보다 길다', len === 70, `${len} vs 곧은 거리 50`);
}

// 실제 도면으로 — 모든 통로가 직각이 되는가
{
  const plan = JSON.parse(
    (await import('node:fs')).readFileSync(
      new URL('../backend/data/plans.json', import.meta.url), 'utf8'));
  const list = Array.isArray(plan) ? plan : (plan.plans || Object.values(plan));
  // 지점이 가장 많은 도면 = 실제로 쓰는 도면. 시연용 작은 도면으로 통과하면
  // 시험이 아무것도 안 지키는 셈이 된다.
  const active = list.filter(p => p?.nodes?.length && p?.edges?.length)
    .sort((a, b) => b.edges.length - a.edges.length)[0];
  if (active) {
    const N = Object.fromEntries(active.nodes.map(n => [n.id, n]));
    let bad = 0;
    for (const e of active.edges) {
      const a = N[e.a], b = N[e.b];
      if (!a || !b) continue;
      if (!allAxisAligned(elbow(a, b))) bad++;
    }
    expect(`실제 도면 통로 ${active.edges.length}개가 전부 직각으로 그려진다`, bad === 0,
      bad ? `${bad}개 실패` : active.name || active.id);
  } else {
    expect('실제 도면을 읽었다', false, 'plans.json 에서 도면을 못 찾음');
  }
}

// ── 벽을 보고 꺾는 방향을 고른다 ───────────────────────────────────────────
//
// 직각으로 꺾는 것만으로는 벽 뚫기가 **전혀 안 줄어든다.** 실제 도면에서 재보니
// 2회 이상 뚫는 통로가 15개 → 15개로 그대로였다. 두 방향 중 덜 뚫는 쪽을
// 골라야 8개로 줄었다. 그래서 벽을 인자로 받는다.
{
  expect('가로지르면 참', crosses({x:0,y:0},{x:10,y:0},{x:5,y:-5},{x:5,y:5}));
  expect('끝만 닿으면 거짓', !crosses({x:0,y:0},{x:10,y:0},{x:5,y:0},{x:5,y:5}));
  expect('안 만나면 거짓', !crosses({x:0,y:0},{x:10,y:0},{x:5,y:5},{x:5,y:9}));
}

{
  // 가로 먼저 가면 벽에 막히고, 세로 먼저 가면 안 막히는 배치
  const a = { x: 0, y: 0 }, b = { x: 100, y: 40 };
  const wall = [{ x1: 50, y1: -20, x2: 50, y2: 20 }];   // 가로 구간을 가로막는다

  const naive = elbow(a, b);
  expect('벽을 모르면 긴 축 먼저 가서 막힌다', wallHits(naive, wall) === 1,
    `${wallHits(naive, wall)}회`);

  const aware = elbow(a, b, { walls: wall });
  expect('벽을 알면 안 막히는 쪽으로 꺾는다', wallHits(aware, wall) === 0,
    `꺾이는 점 (${aware[1].x}, ${aware[1].y})`);
  expect('그래도 시작과 끝은 그대로', aware[0].x === 0 && aware[2].x === 100 && aware[2].y === 40);
  expect('그래도 전부 직각', allAxisAligned(aware));
}

{
  // 어느 쪽으로 가도 막히면 긴 축 먼저(복도 모양)를 지킨다
  const a = { x: 0, y: 0 }, b = { x: 100, y: 40 };
  const box = [
    { x1: 50, y1: -20, x2: 50, y2: 20 },
    { x1: -20, y1: 20, x2: 20, y2: 20 },
  ];
  const p = elbow(a, b, { walls: box });
  expect('둘 다 막히면 긴 축 먼저를 지킨다', p[1].x === 100 && p[1].y === 0,
    `꺾이는 점 (${p[1].x}, ${p[1].y})`);
}

// ── 안내와 그림이 같은 길을 말하는가 ──────────────────────────────────────
//
// 한때 지도만 직각으로 그리고 안내는 곧은 선을 썼다. 화면은 «위로 갔다가 왼쪽»
// 이라고 그리는데 음성은 «285° 쪽으로» 라고 말했다 — 실기기에서야 알았고, 재보니
// 최대 89° 어긋났다. 지금은 **꺾임점이 경로의 정식 지점**이라 둘이 같은 길을 말한다.
//
// 그림과 안내가 같은 함수(`routeWaypoints`)를 쓰므로 자명해 보이지만, 자명한 것이
// 갈라지는 것을 이미 한 번 겪었다. 시험으로 박아 둔다.
{
  const plan = JSON.parse(
    (await import('node:fs')).readFileSync(
      new URL('../backend/data/plans.json', import.meta.url), 'utf8'));
  const list = Array.isArray(plan) ? plan : (plan.plans || Object.values(plan));
  const active = list.filter(p => p?.nodes?.length && p?.edges?.length)
    .sort((a, b) => b.edges.length - a.edges.length)[0];
  const N = Object.fromEntries(active.nodes.map(n => [n.id, n]));

  // 실제 경로 하나를 편다
  const ids = ['R_OPENOFFICE', 'J_SS2', 'EXIT_SS_DRCHON'].filter(id => N[id]);
  const nodes = ids.length >= 2 ? ids.map(id => N[id]) : active.nodes.slice(0, 3);
  const wps = routeWaypoints(nodes);

  expect('경로를 펴면 지점이 늘어난다 (꺾임점이 들어간다)', wps.length >= nodes.length,
    `${nodes.length}개 → ${wps.length}개`);
  expect('편 경로의 모든 다리가 직각', allAxisAligned(wps));
  expect('출발점이 그대로', wps[0].x === nodes[0].x && wps[0].y === nodes[0].y);
  const last = wps[wps.length - 1], dest = nodes[nodes.length - 1];
  expect('도착점이 그대로', last.x === dest.x && last.y === dest.y);
  expect('도착점은 꺾임점이 아니다', last.corner === false);

  const corners = wps.filter(w => w.corner);
  expect('꺾임점에는 이름이 물려진다', corners.every(c => c.name),
    corners.length ? `꺾임점 ${corners.length}개` : '꺾임점 없음');
  expect('꺾임점에는 id 가 없다 (도면에 없는 자리)', corners.every(c => c.id === null));

  // 그리는 쪽과 안내하는 쪽이 같은 꼭짓점을 쓰는가
  const drawn = elbowPath(nodes);
  const same = drawn.length === wps.length
    && drawn.every((p, i) => p.x === wps[i].x && p.y === wps[i].y);
  expect('그리는 꼭짓점과 안내하는 지점이 같다', same,
    `그림 ${drawn.length}개 vs 안내 ${wps.length}개`);
}

{
  // 벽을 주면 안내도 그림도 **같은 쪽으로** 꺾는다. 하나만 벽을 알면 갈라진다.
  const a = { id: 'A', name: 'A', x: 0, y: 0 };
  const b = { id: 'B', name: 'B', x: 100, y: 40 };
  const wall = [{ x1: 50, y1: -20, x2: 50, y2: 20 }];
  const wps = routeWaypoints([a, b], { walls: wall });
  const drawn = elbowPath([a, b], { walls: wall });
  expect('벽을 알면 안내와 그림이 같은 쪽으로 꺾는다',
    drawn.every((p, i) => p.x === wps[i].x && p.y === wps[i].y),
    `꺾임점 (${wps[1].x}, ${wps[1].y})`);
  expect('그 꺾임은 벽을 안 뚫는다', wallHits(wps, wall) === 0);
}

console.log(failed === 0 ? '\n직각 그리기 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
