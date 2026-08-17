/**
 * 방향 확인 모드 — "나의 찾기" 식 탐색 피드백.
 *
 * 기존 안내(guidance.js)는 **걸음마다 한 번** 말해준다. 그래서 걷는 도중
 * "지금 이 방향이 맞나?"를 확인할 방법이 없다. 시각장애인은 그 확신이 없으면
 * 발을 못 뗀다.
 *
 * 여기서는 폰을 쥔 손을 좌우로 훑으면 **맞는 쪽에서 신호가 강해진다.**
 * 아이폰 '나의 찾기'와 같은 방식이다 — 방향을 공간이 아니라 **시간축**에 담는다.
 * (폰은 진동 모터가 하나뿐이라 "왼쪽만 진동" 같은 건 물리적으로 불가능하다.)
 *
 * ## 왜 누르고 있을 때만 울리나
 *
 * 계속 소리를 내면 화재경보·사람 목소리·지팡이 소리를 가린다. 시각장애인에게
 * 주변 소리는 시야에 해당하므로, 그걸 덮는 안내는 도움이 아니라 위험이다.
 * 그래서 **화면을 누르고 있는 동안만** 신호가 나간다. 손을 떼면 즉시 조용해진다.
 *
 * ## 두 채널을 함께 쓴다
 *
 *   소리  좌우 스테레오 + 빠르기  ← 방향이 실제로 좌우에서 들린다
 *   진동  빠르기                  ← 안드로이드만 (iOS Safari 는 진동 API 미지원)
 *
 * 소리가 주 채널인 이유는 **폰 모터로는 방향을 표현할 수 없기** 때문이다.
 * 스테레오는 좌우가 실제로 갈리므로 부호를 외울 필요가 없다.
 */

const ALIGNED_DEG = 12;    // 이 안에 들면 "정면"
const WIDE_DEG = 60;       // 이보다 크게 벗어나면 "완전히 다른 방향"

// 정렬도(0~1)에 따른 신호 간격(ms). 맞을수록 촘촘해진다.
const FAST_MS = 90;
const SLOW_MS = 620;

// 근접도가 0일 때도 남겨두는 세기. 출발 직후에 아무 신호도 없으면
// "방향이 맞는지"를 확인할 수가 없다.
const NEAR_BASE = 0.45;

// 진동 길이(ms). 웹 진동 API 는 **세기를 조절할 수 없고 길이만** 지정할 수 있다.
// 그래서 "강함"을 길이로 흉내낸다. (네이티브 앱이면 iOS Core Haptics /
// Android VibrationEffect 로 실제 진폭을 조절할 수 있다.)
const BUZZ_MIN = 15;
const BUZZ_MAX = 70;

export class CompassGuide {
  /**
   * @param {() => number|null} getError  현재 방위 오차(도). 양수 = 목표가 오른쪽.
   *                                      센서가 없으면 null.
   * @param {() => number} getProximity   다음 지점까지의 근접도 0~1 (1 = 코앞).
   */
  constructor(getError, getProximity = () => 0) {
    this.getError = getError;
    this.getProximity = getProximity;
    this.active = false;
    this._timer = null;
    this._ctx = null;
    this._lastState = null;
    this.onState = null;   // (텍스트, 정렬도) — 화면 표시·로그용
  }

  /** 사용자가 화면을 누른 순간 */
  start() {
    if (this.active) return;
    const err = this.getError();
    if (err === null) {
      this._announce('방향 센서를 쓸 수 없습니다', 0);
      return false;
    }
    this.active = true;
    this._ensureAudio();
    this._tick();
    return true;
  }

  /** 손을 뗀 순간 — 즉시 조용해져야 한다 */
  stop() {
    this.active = false;
    clearTimeout(this._timer);
    this._timer = null;
    this._lastState = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }

  // ---------------------------------------------------------------- 내부

  _ensureAudio() {
    if (!this._ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) this._ctx = new Ctx();
    }
    // iOS 는 사용자 제스처 안에서 resume 해야 소리가 난다
    if (this._ctx && this._ctx.state === 'suspended') this._ctx.resume();
  }

  _tick() {
    if (!this.active) return;

    const err = this.getError();
    if (err === null) { this.stop(); return; }

    const abs = Math.abs(err);
    // 정렬도 0~1 — 정면이 1, WIDE_DEG 밖이면 0
    const align = abs <= ALIGNED_DEG ? 1
      : abs >= WIDE_DEG ? 0
      : 1 - (abs - ALIGNED_DEG) / (WIDE_DEG - ALIGNED_DEG);

    // 근접도 0~1. 방향이 맞아도 아직 멀면 약하게, 코앞이면 강하게.
    // 둘을 곱하지 않고 바닥값(BASE)을 두는 이유: 출발 직후(근접도 0)에도
    // 방향이 맞으면 그걸 느낄 수 있어야 하기 때문이다.
    const near = Math.max(0, Math.min(1, this.getProximity()));
    const strength = align * (NEAR_BASE + (1 - NEAR_BASE) * near);

    this._beep(err, align, strength);
    this._buzz(strength);
    this._reportState(abs, err, align);

    // 빠르기는 정렬도만 따른다 — 훑는 동안 즉각 반응해야 방향을 찾을 수 있다.
    const gap = SLOW_MS - (SLOW_MS - FAST_MS) * align;
    this._timer = setTimeout(() => this._tick(), gap);
  }

  /**
   * 한 번의 신호음. 목표가 오른쪽이면 오른쪽 귀에서, 왼쪽이면 왼쪽 귀에서 난다.
   * 정면에 가까울수록 가운데로 모이고 음이 높아진다.
   */
  _beep(err, align, strength) {
    const ctx = this._ctx;
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // 440Hz(벗어남) → 880Hz(정면). 음이 높아지는 것만으로도 방향을 좁힐 수 있다.
    osc.frequency.value = 440 + 440 * align;

    let node = gain;
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      // 목표가 오른쪽(err>0)이면 소리도 오른쪽에서. 정면이면 가운데.
      pan.pan.value = Math.max(-1, Math.min(1, err / WIDE_DEG));
      gain.connect(pan);
      node = pan;
    }
    node.connect(ctx.destination);
    osc.connect(gain);

    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.06 + 0.28 * strength, t + 0.01);
    gain.gain.linearRampToValueAtTime(0, t + 0.07);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  /**
   * 진동. 웹 API 는 진폭을 못 바꾸므로 **길이로 세기를 대신한다.**
   * iOS Safari 는 진동 자체가 없어 아무 일도 일어나지 않는다(소리가 주 채널).
   */
  _buzz(strength) {
    if (!navigator.vibrate) return;
    navigator.vibrate(Math.round(BUZZ_MIN + (BUZZ_MAX - BUZZ_MIN) * strength));
  }

  /** 상태가 바뀔 때만 화면·로그에 알린다 (매 신호마다 갱신하면 읽을 수 없다) */
  _reportState(abs, err, align) {
    const state = abs <= ALIGNED_DEG ? 'aligned'
      : abs >= WIDE_DEG ? 'far'
      : (err > 0 ? 'right' : 'left');
    if (state === this._lastState) return;
    this._lastState = state;

    const text =
      state === 'aligned' ? '정면입니다' :
      state === 'far' ? '많이 벗어났습니다' :
      state === 'right' ? '오른쪽으로 조금 더' : '왼쪽으로 조금 더';
    this._announce(text, align);
  }

  _announce(text, align) {
    if (this.onState) this.onState(text, align);
  }
}
