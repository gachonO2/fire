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
  }
  return mapper;
}

/**
 * 맥을 BLE 수신기로 쓴다 — **폰이 못 읽으니 맥이 대신 듣는다.**
 *
 * Expo Go 는 BLE 스캔을 못 한다(네이티브 모듈이 필요하다). 그런데 측위를 확인하려면
 * 진짜 전파가 있어야 한다. 맥은 읽을 수 있으므로, **같은 사람이 둘 다 들고 다니면**
 * 맥이 귀 역할을 하고 폰이 눈과 다리 역할을 한다.
 *
 * 서버가 하는 일은 둘이다.
 *
 *   1. 매핑 만들기   폰 위치 + 신호  →  "이 비콘은 저 지점에 있다"
 *   2. 지점 판정     매핑이 생긴 뒤   →  "지금 가장 센 비콘은 저 지점"  → 폰에 밀어준다
 *
 * 1 없이 2 를 할 수 없고, 2 를 하려면 1 이 먼저 쌓여야 한다. 그래서 **처음 한 바퀴는
 * 걸음으로만 돌고**(매핑을 만들고), 그 뒤부터 전파가 위치를 잡아 준다.
 */

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

  if (fresh.length === 0) {
    // 걷는 사람이 없으면 신호만 있고 위치가 없다. 버리되 왜 버렸는지는 알려준다.
    return res.json({ ok: true, taken: 0, reason: '최근 폰 위치가 없습니다' });
  }

  const pos = fresh[0];
  const taken = m.observe(pos, readings, pos.confidence ?? 1);
  const estimates = m.estimates();
  publish('beaconMap', estimates);

  // 매핑이 쌓였으면 이제 **전파가 위치를 잡는다.** 걸음이 아니라 신호가 답한다.
  // 사람이 정한 것이 우선한다 — 걸음 추정보다 믿을 만하다
  const mapping = { ...m.mapping(), ...surveyed };
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
    at: { x: pos.x, y: pos.y, nodeId: pos.nodeId, confidence: pos.confidence },
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

beaconRoutes.put('/beacon-map/mapping', (req, res) => {
  const { mapping, merge = true } = req.body || {};
  if (!mapping || typeof mapping !== 'object') {
    return res.status(400).json({ error: 'mapping 객체가 필요합니다.' });
  }
  surveyed = merge ? { ...surveyed, ...mapping } : { ...mapping };
  locatorKeys = '';                       // 다음 관측에서 판정기가 새 매핑을 받는다
  publish('beaconMap', mapper ? mapper.estimates() : []);
  res.json({ ok: true, count: Object.keys(surveyed).length });
});

beaconRoutes.delete('/beacon-map/mapping', (req, res) => {
  surveyed = {};
  locatorKeys = '';
  res.json({ ok: true });
});

/** 지금까지 알아낸 비콘 위치 — 관제 지도가 이걸 그린다 */
beaconRoutes.get('/beacon-map', async (req, res) => {
  const m = await currentMapper();
  if (!m) return res.json({ estimates: [], mapping: {} });
  res.json({ estimates: m.estimates(), mapping: m.mapping() });
});

/** 다시 시작 — 잘못 걸어서 엉킨 것을 버린다 */
beaconRoutes.delete('/beacon-map', async (req, res) => {
  const m = await currentMapper();
  m?.reset();
  publish('beaconMap', []);
  res.json({ ok: true });
});
