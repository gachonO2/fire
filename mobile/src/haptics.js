/**
 * 진동 엔진 — "나의 찾기" 식 세기 조절.
 *
 * ## 왜 세기를 직접 못 주는가
 *
 * iOS 의 Core Haptics 는 세기(0~1)를 연속으로 지정할 수 있지만, 그건 네이티브
 * 모듈이 필요하고 **Expo Go 에서는 쓸 수 없다.** expo-haptics 가 주는 것은
 * 미리 정해진 5단계(Soft·Light·Medium·Rigid·Heavy)뿐이다.
 *
 * ## 그래서 두 축을 함께 쓴다
 *
 *   진폭  5단계 중 하나를 고른다        ← 굵기
 *   빈도  얼마나 자주 때리는가          ← 촘촘함
 *
 * 사람이 느끼는 "세기"는 진폭만이 아니라 **단위 시간당 자극량**이다.
 * 금속탐지기가 진폭이 아니라 빠르기로 강약을 만드는 것과 같은 원리다.
 * 두 축을 곱하면 5단계로도 꽤 연속적인 감각이 나온다.
 *
 * ## 정면일 때만 성격을 바꾼다
 *
 * 길이만 늘리면 "조금 센 톡"이라 확신이 안 선다. 정면에서는 **끊기지 않고
 * 이어지는** 느낌을 주어, 훑다가 "여기다"가 분명해지게 한다.
 * (금속탐지기의 삐-삐-삐 → 삐———)
 *
 * 네이티브 빌드로 올릴 때는 setEngine() 으로 연속 진동 구현만 갈아끼우면 된다.
 */

import * as Haptics from 'expo-haptics';

const STYLES = [
  Haptics.ImpactFeedbackStyle.Soft,
  Haptics.ImpactFeedbackStyle.Light,
  Haptics.ImpactFeedbackStyle.Medium,
  Haptics.ImpactFeedbackStyle.Rigid,
  Haptics.ImpactFeedbackStyle.Heavy,
];

// 세기 0~1 을 때리는 간격(ms)으로. 셀수록 촘촘하다.
const GAP_MAX = 620;   // 거의 안 맞을 때
const GAP_MIN = 55;    // 정면 — 이보다 짧으면 개별 타격이 뭉개져 연속처럼 느껴진다
const LOCK_THRESHOLD = 0.88;  // 이 위는 "정면 고정" 취급

/** 네이티브 연속 진동으로 교체할 자리 (Expo Go 에서는 null) */
let engine = null;
export function setEngine(impl) { engine = impl; }

function styleFor(strength) {
  const i = Math.min(STYLES.length - 1,
                     Math.max(0, Math.round(strength * (STYLES.length - 1))));
  return STYLES[i];
}

export class HapticCompass {
  constructor() {
    this._timer = null;
    this.running = false;
    this._strength = 0;
  }

  /** strength 0~1 — 방향 정확도와 근접도를 이미 곱한 값 */
  setStrength(strength) {
    this._strength = Math.max(0, Math.min(1, strength || 0));
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this._timer);
    this._timer = null;
    if (engine?.stop) engine.stop();
  }

  _loop() {
    if (!this.running) return;
    const s = this._strength;

    if (engine?.pulse) {
      // 네이티브 경로: 세기를 그대로 넘긴다
      engine.pulse(s);
    } else if (s > 0.04) {
      // Expo Go 경로: 5단계 중 하나 + 간격으로 세기를 만든다
      Haptics.impactAsync(styleFor(s)).catch(() => {});
    }

    // 정면 근처에서는 간격을 바닥까지 좁혀 **끊기지 않는 느낌**을 만든다.
    const gap = s >= LOCK_THRESHOLD
      ? GAP_MIN
      : GAP_MAX - (GAP_MAX - GAP_MIN) * s;

    this._timer = setTimeout(() => this._loop(), gap);
  }
}

// --------------------------------------------------------- 단발 신호

/** 대피 시작 — 길게 한 번 (다른 어떤 신호와도 헷갈리면 안 된다) */
export function cueStart() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

/** 촬영 틀이 맞았을 때 — 짧고 기분 좋은 확인 */
export function cueLocked() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

/** 잘못된 방향·거부 — 짧게 두 번 */
export function cueReject() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
}

/** 화재 경보 — 강한 타격을 반복. 자는 사람도 깨야 한다. */
export function alarmBurst(times = 3) {
  for (let i = 0; i < times; i++) {
    setTimeout(() => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      setTimeout(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      }, 110);
    }, i * 420);
  }
}
