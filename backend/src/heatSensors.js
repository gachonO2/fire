/**
 * 열감지기 — **불이 났다고 사람이 정해 주지 않는다.**
 *
 * ## 왜 이게 필요한가
 *
 * 지금 시연은 관제에서 사람이 방을 눌러 불을 넣는다. 보는 사람에게 그것은
 * «불이 났다고 사람이 알려 주면 경로를 다시 그리는 시스템» 이다. 그러면
 * 가장 중요한 질문이 답을 못 받는다 — **불이 난 걸 누가 아나?**
 *
 * 온도 계층은 이미 다 있었다. `POST /api/sensors/temperature`, 문턱값
 * 45℃ 경고 / 60℃ 차단, 넘으면 `currentHazards()` 가 통로를 끊고 SSE 로 전
 * 앱이 재탐색한다. **감지기가 0대라 화면에 안 보였을 뿐이다.**
 *
 *     지금        사람이 화재 클릭  →  경로 바뀜
 *     감지기 있으면  감지기가 62℃ 보고  →  시스템이 스스로 끊음  →  경로 바뀜
 *
 * ## 왜 분기점에 다나
 *
 * 방 안에 달면 그 방 하나만 못 쓰게 되고 경로는 그대로다. 분기점이라야
 * «여기가 막히면 저쪽으로» 가 성립한다. 실제 건물의 열감지기도 복도와
 * 계단참에 붙는다.
 *
 * ## 시뮬레이션이라는 사실을 숨기지 않는다
 *
 * 진짜 감지기가 아니다. 다만 **진짜 감지기가 쓰는 것과 똑같은 경로**로
 * 보고한다(`repo.setSensorReading`). 그래야 ESP32 한 대를 붙였을 때 이
 * 파일만 끄면 되고, 나머지는 한 줄도 안 바뀐다. 시뮬레이션용 별도 경로를
 * 파면 실물을 붙이는 날 그 경로가 통째로 죽어 있는 것을 발견하게 된다.
 *
 * id 앞에 `SIM-` 을 붙여 화면이 실물과 구분할 수 있게 둔다.
 *
 * ## 온도는 어떻게 오르나
 *
 * 불에서 멀수록, 그리고 불이 난 지 얼마 안 됐을수록 덜 오른다. 불의 크기는
 * 이미 `shared/hazard-spread.js` 가 시간의 함수로 정해 두었으므로 그 곡선을
 * 그대로 쓴다 — 화면에 보이는 불의 크기와 감지기 온도가 **같은 값에서**
 * 나와야 «저 불 때문에 이 감지기가 올랐다» 가 눈으로 이어진다.
 */

import { SPREAD } from '../../shared/hazard-spread.js';
import { DETECTOR, Detector, SPEC, STATE } from '../../shared/detectors.js';

const SPEC_SMOKE = SPEC.smoke;
import { activeFloorPlan } from './floor.js';
import { getRepo } from './repositories/index.js';

/**
 * 감지기를 달 지점. **분기점·승강기 앞·비상구** — 경로가 갈리는 곳과
 * 사람이 모이는 곳이다.
 *
 * 방 안에 달면 그 방 하나만 못 쓰게 되고 경로는 그대로다. 분기점이라야
 * «여기가 막히면 저쪽으로» 가 성립한다.
 *
 * ## 왜 열 대인가 — 재서 정했다
 *
 * 처음에는 분기점 여섯이었다. 그런데 통로 44개 중 **14개가 사각지대**였다.
 * 남서쪽(THE LOUNGE·ACCEL LAB 앞)과 남동쪽(OPEN OFFICE·WELCOME)이 통째로
 * 비어서, 거기에 불을 놓으면 감지기가 하나도 안 울린다. 시연에서 그 자리를
 * 누르면 «감지기가 고장났나» 로 보인다.
 *
 * 비상구 셋과 OPEN OFFICE 를 더해 **44개 중 43개**가 잡힌다. 남는 하나는
 * MR(회의실) 둘을 잇는 통로인데, 방과 방 사이라 복도 감지기의 몫이 아니다.
 *
 * 비상구에 다는 것은 현실과도 맞는다 — 계단 앞은 사람이 모이는 곳이라
 * 실제 건물에서도 감지기가 반드시 붙는다.
 *
 * 도면에 없는 지점은 조용히 건너뛴다. 다른 건물 도면을 올렸을 때 서버가
 * 죽으면 안 되고, 그 도면에는 그 도면의 분기점이 있을 것이다.
 */
/**
 * 감지기를 달 자리 — **국내 기준의 간격을 지킨다.**
 *
 * ## 왜 분기점마다 달면 안 되나
 *
 * 처음에는 복도 분기점 전부에 달았다. 그랬더니 기준층 하나에 **52대**가
 * 붙었다. 도면의 «분기점» 은 우리가 경로를 풀려고 13m 마다 찍어 둔 점이지
 * 감지기를 달 자리가 아니다. 화면이 감지기로 뒤덮이는 것도 문제지만,
 * 더 나쁜 것은 **그 숫자가 실제 건물과 다르다**는 것이다. 시연에서
 * 「저 건물에 감지기가 저렇게 많나요」 를 물으면 답할 말이 없다.
 *
 * ## 기준 (NFTC 203)
 *
 *   복도 연기감지기   **보행거리 30m 마다 1개** (3종은 20m)
 *   계단·엘리베이터   수직 통로는 별도로 반드시 단다
 *
 * 130m 짜리 복도면 다섯 대다. 쉰두 대가 아니라.
 *
 * ## 그래서 이렇게 고른다
 *
 *   ① 계단·비상구·엘리베이터 앞은 **무조건** — 수직 통로이고 사람이 모인다
 *   ② 복도 분기점은 **30m 간격으로 솎아서** — 앞에 고른 것에서 그만큼
 *      떨어진 것만 남긴다
 *
 * 간격은 도면의 축척(`metersPerUnit`)으로 잰다. 픽셀로 재면 도면 크기가
 * 다른 건물에서 간격이 통째로 달라진다.
 */

/** 복도 감지기 간격(m). NFTC 203 의 보행거리 30m. */
export const CORRIDOR_SPACING_M = 30;

export function detectorSpots(plan) {
  const nodes = plan?.nodes || [];
  if (!nodes.length) return [];
  const mpu = Number(plan.metersPerUnit) > 0 ? Number(plan.metersPerUnit) : 0.1;
  const far = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) * mpu;

  // ① 수직 통로는 무조건. 계단실은 연기가 굴뚝처럼 오르는 곳이고,
  //    엘리베이터 승강로도 마찬가지다.
  const must = nodes.filter(n => n.type === 'exit' || n.type === 'elevator');

  // ② 복도는 30m 간격으로 솎는다. 이미 고른 것과 가까우면 건너뛴다.
  const picked = [...must];
  for (const n of nodes) {
    if (n.type !== 'junction') continue;
    if (picked.every(m => far(n, m) >= CORRIDOR_SPACING_M)) picked.push(n);
  }

  // 한 자리에 연기와 열을 같이 단다(교차회로). 연기는 빨리 울지만 수증기·
  // 먼지에 잘 속고, 열은 느리지만 거의 안 속는다 — 둘이 같이 울면 확실하다.
  //
  // 주소는 **도면 순서**로 매긴다. 고른 순서(출구 먼저)로 매기면 도면을
  // 다시 읽을 때마다 같은 기기의 주소가 바뀌어, 무전으로 부르던 이름이
  // 어제와 달라진다.
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  picked.sort((a, b) => order.get(a.id) - order.get(b.id));

  return picked.flatMap((n, i) => [
    { id: `SIM-SMOKE-${n.id}`, kind: DETECTOR.SMOKE, nodeId: n.id, label: n.name || n.id,
      address: `L1-${String(i * 2 + 1).padStart(3, '0')}` },
    { id: `SIM-HEAT-${n.id}`, kind: DETECTOR.HEAT, nodeId: n.id, label: n.name || n.id,
      address: `L1-${String(i * 2 + 2).padStart(3, '0')}` },
  ]);
}

/** 평상시 실내 온도(℃) */
const BASE_C = 23;
/** 불 한가운데의 온도(℃). 실제 구획 화재의 천장부는 이보다 훨씬 뜨겁다. */
const FIRE_PEAK_C = 240;
/** 연기만 있는 구간은 이 정도까지만 오른다 — 뜨겁진 않아도 위험하다 */
const SMOKE_PEAK_C = 52;

/**
 * 보고 주기. `TEMP.STALE_MS`(60초)보다 넉넉히 짧아야 한다 — 길면 관제가
 * 판독값을 «오래됐음» 으로 내리고, 감지기가 살아 있는데 죽은 것처럼 보인다.
 */
const TICK_MS = 12_000;

/** 불에서 이만큼 떨어지면 사실상 안 오른다 (다 큰 불 반지름의 배수) */
const REACH = 2.6;

/**
 * 연기는 **열보다 멀리, 빨리 간다.**
 *
 * 열은 공기를 데워야 전해지지만 연기는 천장을 타고 흐른다(ceiling jet).
 * 그래서 같은 불에서 연기감지기가 먼저 울고, 그 차이가 곧 대피 시간이다.
 * 이 두 상수가 그 차이를 만든다 — 도달 범위는 1.6배, 시간 상수는 절반.
 */
const SMOKE_REACH_X = 1.6;
const SMOKE_TAU_MS = 22_000;
/** 불 한가운데의 감광률(%/m). 작동값 15%/m 을 한참 넘는 값이다. */
const SMOKE_PEAK = 62;

/**
 * 감지기가 뜨거워지는 시간 상수(ms).
 *
 * **불이 번지는 속도와 따로 둔다.** 처음에는 `spreadProgress` 를 그대로 썼는데,
 * 그러면 57px 떨어진 감지기가 우는 데 5분이 걸렸다 — 시연에서 못 쓴다.
 *
 * 틀린 것은 시연 편의가 아니라 물리였다. 불꽃이 번지는 것과 열이 퍼지는 것은
 * 속도가 다르다. 천장을 타고 흐르는 열기류(ceiling jet)는 구획 전체를 1분
 * 안에 훑는데, 불꽃이 그만큼 번지려면 몇 분이 걸린다. 그래서 **도달 범위는
 * 다 큰 불 기준으로 고정**하고, **세기만** 이 상수로 오르내리게 둔다.
 *
 * 45초면 바로 옆 감지기가 10초쯤에, 반쯤 떨어진 감지기가 30초에 경고·60초에
 * 차단을 넘는다. 발표하며 «지금 올라가고 있습니다» 를 말할 시간이 나온다.
 */
const HEAT_TAU_MS = 45_000;

let timer = null;

/**
 * 한 지점의 지금 온도.
 *
 * 여러 불이 있으면 **가장 뜨겁게 만드는 것 하나**를 쓴다. 더하면 멀리 있는
 * 불 두 개가 합쳐져 아무 일 없는 복도를 60℃로 만든다.
 *
 * @param {{x:number,y:number}} at 감지기 자리
 * @param {Array<{ax,ay,bx,by,type:string,elapsedMs:number,unit?:number}>} fires
 *        불난 **통로 구간**. 점이 아니라 선분이다 — 아래 설명 참고.
 * @param {number} jitter 0~1 — 같은 값이 계속 나오면 화면이 멈춘 것처럼 보인다
 */
export function heatAt(at, fires = [], jitter = 0) {
  let peak = BASE_C + jitter * 1.4;
  for (const f of fires) {
    const type = SPREAD[f.type] ? f.type : 'fire';
    if (type === 'crowd') continue;              // 사람이 몰려도 안 뜨겁다
    // **불난 통로는 점이 아니라 선분이다.**
    //
    // 처음에는 통로의 가운데 한 점으로 뒀는데, NORTH STREET 처럼 긴 복도는
    // 가운데가 양끝 분기점에서 259px 나 떨어진다. 그래서 복도 전체가 타도
    // 그 복도의 감지기가 하나도 안 울렸다 — 감지기를 단 의미가 없어진다.
    //
    // 선분까지의 거리로 재면 «이 복도가 탄다» 가 «이 복도의 감지기가 운다» 로
    // 바로 이어지고, 방에서 난 불(방↔분기점 통로)은 그 분기점을 데운다.
    const d = distToSegment(at, f);
    // 도달 범위는 **다 큰 불** 기준으로 고정한다. 시간은 아래 세기에만 쓴다 —
    // 둘 다 시간에 걸면 «범위가 커질 때까지» 와 «뜨거워질 때까지» 가 겹쳐
    // 곱해져서, 옆에 있는 감지기가 우는 데 몇 분이 걸린다.
    const reach = SPREAD[type].rMax * (f.unit ?? 1) * REACH;
    if (!reach || d >= reach) continue;
    // 가운데가 제일 뜨겁고 가장자리에서 평상 온도로 떨어진다.
    // 제곱으로 떨어뜨린다 — 선형이면 «불에서 먼데 왜 이렇게 뜨겁지» 가 된다.
    const near = 1 - d / reach;
    // **시간이 온도를 정한다 — 거리만이 아니라.**
    //
    // 처음에는 거리만 봤다. 그런데 감지기는 분기점에 있고 불난 통로의 끝이
    // 곧 그 분기점이라 거리가 0 이다. 그래서 불을 넣는 **순간** 240℃ 가 되고
    // 통로 일곱 개가 동시에 끊겼다 — 화면의 불은 아직 점만 한데 말이다.
    //
    // 실제 구획 화재도 그렇게 안 된다. 발화하고 감지기가 뜨거워질 때까지
    // 시간이 걸린다(`HEAT_TAU_MS`).
    const grown = 1 - Math.exp(-Math.max(0, f.elapsedMs || 0) / HEAT_TAU_MS);
    const top = type === 'smoke' ? SMOKE_PEAK_C : FIRE_PEAK_C;
    peak = Math.max(peak, BASE_C + (top - BASE_C) * near * near * grown);
  }
  return Math.round(peak * 10) / 10;
}

/**
 * 한 지점의 지금 **감광률(%/m)**.
 *
 * 열과 같은 꼴이되 세 가지가 다르다 — 더 멀리 가고(1.6배), 더 빨리 차오르며
 * (τ 22초 vs 45초), **연기 위험은 연기가 제일 세게 만든다.** 화재도 연기를
 * 내지만, 「연기」 로 표시한 구간이 연기감지기에게는 더 진한 값이다.
 */
export function smokeAt(at, fires = [], jitter = 0) {
  const s = SPEC_SMOKE;
  let peak = s.base + jitter * 0.5;
  for (const f of fires) {
    const type = SPREAD[f.type] ? f.type : 'fire';
    if (type === 'crowd') continue;
    const d = distToSegment(at, f);
    const reach = SPREAD[type].rMax * (f.unit ?? 1) * REACH * SMOKE_REACH_X;
    if (!reach || d >= reach) continue;
    const near = 1 - d / reach;
    const grown = 1 - Math.exp(-Math.max(0, f.elapsedMs || 0) / SMOKE_TAU_MS);
    // 연기로 표시한 구간이 불보다 진하다 — 그게 그 표시의 뜻이다
    const top = type === 'smoke' ? SMOKE_PEAK : SMOKE_PEAK * 0.8;
    peak = Math.max(peak, s.base + (top - s.base) * near * near * grown);
  }
  return Math.round(peak * 10) / 10;
}

/** 점에서 선분까지의 거리. 통로는 선분이므로 이걸로 잰다. */
function distToSegment(p, seg) {
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p.x - seg.ax) * dx + (p.y - seg.ay) * dy) / L)) : 0;
  return Math.hypot(p.x - (seg.ax + dx * t), p.y - (seg.ay + dy * t));
}

/** 지금 도면에 실제로 있는 감지기들 */
export async function mountedSensors() {
  const plan = await activeFloorPlan();
  if (!plan) return [];
  return detectorSpots(plan)
    .map(s => ({ ...s, node: plan.getNode?.(s.nodeId) }))
    .filter(s => s.node && Number.isFinite(s.node.x));
}

/**
 * 한 바퀴 — 감지기마다 지금 온도를 **진짜 감지기와 같은 경로로** 올린다.
 * @returns {Promise<Array<{sensorId, nodeId, celsius}>>}
 */
export async function tick() {
  const mounted = await mountedSensors();
  if (!mounted.length) return [];

  const repo = await getRepo();
  const plan = await activeFloorPlan();
  const manual = await repo.getHazards();

  // 불난 통로를 **선분 그대로** 담는다 — 긴 복도의 가운데 한 점으로 줄이면
  // 그 복도의 감지기가 오히려 반응 범위 밖으로 나간다.
  const now = Date.now();
  const unit = (plan.image?.width || 1000) / 400;
  const fires = [];
  for (const [edgeId, h] of Object.entries(manual || {})) {
    if (!h?.type || h.type === 'clear') continue;
    const e = plan.edges?.find(x => x.id === edgeId);
    const a = e && plan.getNode(e.a);
    const b = e && plan.getNode(e.b);
    if (!a || !b) continue;
    fires.push({
      ax: a.x, ay: a.y, bx: b.x, by: b.y,
      type: h.type, elapsedMs: now - (h.updatedAt ?? now), unit,
    });
  }

  const out = [];
  for (const s of mounted) {
    // 지점마다 다른 흔들림 — 스무 개가 소수점까지 똑같으면 «가짜» 로 읽힌다.
    // 실제 감지기도 가만히 있어도 값이 조금씩 움직인다.
    const jitter = (Math.sin(now / 9000 + s.nodeId.length + s.id.length) + 1) / 2;
    const value = s.kind === DETECTOR.SMOKE
      ? smokeAt(s.node, fires, jitter)
      : heatAt(s.node, fires, jitter);

    // **상태 기계는 여기 하나뿐이다.** 화면이 따로 문턱을 들면 언젠가 서로
    // 다른 말을 하고, 그때 어느 쪽이 맞는지 가릴 방법이 없다.
    const det = detectorFor(s);
    det.push(value, now);

    await repo.setSensorReading({
      sensorId: s.id, edgeId: null, nodeId: s.nodeId,
      // 열은 예전 그대로 `celsius` 로도 보낸다 — 온도 문턱으로 통로를 끊는
      // 기존 경로(`hazardsFromSensors`)가 이 이름을 보고 있다.
      celsius: s.kind === DETECTOR.HEAT ? value : undefined,
      ...det.toJSON(now),
    });
    out.push(det.toJSON(now));
  }
  return out;
}

/**
 * 감지기 하나의 상태 기계를 기억해 둔다.
 *
 * 축적(«20초 지속되면 화재 확정»)은 **기억이 있어야** 판정된다. 매번 새로
 * 만들면 매번 «방금 넘었다» 가 되어 영영 확정이 안 된다.
 */
const detectors = new Map();
function detectorFor(spot) {
  let d = detectors.get(spot.id);
  if (!d) { d = new Detector(spot); detectors.set(spot.id, d); }
  return d;
}

/** 수신기가 보는 목록 — 화면이 이 순서로 그린다 */
export function detectorList(now = Date.now()) {
  return [...detectors.values()].map(d => (d.tick(now), d.toJSON(now)));
}

/** 시나리오 초기화 — 축적 기억까지 지운다 */
export function resetDetectors() { detectors.clear(); }

/** 서버가 사는 동안 감지기도 산다 */
export function startHeatSensors() {
  if (timer) return;
  // 첫 보고를 바로 한 번 — 안 그러면 12초 동안 관제에 감지기가 0대로 보인다
  tick().then(r => {
    if (r.length) {
      const smoke = r.filter(x => x.kind === 'smoke').length;
      console.log(`  화재감지기 ${r.length}대 가동 — 연기 ${smoke} · 열 ${r.length - smoke}`
        + ' (시뮬레이션 · SIM- 접두)');
    }
  }).catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

export function stopHeatSensors() {
  clearInterval(timer);
  timer = null;
}
