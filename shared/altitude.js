/**
 * 기압 → 층 이동 판정. 엘리베이터와 계단을 **공짜 앵커**로 만든다.
 *
 * ## 왜 이게 앵커가 되는가
 *
 * 층이 바뀌었다는 것은 엘리베이터나 계단을 지났다는 뜻이고, 둘 다 도면에서
 * **위치가 정해진 지점**이다(`NODE_TYPES` 의 `elevator`, `stair`). 즉 층 변화를
 * 감지하는 것만으로 "지금 엘리베이터 앞"이라는 확정 단서가 생긴다.
 *
 * 기기를 사지 않아도 되고, 설치할 것도 없고, 배터리도 안 든다. 폰에 이미 있다.
 *
 * ## 절대 고도는 쓸 수 없다
 *
 * 기압은 날씨로 하루에도 몇 hPa 씩 움직인다. 한 층이 약 0.42 hPa 인데 날씨 변화가
 * 그보다 열 배 크므로, "지금 기압이 1013 이니 3층"같은 계산은 불가능하다.
 *
 * 그래서 **변화만** 본다. 기준선(baseline)을 두고, 기준선이 날씨는 천천히 따라가되
 * 층 이동처럼 빠른 변화는 못 따라가게 한다. 층 이동은 기준선에서 벗어나는 사건으로
 * 나타난다.
 *
 * ## 엘리베이터와 계단 구분
 *
 * 고도가 변하는 동안 걸었는지만 보면 된다.
 *
 *   걸음 거의 없음 + 고도 변화  →  엘리베이터
 *   걸음 많음      + 고도 변화  →  계단
 *
 * ## 시간을 부르지 않는다
 *
 * `Date.now()` 대신 `now` 를 인자로 받는다. 테스트가 30분치 날씨 변화를 몇
 * 밀리초에 감아 돌려야 "드리프트를 층 이동으로 오인하지 않는가"를 검증할 수 있다.
 * (`positioning.js`, `fusion.js` 와 같은 원칙)
 */

export const ALTITUDE_DEFAULTS = {
  /** 해수면 근처에서 1 hPa ≈ 8.33 m */
  metersPerHpa: 8.33,
  /** 층고(m). 건물마다 다르면 도면에서 넘긴다 */
  floorHeight: 3.5,

  /** 저역통과 계수 — 작을수록 매끄럽고 굼뜨다 */
  smoothAlpha: 0.25,
  /** 기준선에서 이만큼 벗어나면 "이동 중"으로 본다 (한 층의 1/3쯤) */
  moveThresholdM: 1.2,
  /**
   * 최근 이 시간 동안의 고도 변동폭이 `settleBandM` 안이면 이동이 끝난 것으로 본다.
   *
   * 이 두 값의 비가 **감지 가능한 최저 속도**를 정한다 (0.45m / 6s = 0.075 m/s).
   * 처음엔 0.5m / 4s = 0.125 m/s 로 뒀는데, **계단으로 한 층 오르는 실제 속도가
   * 0.09~0.175 m/s** 라 그 한가운데를 자르고 있었다. 느리게 걸어 오르면 이동
   * 중간에 "도착했다"고 판정하고, 조각난 변화는 각각 한 층에 못 미쳐 전부 버려졌다.
   */
  settleMs: 6000,
  settleBandM: 0.45,

  /**
   * 정지 중 기준선이 실제 고도를 따라가는 속도(m/s) — 날씨 드리프트 흡수용.
   *
   * 날씨는 보통 시간당 8~25m 상당(1~3 hPa)으로 움직이는데, 이 값이면 시간당 36m 를
   * 따라갈 수 있어 충분하다. 반대로 계단으로 한 층 오르는 30초 동안 흡수되는 양은
   * 0.3m 뿐이라 3.5m 짜리 층 이동을 지우지는 못한다.
   */
  baselineDriftPerSec: 0.01,

  /** 이보다 작은 변화는 층 이동으로 보지 않는다 (문 여닫힘·공조·바람) */
  minFloorM: 2.0,
  /** 이동 중 걸음이 이 이하면 엘리베이터로 본다 */
  elevatorMaxSteps: 6,
};

export class AltitudeTracker {
  constructor(opts = {}) {
    this.opts = { ...ALTITUDE_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.refHpa = null;     // 첫 측정값 — 여기를 고도 0 으로 둔다
    this.altM = null;       // 평활 고도(상대)
    this.baselineM = 0;     // 기준선. 날씨는 따라가고 층 이동은 못 따라간다
    this.moving = null;     // { startAlt, startSteps, lastMoveAt, lastAlt }
    this.lastAt = null;
    this.floorOffset = 0;   // 시작 층 기준 누적 층수 (+1 = 한 층 위)
  }

  /**
   * 측정값 하나 주입.
   * @param {number} hPa   기압
   * @param {number} now   측정 시각(ms)
   * @param {number} steps 누적 걸음 수 (엘리베이터/계단 구분용)
   * @returns {{kind:'elevator'|'stair', floors:number, meters:number, steps:number}|null}
   *          층 이동이 **끝난 순간** 한 번만 결과를 낸다. 그 외에는 null.
   */
  push(hPa, now, steps = 0) {
    if (!Number.isFinite(hPa)) return null;
    const o = this.opts;

    if (this.refHpa === null) {
      this.refHpa = hPa;
      this.altM = 0;
      this.baselineM = 0;
      this.lastAt = now;
      return null;
    }

    const raw = -(hPa - this.refHpa) * o.metersPerHpa;   // 기압이 낮을수록 높다
    this.altM = o.smoothAlpha * raw + (1 - o.smoothAlpha) * this.altM;
    const dt = Math.max(0, (now - this.lastAt) / 1000);
    this.lastAt = now;

    if (!this.moving) {
      // 기준선이 실제 고도를 천천히 따라간다 — 날씨를 흡수하는 부분
      const gap = this.altM - this.baselineM;
      const maxDrift = o.baselineDriftPerSec * dt;
      this.baselineM += Math.max(-maxDrift, Math.min(maxDrift, gap));

      if (Math.abs(this.altM - this.baselineM) > o.moveThresholdM) {
        this.moving = {
          startAlt: this.baselineM,
          startSteps: steps,
          window: [{ t: now, alt: this.altM }],
        };
      }
      return null;
    }

    // 이동 중 — 최근 settleMs 구간의 변동폭이 좁아질 때까지 기다린다.
    //
    // 직전 표본과만 비교하면 안 된다. 계단을 천천히 오르면 1초당 0.1m 씩만
    // 움직여서 매 표본이 "거의 안 움직였다"로 보이고, 이동 한복판에서 도착
    // 판정이 나 버린다. 구간 전체의 최대-최소를 봐야 느린 이동도 이동으로 남는다.
    const w = this.moving.window;
    w.push({ t: now, alt: this.altM });
    while (w.length > 1 && now - w[0].t > o.settleMs) w.shift();
    if (now - w[0].t < o.settleMs) return null;

    let lo = Infinity, hi = -Infinity;
    for (const s of w) { if (s.alt < lo) lo = s.alt; if (s.alt > hi) hi = s.alt; }
    if (hi - lo > o.settleBandM) return null;

    // 도착
    const meters = this.altM - this.moving.startAlt;
    const walked = steps - this.moving.startSteps;
    this.baselineM = this.altM;
    this.moving = null;

    if (Math.abs(meters) < o.minFloorM) return null;   // 층 이동이라기엔 작다

    const floors = Math.sign(meters) * Math.max(1, Math.round(Math.abs(meters) / o.floorHeight));
    this.floorOffset += floors;
    return {
      kind: walked <= o.elevatorMaxSteps ? 'elevator' : 'stair',
      floors,
      meters,
      steps: walked,
    };
  }

  /** 지금 층을 이동하는 중인가 — 화면이 "이동 중입니다"를 띄울 근거 */
  get inTransit() { return this.moving !== null; }
}
