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
  scaleNote: '도면 전체 폭 50m 추정 — 현장 실측 후 교체',
});

export function isPhotoScenario(planId, hazards) {
  const fire = hazards?.[PHOTO_SCENARIO.fireEdgeId];
  return planId === PHOTO_SCENARIO.planId
    && fire?.type === 'fire'
    && fire?.label === PHOTO_SCENARIO.fireLabel;
}
