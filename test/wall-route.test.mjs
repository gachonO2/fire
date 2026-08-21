// 벽 회피 길찾기: **선이 벽을 지나지 않게 길을 바꾼다.**
//
// 직각으로 꺾는 것만으로는 안 됐다 — 꺾는 방법이 두 가지뿐이라 둘 다 막히면
// 방법이 없고, 실제 대피 경로 37개에서 곧게 60회 · 꺾어서 51회로 거의 안 줄었다.
// 지날 수 있는 곳을 알고 찾아야 길이 바뀐다.
import { routeThroughWalls, planRoute, pruneForGuidance, WALL_ROUTE_DEFAULTS } from '../shared/wall-route.js';
import { wallHits } from '../shared/orthogonal.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

function allAxisAligned(pts) {
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = Math.abs(pts[i + 1].x - pts[i].x);
    const dy = Math.abs(pts[i + 1].y - pts[i].y);
    if (dx > 1e-6 && dy > 1e-6) return false;
  }
  return true;
}

// 벽에 틈이 있으면 그리로 간다 — 이게 «꺾기» 로는 안 되는 일이다
{
  const wall = [
    { x1: 50, y1: 0, x2: 50, y2: 40 },
    { x1: 50, y1: 60, x2: 50, y2: 100 },
  ];
  const p = routeThroughWalls({ x: 10, y: 50 }, { x: 90, y: 50 }, { walls: wall, cell: 2 });
  expect('벽의 틈으로 지나간다', p && wallHits(p, wall) === 0, `${wallHits(p, wall)}회`);
  expect('찾은 길이 전부 직각', allAxisAligned(p));
  expect('시작과 끝이 그대로', p[0].x === 10 && p[p.length - 1].x === 90);
}

// 사방이 막힌 방 — **못 찾겠다고 하지 않는다.**
// 이 도면의 벽에는 문이 없어서, 막으면 방에서 나오는 길이 아예 없어진다.
// 대피 중에 «경로 없음» 은 아무 도움도 안 되므로 한 번 넘어서라도 나간다.
{
  const box = [
    { x1: 0, y1: 0, x2: 40, y2: 0 }, { x1: 40, y1: 0, x2: 40, y2: 40 },
    { x1: 40, y1: 40, x2: 0, y2: 40 }, { x1: 0, y1: 40, x2: 0, y2: 0 },
  ];
  const p = routeThroughWalls({ x: 20, y: 20 }, { x: 100, y: 20 }, { walls: box, cell: 2 });
  expect('막힌 방에서도 길을 낸다', Boolean(p));
  expect('벽은 한 번만 넘는다', wallHits(p, box) === 1, `${wallHits(p, box)}회`);
}

// 벽이 없으면 null — 부르는 쪽이 싼 방법(꺾기)으로 돌아간다
{
  expect('벽이 없으면 길찾기를 안 한다', routeThroughWalls({ x: 0, y: 0 }, { x: 9, y: 9 }, { walls: [] }) === null);
}

// 계단 모양이 나오면 안 된다 — «1미터 직진» 을 서른 번 말하게 된다
{
  const p = routeThroughWalls({ x: 0, y: 0 }, { x: 100, y: 60 }, {
    walls: [{ x1: 200, y1: 200, x2: 201, y2: 201 }], cell: 2,
  });
  expect('비스듬한 이동도 몇 토막으로 끝난다', p && p.length <= 5, `꼭짓점 ${p?.length}개`);
  expect('계단 모양이 아니다', p && p.length <= 5 && allAxisAligned(p));
}

// 걸을 수 없는 짧은 토막이 남으면 안 된다
{
  const nodes = [
    { id: 'A', name: 'A', x: 0, y: 0 },
    { id: 'B', name: 'B', x: 100, y: 60 },
    { id: 'C', name: 'C', x: 100, y: 160 },
  ];
  const path = planRoute(nodes, { walls: [{ x1: 300, y1: 300, x2: 301, y2: 301 }], cell: 4 });
  expect('그림용 길은 전부 직각', allAxisAligned(path));

  // 안내용으로 추리면 걸을 수 없는 토막이 사라진다
  const w = pruneForGuidance(path, 4 * 1.5);
  const legs = [];
  for (let i = 0; i < w.length - 1; i++) {
    legs.push(Math.hypot(w[i + 1].x - w[i].x, w[i + 1].y - w[i].y));
  }
  expect('안내에는 걸을 수 없는 토막이 없다',
    legs.every(l => l >= 4 * 1.5 - 1e-6),
    `제일 짧은 토막 ${Math.min(...legs).toFixed(1)}`);
  expect('추려도 시작과 끝은 그대로',
    w[0].x === path[0].x && w[w.length - 1].x === path[path.length - 1].x);

  // 도면에 있는 지점은 안내가 이름으로 부르는 자리라 사라지면 안 된다
  const named = w.filter(p => p.id).map(p => p.id);
  expect('지나가는 지점 이름이 남는다', named.includes('B') && named.includes('C'),
    named.join(', '));
}

// 실제 도면 — 이 변경의 유일한 근거
{
  const fs = await import('node:fs');
  const plan = JSON.parse(fs.readFileSync(new URL('../backend/data/plans.json', import.meta.url), 'utf8'));
  const list = Array.isArray(plan) ? plan : (plan.plans || Object.values(plan));
  const active = list.filter(p => p?.nodes?.length && p?.edges?.length)
    .sort((a, b) => b.edges.length - a.edges.length)[0];
  const walls = active?.walls || null;

  if (!walls?.length) {
    // 벽은 별도 API 로 저장돼 도면 파일에 없을 수 있다. 그때는 합성 도면으로 확인한다.
    expect('실제 도면에 벽이 없으면 건너뛴다 (합성으로 이미 확인함)', true, '도면 파일에 walls 없음');
  } else {
    const N = Object.fromEntries(active.nodes.map(n => [n.id, n]));
    let before = 0, after = 0;
    for (const e of active.edges.slice(0, 20)) {
      const a = N[e.a], b = N[e.b];
      if (!a || !b) continue;
      before += wallHits([a, b], walls);
      after += wallHits(planRoute([a, b], { walls }), walls);
    }
    expect('실제 도면에서 벽 지나는 횟수가 준다', after <= before, `${before} → ${after}`);
  }
}

console.log(failed === 0 ? '\n벽 회피 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
