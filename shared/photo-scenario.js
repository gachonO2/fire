/**
 * 사용자가 COCONE 6층 사진에 표시한 단일 대피 시나리오.
 *
 * 원본 사진(1976×1052)의 표시를 현재 도면(1352×718) 좌표로 환산했다.
 * 관제·웹 앱·네이티브 앱이 이 한 값을 공유해야 세 화면의 불·현재 위치·길이
 * 서로 어긋나지 않는다.
 */
const ROUTE = [
  [752, 293], [772, 314], [884, 276], [1015, 229], [1092, 204],
  [1189, 181], [1194, 264], [1165, 287], [1142, 284],
];

/** 폴리라인의 도면상 길이. 사진 시나리오의 지도·안내·거리 표시에 함께 쓴다. */
export function polylineLength(points = []) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return length;
}

// 원래 도면 축척(0.1067m/px)은 1352px짜리 한 층을 144m로 계산해 지나치게 컸다.
// 이 시나리오는 도면 전체 폭을 약 50m로 보정한다. 문 폭·복도 폭과 비교해도
// 1px ≈ 3.7cm가 자연스럽고, 아래 파란 경로는 약 22.6m가 된다.
const METERS_PER_UNIT = 50 / 1352;
const STEP_LENGTH = 0.7;
const TOTAL_METERS = polylineLength(ROUTE) * METERS_PER_UNIT;
const DURATION_MS = 90_000;
const TOTAL_STEPS = ROUTE.slice(1).reduce((sum, point, i) => {
  const previous = ROUTE[i];
  const meters = Math.hypot(point[0] - previous[0], point[1] - previous[1]) * METERS_PER_UNIT;
  return sum + Math.max(1, Math.round(meters / STEP_LENGTH));
}, 0);

export const PHOTO_SCENARIO = Object.freeze({
  planId: 'cocone-6f',
  userId: 'scenario-cocone-photo',
  startNodeId: 'J_NS4',
  exitNodeId: 'EXIT_CW',
  fireEdgeId: 'e12',
  fireLabel: '사진 시나리오 · NORTH STREET 화재',
  fire: [616, 338],
  current: [752, 293],
  route: ROUTE,
  metersPerUnit: METERS_PER_UNIT,
  stepLength: STEP_LENGTH,
  totalMeters: Math.round(TOTAL_METERS * 10) / 10,
  totalSteps: TOTAL_STEPS,
  durationMs: DURATION_MS,
  scaleNote: '도면 전체 폭 50m 추정 — 현장 실측 후 교체',
});

/** 경로 길이를 기준으로 진행률 위치를 찾는다. 점 개수가 달라도 속도가 일정하다. */
export function pointOnRoute(points = ROUTE, progress = 0) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  if (!points.length) return { x: 0, y: 0, segment: 0, segmentProgress: 0 };
  if (points.length === 1 || p === 0) {
    return { x: points[0][0], y: points[0][1], segment: 0, segmentProgress: 0 };
  }

  const lengths = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    lengths.push(length);
    total += length;
  }
  let left = total * p;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? Math.min(1, left / lengths[i]) : 1;
      return {
        x: points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        y: points[i][1] + (points[i + 1][1] - points[i][1]) * t,
        segment: i,
        segmentProgress: t,
      };
    }
    left -= lengths[i];
  }
  const last = points.at(-1);
  return { x: last[0], y: last[1], segment: points.length - 2, segmentProgress: 1 };
}

/** 서버 시각 하나로 관제와 휴대폰이 함께 쓰는 90초 대피 상태를 만든다. */
export function photoScenarioSnapshot(startedAt, now = Date.now()) {
  const running = Number.isFinite(startedAt);
  const elapsedMs = running ? Math.max(0, now - startedAt) : 0;
  const progress = running ? Math.min(1, elapsedMs / DURATION_MS) : 0;
  const point = pointOnRoute(ROUTE, progress);
  const remainingMeters = TOTAL_METERS * (1 - progress);
  return {
    ...point,
    progress,
    elapsedMs: Math.min(DURATION_MS, elapsedMs),
    remainingMs: Math.max(0, DURATION_MS - elapsedMs),
    remainingMeters,
    stepsLeft: Math.ceil(remainingMeters / STEP_LENGTH),
    phase: progress >= 1 ? 'arrived' : 'guiding',
    timelineState: running ? (progress >= 1 ? 'arrived' : 'running') : 'armed',
  };
}

export function isPhotoScenario(planId, hazards) {
  const fire = hazards?.[PHOTO_SCENARIO.fireEdgeId];
  return planId === PHOTO_SCENARIO.planId
    && fire?.type === 'fire'
    && fire?.label === PHOTO_SCENARIO.fireLabel;
}
