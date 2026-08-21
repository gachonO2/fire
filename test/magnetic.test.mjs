// 지자기 지문: 자기장 세기의 순서로 위치를 좁히는 부분.
//
// 이 기능은 **아직 되는지 모른다.** 전제가 "같은 자리에서 같은 값이 나온다"인데
// 실제로 재본 적이 없다. 그래서 첫 묶음은 그 판정(reproducibilityReport)을
// 검사하고, 나머지는 판정을 통과했다고 가정한 뒤의 동작을 검사한다.
import { FloorPlan } from '../shared/floor-plan.js';
import { Fusion } from '../shared/fusion.js';
import {
  MagneticMatcher, normalizeWindow, matchScore,
  buildFingerprint, reproducibilityReport,
} from '../shared/magnetic.js';
import { MagneticAnchor } from '../shared/magnetic-anchor.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// ══════════════════════════════════ 재현성 판정 (Phase 0 관문)

// ─────────────────────────────────────────── 지문이 성립하는 경우
{
  // 세 지점이 뚜렷이 다르고, 재방문해도 거의 같은 값
  const r = reproducibilityReport([
    { spot: 'A', samples: [48.1, 48.3, 48.0] },
    { spot: 'A', samples: [48.4, 48.2, 48.5] },
    { spot: 'B', samples: [53.0, 53.2, 52.9] },
    { spot: 'B', samples: [53.3, 53.1, 53.4] },
    { spot: 'C', samples: [44.0, 44.2, 43.8] },
    { spot: 'C', samples: [43.9, 44.1, 44.3] },
  ]);
  expect('재현되면 good', r.verdict === 'good', `→ ${r.verdict} (비 ${r.ratio.toFixed(1)})`);
  expect('지점 간 차이가 방문 간 차이보다 크다', r.betweenUt > r.withinUt,
    `${r.betweenUt.toFixed(2)} vs ${r.withinUt.toFixed(2)}`);
}

// ─────────────────────────────────────────── 값이 마구 튀는 경우 — 접어야 한다
{
  const r = reproducibilityReport([
    { spot: 'A', samples: [48.0] }, { spot: 'A', samples: [55.0] },   // 같은 자리인데 7 차이
    { spot: 'B', samples: [50.0] }, { spot: 'B', samples: [45.0] },
    { spot: 'C', samples: [49.0] }, { spot: 'C', samples: [52.0] },
  ]);
  expect('재현이 안 되면 unusable', r.verdict === 'unusable',
    `→ ${r.verdict} (비 ${r.ratio.toFixed(2)})`);
  expect('접으라고 말해준다', r.message.includes('접는'), `→ ${r.message}`);
}

// ─────────────────────────────────────────── 표본이 모자라면 판정하지 않는다
{
  const r = reproducibilityReport([
    { spot: 'A', samples: [48.0] },
    { spot: 'B', samples: [53.0] },
  ]);
  expect('한 번씩만 재면 판정 불가', r.verdict === 'insufficient', `→ ${r.verdict}`);
}

// ══════════════════════════════════ 순수 함수

// ─────────────────────────────────────────── 폰이 달라도 모양이 같으면 맞는다
//
// 폰 안의 스피커 자석·카메라가 자력계를 밀어놓는다(하드아이언 오프셋).
// 절대값을 비교하면 기종이 바뀔 때마다 전부 어긋난다.
{
  const iphone = [48.2, 51.7, 49.1, 44.3, 46.8, 53.2];
  const galaxy = iphone.map(v => v + 3.2);          // 통째로 +3.2 어긋난 폰

  expect('평균을 빼면 오프셋이 사라진다',
    normalizeWindow(iphone).every((v, i) => near(v, normalizeWindow(galaxy)[i], 1e-9)));
  expect('다른 폰이어도 모양이 같으면 1점', near(matchScore(iphone, galaxy), 1, 1e-9),
    `→ ${matchScore(iphone, galaxy).toFixed(3)}`);
}

// ─────────────────────────────────────────── 모양이 다르면 점수가 떨어진다
{
  const a = [48.2, 51.7, 49.1, 44.3, 46.8, 53.2];
  const flat = [50, 50, 50, 50, 50, 50];
  const reversed = [...a].reverse();
  expect('밋밋한 구간과는 안 맞는다', matchScore(a, flat) < 0.3,
    `→ ${matchScore(a, flat).toFixed(3)}`);
  expect('거꾸로 된 무늬와도 안 맞는다', matchScore(a, reversed) < 0.5,
    `→ ${matchScore(a, reversed).toFixed(3)}`);
  expect('비교할 게 없으면 감점하지 않는다', matchScore(a, []) === 1);
}

// ─────────────────────────────────────────── 측량 결과를 걸음 단위로 편다
{
  const fp = buildFingerprint([40, 50, 60], 4);
  expect('걸음+1 개로 만든다', fp.length === 5, `→ ${fp.length}`);
  expect('양 끝이 보존된다', near(fp[0], 40) && near(fp[4], 60));
  expect('가운데는 보간된다', near(fp[2], 50), `→ ${fp[2]}`);
}

// ══════════════════════════════════ 실시간 대조 + 판단 계층 연결

// R302 ── J1 ── EXIT,  R302 ── FAR   (전부 8걸음)
// E1 과 E3 에 서로 다른 지문을 심는다 — 갈림길에서 갈리는지 보려는 것이다.
const E1_PRINT = [48.0, 49.5, 52.0, 50.5, 46.0, 44.5, 47.0, 51.0, 53.0];
const E3_PRINT = [48.0, 46.0, 44.0, 45.5, 49.0, 52.5, 51.0, 47.5, 45.0];

const plan = new FloorPlan({
  id: 'mag-fixture',
  name: '지자기 시험용',
  metersPerUnit: 1,
  stepLength: 1,
  northOffset: 0,
  nodes: [
    { id: 'R302', name: '302호 앞', x: 0, y: 0, type: 'room' },
    { id: 'J1', name: '교차점', x: 8, y: 0, type: 'junction' },
    { id: 'EXIT', name: '출구', x: 16, y: 0, type: 'exit' },
    { id: 'FAR', name: '반대편', x: 0, y: 8, type: 'room' },
  ],
  edges: [
    { id: 'E1', a: 'R302', b: 'J1', magnetic: E1_PRINT },
    { id: 'E2', a: 'J1', b: 'EXIT' },                      // 지문 없음
    { id: 'E3', a: 'R302', b: 'FAR', magnetic: E3_PRINT },
  ],
});

expect('지문이 있는 도면임을 안다', new MagneticMatcher(plan).hasFingerprints === true);

// ─────────────────────────────────────────── 지문 없는 통로는 감점하지 않는다
{
  const m = new MagneticMatcher(plan);
  for (const v of [50, 51, 52, 53, 54, 55]) m.push(v);
  const s = m.scoreFor({ from: 'J1', to: 'EXIT', step: 6, steps: 8 });
  expect('지문 없는 통로는 1점', s === 1, `→ ${s}`);
}

// ─────────────────────────────────────────── 창이 짧으면 판단하지 않는다
{
  const m = new MagneticMatcher(plan);
  m.push(48.0); m.push(49.5);
  const s = m.scoreFor({ from: 'R302', to: 'J1', step: 1, steps: 8 });
  expect('두 걸음으로는 판단하지 않는다', s === 1, `→ ${s}`);
}

// ─────────────────────────────────────────── 맞는 통로를 걸으면 높은 점수
{
  const m = new MagneticMatcher(plan);
  for (let i = 0; i <= 6; i++) m.push(E1_PRINT[i] + 2.5);   // 오프셋 있는 다른 폰
  const good = m.scoreFor({ from: 'R302', to: 'J1', step: 6, steps: 8 });
  const bad = m.scoreFor({ from: 'R302', to: 'FAR', step: 6, steps: 8 });
  expect('걸어온 통로와는 잘 맞는다', good > 0.9, `→ ${good.toFixed(3)}`);
  expect('다른 통로와는 안 맞는다', bad < 0.5, `→ ${bad.toFixed(3)}`);
}

// ─────────────────────────────────────────── 반대 방향으로 걸으면 지문을 뒤집는다
{
  const m = new MagneticMatcher(plan);
  // J1 → R302 로 걷는다. 지문은 R302→J1 순서로 저장돼 있으므로 뒤집어 읽어야 한다.
  for (let i = 8; i >= 2; i--) m.push(E1_PRINT[i]);
  const s = m.scoreFor({ from: 'J1', to: 'R302', step: 6, steps: 8 });
  expect('역방향 주행도 맞춘다', s > 0.9, `→ ${s.toFixed(3)}`);
}

// ─────────────────────────────────────────── 갈림길에서 지자기가 방향을 고른다
//
// 나침반 없이 걸음만으로는 R302 에서 J1 쪽인지 FAR 쪽인지 모른다.
// 지문이 있으면 갈린다 — 이게 지자기가 벌어주는 것이다.
{
  const f = new Fusion(plan);
  const anchor = new MagneticAnchor(f, new MagneticMatcher(plan));
  f.anchorAt('R302', { kind: 'beacon' });

  for (let i = 1; i <= 6; i++) {
    f.step();                       // 방위 없이 — 나침반이 없다고 치자
    anchor.update(E1_PRINT[i] + 2.5);
  }

  const p = f.position();
  expect('지자기가 갈림길을 고른다', p.to === 'J1', `→ ${p.to}`);
  // 지워지지 않고 남아 있어야 한다 — 지문이 한 번 잘못 맞았을 때 되돌아올 길이다
  const far = f.snapshot().find(c => c.to === 'FAR');
  expect('맞은편 후보가 지워지지는 않는다', far !== undefined);
  expect('다만 가볍다', (far?.weight ?? 1) < 0.2, `→ ${far?.weight.toFixed(3)}`);
}

// ─────────────────────────────────────────── 누적 확정 — 확신도를 되살린다
//
// observe() 만으로는 stepsSinceAnchor 가 안 줄어 확신도가 계속 떨어진다.
// 지문이 내리 일치했다면 그건 확인된 것이므로 앵커로 승격해야 한다.
{
  const withMag = new Fusion(plan);
  const anchor = new MagneticAnchor(withMag, new MagneticMatcher(plan));
  withMag.anchorAt('R302', { kind: 'beacon' });

  const without = new Fusion(plan);
  without.anchorAt('R302', { kind: 'beacon' });

  let anchored = false;
  for (let i = 1; i <= 8; i++) {
    withMag.step();
    if (anchor.update(E1_PRINT[i] + 2.5).anchored) anchored = true;
    without.step();
  }

  expect('창이 차면 누적 확정으로 승격한다', anchored === true);
  expect('지자기가 있으면 확신도가 더 높다',
    withMag.confidence() > without.confidence(),
    `${withMag.confidence().toFixed(2)} vs ${without.confidence().toFixed(2)}`);
}

// ─────────────────────────────────────────── 애매하면 앵커를 놓지 않는다
{
  const f = new Fusion(plan);
  const m = new MagneticMatcher(plan);
  const anchor = new MagneticAnchor(f, m);
  f.anchorAt('R302', { kind: 'beacon' });

  let anchored = 0;
  for (let i = 1; i <= 8; i++) {
    f.step();
    // 어느 지문과도 안 맞는 값 — 밋밋한 직선
    if (anchor.update(50).anchored) anchored++;
  }
  expect('닮지 않으면 확정하지 않는다', anchored === 0, `→ ${anchored}회`);
}

// ─────────────────────────────────────────── 지문 없는 도면에서는 아무 일도 없다
{
  const bare = new FloorPlan({
    ...plan.toJSON(),
    edges: plan.edges.map(({ magnetic, ...e }) => e),
  });
  const f = new Fusion(bare);
  const anchor = new MagneticAnchor(f, new MagneticMatcher(bare));
  f.anchorAt('R302', { kind: 'beacon' });
  const before = f.snapshot();
  f.step();
  const r = anchor.update(48.0);
  expect('지문이 없으면 건너뛴다', r.anchored === false);
  expect('가중치를 건드리지 않는다', f.snapshot().length >= before.length);
}

console.log(failed === 0 ? '\n지자기 지문 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
