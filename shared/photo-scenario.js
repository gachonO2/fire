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

// 2026-08-19 현장 실측값. FR/FR(북쪽)과 CREATIVE WORKSPACE 옆 비상구 사이를
// 63걸음(보폭 0.7m) 걸었고, 두 지점의 도면상 직선거리는 405.743px였다.
// 축척은 이 값에서만 계산한다. 파란 선은 두 지점을 잇는 직선보다 굽어 있으므로
// 전체 대피 경로 길이는 44.1m가 아니라 약 66.3m가 된다.
const FIELD_CALIBRATION = Object.freeze({
  fromNodeId: 'EXIT_CW',
  toNodeId: 'R_FRFR1',
  steps: 63,
  stepLength: 0.7,
  walkedMeters: 44.1,
  planUnits: 405.7429640794773,
  measuredAt: '2026-08-19',
});
const METERS_PER_UNIT = FIELD_CALIBRATION.walkedMeters / FIELD_CALIBRATION.planUnits;
const STEP_LENGTH = FIELD_CALIBRATION.stepLength;
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
  calibration: FIELD_CALIBRATION,
  scaleNote: '현장 실측 63걸음 × 0.700m ÷ 405.743px',
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

/**
 * 현재 위치에서 기존 답사 비콘 위치에 대응하는 RSSI를 만든다.
 * 비콘 좌표와 ID를 여기서 만들지 않는다. 서버에 저장된 실제 답사 매핑을 받아
 * 값만 계산해야 지도에 없는 B1/B2 같은 가짜 설비가 생기지 않는다.
 * 자유공간 로그 거리 모델의 단순값이며 실제 측정치는 아니다.
 */
export function scenarioBeaconReadings(position, beacons = []) {
  const px = Number(position?.x);
  const py = Number(position?.y);
  return beacons.map(beacon => {
    const distanceMeters = Number.isFinite(px) && Number.isFinite(py)
      ? Math.hypot(beacon.x - px, beacon.y - py) * METERS_PER_UNIT
      : 0;
    const modeledDistance = Math.max(0.5, distanceMeters);
    const txPower = Number.isFinite(beacon.txPower) ? beacon.txPower : -59;
    const biasDb = Number.isFinite(beacon.biasDb) ? beacon.biasDb : 0;
    const rssi = Math.max(-96, Math.min(-42,
      Math.round(txPower - 20 * Math.log10(modeledDistance) + biasDb)));
    return {
      ...beacon,
      rssi,
      distanceMeters: Math.round(distanceMeters * 10) / 10,
      simulated: true,
    };
  });
}

/** 서버 시각 하나로 관제와 휴대폰이 함께 쓰는 90초 대피 상태를 만든다. */
export function photoScenarioSnapshot(startedAt, now = Date.now(), beacons = []) {
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
    beacons: scenarioBeaconReadings(point, beacons),
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
