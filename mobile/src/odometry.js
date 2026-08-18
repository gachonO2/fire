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

const ALPHA = 0.8;            // 중력 분리용 저역통과 계수 (원본 Visual_Slam 값)
const PEAK_THRESHOLD = 0.18;  // g 단위 — 이보다 큰 봉우리를 걸음으로 본다
const MIN_STEP_MS = 260;      // 이보다 빨리 또 세지 않는다 (한 걸음이 두 번 세지는 것 방지)
const MAX_STEP_MS = 2000;     // 이보다 느리면 걷다 멈춘 것으로 본다

/** 한 걸음마다 깎이는 확신도. 40걸음쯤 걸으면 경고 수준에 닿는다. */
const CONF_DECAY_PER_STEP = 0.012;

export class Odometry {
  constructor() {
    this.steps = 0;
    this.confidence = 1;
    this.walking = false;
    this.onStep = null;         // (steps) => void

    this._gravity = { x: 0, y: 0, z: 0 };
    this._lastPeakAt = 0;
    this._prevMag = 0;
    this._rising = false;
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
    this._lastPeakAt = 0;
  }

  _sample({ x, y, z }) {
    // 중력은 천천히 변하므로 저역통과로 뽑아내고, 나머지가 몸의 움직임이다
    this._gravity.x = ALPHA * this._gravity.x + (1 - ALPHA) * x;
    this._gravity.y = ALPHA * this._gravity.y + (1 - ALPHA) * y;
    this._gravity.z = ALPHA * this._gravity.z + (1 - ALPHA) * z;

    const lx = x - this._gravity.x;
    const ly = y - this._gravity.y;
    const lz = z - this._gravity.z;
    const mag = Math.sqrt(lx * lx + ly * ly + lz * lz);

    const now = Date.now();

    // 봉우리 검출: 올라가다가 내려가기 시작하는 순간이 한 걸음
    if (mag > this._prevMag) {
      this._rising = true;
    } else if (this._rising && this._prevMag >= PEAK_THRESHOLD) {
      this._rising = false;
      if (now - this._lastPeakAt >= MIN_STEP_MS) {
        this._lastPeakAt = now;
        this.steps++;
        this.confidence = Math.max(0, this.confidence - CONF_DECAY_PER_STEP);
        this.walking = true;
        this.onStep?.(this.steps);
      }
    } else {
      this._rising = false;
    }
    this._prevMag = mag;

    if (now - this._lastPeakAt > MAX_STEP_MS) this.walking = false;
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
