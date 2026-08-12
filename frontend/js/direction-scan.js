/**
 * 방향 스캔 — 금속탐지기처럼 폰을 좌우로 훑어 나아갈 방향을 찾는다.
 *
 * "오른쪽으로 30도 도세요"는 말로 듣고 몸으로 옮기는 데 시간이 걸린다.
 * 대신 폰을 쥔 손을 좌우로 쓸면, 맞는 방향에서 진동이 **끊기지 않고** 이어진다.
 * 사용자는 각도를 계산할 필요 없이 "진동이 안 끊기는 쪽"만 찾으면 된다.
 *
 *   0~8°    잠김   우우우웅——   (끊김 없는 연속 진동)
 *   8~20°   근접   우웅-우웅-   (짧게 끊김)
 *   20~40°  멀다   툭... 툭...  (뚝뚝 끊김)
 *   40~70°  가장자리 툭...... 툭......
 *   70°~    없음   (무음)
 *
 * 진동이 없는 기기(iOS Safari는 Vibration API를 지원하지 않는다)를 위해
 * 같은 규칙으로 소리도 함께 낸다. 방향이 맞을수록 음이 높고 끊김이 없다.
 */

/** 각도 구간 → 신호 등급. 경계는 당사자 실증에서 조정할 값이다. */
const LEVELS = [
  { id: 'lock', maxError: 8,   label: '연속 신호', pattern: [260],       period: 260, freq: 880, continuous: true },
  { id: 'near', maxError: 20,  label: '빠른 신호', pattern: [140, 70],   period: 210, freq: 700 },
  { id: 'far',  maxError: 40,  label: '느린 신호', pattern: [80, 260],   period: 340, freq: 540 },
  { id: 'edge', maxError: 70,  label: '드문 신호', pattern: [45, 620],   period: 665, freq: 400 },
  { id: 'none', maxError: 181, label: '신호 없음', pattern: null,        period: 700, freq: 0 },
];

export function levelForError(errorDeg) {
  const abs = Math.abs(errorDeg);
  return LEVELS.find(l => abs <= l.maxError) || LEVELS[LEVELS.length - 1];
}

export class DirectionScanner {
  /**
   * @param {Odometry} odometry 나침반 방위를 제공 (heading이 null이면 수동 방위 사용)
   */
  constructor({ odometry = null } = {}) {
    this.odometry = odometry;
    this.active = false;
    this.level = null;
    this.error = null;

    /** 나침반이 없는 환경(데스크톱 시연)에서 대신 쓸 방위 */
    this.manualHeading = null;

    /** 소리도 함께 낼지 — 진동이 없는 기기 대비 */
    this.sound = true;

    this.onUpdate = () => {};
    this._getTarget = () => null;
    this._tickTimer = null;
    this._pulseTimer = null;
    this._audio = null;
  }

  get heading() {
    return this.manualHeading ?? this.odometry?.heading ?? null;
  }

  /** @param {() => number|null} getTargetBearing 나아가야 할 방위(도) */
  start(getTargetBearing) {
    if (this.active) return;
    this.active = true;
    this._getTarget = getTargetBearing;
    this._initAudio();
    this._tickTimer = setInterval(() => this._tick(), 100);
    this._tick();
  }

  stop() {
    this.active = false;
    clearInterval(this._tickTimer);
    clearInterval(this._pulseTimer);
    this._tickTimer = this._pulseTimer = null;
    this.level = null;
    navigator.vibrate?.(0);
    this._gain?.gain.setTargetAtTime(0, this._audio?.currentTime ?? 0, 0.02);
    this.onUpdate({ active: false });
  }

  toggle(getTargetBearing) {
    this.active ? this.stop() : this.start(getTargetBearing);
    return this.active;
  }

  // ------------------------------------------------------------------ 내부
  _tick() {
    const target = this._getTarget();
    const heading = this.heading;

    if (target == null || heading == null) {
      // 나침반이 없거나 목표가 없으면 신호를 내지 않는다.
      // 방향을 모르는 채 아무 진동이나 주면 잘못된 쪽으로 걷게 된다.
      this._setLevel(LEVELS[LEVELS.length - 1]);
      this.error = null;
      this.onUpdate({ active: true, error: null, heading, target, level: null, reason: 'no-heading' });
      return;
    }

    let error = target - heading;
    while (error > 180) error -= 360;
    while (error < -180) error += 360;
    this.error = error;

    const level = levelForError(error);
    this._setLevel(level);
    this.onUpdate({ active: true, error, heading, target, level });
  }

  _setLevel(level) {
    if (this.level?.id === level.id) return;
    this.level = level;

    clearInterval(this._pulseTimer);
    navigator.vibrate?.(0);

    if (!level.pattern) {
      this._setTone(0, false);
      return;
    }

    this._pulse(level);
    this._pulseTimer = setInterval(() => this._pulse(level), level.period);
  }

  _pulse(level) {
    // 같은 패턴을 주기마다 다시 걸어 끊김 없는 느낌을 만든다
    navigator.vibrate?.(level.pattern);
    this._setTone(level.freq, level.continuous, level.pattern[0]);
  }

  // ------------------------------------------------------------------ 소리
  _initAudio() {
    if (this._audio || !this.sound) return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._audio = new Ctx();
      this._osc = this._audio.createOscillator();
      this._gain = this._audio.createGain();
      this._gain.gain.value = 0;
      this._osc.type = 'sine';
      this._osc.frequency.value = 440;
      this._osc.connect(this._gain).connect(this._audio.destination);
      this._osc.start();
    } catch (_) { this._audio = null; }
  }

  _setTone(freq, continuous, onMs = 120) {
    if (!this._audio || !this._gain) return;
    if (this._audio.state === 'suspended') this._audio.resume().catch(() => {});

    const now = this._audio.currentTime;
    if (!freq) {
      this._gain.gain.cancelScheduledValues(now);
      this._gain.gain.setTargetAtTime(0, now, 0.02);
      return;
    }

    this._osc.frequency.setTargetAtTime(freq, now, 0.03);
    this._gain.gain.cancelScheduledValues(now);
    if (continuous) {
      this._gain.gain.setTargetAtTime(0.09, now, 0.03);
    } else {
      // 진동과 같은 길이로 소리를 끊어 준다
      this._gain.gain.setTargetAtTime(0.09, now, 0.01);
      this._gain.gain.setTargetAtTime(0, now + onMs / 1000, 0.02);
    }
  }
}
