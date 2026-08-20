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
import { activeFloorPlan } from './floor.js';
import { getRepo } from './repositories/index.js';

/**
 * 감지기를 달 지점. **분기점과 승강기 앞** — 경로가 갈리는 곳이다.
 *
 * 도면에 없는 지점은 조용히 건너뛴다. 다른 건물 도면을 올렸을 때 서버가
 * 죽으면 안 되고, 그 도면에는 그 도면의 분기점이 있을 것이다.
 */
export const HEAT_SPOTS = [
  { id: 'SIM-HEAT-NS3', nodeId: 'J_NS3', label: 'NORTH STREET 서쪽' },
  { id: 'SIM-HEAT-NS4', nodeId: 'J_NS4', label: 'NORTH STREET 동쪽' },
  { id: 'SIM-HEAT-ALLEY', nodeId: 'J_ALLEY', label: 'LOCKER ALLEYWAY' },
  { id: 'SIM-HEAT-SS1', nodeId: 'J_SS1', label: 'SOUTH STREET 서쪽' },
  { id: 'SIM-HEAT-SS2', nodeId: 'J_SS2', label: 'SOUTH STREET 동쪽' },
  { id: 'SIM-HEAT-ELE', nodeId: 'ELEWAY', label: '엘리베이터 앞' },
];

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
  return HEAT_SPOTS
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
    // 지점마다 다른 흔들림 — 여섯 개가 소수점까지 똑같으면 «가짜» 로 읽힌다
    const jitter = (Math.sin(now / 9000 + s.nodeId.length) + 1) / 2;
    const celsius = heatAt(s.node, fires, jitter);
    await repo.setSensorReading({
      sensorId: s.id, edgeId: null, nodeId: s.nodeId, celsius,
    });
    out.push({ sensorId: s.id, nodeId: s.nodeId, celsius });
  }
  return out;
}

/** 서버가 사는 동안 감지기도 산다 */
export function startHeatSensors() {
  if (timer) return;
  // 첫 보고를 바로 한 번 — 안 그러면 12초 동안 관제에 감지기가 0대로 보인다
  tick().then(r => {
    if (r.length) console.log(`  열감지기 ${r.length}대 가동 (시뮬레이션 · SIM- 접두)`);
  }).catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}

export function stopHeatSensors() {
  clearInterval(timer);
  timer = null;
}
