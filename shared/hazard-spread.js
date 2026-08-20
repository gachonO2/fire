/**
 * 불은 **점이 아니라 번지는 것이다.**
 *
 * ## 왜 크기를 시간의 함수로 두나
 *
 * 지금까지 화재는 고정 반지름의 빨간 원이었다. 그러면 화면이 «저기 불이 났다»
 * 까지만 말하고, 관제가 정작 알아야 할 «지금 더 커지고 있나, 멎었나» 를 말하지
 * 않는다. 5분 전에 난 불과 방금 난 불이 똑같이 생겼으면, 어느 쪽을 먼저 끊어야
 * 하는지 화면만 보고는 못 정한다.
 *
 * 그래서 반지름을 **불이 난 뒤 흐른 시간**에서 계산한다. 서버가 이미
 * `hazards[edgeId].updatedAt` 을 들고 있으므로 새로 저장할 값은 없다.
 *
 * ## 왜 지수 곡선인가
 *
 * 선형으로 키우면 시연 5분째에 층 전체를 덮는다. 실제 구획 화재도 그렇게 되지
 * 않는다 — 방 하나를 채우면 문·벽에 막혀 성장이 느려지고, 산소와 연료가 정하는
 * 한계에서 멎는다.
 *
 *     r(t) = rMax − (rMax − r0)·e^(−t/τ)
 *
 * 처음엔 빠르고, `rMax` 에 붙으면서 느려진다. 넘어가지 않으므로 «불이 도면을
 * 다 먹어 버리는» 그림이 안 나온다.
 *
 * ## τ 는 시연이 정한다
 *
 * 물리 상수가 아니라 **보는 사람이 변화를 알아채는 속도**다. τ=70초면 30초 뒤
 * 35%, 1분 뒤 58%, 3분 뒤 92% 까지 온다. 발표 중 "지금 번지고 있습니다" 를
 * 말하는 동안 실제로 커지는 것이 눈에 보이는 값이다. 진짜 화재 확산 모델이
 * 아니라는 뜻이고, 화면에도 «예상 확산» 으로 적어야 한다.
 *
 * ## 종류마다 다르게 번진다
 *
 * 연기는 불보다 **멀리, 빨리** 간다 — 실제로 사람을 먼저 잡는 것도 연기다.
 * 혼잡은 번지지 않는다(사람이 몰린 자리는 그 자리다). 시간을 안 쓰는 것도
 * 이 함수가 답할 수 있어야 한다.
 */

/** 종류별 번짐 성질. 단위는 도면 좌표(px)가 아니라 **배율 u** 의 배수다. */
export const SPREAD = Object.freeze({
  //        r0   rMax  tau(ms)  설명
  fire:  { r0: 2.2, rMax: 13.5, tauMs: 70_000 },
  smoke: { r0: 3.4, rMax: 22, tauMs: 45_000 },   // 더 크고 더 빠르다
  crowd: { r0: 6.0, rMax: 6.5, tauMs: 60_000 },  // 사실상 안 번진다
  temp:  { r0: 3.0, rMax: 8, tauMs: 90_000 },
  // 감지기가 만든 위험. 화면에서는 덩어리로 안 그리지만(불이 이미 그 자리를
  // 말한다), 값을 물으면 답할 수 있어야 한다 — 없으면 «불» 로 되돌아가
  // 엉뚱한 색과 이름이 나온다.
  heat:  { r0: 3.0, rMax: 8, tauMs: 90_000 },
  warm:  { r0: 2.5, rMax: 6, tauMs: 90_000 },
  blocked: { r0: 3.0, rMax: 4, tauMs: 1 },
  clear: { r0: 0, rMax: 0, tauMs: 1 },
});

/** 이 시간이 지나면 «다 컸다» 로 보고 더 그리지 않는다 (τ의 4배 ≈ 98%) */
export const SETTLED_AT = 4;

/**
 * 불이 난 뒤 `elapsedMs` 지난 시점의 반지름.
 *
 * @param {number} elapsedMs 발생 후 흐른 시간(ms). 음수는 0으로 본다.
 * @param {string} type `SPREAD` 의 키
 * @returns {number} 배율 u 의 배수
 */
export function spreadRadius(elapsedMs, type = 'fire') {
  const s = SPREAD[type] || SPREAD.fire;
  const t = Math.max(0, Number(elapsedMs) || 0);
  return s.rMax - (s.rMax - s.r0) * Math.exp(-t / s.tauMs);
}

/**
 * 0(막 났다) ~ 1(다 컸다). 화면의 «번짐» 막대와 글씨에 쓴다.
 *
 * 반지름 비율이 아니라 **성장 곡선상의 위치**다. 반지름은 r0 에서 시작하므로
 * 반지름 비율을 그대로 쓰면 0초에 이미 24% 가 되어 «막 났다» 를 못 말한다.
 */
export function spreadProgress(elapsedMs, type = 'fire') {
  const s = SPREAD[type] || SPREAD.fire;
  const t = Math.max(0, Number(elapsedMs) || 0);
  return Math.min(1, 1 - Math.exp(-t / (s.tauMs * SETTLED_AT)));
}

/** «3분 12초째 번지는 중» — 관제 목록과 툴팁이 같은 문장을 쓰게 한다. */
export function spreadLabel(elapsedMs, type = 'fire') {
  const t = Math.max(0, Number(elapsedMs) || 0);
  const sec = Math.floor(t / 1000);
  const clock = sec < 60 ? `${sec}초` : `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  const grown = spreadProgress(t, type) >= 0.9;
  const verb = type === 'crowd' ? '유지' : grown ? '확산 멈춤' : '번지는 중';
  return `${clock}째 · ${verb}`;
}
