/**
 * 비콘 관측 수집 — **걸으면 비콘 지도가 채워진다.**
 *
 * ## 왜 서버가 합치는가
 *
 * 폰과 맥이 반쪽씩 들고 있다.
 *
 *   폰   걸음 + 도면  →  "지금 복도 중앙쯤"   (BLE 를 못 읽는다)
 *   맥   BLE 스캔     →  "6760CC10 이 −46"   (자기 위치를 모른다)
 *
 * 둘을 이어 붙일 수 있는 곳은 **둘 다 보고 있는 서버**뿐이다. 맥이 신호를 올리면
 * 서버가 그 순간의 폰 위치와 짝지어 `BeaconMapper` 에 넣는다.
 *
 * ## 시각으로 맞추지 않고 "지금"으로 맞춘다
 *
 * 맥과 폰의 시계는 서로 다르다(NTP 로 맞아 있어도 몇 백 ms 는 어긋난다). 그래서
 * 타임스탬프로 짝짓지 않고, **관측이 들어온 순간의 최신 폰 위치**를 쓴다.
 * 폰은 2초마다 보고하고 사람은 그 사이 1.5m 쯤 걷는다 — 지점 단위 해상도에는
 * 그 정도 어긋남이 문제가 되지 않는다.
 *
 * 대신 **너무 오래된 위치와는 짝짓지 않는다**(`STALE_MS`). 폰이 꺼졌는데 마지막
 * 위치로 계속 비콘을 놓으면 한 자리에 전부 쌓인다.
 */
import { Router } from 'express';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { remapSurvey } from '../../../shared/survey-remap.js';
import { bakeWalk } from '../../../shared/walk-survey.js';
import { buildGraph, shortestPath } from '../../../shared/pathfinding.js';
import { getRepo } from '../repositories/index.js';
import { FloorPlan } from '../../../shared/floor-plan.js';
import { BeaconMapper } from '../../../shared/beacon-map.js';
import { BeaconLocator } from '../../../shared/positioning.js';
import { publish } from '../events.js';

export const beaconRoutes = Router();

/** 이보다 오래된 폰 위치와는 짝짓지 않는다 */
const STALE_MS = 6000;

let mapper = null;
let mapperPlanId = null;
let locator = null;      // 매핑이 생긴 뒤부터 실제 전파로 지점을 판정한다
let locatorKeys = '';    // 매핑이 바뀌면 도면만 갈아 끼운다
let lastSeenNode = null; // 직전 판정
let lastObservedAt = 0;  // 맥 스캐너가 마지막으로 신호를 올린 시각

async function currentMapper() {
  const repo = await getRepo();
  const plan = await repo.getActivePlan();
  if (!plan) return null;
  // 도면이 바뀌면 지금까지 모은 것은 의미가 없다 — 좌표계가 달라진다
  if (!mapper || mapperPlanId !== plan.id) {
    mapper = new BeaconMapper(new FloorPlan(plan));
    mapperPlanId = plan.id;
    locatorKeys = '';
  }
  return mapper;
}

/**
 * 지금 도면에 맞춘 답사 매핑. **저장본은 건드리지 않는다.**
 *
 * 계산은 `shared/survey-remap.js` 가 한다 — 순수 함수라 시험으로 못 박을 수
 * 있고(`test/survey-remap.test.mjs`), 앱에서도 같은 규칙을 쓸 수 있다.
 *
 * 저장본을 직접 고치지 않는 이유: 처음에는 고치고 짝 없는 것을 버렸는데,
 * 그러면 **다른 층을 잠깐 열어 보는 것만으로 답사가 지워진다.** 건물을 걸어서
 * 만든 값을 화면 전환으로 잃으면 안 된다.
 */
let surveyKey = null;
function surveyFor(plan) {
  const r = remapSurvey(plan, surveyed, spotXY);
  if (r.remapped && surveyKey !== plan?.id) {
    surveyKey = plan?.id;
    console.log(`  답사 재연결: ${r.remapped}개를 «${plan?.name}» 의 새 지점으로 이음`
      + (r.dropped ? ` · ${r.dropped}개는 짝 없음` : ''));
  }
  return r.mapping;
}

/**
 * 맥 스캐너가 올리는 관측.
 * body: { readings: [{beaconId, rssi}], userId? }
 */
beaconRoutes.post('/observations', async (req, res) => {
  const { readings, userId } = req.body || {};
  if (!Array.isArray(readings)) return res.status(400).json({ error: 'readings 배열이 필요합니다.' });

  lastObservedAt = Date.now();   // 진짜 수신기가 붙어 있다는 증거

  const m = await currentMapper();
  if (!m) return res.status(404).json({ error: '활성 도면이 없습니다.' });

  const repo = await getRepo();
  const positions = await repo.getPositions();
  const fresh = positions
    .filter(p => Number.isFinite(p?.x) && Date.now() - (p.ts ?? 0) < STALE_MS)
    .filter(p => !userId || p.userId === userId)
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  // 폰 위치는 **매핑을 만들 때만** 필요하다.
  //
  // 예전에는 여기서 바로 돌려보냈는데, 그러면 사람이 답사로 매핑을 다 만들어
  // 놔도 폰이 안 걷는 한 판정이 영영 안 돈다. 답사의 목적이 바로 «폰 위치에
  // 기대지 않는 것» 인데 그 경로가 폰 위치를 요구하고 있었던 셈이다.
  //
  //   매핑 만들기(자동 추정)  →  폰 위치가 필요하다
  //   지점 판정              →  매핑만 있으면 된다
  //
  // 그래서 앞의 것만 건너뛰고 뒤는 계속 간다.
  const pos = fresh[0] ?? null;
  const taken = pos ? m.observe(pos, readings, pos.confidence ?? 1) : 0;
  const estimates = m.estimates();
  publish('beaconMap', estimates);
  const plan0 = await (await getRepo()).getActivePlan();

  // 매핑이 쌓였으면 이제 **전파가 위치를 잡는다.** 걸음이 아니라 신호가 답한다.
  // 사람이 정한 것이 우선한다 — 걸음 추정보다 믿을 만하다
  // **지금 도면에 맞춘** 답사를 쓴다. 저장본을 그대로 쓰면 도면을 다시
  // 판독한 뒤로 없는 지점을 가리켜 판정이 통째로 죽는다.
  const mapping = { ...m.mapping(), ...surveyFor(plan0) };
  let fix = null;
  let est = null;
  const keys = Object.keys(mapping).sort().join('|');
  if (keys) {
    const plan = await (await getRepo()).getActivePlan();
    if (!locator) {
      // 기본값은 비콘이 5~10m 간격일 때를 가정한 값이다. 이 건물은 지점이
      // 2~5m 간격으로 촘촘하고 관측도 초당 여러 번 들어오므로 창을 짧게 잡는다.
      //
      // 다만 이걸 조여도 위치 오차는 안 줄었다(중앙값 4.7m 그대로). 원인이
      // 히스테리시스가 아니라 **신호 잡음**이기 때문이다 — 지점이 3m 와 5m 로
      // 떨어져 있으면 세기 차이가 5.5dB 인데 실내 잡음이 ±4dB 라 순위가 뒤집힌다.
      // 이건 설정으로 못 줄이고, 신호원이 촘촘해지거나 표본이 쌓여야 나아진다.
      // 가만히 서 있는데 위치가 튀는 것을 막는 설정.
      //
      // 처음에는 창을 짧게(1.5초) 잡아 반응을 빠르게 했는데, 그러면 평활에 쓰는
      // 표본이 서너 개뿐이라 ±4dB 잡음에 1등이 계속 뒤집힌다. 1등이 뒤집히면
      // 확정(locked)이 안 되고, 확정이 안 되면 **히스테리시스가 통째로 안 걸린다** —
      // 판정기가 매번 그 순간의 최댓값을 그대로 답한다. 그게 "가만히 있는데
      // 왔다 갔다"의 정체다.
      //
      // 그래서 창을 길게 잡아 1등을 안정시키고, 확정된 뒤에는 6dB 이상 확실히
      // 세야만 옮기게 한다. 반응이 1~2초 늦어지지만, 우리가 필요한 해상도는
      // 지점 단위라 그 지연이 문제되지 않는다.
      locator = new BeaconLocator(new FloorPlan(plan), {
        windowMs: 4000, holdMs: 1200, switchDb: 6, staleMs: 8000,
      });
    }
    if (locatorKeys !== keys) {
      // 매핑이 늘 때마다 판정기를 **새로 만들지 않는다.** 새로 만들면 모아 둔
      // 표본과 확정 상태가 날아가는데, 걷는 동안 매핑은 계속 느니까 영영 확정이
      // 안 된다. 매핑만 갈아 끼우면 판정 이력이 그대로 이어진다.
      //
      // 도면을 거치지 않고 직접 넣는 이유: 도면은 노드당 비콘을 하나만 들 수
      // 있어서, 한 방에 기기가 여럿이면 나머지가 판정에서 빠진다.
      locator.setBeaconMap(mapping);
      locatorKeys = keys;
    }
    const now = Date.now();
    locator.addScans(readings.map(r => ({ ...r, ts: now })));
    est = locator.estimate(now);

    // `locked` 를 요구하지 않는다.
    //
    // 확정(locked)은 **2초간 같은 지점**이 조건이라, 걷는 사람에게는 성립하지
    // 않는다 — 지점이 계속 바뀌니까. 실제로 그 조건 때문에 144회 관측에 판정이
    // 0회였다.
    //
    // 대신 **같은 지점이 두 번 연속** 나올 때만 보낸다. 한 번 튄 값으로 폰을
    // 흔들지 않으면서, 걸어도 판정이 나온다. 폰 쪽 판단 계층에도 거리 검사가
    // 있어 말이 안 되는 위치는 어차피 걸러진다.
    if (est?.nodeId) {
      // **들리는 대로 보낸다.** 걸러내는 일은 폰이 한다.
      //
      // 처음에는 서버에서 「두 번 연속 같은 지점」을 요구했는데, 걷는 중에는
      // 지점이 계속 바뀌어 108회 관측에 판정이 5회뿐이었다. 신호를 95% 버린 셈이다.
      //
      // 폰의 판단 계층에는 이미 걸음 거리 기반 타당성 검사가 있어서 말이 안 되는
      // 위치는 못 들어간다. 서버가 미리 깎을 이유가 없다 —
      // **듣는 쪽과 믿는 쪽을 나누는 것**이 이 구조의 요지다.
      fix = { nodeId: est.nodeId, rssi: est.rssi, beaconId: est.beaconId, at: now };
      lastFix = fix;
      publish('beaconFix', fix);
      lastSeenNode = est.nodeId;
    }
  }

  res.json({
    ok: true, taken, fix,
    reason: pos ? undefined : '최근 폰 위치가 없습니다 — 매핑은 안 쌓지만 판정은 돕니다',
    at: pos ? { x: pos.x, y: pos.y, nodeId: pos.nodeId, confidence: pos.confidence } : null,
    beacons: estimates.length,
    ready: estimates.filter(e => e.ready).length,
    mapped: Object.keys(mapping).length,
    surveyed: Object.keys(surveyed).length,
  });
});

/**
 * 시뮬레이션에서 "지금 실제로 서 있는 곳".
 *
 * 실물 비콘 매핑이 쌓이기 전에는 가상 신호를 어딘가에서 만들어야 하는데, 그
 * "어딘가"를 **코드에 박으면 안 된다.** 시험할 때마다 파일을 고치고 앱을 다시
 * 띄워야 하고, 무엇보다 그 값이 진짜인 척하게 된다.
 *
 * 그래서 서버가 들고 있고 브라우저나 앱에서 바꾼다. **매핑이 쌓이면 이 값은
 * 쓰이지 않는다** — 그때부터는 실제 전파가 위치를 말한다.
 */
let standNode = null;

beaconRoutes.get('/demo/stand', (req, res) => res.json({ nodeId: standNode }));

beaconRoutes.put('/demo/stand', async (req, res) => {
  const { nodeId } = req.body || {};
  if (nodeId === null || nodeId === '') { standNode = null; return res.json({ nodeId: null }); }
  const plan = await (await getRepo()).getActivePlan();
  if (!plan?.nodes?.some(n => n.id === nodeId)) {
    return res.status(404).json({ error: `도면에 없는 지점입니다: ${nodeId}` });
  }
  standNode = nodeId;
  res.json({ nodeId });
});

/**
 * 맥이 대신 들은 최신 판정 — 폰이 짧은 주기로 물어 간다.
 *
 * 오래된 값은 주지 않는다. 맥이 꺼졌는데 마지막 판정으로 계속 앵커를 놓으면
 * 걸어도 위치가 한 자리에 붙박인다 — 안 주는 편이 낫다.
 */
let lastFix = null;
beaconRoutes.get('/beacon-fix', (req, res) => {
  const now = Date.now();
  // `scanner` 가 참이면 **진짜 수신기가 붙어 있다** — 앱은 가상 비콘을 쓰지 않는다.
  //
  // 이 구분이 없으면 가상 비콘이 폰 위치를 잡고, 그 위치로 실제 신호를 매핑하는
  // 순환이 된다. 자기가 만든 답을 자기가 다시 읽는 셈이라 아무리 걸어도 진짜가
  // 되지 않는다. 진짜 귀가 있으면 가짜 귀는 꺼야 한다.
  res.json({
    fix: lastFix && now - lastFix.at < 8000 ? lastFix : null,
    scanner: now - lastObservedAt < 8000,
    mapped: Object.keys({ ...(mapper ? mapper.mapping() : {}), ...surveyed }).length,
    surveyed: Object.keys(surveyed).length,
  });
});

/**
 * 사람이 직접 정한 매핑 — **걸음 추정을 거치지 않는다.**
 *
 * 지금까지는 폰이 말하는 위치에 신호를 붙였다. 그런데 그 위치가 걸음 추정이라
 * 흔들리고, 흔들린 위치에 붙인 매핑으로 다시 위치를 잡으니 순환이 됐다.
 * 실제로 세 번 걸어서 나온 매핑이 전부 두세 지점에 뭉쳤다.
 *
 * 사람이 그 자리에 서서 "여기는 STUDIO 다"라고 말하면 그 고리가 끊긴다.
 * 측량은 원래 한 번 하는 일이고, 사람이 하는 편이 정확하다. 그 뒤의 위치 판정은
 * 자동으로 돌아간다 — **측량은 사람, 안내는 기계.**
 *
 * 이 매핑은 걸음으로 만든 것보다 **우선한다**.
 */
let surveyed = {};
/** 지점 id → 그때의 좌표. 도면을 다시 읽어도 답사를 되살리는 열쇠다. */
let spotXY = {};

/**
 * 답사 결과는 **파일에 남긴다.**
 *
 * 메모리에만 두면 서버를 한 번 재시작하는 순간 통째로 사라진다. 다른 값이면
 * 다시 계산하면 그만이지만, 이것은 사람이 건물을 한 바퀴 걸어서 만든 값이다.
 * 코드를 고치다 서버를 내리는 것만으로 그 걸음이 없어져서는 안 된다.
 *
 * 도면(`plans.json`)과는 다른 파일에 둔다 — 도면을 되돌리는 일과 답사를
 * 되돌리는 일은 별개이고, 실제로 도면을 되돌리다 답사를 함께 날린 적이 있다.
 */
const SURVEY_FILE = new URL('../../data/beacon-survey.json', import.meta.url);

function loadSurvey() {
  try {
    const raw = JSON.parse(readFileSync(SURVEY_FILE, 'utf8'));
    // 예전 파일은 `{beaconId: nodeId}` 평면 구조였다 — 그대로 읽어 준다
    surveyed = raw.surveyed ?? raw;
    spotXY = raw.spotXY ?? {};
    const spots = new Set(Object.values(surveyed)).size;
    if (spots) console.log(`  답사 복원: 신호 ${Object.keys(surveyed).length}개 · ${spots}지점`);
  } catch (_) { surveyed = {}; }
}

function saveSurvey() {
  try {
    mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
    writeFileSync(SURVEY_FILE, JSON.stringify({ surveyed, spotXY }, null, 1));
  } catch (e) {
    console.warn('  답사 저장 실패:', e.message);
  }
}

loadSurvey();

/**
 * 사진 시나리오가 사용할 기존 답사 위치.
 *
 * 한 위치에서 여러 BLE 신호를 잡았으므로 장치 24개를 같은 좌표에 겹쳐 찍지 않고
 * «답사 위치 8곳»으로 묶는다. 실제 장치 ID는 beaconIds에 그대로 남겨 관제에서
 * 언제든 원본 매핑과 대조할 수 있다.
 */
export function surveyedBeaconPlacements(plan) {
  if (!plan?.nodes?.length) return [];
  const grouped = new Map();
  for (const [beaconId, nodeId] of Object.entries(surveyFor(plan))) {
    const ids = grouped.get(nodeId) || [];
    ids.push(beaconId);
    grouped.set(nodeId, ids);
  }

  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([nodeId, beaconIds]) => {
    const node = plan.nodes.find(n => n.id === nodeId);
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.y)) return [];
    return [{
      id: `survey-spot:${nodeId}`,
      nodeId,
      nodeName: node.name,
      x: node.x,
      y: node.y,
      count: beaconIds.length,
      beaconIds: [...beaconIds].sort(),
      txPower: -59,
      mapped: true,
    }];
  });
}

beaconRoutes.put('/beacon-map/mapping', async (req, res) => {
  const { mapping, merge = true } = req.body || {};
  if (!mapping || typeof mapping !== 'object') {
    return res.status(400).json({ error: 'mapping 객체가 필요합니다.' });
  }

  // 값은 **지점 id** 여야 한다. 화면의 버튼은 id 를 넣지만 직접 타이핑하면
  // 이름("ACCEL LAB")이 들어오는데, 그러면 판정기가 도면에서 그 지점을 못 찾아
  // 매핑이 조용히 죽는다 — 답사를 한 바퀴 다 돌고 나서야 알게 된다.
  // 이름으로 들어온 것은 id 로 바꿔 주고, 도면에 없는 것은 되돌려 알린다.
  const plan = await (await getRepo()).getActivePlan();
  const ids = new Set((plan?.nodes || []).map(n => n.id));
  const byName = new Map((plan?.nodes || []).map(n => [String(n.name).trim(), n.id]));
  const clean = {};
  const rejected = [];
  for (const [beaconId, value] of Object.entries(mapping)) {
    const v = String(value).trim();
    if (ids.has(v)) clean[beaconId] = v;
    else if (byName.has(v)) clean[beaconId] = byName.get(v);
    else rejected.push(v);
  }
  if (rejected.length && !Object.keys(clean).length) {
    return res.status(400).json({
      error: `도면에 없는 지점입니다: ${[...new Set(rejected)].join(', ')}`,
    });
  }
  surveyed = merge ? { ...surveyed, ...clean } : { ...clean };
  // 지점의 **좌표**도 남긴다.
  //
  // 도면을 다시 판독하면 지점 id 가 새로 생긴다(`R_ACCEL` → `R_ACCELLAB`).
  // id 만 들고 있으면 그 순간 답사가 통째로 무효가 되고, 건물을 다시 걸어야
  // 한다. 좌표는 같은 사진에서 나오므로 거의 그대로다 — 그걸로 다시 잇는다.
  for (const nodeId of new Set(Object.values(clean))) {
    const n = (plan?.nodes || []).find(x => x.id === nodeId);
    if (n) spotXY[nodeId] = [n.x, n.y];
  }
  saveSurvey();
  locatorKeys = '';                       // 다음 관측에서 판정기가 새 매핑을 받는다
  publish('beaconMap', mapper ? mapper.estimates() : []);
  res.json({
    ok: true,
    count: Object.keys(surveyed).length,
    spots: new Set(Object.values(surveyed)).size,
    rejected: [...new Set(rejected)],
  });
});

beaconRoutes.delete('/beacon-map/mapping', (req, res) => {
  surveyed = {};
  spotXY = {};
  saveSurvey();
  locatorKeys = '';
  res.json({ ok: true });
});

/** 지금까지 알아낸 비콘 위치 — 관제 지도가 이걸 그린다 */
beaconRoutes.get('/beacon-map', async (req, res) => {
  const m = await currentMapper();
  // `surveyed` 는 사람이 태그한 것이라 도면이 없어도 유효하다. 조회에서 빼면
  // 답사가 쌓이고 있는지 화면이 알 길이 없어 «해도 안 되는 것» 처럼 보인다.
  if (!m) return res.json({ estimates: [], mapping: {}, surveyed });
  const plan = await (await getRepo()).getActivePlan();
  res.json({
    estimates: m.estimates(),
    mapping: m.mapping(),
    surveyed: surveyFor(plan),        // 지금 도면에서 실제로 쓰이는 것
    stored: Object.keys(surveyed).length,
  });
});

/** 다시 시작 — 잘못 걸어서 엉킨 것을 버린다 */
beaconRoutes.delete('/beacon-map', async (req, res) => {
  const m = await currentMapper();
  m?.reset();
  publish('beaconMap', []);
  res.json({ ok: true });
});


/* ─────────────────────── 걷기 답사 ───────────────────────
 *
 * **출발 찍고, 걷고, 도착 찍는다.** 그게 전부다.
 *
 * 지금까지 답사는 «지점마다 서서 10초 태그» 였다. 42지점이면 한 시간이 넘고,
 * 그것도 기기 한 대분이다 — Web Bluetooth 의 `device.id`, macOS 의 peripheral
 * UUID, iOS 의 identifier 가 전부 (기기, 출처)마다 다른 값이라, 폰을 한 대
 * 늘릴 때마다 건물을 다시 걸어야 한다. 그 노동을 없애지 않으면 «폰으로
 * 측위» 는 영영 안 된다.
 *
 * 걸으며 받은 신호를 **경로 위 어디쯤이었나** 로 되짚어 붙인다. 그 «어디쯤»
 * 은 걸음 수의 비율로 나오고, 경로의 모양은 도면 그래프가 안다. 방위는 안
 * 쓴다 — 실내 나침반은 철골·배전반에 수십 도씩 틀어지고 그 오차가 쌓인다.
 *
 * 굽는 규칙은 `shared/walk-survey.js` 에 있고 테스트가 지키고 있다.
 * 여기서는 세션을 들고 있다가 넘겨줄 뿐이다.
 */

/** 한 번에 하나. 두 사람이 동시에 걸으면 신호가 섞여 둘 다 못 쓴다. */
let walk = null;

beaconRoutes.post('/survey/walk/start', async (req, res) => {
  const { fromNodeId } = req.body || {};
  const plan = await (await getRepo()).getActivePlan();
  if (!plan) return res.status(404).json({ error: '활성 도면이 없습니다.' });
  if (!plan.nodes.some(n => n.id === fromNodeId)) {
    return res.status(400).json({ error: `도면에 없는 지점입니다: ${fromNodeId}` });
  }
  walk = { planId: plan.id, from: fromNodeId, samples: [], startedAt: Date.now() };
  console.log(`  걷기 답사 시작: ${fromNodeId}`);
  res.json({ ok: true, from: fromNodeId, startedAt: walk.startedAt });
});

/**
 * 걸으며 올린다. `steps` 는 **출발부터 누적된** 걸음 수다.
 *
 * 누적으로 받는 이유: 구간 걸음(delta)으로 받으면 요청 하나가 유실될 때
 * 그 뒤 전부가 앞으로 당겨진다. 누적이면 다음 요청이 스스로 고친다.
 */
beaconRoutes.post('/survey/walk/sample', (req, res) => {
  if (!walk) return res.status(409).json({ error: '걷기 답사가 시작되지 않았습니다.' });
  const { readings, steps } = req.body || {};
  if (!Array.isArray(readings)) return res.status(400).json({ error: 'readings 배열이 필요합니다.' });
  lastObservedAt = Date.now();   // 진짜 수신기가 붙어 있다는 증거
  walk.samples.push({ steps: Number(steps) || 0, readings, at: Date.now() });
  res.json({
    ok: true,
    samples: walk.samples.length,
    steps: Number(steps) || 0,
    devices: new Set(walk.samples.flatMap(s => s.readings.map(r => r.beaconId))).size,
  });
});

beaconRoutes.post('/survey/walk/finish', async (req, res) => {
  if (!walk) return res.status(409).json({ error: '걷기 답사가 시작되지 않았습니다.' });
  const { toNodeId } = req.body || {};
  const plan = await (await getRepo()).getActivePlan();
  if (!plan) return res.status(404).json({ error: '활성 도면이 없습니다.' });
  if (plan.id !== walk.planId) {
    walk = null;
    return res.status(409).json({ error: '걷는 도중 도면이 바뀌었습니다. 다시 걸어야 합니다.' });
  }
  const fp = plan instanceof FloorPlan ? plan : new FloorPlan(plan);
  if (!fp.getNode(toNodeId)) {
    return res.status(400).json({ error: `도면에 없는 지점입니다: ${toNodeId}` });
  }

  // 지나온 길 — **화재를 무시하고** 순수한 통행 그래프로 푼다. 답사는
  // 평시에 걷는 일이고, 그때 막힌 통로를 피해 돌아간 경로로 되짚으면
  // 실제로 걸은 자리와 어긋난다.
  const adj = buildGraph(fp, {}, { fireMode: false });
  // `shortestPath` 는 `{nodes, edges, distance}` 를 준다 — 배열이 아니다.
  const ids = shortestPath(adj, walk.from, toNodeId)?.nodes;
  if (!ids?.length) {
    return res.status(409).json({ error: `${walk.from} 에서 ${toNodeId} 로 가는 길이 도면에 없습니다.` });
  }
  const routeNodes = ids.map(id => fp.getNode(id)).filter(Boolean);

  const baked = bakeWalk(routeNodes, walk.samples);

  // **사람이 서서 태그한 것을 덮어쓰지 않는다.** 걷기 답사는 지나가며 만든
  // 값이라 서서 만든 것보다 거칠다. 겹치면 서 있던 쪽이 이긴다.
  let added = 0;
  for (const [beaconId, nodeId] of Object.entries(baked.mapping)) {
    if (surveyed[beaconId]) continue;
    surveyed[beaconId] = nodeId;
    added++;
  }
  for (const n of routeNodes) spotXY[n.id] = [n.x, n.y];
  saveSurvey();

  const took = walk.samples.length;
  const from = walk.from;
  walk = null;
  console.log(`  걷기 답사 완료: ${from} → ${toNodeId} · ${baked.steps}걸음`
    + ` · 기기 ${baked.devices}개 중 ${baked.kept}개 채택 · 새로 ${added}개`);

  res.json({
    ok: true,
    from, to: toNodeId,
    route: ids,
    steps: baked.steps,
    samples: took,
    devices: baked.devices,
    kept: baked.kept,
    added,
    spots: baked.spots,
    dropped: baked.dropped.slice(0, 20),
    surveyed: Object.keys(surveyed).length,
  });
});

/** 잘못 걸었을 때 — 굽지 않고 버린다 */
beaconRoutes.delete('/survey/walk', (req, res) => {
  walk = null;
  res.json({ ok: true });
});

/** 지금 걷는 중인가 (화면이 버튼 상태를 정하는 데 쓴다) */
beaconRoutes.get('/survey/walk', (req, res) => {
  res.json(walk
    ? { active: true, from: walk.from, samples: walk.samples.length,
      devices: new Set(walk.samples.flatMap(s => s.readings.map(r => r.beaconId))).size,
      steps: walk.samples.at(-1)?.steps ?? 0 }
    : { active: false });
});
