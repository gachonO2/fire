/**
 * 방위 — 폰이 지금 어느 쪽을 향하는가.
 *
 * ## 왜 자력계를 직접 읽지 않는가
 *
 * 예전에는 `Magnetometer` 의 x, y 를 그대로 atan2 로 돌렸다. **폰을 똑바로 세워
 * 들었을 때만** 맞는 계산이다. 실제로는 한 손에 지팡이, 한 손에 폰을 들고 걷기
 * 때문에 폰이 늘 기울어져 있고, 그러면 방위가 크게 어긋난다.
 * ("상하좌우 인식이 잘 안 된다"의 원인이 이것이었다.)
 *
 * iOS 의 `CoreLocation` 은 자력계·가속도계·자이로를 합쳐 **기울기를 보정하고**,
 * 하드아이언 보정까지 해서 방위를 준다. 그걸 쓰는 게 맞다 — 우리가 다시 만들
 * 이유가 없다. `expo-location` 의 `watchHeadingAsync` 가 그 창구다.
 *
 * 권한이 거절되거나 실패하면 자력계로 내려간다(예전 방식). 안 되는 것보다 낫고,
 * 그때는 정확도가 떨어진다는 사실이 `stability` 에 드러난다.
 *
 * ## 실내 자기장은 믿을 수 없다
 *
 * 철골·전선·엘리베이터가 자기장을 휘게 한다. 그래서 안정도를 재고, 기준 이하면
 * **안내를 멈출 근거**로 쓴다. 틀린 방향을 자신 있게 알려주는 것은 아무것도
 * 안 하는 것보다 위험하다.
 */

import { Magnetometer } from 'expo-sensors';
import * as Location from 'expo-location';

const SMOOTH = 0.2;         // 저역통과 계수 — 작을수록 매끄럽고 굼뜨다
const STABLE_WINDOW = 20;   // 안정도 판정에 쓰는 표본 수
const STABLE_DEG = 25;      // 이 이상 흔들리면 "불안정"

/** iOS 가 보고하는 오차각(도). 이보다 나쁘면 못 믿는다. */
const ACCURACY_BAD = 35;

/** -180~180 으로 접기 */
export function normalizeDelta(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

export class BearingSensor {
  constructor() {
    this.heading = null;      // 0~360, 자북 기준
    this.stability = 1;       // 0~1, 1이면 안정
    this.source = null;       // 'location' | 'magnetometer'
    this._sub = null;
    this._magSub = null;
    this._recent = [];
    this._accuracy = null;
  }

  async start(intervalMs = 60) {
    // 1순위: CoreLocation. 기울기 보정과 보정 이력이 들어간 값이다.
    try {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      if (granted) {
        this._sub = await Location.watchHeadingAsync(h => this._onHeading(h));
        this.source = 'location';
        return true;
      }
    } catch (_) { /* 아래 자력계로 내려간다 */ }

    // 2순위: 자력계 원본. 폰을 세워 든 자세를 전제로 한다.
    Magnetometer.setUpdateInterval(intervalMs);
    this._magSub = Magnetometer.addListener(({ x, y }) => {
      this._push(norm360(Math.atan2(y, x) * (180 / Math.PI)));
    });
    this.source = 'magnetometer';
    return true;
  }

  stop() {
    this._sub?.remove?.();
    this._magSub?.remove?.();
    this._sub = null;
    this._magSub = null;
  }

  _onHeading(h) {
    // trueHeading 은 위치를 알아야 나온다(실내에서는 -1). 없으면 자북 기준을 쓴다 —
    // 도면 보정값도 자북 기준으로 잡으므로 둘이 어긋나지 않는다.
    const deg = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
    this._accuracy = typeof h.accuracy === 'number' ? h.accuracy : null;
    if (typeof deg === 'number' && deg >= 0) this._push(deg);
  }

  _push(deg) {
    if (this.heading === null) {
      this.heading = deg;
    } else {
      // 359°→1° 같은 경계를 넘을 때 평균이 튀지 않도록 차이로 보정한다
      this.heading = norm360(this.heading + normalizeDelta(deg - this.heading) * SMOOTH);
    }
    this._recent.push(deg);
    if (this._recent.length > STABLE_WINDOW) this._recent.shift();
    this._updateStability();
  }

  /** 최근 표본의 흩어짐 + iOS 가 보고한 오차각을 함께 본다 */
  _updateStability() {
    let spread = 1;
    if (this._recent.length >= STABLE_WINDOW) {
      const base = this._recent[0];
      let max = 0;
      for (const d of this._recent) max = Math.max(max, Math.abs(normalizeDelta(d - base)));
      spread = Math.max(0, Math.min(1, 1 - max / (STABLE_DEG * 2)));
    }
    const reported = this._accuracy === null || this._accuracy < 0
      ? 1
      : Math.max(0, Math.min(1, 1 - this._accuracy / ACCURACY_BAD));
    this.stability = Math.min(spread, reported);
  }

  /**
   * 목표 방위와의 차이. 양수 = 목표가 오른쪽.
   * @returns -180~180, 방위를 모르면 null
   */
  errorTo(targetBearing) {
    if (this.heading === null || targetBearing === null || targetBearing === undefined) return null;
    return normalizeDelta(targetBearing - this.heading);
  }
}

// ---------------------------------------------------------- 방향 판정
//
// 목표 방위는 서버 경로에서 나온다(`src/route.js` 의 RouteFollower).
// 도면 좌표계 계산은 `../fire` 편집기가 하므로 앱에서는 하지 않는다 —
// 같은 일을 두 곳에서 하면 반드시 어긋난다.

/**
 * 방향 정확도(0~1). 정면이 1.
 * ALIGNED 안쪽은 전부 1로 두어, 걷는 동안 미세한 흔들림에 신호가 요동치지 않게 한다.
 */
export const ALIGNED_DEG = 16;
export const WIDE_DEG = 75;

export function alignment(errorDeg) {
  if (errorDeg === null) return 0;
  const a = Math.abs(errorDeg);
  if (a <= ALIGNED_DEG) return 1;
  if (a >= WIDE_DEG) return 0;
  return 1 - (a - ALIGNED_DEG) / (WIDE_DEG - ALIGNED_DEG);
}

/**
 * 근접도(0~1). 가까울수록 1.
 * 처음부터 0 이면 출발할 때 아무 신호가 없어 방향을 못 찾으므로 바닥값을 둔다.
 */
export const NEAR_BASE = 0.4;

export function proximity(distanceM, startM = 30) {
  const p = 1 - Math.min(1, Math.max(0, distanceM / startM));
  return NEAR_BASE + (1 - NEAR_BASE) * p;
}
