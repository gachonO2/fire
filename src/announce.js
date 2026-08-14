/**
 * 말하기 — VoiceOver 가 켜져 있든 꺼져 있든 들리게 한다.
 *
 * ## 왜 두 경로가 필요한가
 *
 * `AccessibilityInfo.announceForAccessibility()` 는 **VoiceOver 가 켜져 있을 때만**
 * 소리를 낸다. 꺼져 있으면 아무 일도 일어나지 않는다.
 *
 * 시각장애인은 대개 켜두지만, 이 앱은 건축 담당자·보호자·일반 사용자도 쓴다.
 * 그들은 VoiceOver 가 꺼져 있고, 그래도 안내는 들려야 한다.
 * (실제로 이 문제로 촬영 화면이 완전히 조용했다.)
 *
 * 반대로 VoiceOver 가 켜진 상태에서 우리가 따로 말하면 **두 목소리가 겹친다.**
 * 그래서 켜져 있으면 VoiceOver 에 맡기고, 꺼져 있으면 우리가 말한다.
 *
 * ## 중복 억제
 *
 * 같은 문장을 연달아 반복하면 듣는 사람이 지치고, 무엇보다 **주변 소리를 덮는다.**
 * 시각장애인에게 화재경보·사람 목소리는 시야에 해당하므로 그걸 가리면 위험하다.
 * 같은 문장은 일정 시간 안에는 다시 말하지 않는다.
 */

import { AccessibilityInfo, Platform } from 'react-native';
import * as Speech from 'expo-speech';

let screenReaderOn = false;
let lastText = '';
let lastAt = 0;

/** 앱 시작 시 한 번 호출. VoiceOver 켜짐/꺼짐 변화도 따라간다. */
export function initAnnounce() {
  AccessibilityInfo.isScreenReaderEnabled()
    .then(on => { screenReaderOn = !!on; })
    .catch(() => {});
  const sub = AccessibilityInfo.addEventListener(
    'screenReaderChanged', on => { screenReaderOn = !!on; },
  );
  return () => sub?.remove?.();
}

export function isScreenReaderOn() { return screenReaderOn; }

/**
 * @param {string} text
 * @param {object} opts
 *   force     같은 문장이라도 다시 말한다 (경보처럼 반복이 목적인 경우)
 *   dedupeMs  같은 문장을 억제할 시간
 *   rate      말하기 속도
 */
export function say(text, { force = false, dedupeMs = 2500, rate = 0.95 } = {}) {
  if (!text) return;
  const now = Date.now();
  if (!force && text === lastText && now - lastAt < dedupeMs) return;
  lastText = text;
  lastAt = now;

  if (screenReaderOn) {
    // VoiceOver 가 읽게 둔다. 우리가 겹쳐 말하면 둘 다 안 들린다.
    AccessibilityInfo.announceForAccessibility(text);
    return;
  }
  try {
    Speech.speak(text, { language: 'ko-KR', rate });
  } catch (_) { /* 음성 합성이 없어도 앱은 계속 돈다 */ }
}

/** 진행 중인 말을 끊는다 (긴급 안내가 앞서야 할 때) */
export function stopSpeaking() {
  try { Speech.stop(); } catch (_) { /* 무시 */ }
  lastText = '';
}

/** 화면이 바뀌었음을 스크린리더에 알린다 — 포커스를 새 화면으로 옮긴다 */
export function announceScreen(title) {
  if (Platform.OS === 'ios' && screenReaderOn) {
    AccessibilityInfo.announceForAccessibility(title);
  } else {
    say(title, { force: true });
  }
}
