/**
 * 걸음 검출 — **흔든 것과 걸은 것을 가른다.**
 *
 * ## 왜 갈라야 하나
 *
 * 예전 검출기는 가속도 크기의 봉우리만 셌다(0.18g 넘고 260ms 지났으면 한 걸음).
 * 그러면 **폰을 흔들기만 해도 위치가 앞으로 간다.** 시연에서 곧바로 드러나는
 * 문제지만, 진짜 위험은 다른 데 있다 — 시각장애인은 걸음 수로 "몇 미터 남았다"를
 * 믿는다. 주머니에서 폰을 꺼내거나 지팡이를 고쳐 쥐는 동작이 걸음으로 세어지면
 * **걷지도 않았는데 모퉁이를 지나친 것이 된다.**
 *
 * ## 무엇으로 가르나
 *
 * 걷기는 몸이 위아래로 튀는 운동이다. 발이 땅을 밀 때마다 **중력 방향으로** 가속이
 * 실린다. 손을 흔드는 동작은 대개 앞뒤·좌우라 그 성분이 작다. 그래서 가속도의
 * 크기가 아니라 **중력 축에 투영한 성분**을 본다. 폰이 어떤 자세로 들려 있어도
 * 중력 방향은 저역통과로 알 수 있으므로, 세워 들든 눕혀 들든 같은 판정이 된다.
 *
 * 여기에 사람 몸의 한계를 두 겹 더한다.
 *
 *   빠르기  한 걸음은 300ms 보다 빠를 수 없다 (달려도 그렇다)
 *   세기    1.3g 를 넘는 봉우리는 걸음이 아니라 충격이다 (폰을 털거나 부딪힘)
 *   리듬    걷기는 규칙적이다. 멈췄다 다시 걸을 때 **첫 두 걸음의 간격이 서로
 *           비슷할 때만** 걷기로 인정한다
 *
 * ## 리듬을 볼 때 걸음을 버리지 않는다
 *
 * 리듬을 확인하려면 두 걸음을 봐야 하는데, 그 두 걸음을 버리면 걸을 때마다 1.4m 씩
 * 모자란다. 그래서 **보류했다가 확인되는 순간 함께 내보낸다.** 0.6초쯤 늦게 오지만
 * 개수는 맞다. (`expo-sensors` 의 만보기를 안 쓴 이유가 «몇 걸음 뒤에 몰아서 준다»
 * 였는데, 그건 걸음이 **몇 초** 늦는 것이고 이건 걷기 시작할 때 한 번뿐이다.)
 *
 * ## 그래도 못 가르는 것
 *
 * 폰을 **위아래로 규칙적으로** 흔들면 가속도계만으로는 제자리걸음과 구분되지
 * 않는다. 물리적으로 같은 신호다. 그건 비콘 앵커가 «그 자리에 있다» 고 계속
 * 말해 주는 것으로 잡아야 하고, 실제로 판단 계층이 그렇게 되어 있다.
 *
 * 이 계층은 `Date.now()` 를 부르지 않는다 — 시험이 시간을 감을 수 있어야
 * 리듬 판정을 검증할 수 있기 때문이다. (`positioning.js` 와 같은 원칙)
 */

export const STEP_DEFAULTS = {
  /** 중력 분리용 저역통과 계수 */
  gravityAlpha: 0.8,
  /** 이보다 약한 봉우리는 걸음으로 안 본다 (g) */
  minPeak: 0.18,
  /** 이보다 센 봉우리는 걸음이 아니라 충격이다 (g) */
  maxPeak: 1.3,
  /** 봉우리에서 중력 축 성분이 차지해야 하는 최소 비율 */
  verticalRatio: 0.5,
  /**
   * 한 걸음의 최소 간격 (ms) — 2.9걸음/초 상한.
   *
   * 달리기 보속(3걸음/초)까지 열어 두려다 340 으로 조였다. 손으로 흔드는 동작이
   * 3Hz 부근에 몰려 있어서 그 위를 열어 두면 그대로 통과한다. 이 앱이 안내하는
   * 사람은 지팡이를 짚고 걷는다 — 초당 세 걸음은 애초에 나오지 않는 값이고,
   * 열어 둬서 얻는 것보다 잃는 것이 크다.
   */
  minStepMs: 340,
  /** 이보다 오래 조용하면 걷기가 끊긴 것으로 본다 (ms) */
  maxStepMs: 2000,
  /** 다시 걷기 시작할 때 리듬을 확인할 걸음 수 */
  warmupSteps: 2,
  /** 리듬이 맞다고 볼 간격 차이 비율 */
  cadenceTolerance: 0.45,
  /**
   * 1초 안에 이보다 많은 봉우리가 오면 걷기가 아니다.
   *
   * 최소 간격만으로는 부족했다. 5Hz 로 털면 봉우리 절반이 «너무 빠름» 으로
   * 버려지는데, **남은 절반이 2.5Hz 로 규칙적**이라 걷기 리듬 검사를 그대로
   * 통과한다. 버린 것까지 세어야 «이건 걷는 게 아니다» 가 보인다.
   */
  maxPeaksPerSec: 4,
};

export class StepDetector {
  constructor(opts = {}) {
    this.opts = { ...STEP_DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this._gravity = null;
    this._prev = 0;
    this._rising = false;
    this._lastStepAt = 0;
    this._peakMax = 0;      // 지금 올라가는 중의 최고값
    this._pending = [];     // 리듬 확인 중인 봉우리 시각
    this._seen = [];        // 버린 것 포함한 최근 봉우리 시각 — 빠르기 판정용
    this._inStride = false; // 리듬이 확인된 상태
  }

  /** 지금 걷는 중인가 — 화면이 "멈춰 있음"을 표시하는 데 쓴다 */
  walking(now) {
    return this._inStride && now - this._lastStepAt <= this.opts.maxStepMs;
  }

  /**
   * 가속도 표본 하나.
   * @param {{x,y,z}} sample  g 단위 (중력 포함)
   * @param {number} now      ms
   * @returns {number} 이 표본으로 확정된 걸음 수 (보통 0, 리듬이 확인되는 순간 2)
   */
  push({ x = 0, y = 0, z = 0 } = {}, now) {
    const o = this.opts;

    // 중력은 천천히 변한다 — 저역통과로 뽑으면 폰의 «아래쪽» 을 알 수 있다
    if (!this._gravity) this._gravity = { x, y, z };
    else {
      this._gravity.x = o.gravityAlpha * this._gravity.x + (1 - o.gravityAlpha) * x;
      this._gravity.y = o.gravityAlpha * this._gravity.y + (1 - o.gravityAlpha) * y;
      this._gravity.z = o.gravityAlpha * this._gravity.z + (1 - o.gravityAlpha) * z;
    }
    const g = this._gravity;
    const gm = Math.hypot(g.x, g.y, g.z) || 1;

    // 몸의 움직임 = 측정값 − 중력
    const lx = x - g.x, ly = y - g.y, lz = z - g.z;
    const total = Math.hypot(lx, ly, lz);
    // 중력 축에 투영 — 걷기는 여기에 실리고, 손을 젓는 동작은 안 실린다.
    //
    // **절댓값을 씌우지 않는다.** 씌우면 한 걸음의 위·아래 두 국면이 각각 봉우리로
    // 잡혀 봉우리 수가 두 배가 된다. 그러면 빠르기 판정이 걷기를 흔들기로 몰고,
    // 최소 간격도 반 주기 기준이 되어 뜻이 어긋난다. 한 걸음에 봉우리 하나여야
    // «1초에 몇 걸음» 이 말 그대로의 뜻이 된다.
    const vertical = (lx * g.x + ly * g.y + lz * g.z) / gm;

    let confirmed = 0;

    // 봉우리 = 올라가다가 내려가기 시작하는 순간.
    //
    // 마지막 표본이 아니라 **올라가는 동안의 최고값**을 쓴다. 50Hz 로 재는데
    // 빠른 흔들림은 한 주기가 10 표본뿐이라, 마지막 값만 보면 실제 봉우리보다
    // 훨씬 작게 잡혀 «세기 상한» 검사를 그냥 빠져나간다.
    if (vertical > this._prev) {
      this._rising = true;
      this._peakMax = Math.max(this._peakMax, vertical);
    } else if (this._rising) {
      this._rising = false;
      confirmed = this._peak(Math.max(this._peakMax, this._prev), total, now);
      this._peakMax = 0;
    }
    this._prev = vertical;

    // 오래 조용하면 걷기가 끊긴 것 — 다음에 다시 리듬부터 확인한다
    if (now - this._lastStepAt > o.maxStepMs) {
      this._inStride = false;
      this._pending = [];
    }
    return confirmed;
  }

  /** 봉우리 하나를 걸음으로 인정할지 판단한다 */
  _peak(peak, total, now) {
    const o = this.opts;
    if (peak < o.minPeak) return 0;

    // 여기서부터는 «움직임» 이다. 세기·방향이 걷기와 달라도 **빠르기 판정에는
    // 넣는다** — 버린 것을 안 세면 빠른 흔들림이 느린 걷기로 위장된다.
    this._seen.push(now);
    while (this._seen.length && now - this._seen[0] > 1000) this._seen.shift();
    if (this._seen.length > o.maxPeaksPerSec) {
      this._inStride = false;
      this._pending = [];
      return 0;
    }

    if (peak > o.maxPeak) return 0;
    // 크기 대비 중력 축 성분이 작으면 걷기가 아니다 (좌우로 젓는 동작)
    if (total > 0 && Math.abs(peak) / total < o.verticalRatio) return 0;

    const gap = now - this._lastStepAt;
    if (gap < o.minStepMs) return 0;

    // 리듬이 이미 확인됐으면 그대로 한 걸음
    if (this._inStride && gap <= o.maxStepMs) {
      this._lastStepAt = now;
      return 1;
    }

    // 다시 걷기 시작하는 중 — 간격이 서로 비슷해질 때까지 보류한다
    this._pending.push(now);
    this._lastStepAt = now;
    if (this._pending.length < o.warmupSteps + 1) return 0;

    const gaps = [];
    for (let i = 1; i < this._pending.length; i++) {
      gaps.push(this._pending[i] - this._pending[i - 1]);
    }
    const steady = gaps.every(gp => gp >= o.minStepMs && gp <= o.maxStepMs)
      && gaps.every(gp => Math.abs(gp - gaps[0]) / gaps[0] <= o.cadenceTolerance);

    if (!steady) {
      this._pending.shift();   // 제일 오래된 것을 버리고 다시 본다
      return 0;
    }

    // 확인됐다 — 보류해 둔 것을 **함께** 내보낸다. 걸음을 버리지 않는다.
    const n = this._pending.length;
    this._pending = [];
    this._inStride = true;
    return n;
  }
}
