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
const start = photoScenarioSnapshot(startedAt, startedAt);
const middle = photoScenarioSnapshot(startedAt, startedAt + 45_000);
const end = photoScenarioSnapshot(startedAt, startedAt + 90_000);

expect('자동 대피 시간은 정확히 90초', PHOTO_SCENARIO.durationMs === 90_000);
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
  photoScenarioSnapshot(startedAt, startedAt + 180_000).progress === 1);

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

expect('탈출 경로에 시연용 비콘 4개 배치',
  PHOTO_SCENARIO.beacons.length === 4 &&
  PHOTO_SCENARIO.beacons.every(b => b.id.startsWith('SIM-EXIT-')));
const startSignals = scenarioBeaconReadings(start);
const atFirstBeacon = scenarioBeaconReadings(PHOTO_SCENARIO.beacons[0]);
expect('서버 스냅샷에 네 비콘 RSSI 포함',
  start.beacons.length === 4 && start.beacons.every(b => Number.isFinite(b.rssi)));
expect('비콘에 가까워지면 해당 RSSI가 강해짐',
  atFirstBeacon[0].rssi > startSignals[0].rssi,
  `${startSignals[0].rssi} → ${atFirstBeacon[0].rssi} dBm`);

if (failed) process.exit(1);
console.log('\n사진 시나리오 90초 동기화 통과');
