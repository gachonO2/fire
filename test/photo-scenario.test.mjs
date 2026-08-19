import {
  PHOTO_SCENARIO, pointOnRoute, photoScenarioSnapshot, scenarioBeaconReadings,
} from '../shared/photo-scenario.js';
import { RouteFollower } from '../mobile/src/route.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

const startedAt = 1_000_000;
const mappedBeacons = [
  { id: 'survey-spot:J_ALLEY', nodeId: 'J_ALLEY', x: 1068.08, y: 315.92,
    count: 1, beaconIds: ['ble:existing-alley'], txPower: -59, mapped: true },
  { id: 'survey-spot:J_NS3', nodeId: 'J_NS3', x: 561.08, y: 315.92,
    count: 1, beaconIds: ['ble:existing-north'], txPower: -59, mapped: true },
];
const allBeacons = [...mappedBeacons, ...PHOTO_SCENARIO.routeBeacons];
const start = photoScenarioSnapshot(startedAt, startedAt, allBeacons);
const middle = photoScenarioSnapshot(startedAt, startedAt + 45_000, allBeacons);
const end = photoScenarioSnapshot(startedAt, startedAt + 90_000, allBeacons);

expect('자동 대피 시간은 정확히 90초', PHOTO_SCENARIO.durationMs === 90_000);
expect('현장 실측 63걸음·44.1m 축척 적용',
  PHOTO_SCENARIO.calibration.steps === 63 &&
  PHOTO_SCENARIO.calibration.walkedMeters === 44.1 &&
  Math.abs(PHOTO_SCENARIO.metersPerUnit - 0.10868950026046945) < 1e-12);
expect('굽은 파란 대피 경로는 실측 축척으로 약 66.3m',
  PHOTO_SCENARIO.totalMeters === 66.3,
  `${PHOTO_SCENARIO.totalMeters}m`);
expect('0초에는 지정한 시작점',
  start.progress === 0 && start.x === PHOTO_SCENARIO.current[0] && start.y === PHOTO_SCENARIO.current[1]);
expect('45초에는 경로 길이의 절반',
  Math.abs(middle.progress - 0.5) < 1e-9 && middle.phase === 'guiding',
  `(${middle.x.toFixed(1)}, ${middle.y.toFixed(1)})`);
expect('90초에는 탈출구에 도착',
  end.progress === 1 && end.phase === 'arrived' && end.remainingMeters === 0);
expect('도착 좌표는 파란 경로 마지막 점',
  end.x === PHOTO_SCENARIO.route.at(-1)[0] && end.y === PHOTO_SCENARIO.route.at(-1)[1]);
expect('90초가 지나도 출구 밖으로 나가지 않음',
  photoScenarioSnapshot(startedAt, startedAt + 180_000, allBeacons).progress === 1);

// 점 사이 시간이 아니라 **걸어야 할 길이**로 보간하는지 확인한다.
const quarter = pointOnRoute([[0, 0], [10, 0], [10, 30]], 0.25);
expect('경로 거리 기준 등속 이동', quarter.x === 10 && quarter.y === 0,
  `(${quarter.x}, ${quarter.y})`);

// 휴대폰의 경로 안내기도 같은 진행률을 받았을 때 서버 좌표와 정확히 겹쳐야 한다.
const follower = new RouteFollower(
  { nodes: [], stepLength: PHOTO_SCENARIO.stepLength },
  { exit: { id: PHOTO_SCENARIO.exitNodeId, name: '비상구' } },
  { path: PHOTO_SCENARIO.route, metersPerUnit: PHOTO_SCENARIO.metersPerUnit },
);
follower.seekProgress(middle.progress);
const phoneMiddle = follower.position();
expect('45초 휴대폰 좌표가 서버·관제 좌표와 일치',
  Math.abs(phoneMiddle.x - middle.x) < 1e-9 && Math.abs(phoneMiddle.y - middle.y) < 1e-9,
  `휴대폰 (${phoneMiddle.x.toFixed(1)}, ${phoneMiddle.y.toFixed(1)})`);
follower.seekProgress(1);
const phoneEnd = follower.position();
expect('90초 휴대폰도 같은 탈출구에서 멈춤',
  phoneEnd.x === end.x && phoneEnd.y === end.y);

expect('파란 경로 위에 요청한 가상 비콘 두 개 배치',
  PHOTO_SCENARIO.routeBeacons.length === 2 &&
  PHOTO_SCENARIO.routeBeacons.every(b => b.virtual && b.id.startsWith('SIM-ROUTE-')));
expect('가상 비콘 좌표는 경로 진행률 좌표와 정확히 일치',
  PHOTO_SCENARIO.routeBeacons.every(b => {
    const p = pointOnRoute(PHOTO_SCENARIO.route, b.progress);
    return Math.abs(p.x - b.x) < 1e-9 && Math.abs(p.y - b.y) < 1e-9;
  }));
const startSignals = scenarioBeaconReadings(start, allBeacons);
const atFirstBeacon = scenarioBeaconReadings(mappedBeacons[0], allBeacons);
expect('서버 스냅샷은 기존 매핑과 경로 가상 두 개만 사용',
  start.beacons.length === mappedBeacons.length + 2 &&
  start.beacons.filter(b => b.mapped).length === mappedBeacons.length &&
  start.beacons.filter(b => b.virtual).length === 2);
expect('기존 위치의 신호원 수와 실제 ID를 보존',
  start.beacons[0].count === 1 && start.beacons[0].beaconIds[0] === 'ble:existing-alley');
expect('기존 비콘 위치에 가까워지면 해당 RSSI가 강해짐',
  atFirstBeacon[0].rssi > startSignals[0].rssi,
  `${startSignals[0].rssi} → ${atFirstBeacon[0].rssi} dBm`);

if (failed) process.exit(1);
console.log('\n사진 시나리오 90초 동기화 통과');
