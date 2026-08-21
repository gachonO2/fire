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
/**
 * 대피 시간을 **구간마다 따로** 잰다.
 *
 * ## 등속으로 훑으면 안 된다
 *
 * 여태는 전체 길이를 시간으로 나눠 폴리라인을 등속으로 훑었다. 그러면
 * **꺾는 데 0초**가 걸린다. 실제로는 그 반대다 — 시각장애인은 방향을 바꿀
 * 때 멈춰서 방위를 다시 잡고, 안내가 «오른쪽» 이라고 말하는 것을 듣고,
 * 몸을 돌린 뒤에야 다시 걷는다. 직선 구간보다 **꺾이는 지점이 느리다.**
 *
 * 시연에서 이게 틀리면 «생각보다 빨리 도착하네» 로 보이고, 그건 대피
 * 시간을 실제보다 짧게 말하는 것이다.
 *
 * ## 세 가지를 더한다
 *
 *     방에서 나오기   문을 열고 복도로 나서서 방위를 잡는 동안
 *     걷기            구간 길이 ÷ 걷는 속도
 *     방향 바꾸기     꺾이는 각도에 비례
 *
 * ## 값의 근거
 *
 * **첫 구간 9초는 현장에서 잰 값이다** (2026-08-21). FR/FR 방에서 나와 첫
 * 꺾임까지 3.2m 를 9초에 걸었다 — 0.36m/s 로, 걷는 속도가 아니라 «나오는
 * 동작» 이 대부분이다. 그래서 그 구간을 걷기와 나누어 잡는다.
 *
 * 걷는 속도 1.1m/s 는 지팡이를 짚고 안내를 들으며 걷는 속도다(보통 걷기는
 * 1.2~1.4). 회전 2.9초/90도는 «멈춤 → 안내 듣기 → 몸 돌리기» 한 묶음이다 —
 * 눈으로 방향을 확인할 수 없으니 돌고 나서 «맞게 섰나» 를 한 번 더 듣는
 * 시간이 들어간다. 이 둘은 아직 실측이 아니다 — 재면 그 값으로 바꾼다.
 *
 * **총 시간은 구간 합이지 따로 적는 숫자가 아니다.** 한 번 리터럴로 박았더니
 * 구간 합(72.4초)과 2.6초 어긋나, 걸음은 이미 출구에 닿았는데 화면은 계속
 * «대피 중» 이라고 말했다. 총 시간을 늘리려면 어느 구간이 더 걸리는지를
 * 고쳐야 한다.
 */
const WALK_MS_PER_M = 1000 / 1.1;
const TURN_MS_PER_90 = 2900;
/**
 * 회전에 이보다 오래 걸리지는 않는다.
 *
 * 제자리에서 도는 동작 자체는 각도에 비례하지만, 이 시간의 대부분은 «멈춰서
 * 안내를 듣는» 몫이라 각도를 따라 늘지 않는다. 상한이 없으면 100도 회전이
 * 65도 회전보다 1초 넘게 오래 걸리는데, 실제로 재 보면 둘 다 2초쯤이다.
 */
const TURN_MS_CAP = 2000;
/**
 * 비콘을 지나는 자리에서 멈칫하는 시간.
 *
 * 비콘이 잡히면 위치가 그 지점으로 확정되고 «○○ 앞을 지납니다» 안내가 나간다.
 * 듣는 사람은 그 말을 확인하느라 반 걸음 멈춘다 — 시간표에 없으면 화면 속
 * 걸음만 혼자 앞서 간다.
 */
const BEACON_PAUSE_MS = 2000;
/** 비콘이 놓인 자리 — 경로 길이의 비율. `ROUTE_BEACONS` 와 같은 값을 쓴다. */
const BEACON_STOPS = [0.34, 0.72];
/** 첫 구간(방에서 나오기)의 실측값 — 걷기·회전과 별도로 통째로 쓴다 */
const LEAVE_ROOM_MS = 9000;

/** 세 점이 이루는 방향 전환 각도(도). 0이면 직진. */
function turnDeg(a, b, c) {
  const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = (t2 - t1) * 180 / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return Math.abs(d);
}

/**
 * 경로를 «걷기 구간» 과 «회전» 이 번갈아 나오는 시간표로 바꾼다.
 *
 * 위치를 구할 때 진행률(0~1)이 아니라 **시간**으로 찾는다. 등속이 아니므로
 * 진행률과 시간이 비례하지 않는다 — 꺾이는 동안 진행률은 안 늘지만 시간은 간다.
 */
function buildTimeline(points, metersPerUnit, stops = []) {
  const legs = [];
  for (let i = 1; i < points.length; i++) {
    const meters = Math.hypot(points[i][0] - points[i - 1][0],
      points[i][1] - points[i - 1][1]) * metersPerUnit;
    // 첫 구간은 실측값을 그대로 쓴다 — 방에서 나오는 동작이 대부분이라
    // 걷는 속도로 환산하면 실제보다 훨씬 짧게 나온다.
    legs.push({ kind: 'walk', from: i - 1, to: i, meters,
      ms: i === 1 ? LEAVE_ROOM_MS : meters * WALK_MS_PER_M });
    if (i < points.length - 1) {
      const deg = turnDeg(points[i - 1], points[i], points[i + 1]);
      // 몇 도 안 되는 꺾임은 걸으면서 흡수된다. 멈추지 않는다.
      if (deg >= 12) {
        legs.push({ kind: 'turn', at: i, deg,
          ms: Math.min(TURN_MS_CAP, (deg / 90) * TURN_MS_PER_90) });
      }
    }
  }

  // 비콘 자리에 «멈칫» 을 끼운다. 걷기 구간 하나를 둘로 쪼개고 그 사이에 넣는다.
  const totalM = legs.reduce((a, l) => a + (l.meters || 0), 0);
  for (const frac of stops) {
    const target = totalM * frac;
    let acc = 0;
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.kind !== 'walk') continue;
      if (acc + l.meters <= target) { acc += l.meters; continue; }
      const f = (target - acc) / l.meters;
      const head = { ...l, meters: l.meters * f, ms: l.ms * f, cutTo: f };
      const tail = { ...l, meters: l.meters * (1 - f), ms: l.ms * (1 - f), cutFrom: f };
      legs.splice(i, 1, head,
        { kind: 'pause', from: l.from, to: l.to, f, ms: BEACON_PAUSE_MS }, tail);
      break;
    }
  }

  let t = 0;
  for (const l of legs) { l.start = t; t += l.ms; }
  return { legs, total: t };
}

const TIMELINE = buildTimeline(ROUTE, METERS_PER_UNIT, BEACON_STOPS);
// **내림이 아니라 올림.** 반올림하면 총 시간이 구간 합보다 1ms 모자랄 수
// 있고, 그러면 «끝났는데 마지막 걸음이 안 끝난» 상태로 출구 직전에 선다.
const DURATION_MS = Math.ceil(TIMELINE.total);
// 사용자가 요청한 경로용 가상 비콘 2개. 좌표를 따로 눈대중으로 찍지 않고
// 파란 경로 길이의 34%, 72% 지점에 놓아 경로가 바뀌어도 선 위에 남게 한다.
// 화면에서는 기존 답사 비콘과 같은 «숫자 원형 링»으로 그린다.
const ROUTE_BEACONS = Object.freeze([
  { id: 'SIM-ROUTE-01', nodeId: 'SIM_ROUTE_01', nodeName: '경로 가상 비콘 1', progress: 0.34 },
  { id: 'SIM-ROUTE-02', nodeId: 'SIM_ROUTE_02', nodeName: '경로 가상 비콘 2', progress: 0.72 },
].map(beacon => {
  const point = pointOnRoute(ROUTE, beacon.progress);
  return Object.freeze({
    ...beacon,
    x: point.x,
    y: point.y,
    count: 1,
    txPower: -59,
    virtual: true,
  });
}));
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
  timeline: TIMELINE,
  durationMs: DURATION_MS,
  routeBeacons: ROUTE_BEACONS,
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

/**
 * 흐른 시간에서 위치를 찾는다.
 *
 * 꺾이는 동안에는 **제자리에 선다** — 걸은 거리도 안 늘고 위치도 안 바뀐다.
 * 그게 실제로 일어나는 일이고, 화면에서도 점이 멈춰 있어야 «지금 돌고 있다»
 * 가 읽힌다.
 */
export function positionAtTime(elapsedMs) {
  const t = Math.max(0, Math.min(DURATION_MS, elapsedMs));
  let walked = 0;
  for (const l of TIMELINE.legs) {
    const end = l.start + l.ms;
    if (l.kind === 'walk') {
      if (t >= end) { walked += l.meters; continue; }
      const f = l.ms ? (t - l.start) / l.ms : 1;
      walked += l.meters * f;
      // 쪼갠 구간은 원래 선분의 일부만 차지한다 — 그 안에서 다시 보간한다.
      const g = (l.cutFrom ?? 0) + f * ((l.cutTo ?? 1) - (l.cutFrom ?? 0));
      const a = ROUTE[l.from], b = ROUTE[l.to];
      return {
        point: { x: a[0] + (b[0] - a[0]) * g, y: a[1] + (b[1] - a[1]) * g,
          segment: l.from, segmentProgress: g },
        walked, turning: false, turnDeg: 0,
      };
    }
    // 비콘 앞 멈칫 — 제자리. 회전과 달리 몸을 돌리지는 않는다.
    if (l.kind === 'pause') {
      if (t >= end) continue;
      const a = ROUTE[l.from], b = ROUTE[l.to];
      return {
        point: { x: a[0] + (b[0] - a[0]) * l.f, y: a[1] + (b[1] - a[1]) * l.f,
          segment: l.from, segmentProgress: l.f },
        walked, turning: false, turnDeg: 0, atBeacon: true,
      };
    }
    // 회전 — 제자리
    if (t < end) {
      const p = ROUTE[l.at];
      return {
        point: { x: p[0], y: p[1], segment: l.at, segmentProgress: 0 },
        walked, turning: true, turnDeg: Math.round(l.deg),
      };
    }
  }
  const last = ROUTE.at(-1);
  return {
    point: { x: last[0], y: last[1], segment: ROUTE.length - 2, segmentProgress: 1 },
    walked: TOTAL_METERS, turning: false, turnDeg: 0,
  };
}

/** 서버 시각 하나로 관제와 휴대폰이 함께 쓰는 대피 상태를 만든다. */
export function photoScenarioSnapshot(startedAt, now = Date.now(), beacons = []) {
  const running = Number.isFinite(startedAt);
  const elapsedMs = running ? Math.max(0, now - startedAt) : 0;
  const at = positionAtTime(elapsedMs);
  const point = at.point;
  // 진행률은 **걸은 거리** 기준이다. 시간 기준으로 내면 꺾이는 동안에도
  // 막대가 차올라 «가고 있다» 고 말하게 된다.
  const progress = TOTAL_METERS ? Math.min(1, at.walked / TOTAL_METERS) : 0;
  const remainingMeters = Math.max(0, TOTAL_METERS - at.walked);
  return {
    ...point,
    progress,
    // 지금 돌고 있는가 — 화면이 «방향을 바꾸는 중» 을 말할 수 있어야
    // «왜 안 움직이지» 가 «아, 돌고 있구나» 가 된다.
    turning: at.turning,
    turnDeg: at.turnDeg,
    elapsedMs: Math.min(DURATION_MS, elapsedMs),
    remainingMs: Math.max(0, DURATION_MS - elapsedMs),
    remainingMeters,
    stepsLeft: Math.ceil(remainingMeters / STEP_LENGTH),
    beacons: scenarioBeaconReadings(point, beacons),
    phase: elapsedMs >= DURATION_MS ? 'arrived' : 'guiding',
    timelineState: running ? (elapsedMs >= DURATION_MS ? 'arrived' : 'running') : 'armed',
  };
}

export function isPhotoScenario(planId, hazards) {
  const fire = hazards?.[PHOTO_SCENARIO.fireEdgeId];
  return planId === PHOTO_SCENARIO.planId
    && fire?.type === 'fire'
    && fire?.label === PHOTO_SCENARIO.fireLabel;
}
