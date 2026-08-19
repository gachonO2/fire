/**
 * 북쪽 보정 — **도면 위쪽이 실제로 몇 도인가.**
 *
 * ## 왜 이 값 하나에 방향 안내 전체가 걸려 있나
 *
 * 도면은 종이에 아무 방향으로나 그려진다. 도면 안의 각도와 나침반 각도는 기준이
 * 다르므로, 둘을 이어 주는 값이 없으면 **비교 자체가 불가능하다.** 그래서 이 값이
 * 없으면 안내 화면은 «폰을 이쪽으로 돌리세요» 를 통째로 접는다 — 진동도, 삐 소리
 * 간격도, "정면입니다"도, "왼쪽으로 도세요"도 전부 이 값 뒤에 있다.
 *
 * 실제로 그 상태였다. 코드는 다 있는데 도면에 값이 없어서 한 번도 돌지 않았고,
 * 화면에는 «○○ 방향으로 12미터» 만 나갔다. 어느 쪽을 보고 서 있든 같은 말이었다.
 *
 * ## 걸으면서 알아내는 것과 재는 것은 다르다
 *
 * `mobile/src/calibrate.js` 는 안내 중에 자동으로 알아낸다 — 곧게 네 걸음을 걸으면
 * 그 방향이 곧 그 구간의 방위라고 보는 방식이다. 편하지만 **반대로 걸으면 180°
 * 틀어진 값이 박힌다.** 앱은 사용자가 경로를 따라 걷는다고 가정하는데, 방향을
 * 모르는 사람이 반대로 걷는 일은 흔하다.
 *
 * 그래서 재는 쪽을 따로 둔다. 측량하는 사람이 «지금 A 에서 B 로 걷습니다» 라고
 * 선언하고 걸으면 추측할 여지가 없다. **측량은 사람, 안내는 기계** — 축척을
 * 그렇게 재고 있고, 북쪽도 같은 값이다. 건물이 돌아가지 않으니 한 번이면 끝난다.
 */

const norm360 = deg => ((deg % 360) + 360) % 360;

export function normalizeDelta(deg) {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 각도의 평균. 359° 와 1° 의 평균은 180° 가 아니라 0° 다.
 * 그래서 산술평균이 아니라 단위벡터를 더해서 낸다.
 */
export function circularMean(degs) {
  if (!degs.length) return null;
  let sx = 0; let sy = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  if (sx === 0 && sy === 0) return null;
  return norm360((Math.atan2(sy, sx) * 180) / Math.PI);
}

/** 표본이 얼마나 흩어져 있나 (도). 두리번거렸으면 크다. */
export function spreadDeg(degs) {
  const mean = circularMean(degs);
  if (mean === null) return Infinity;
  return Math.max(...degs.map(d => Math.abs(normalizeDelta(d - mean))));
}

/** 도면 안에서 A→B 가 놓인 각도. 도면 위쪽이 0°, 시계 방향. */
export function planBearing(from, to) {
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  // y 는 화면 좌표라 아래로 갈수록 커진다 — 부호를 뒤집어야 «위쪽» 이 0° 가 된다
  return norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/** 이보다 흩어졌으면 걸으면서 두리번거린 것으로 본다 */
export const MAX_SPREAD_DEG = 45;
/** 이보다 표본이 적으면 믿지 않는다 (0.3초 간격이면 3초) */
export const MIN_SAMPLES = 10;

/**
 * 두 지점 사이를 걸으며 모은 나침반 값에서 보정을 낸다.
 *
 *     northOffset = (걸으면서 잰 실제 방위) − (도면 안에서 A→B 가 놓인 각도)
 *
 * @param headings 걷는 동안의 나침반 값들(도). 흔들린 표본은 부르는 쪽에서 걸러 온다
 * @param from,to  도면 위의 두 지점 {x, y}
 * @returns {{offset, bearing, planDeg, spread, samples} | {error}}
 */
export function northFromWalk(headings, from, to) {
  const planDeg = planBearing(from, to);
  if (planDeg === null) return { error: '두 지점이 같은 자리입니다' };
  if (!headings?.length || headings.length < MIN_SAMPLES) {
    return { error: `방위 표본이 모자랍니다 (${headings?.length ?? 0}개)` };
  }
  const spread = spreadDeg(headings);
  if (spread > MAX_SPREAD_DEG) {
    return { error: `걷는 동안 방향이 ${Math.round(spread)}° 흔들렸습니다 — 곧게 다시` };
  }
  const bearing = circularMean(headings);
  return {
    offset: norm360(bearing - planDeg),
    bearing, planDeg, spread, samples: headings.length,
  };
}
