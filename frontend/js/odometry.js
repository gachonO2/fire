/**
 * 이동추적(보행 오도메트리) — Visual_Slam(MIT)의 odometry.js를 개작.
 * 원본: devicemotion 저역통과 필터 + 피크 검출로 걸음 감지,
 *       deviceorientation으로 방위 추적, 신뢰도(confidence) 관리.
 *
 * MVP 원칙: 실시간 정밀측위는 다음 단계로 미루고,
 *   - 시작 위치는 QR/수동 선택으로 확정
 *   - 걸음 수 × 보폭으로 엣지 위 진행도를 추정
 *   - 진행방향(나침반)과 경로 방위의 차이로 "이탈"을 감지
 *   - 위치확신도가 기준 이하로 떨어지면 임의 안내를 멈추고 안전상태로 전환
 */

export class Odometry {
  constructor() {
    this.heading = null;        // 도(deg), 나침반 기준. null = 센서 없음(데스크톱 데모)
    this.confidence = 1.0;      // 0~1 위치확신도
    this.stepCount = 0;

    this._alpha = 0.8;          // 저역통과 필터 계수 (Visual_Slam 원본 값)
    this._gravity = { x: 0, y: 0, z: 0 };
    this._lastStepTime = 0;
    this._stepThreshold = 1.6;  // m/s^2, 선형가속 피크 기준

    this.onStep = null;         // 걸음 감지 콜백
  }

  /** iOS 13+ 는 사용자 제스처에서 권한 요청 필요 */
  async start() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' &&
          typeof DeviceMotionEvent.requestPermission === 'function') {
        await DeviceMotionEvent.requestPermission();
      }
      if (typeof DeviceOrientationEvent !== 'undefined' &&
          typeof DeviceOrientationEvent.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission();
      }
    } catch (_) { /* 거부 시 데모 버튼으로 대체 */ }

    window.addEventListener('devicemotion', e => this._handleMotion(e));
    window.addEventListener('deviceorientationabsolute', e => this._handleOrientation(e));
    window.addEventListener('deviceorientation', e => {
      if (this.heading === null) this._handleOrientation(e);
    });
  }

  _handleOrientation(e) {
    if (e.alpha === null || e.alpha === undefined) return;
    // alpha: 0=북 기준 반시계 → 나침반 방위로 변환
    this.heading = (360 - e.alpha) % 360;
  }

  _handleMotion(e) {
    const acc = e.accelerationIncludingGravity;
    if (!acc || acc.x === null) return;

    // 저역통과로 중력 분리 → 선형가속 크기
    const g = this._gravity;
    g.x = this._alpha * g.x + (1 - this._alpha) * acc.x;
    g.y = this._alpha * g.y + (1 - this._alpha) * acc.y;
    g.z = this._alpha * g.z + (1 - this._alpha) * acc.z;
    const lin = Math.hypot(acc.x - g.x, acc.y - g.y, acc.z - g.z);

    const now = Date.now();
    if (lin > this._stepThreshold && now - this._lastStepTime > 350) {
      this._lastStepTime = now;
      this.stepCount++;
      if (this.onStep) this.onStep();
    }
  }

  /**
   * 경로 방위와 현재 진행방향의 차이(도). 센서 없으면 null.
   * @returns -180 ~ 180 (양수 = 경로가 오른쪽에 있음)
   */
  headingError(expectedBearing) {
    if (this.heading === null) return null;
    let d = expectedBearing - this.heading;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }

  degradeConfidence(amount) {
    this.confidence = Math.max(0, this.confidence - amount);
    return this.confidence;
  }

  restoreConfidence(amount = 0.1) {
    this.confidence = Math.min(1, this.confidence + amount);
    return this.confidence;
  }

  resetAt() {
    // 확정 지점(QR/노드 도착) 통과 시 확신도 회복
    this.confidence = 1.0;
  }
}
