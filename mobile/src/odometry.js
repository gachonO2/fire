/**
 * 걸음 감지 — "몇 미터 남았다"를 진짜로 만든다.
 *
 * 이게 없으면 남은 거리가 **화면에서만 줄어든다.** 시각장애인은 그 걸음 수를 믿고
 * 걷기 때문에, 실제로 걷지도 않았는데 거리가 줄면 모퉁이를 지나쳐 버린다.
 *
 * `../fire` 의 `frontend/js/odometry.js`(Visual_Slam 개작)를 React Native 센서로 옮겼다.
 * 원리는 같다 — 저역통과 필터로 중력을 걷어내고, 남은 가속도의 봉우리를 센다.
 *
 * ## 왜 만보기(Pedometer)를 안 쓰는가
 *
 * expo-sensors 의 Pedometer 는 iOS 의 CMPedometer 를 쓰는데, **몇 걸음 지난 뒤에
 * 몰아서** 값을 준다(걸음을 확정하려고 잠시 지켜본다). 평소엔 문제없지만 대피
 * 안내에서는 "지금 도착했다"가 몇 초 늦으면 모퉁이를 지나친다. 그래서 직접 센다.
 *
 * ## 확신도를 함께 관리한다
 *
 * 보폭은 사람마다 다르고, 지팡이를 짚으면 걸음 간격도 흔들린다. 오래 걸을수록
 * 어긋나므로 확신도를 깎고, 기준 아래로 떨어지면 **안내를 멈추고 구조를 요청한다.**
 * 틀린 위치를 자신 있게 알려주는 것은 아무것도 안 하는 것보다 위험하다.
 */

import { Accelerometer } from 'expo-sensors';

import { StepDetector } from './step-detect.js';

/** 한 걸음마다 깎이는 확신도. 40걸음쯤 걸으면 경고 수준에 닿는다. */
const CONF_DECAY_PER_STEP = 0.012;

export class Odometry {
  constructor() {
    this.steps = 0;
    this.confidence = 1;
    this.walking = false;
    this.onStep = null;         // (steps) => void

    // 봉우리를 세는 일은 `shared/step-detect.js` 가 한다 — 시간을 인자로 받는
    // 순수 계층이라 «흔든 것과 걸은 것» 을 시험으로 가릴 수 있다.
    this._detector = new StepDetector();
    this._sub = null;
  }

  start(intervalMs = 50) {
    Accelerometer.setUpdateInterval(intervalMs);
    this._sub = Accelerometer.addListener(g => this._sample(g));
  }

  stop() {
    this._sub?.remove();
    this._sub = null;
  }

  reset() {
    this.steps = 0;
    this.confidence = 1;
    this._detector.reset();
  }

  _sample(g) {
    const now = Date.now();
    // 리듬이 확인되는 순간 보류해 둔 걸음이 함께 나온다 — 그래서 1이 아닐 수 있다
    const n = this._detector.push(g, now);
    for (let i = 0; i < n; i++) {
      this.steps++;
      this.confidence = Math.max(0, this.confidence - CONF_DECAY_PER_STEP);
      this.onStep?.(this.steps);
    }
    this.walking = this._detector.walking(now);
  }

  /** 방향을 크게 벗어난 채로 걸으면 위치를 더 못 믿는다 */
  penalize(amount = 0.05) {
    this.confidence = Math.max(0, this.confidence - amount);
    return this.confidence;
  }

  /** 지점에 제대로 도착하면 조금 회복시킨다 */
  reward(amount = 0.08) {
    this.confidence = Math.min(1, this.confidence + amount);
    return this.confidence;
  }
}
