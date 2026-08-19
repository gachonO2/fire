/**
 * 대피 안내 — 아이폰 '나의 찾기' 정밀 찾기 화면을 따랐다.
 *
 * ## 화면에 세 가지만 둔다
 *
 *   위     어디 건물인가        (현재 위치 · AI 공학관 7층)
 *   가운데  어느 쪽인가          (큰 화살표)
 *   아래   얼마나 남았는가       (7.4m · 사용자의 오른쪽)
 *
 * 설명 문구를 화면에 늘어놓지 않는다. 눈이 보이는 사람에게는 **한눈에 안 읽히면
 * 없느니만 못하고**, 시각장애인에게는 애초에 안 보인다. 알려야 할 사정은
 * **말로** 전한다 — 그게 이 앱에서 정보를 전달하는 본래 통로다.
 *
 * ## 걸음 수가 아니라 미터로 말한다
 *
 * 걸음은 사람마다 보폭이 달라 옮겨 말할수록 어긋난다. 비콘이 거리를 직접 주므로
 * 미터가 원본이고, 걸음은 그걸 나눈 값일 뿐이다. 원본을 말한다.
 *
 * ## 폰은 진동 모터가 하나뿐이다
 *
 * "왼쪽만 진동"은 물리적으로 불가능하다. 그래서 방향을 공간이 아니라 **시간축**에
 * 담는다 — 폰을 돌리면 맞는 쪽에서 진동이 세지고 촘촘해진다.
 *
 *   진동  세기 — 얼마나 맞는 방향인가
 *   소리  좌우 — 어느 쪽으로 돌려야 하는가 (스테레오는 실제로 갈린다)
 *
 * ## 모르면 안내하지 않는다
 *
 * 방향을 못 믿는 상황이면 **화살표를 죽이고 진동을 끈다.** 틀린 방향을 자신 있게
 * 알려주는 것은 아무것도 안 하는 것보다 위험하다. 화면 문구는 지웠지만
 * **이 판단과 음성 안내는 절대 지우지 말 것.**
 */

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { Barometer, Magnetometer } from 'expo-sensors';

import { BearingSensor, alignment, proximity, ALIGNED_DEG } from '../bearing';
import { Tracking } from '../tracking';
import { WalkSim } from '../walk-sim';
import { scanBeacons } from '../beaconLocator';
import { withVirtualBeacons } from '../beaconSim';
import PositionMap from './PositionMap';
import { RouteFollower, routeHitsHazard } from '../route';
import { routeToNearestExit } from '../pathfinding';
import { Odometry } from '../odometry';
import { NorthCalibrator } from '../calibrate';
import { HapticCompass, cueStart, cueLocked } from '../haptics';
import { beepDirection, chimeGood, chimeWrong, chimeLocked } from '../sound';
import { say, stopSpeaking } from '../announce';
import { deviceIdNow } from '../deviceId';
import EmergencyTorch from '../EmergencyTorch';
import { theme } from '../theme';

const TICK_MS = 110;
const STABILITY_FLOOR = 0.25;     // 자기장이 이보다 흔들리면 방향을 믿지 않는다
const CONFIDENCE_FLOOR = 0.35;    // 위치 확신도가 이보다 낮으면 안내 중단

/**
 * 확신도가 이 시간 **내리** 낮아야 안전상태로 넘어간다.
 *
 * 한 틱 떨어졌다고 바로 멈추면 안 된다. 갈림길에 들어서는 순간에는 정말로 잠깐
 * 어느 쪽인지 모르고, 그건 정직한 하락이다. 시뮬레이션에서도 교차점마다 몇 걸음씩
 * 떨어졌다가 회복됐다. 비콘 판정이 `holdMs` 를 두는 것과 같은 이유다.
 */
const LOW_CONF_MS = 3000;

/** 비콘 스캔 주기 — 실제 BLE 광고 주기와 같은 규모 */
const SCAN_MS = 500;

/**
 * 이보다 빨리 방위가 돌면 **제자리 회전**으로 보고 위치를 전진시키지 않는다.
 *
 * 가속도계는 몸을 트는 동작도 봉우리로 잡는다. 그대로 걸음으로 세면 서서 두리번거리기만
 * 해도 지도의 점이 복도를 따라 나아가고, 방위까지 바뀌니 가상 보행자가 엉뚱한 복도로
 * 꺾여 버린다.
 *
 * 모퉁이를 돌며 걷는 것과 겹치지 않게 넉넉히 잡았다. 조금 덜 세는 쪽이,
 * 서 있는 사람을 움직였다고 하는 것보다 낫다 — 덜 센 것은 비콘이 곧 바로잡는다.
 */
const TURNING_DPS = 90;

/**
 * 경로에서 벗어난 것으로 보이는 상태가 이 시간 이어져야 재탐색한다.
 *
 * 갈림길을 지나는 순간에는 잠깐 옆 통로로 읽힐 수 있다. 그때마다 "경로를
 * 벗어났습니다"를 말하면 안내가 소음이 된다. 확신도 문턱과 같은 이유의 지연이다.
 */
const OFF_ROUTE_MS = 4000;
const HAZARD_POLL_MS = 3000;
const SUMMARY_MS = 30000;

/**
 * 방향이 완전히 틀렸을 때도 남겨두는 진동 세기.
 *
 * 0 으로 두면 **아무 신호가 없어서** 고장인지 틀린 건지 알 수가 없다.
 * 약하고 느린 맥박을 남겨 "살아 있지만 아니다"를 전한다.
 * 맞는 방향(빠르고 센 진동)과는 확실히 구분된다.
 */
const WRONG_FLOOR = 0.1;

/** 아직 방위를 못 잡았을 때 내보내는 "탐색 중" 맥박 */
const SEEKING = 0.06;

/** 틀린 방향으로 서 있을 때 다시 알려주는 간격 */
const WRONG_NAG_MS = 6000;

/** 서버에서 건물 이름을 못 받았을 때 보여줄 값 */
const FALLBACK_PLACE = 'AI 공학관 7층';

export default function GuideScreen({ api, plan, route, walls: wallsProp = null,
                                      startNode, scenario = null, onExit, onSafeHold }) {
  const [err, setErr] = useState(null);
  const [align, setAlign] = useState(0);
  const [blocked, setBlocked] = useState(false);   // 방향을 믿을 수 없는 상태
  // 지도는 **동행하는 사람과 만드는 사람**을 위한 것이다. 화살표 하나로는
  // "위치가 맞게 잡히고 있나"를 확인할 수 없고, 확인이 안 되면 측위가 되는지 모른다.
  const [showMap, setShowMap] = useState(true);
  const [arrived, setArrived] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [info, setInfo] = useState(null);

  const sensor = useRef(new BearingSensor()).current;
  const haptic = useRef(new HapticCompass()).current;
  const odo = useRef(new Odometry()).current;
  // 기기마다 하나. 새로고침해도 안 바뀐다 — 바뀌면 관제에 유령이 하나씩 쌓인다.
  const userId = useRef(deviceIdNow());
  const followerOptions = wallSet => ({
    walls: wallSet,
    path: scenario?.route ?? null,
    metersPerUnit: scenario?.metersPerUnit ?? null,
  });
  const followerRef = useRef(new RouteFollower(plan, route, followerOptions(wallsProp)));

  // 판단 계층. 비콘·걸음·기압·지자기를 하나의 위치·확신도로 모은다(`src/tracking.js`).
  // 경로 추종(RouteFollower)과 **일부러 분리**한다 — 경로 추종은 "걸었으니 갔겠지"로
  // 미는 값이라, 합치면 경로에서 벗어난 것을 영영 알 수 없다.
  const tracking = useRef(
    new Tracking(withVirtualBeacons(plan), { startNodeId: startNode?.id })
  ).current;
  // 시뮬레이션에서 "실제로 서 있는 곳". 가상 비콘이 여기서 신호를 만든다.
  //
  // 예전에는 경로 위 위치를 썼는데, 그러면 어디로 걷든 가상 위치가 경로를 따라가서
  // **경로 이탈을 재현할 수 없었다.** 이제 진짜 걸음과 진짜 나침반으로 움직이되
  // 복도에 갇혀 있다 — 갈림길에서 딴 쪽으로 꺾으면 진짜로 그쪽으로 간다.
  const walkSim = useRef(new WalkSim(withVirtualBeacons(plan), startNode?.id)).current;
  const magUt = useRef(null);        // 마지막 자기장 크기 — 걸음마다 판단 계층에 넣는다
  const offRouteSince = useRef(0);   // 경로를 벗어난 것으로 보이기 시작한 시각
  const realBeacons = useRef(false); // 맥이 들은 진짜 신호를 한 번이라도 받았나
  const headingMark = useRef(null);  // 회전 속도 판정용 (직전 방위·시각)
  const [mapped, setMapped] = useState(0);   // 실제 전파로 자리를 알아낸 신호원 수
  // 도면 사진 — 지도 배경. 한 번만 받아 둔다(수백 KB 라 매번 받으면 안 된다).
  const [planImage, setPlanImage] = useState(null);
  const [walls, setWalls] = useState(wallsProp);
  const lowConfSince = useRef(0);    // 확신도가 낮아진 시각 (0 = 정상)
  const rotate = useRef(new Animated.Value(0)).current;

  const zone = useRef(null);
  const lastBeep = useRef(0);
  const lastSummary = useRef(0);
  const routeRef = useRef(route);
  const halted = useRef(false);
  const noNorth = useRef(false);
  const lastSpoken = useRef('');
  const calib = useRef(new NorthCalibrator()).current;
  const lastWrongNag = useRef(0);

  const place = plan?.name?.trim() || FALLBACK_PLACE;

  // ---------------------------------------------------- 시작
  useEffect(() => {
    let alive = true;

    sensor.start();
    haptic.start();
    odo.onStep = () => onStep();
    odo.start();

    // 도면에 보정값이 있으면 그대로 쓰고, 없으면 걸으면서 알아낸다(`src/calibrate.js`).
    const known = followerRef.current.northOffset;
    if (known !== null) { calib.offset = known; calib.samples = 3; }
    noNorth.current = known === null;

    // 도면 사진을 받아 지도 배경으로 깐다. 없어도 선으로는 그려지므로 조용히 넘어간다.
    if (plan?.id && plan?.image?.width) {
      api?.getPlanImage?.(plan.id)
        .then(r => { if (alive && r?.dataUri) setPlanImage(r.dataUri); })
        .catch(() => {});
    }

    // 벽을 받아 두면 통로를 그릴 때 **덜 뚫는 쪽으로** 꺾을 수 있다.
    // 없어도 그려지므로(긴 축 먼저) 조용히 넘어간다.
    if (plan?.id) {
      api?.getPlanWalls?.(plan.id)
        .then(w => {
          if (!alive || !w?.walls?.length) return;
          setWalls(w.walls);
          // 아직 출발 전이면 경로도 다시 편다 — 그리는 쪽과 같은 꺾임을 써야 한다
          followerRef.current?.setWalls?.(w.walls);
          setInfo(followerRef.current.describe());
        })
        .catch(() => {});
    }

    cueStart();
    setInfo(followerRef.current.describe());

    // 시작 즉시 한 번, 이후 주기적으로 — 멈춰 서 있어도 관제에서 사라지지 않게
    report('guiding');
    const reportTimer = setInterval(() => report(), 2000);

    const d = followerRef.current.describe();
    speak(`대피 안내를 시작합니다. ${d.exitName}까지 ${fmt(d.totalMetersLeft)}미터. `
      + (noNorth.current
        ? '좌우 회전으로 안내합니다.'
        : '폰을 들고 천천히 돌리세요. 방향이 맞으면 진동이 세집니다.'));
    setTimeout(() => alive && announceSegment(true), 2600);

    const timer = setInterval(() => alive && tick(), TICK_MS);
    const hazardTimer = setInterval(() => alive && checkHazards(), HAZARD_POLL_MS);

    // 비콘을 **걷는 동안에도** 계속 확인한다. 예전에는 출발 지점을 잡을 때 한 번
    // 스캔하고 끝이라, 걸음 오차가 쌓여도 바로잡을 길이 없었다.
    //
    // 두 갈래로 듣는다:
    //   진짜  맥이 BLE 를 대신 듣고 서버가 판정한 것 (Expo Go 는 BLE 를 못 읽는다)
    //   가상  맥이 없을 때를 위한 시뮬레이션
    // **진짜가 들어오면 가상은 멈춘다.** 둘 다 넣으면 서로 다른 위치를 우겨 댄다.
    const bp = withVirtualBeacons(plan);
    const scanTimer = setInterval(async () => {
      if (!alive) return;
      const now = Date.now();

      const got = await api?.getBeaconFix?.().catch(() => null);

      // **진짜 수신기가 붙어 있으면 가상 비콘을 쓰지 않는다.**
      //
      // 둘을 같이 돌리면 순환이 된다: 가상 비콘이 폰 위치를 잡고 → 그 위치로 실제
      // 신호를 매핑하고 → 그 매핑으로 위치를 잡는다. 자기가 만든 답을 자기가 다시
      // 읽는 것이라, 걸어도 진짜가 되지 않는다.
      //
      // 그래서 스캐너가 붙은 순간부터 위치는 **걸음 + 실제 전파**로만 간다.
      // 매핑이 쌓이기 전에는 걸음만으로 버티고, 쌓이면 전파가 이어받는다.
      if (got?.scanner) {
        if (!realBeacons.current) {
          realBeacons.current = true;
          speak('실제 비콘 수신기에 연결됐습니다. 걸으면 지도가 만들어집니다.');
        }
        setMapped(got.mapped ?? 0);
        if (got.fix?.nodeId) tracking.pushRemoteFix(got.fix.nodeId);
        return;
      }
      if (realBeacons.current) return;   // 진짜에 붙은 적이 있으면 가상으로 안 돌아간다

      tracking.pushScans(scanBeacons(bp, now, walkSim.position()), now);
    }, SCAN_MS);

    // 기압계 — 층이 바뀌면 엘리베이터·계단 노드가 공짜 앵커가 된다
    let baroSub = null;
    Barometer.isAvailableAsync().then(ok => {
      if (!ok || !alive) return;
      Barometer.setUpdateInterval(1000);
      baroSub = Barometer.addListener(({ pressure }) => {
        const change = tracking.pushPressure(pressure, Date.now());
        if (change) {
          // 층이 바뀌면 **도면도 바뀌어야 한다.** 지금 도면 모델은 한 층짜리라
          // 여기서는 알리기만 한다(다음 단계에서 도면 교체를 붙인다).
          speak(change.kind === 'elevator'
            ? `엘리베이터로 ${Math.abs(change.floors)}개 층 이동했습니다.`
            : `계단으로 ${Math.abs(change.floors)}개 층 이동했습니다.`);
        }
      });
    }).catch(() => {});

    // 자력계 — 지문이 있는 도면에서만 쓰인다. 값만 받아 두고 걸음마다 넣는다.
    let magSub = null;
    Magnetometer.isAvailableAsync().then(ok => {
      if (!ok || !alive) return;
      Magnetometer.setUpdateInterval(200);
      magSub = Magnetometer.addListener(({ x, y, z }) => {
        // 크기만 쓴다 — 폰을 어떻게 들든 같은 값이라 자세와 무관해진다
        magUt.current = Math.sqrt(x * x + y * y + z * z);
      });
    }).catch(() => {});

    return () => {
      alive = false;
      clearInterval(reportTimer);
      clearInterval(timer);
      clearInterval(hazardTimer);
      clearInterval(scanTimer);
      baroSub?.remove?.();
      magSub?.remove?.();
      haptic.stop();
      sensor.stop();
      odo.stop();
      stopSpeaking();
    };
  }, []);

  /** 마지막으로 한 말을 기억해 둔다 — 화면을 누르면 다시 들려준다 */
  function speak(text) {
    lastSpoken.current = text;
    say(text, { force: true });
  }

  function repeat() {
    if (lastSpoken.current) say(lastSpoken.current, { force: true });
  }

  // ---------------------------------------------------- 매 틱
  function tick() {
    if (halted.current || arrived) return;

    const f = followerRef.current;
    const target = f.trueBearing();
    const shaky = sensor.stability < STABILITY_FLOOR;
    setInfo(f.describe());

    // 자기장이 심하게 흔들리면 방향을 못 믿는다 — 이때만 완전히 끈다.
    if (shaky) {
      haptic.setStrength(0);
      setBlocked(true);
      setErr(null);
      return;
    }

    // 아직 방위를 못 잡았다. **조용히 있지 않는다** — 예전에는 여기서 그냥
    // 돌아가 버려서 진동도 소리도 전혀 없었다("아무 반응이 없다"의 원인).
    // 약한 맥박을 내보내고, 걸으라고 말한다. 걸으면 보정이 잡힌다.
    if (target === null) {
      haptic.setStrength(SEEKING);
      setBlocked(true);
      setErr(null);
      if (Date.now() - lastSummary.current > 8000) {
        lastSummary.current = Date.now();
        const d = f.describe();
        speak(`${d.targetName} 쪽으로 앞으로 걸으세요. 몇 걸음 걸으면 방향을 잡습니다.`);
      }
      return;
    }
    setBlocked(false);

    const e = sensor.errorTo(target);
    const a = alignment(e);
    setErr(e);
    setAlign(a);
    // 틀린 방향에서도 0 으로 떨어뜨리지 않는다. 완전한 무음은
    // "고장"과 구분되지 않아서, 사용자가 폰을 흔들며 시간을 버린다.
    haptic.setStrength(Math.max(WRONG_FLOOR, a * proximity(f.metersLeft, 15)));

    if (e !== null) {
      const gap = 620 - 520 * a;
      const now = Date.now();
      if (now - lastBeep.current >= gap) {
        lastBeep.current = now;
        beepDirection(a, e, a);
      }

      // 세 구역. 구역이 바뀔 때만 울린다 — 매번 울리면 의미가 없어진다.
      // 처음부터 반대로 서 있어도 경고가 나오도록 첫 진입에도 울린다.
      const nowZone = a >= 0.92 ? 'good' : a >= 0.35 ? 'near' : 'far';
      if (nowZone !== zone.current) {
        const prev = zone.current;
        zone.current = nowZone;
        if (nowZone === 'good') {
          chimeGood();
          speak(`정면입니다. ${fmt(f.metersLeft)}미터 앞으로.`);
        } else if (nowZone === 'far') {
          chimeWrong();
          odo.penalize(0.02);
          lastWrongNag.current = Date.now();
          // 처음부터 반대로 서 있어도 알려준다 (prev === null 이어도 말한다)
          speak(e > 0 ? '오른쪽으로 도세요.' : '왼쪽으로 도세요.');
        }
      }

      // 계속 틀린 채로 서 있으면 주기적으로 다시 알려준다.
      // 한 번 말하고 마는 것으로는, 못 들었거나 잊은 사람을 도울 수 없다.
      if (nowZone === 'far' && Date.now() - lastWrongNag.current > WRONG_NAG_MS) {
        lastWrongNag.current = Date.now();
        chimeWrong();
        speak(e > 0 ? '오른쪽으로 도세요.' : '왼쪽으로 도세요.');
      }

      if (Date.now() - lastSummary.current > SUMMARY_MS) {
        lastSummary.current = Date.now();
        const s = e > ALIGNED_DEG ? '오른쪽' : e < -ALIGNED_DEG ? '왼쪽' : '정면';
        say(`${f.describe().targetName}까지 ${fmt(f.metersLeft)}미터. ${s}입니다.`);
      }
    }

    Animated.timing(rotate, {
      toValue: e ?? 0, duration: TICK_MS, easing: Easing.linear, useNativeDriver: true,
    }).start();

    // 경로를 벗어났나 — 신호가 말하는 통로와 경로 추종이 믿는 통로가 다르면.
    //
    // 경로 추종은 "걸었으니 갔겠지"로 미는 값이라 **어긋나면 대개 그쪽이 틀렸다.**
    // 다만 확신이 있을 때만 판단하고(`offRoute` 안에서 거른다), 잠깐 어긋난 것으로
    // 흔들지 않도록 몇 초 이어질 때만 재탐색한다.
    const onEdge = f.position()?.edgeId ?? null;
    if (!scenario && tracking.offRoute(onEdge)) {
      if (!offRouteSince.current) offRouteSince.current = Date.now();
      else if (Date.now() - offRouteSince.current > OFF_ROUTE_MS) {
        offRouteSince.current = 0;
        rerouteFromHere();
      }
    } else {
      offRouteSince.current = 0;
    }

    // 확신도가 **내리** 낮을 때만 멈춘다. 한 틱 떨어졌다고 멈추면 갈림길마다
    // 안내가 끊긴다 — 시뮬레이션에서 교차점마다 몇 걸음씩 떨어졌다가 회복됐다.
    if (tracking.confidence() < CONFIDENCE_FLOOR) {
      if (!lowConfSince.current) lowConfSince.current = Date.now();
      else if (Date.now() - lowConfSince.current > LOW_CONF_MS) {
        safeHold('위치를 확인할 수 없습니다.');
      }
    } else {
      lowConfSince.current = 0;
    }
  }

  // ---------------------------------------------------- 관제로 위치 보고
  /**
   * 지금 위치를 서버에 올린다 — 관제 지도의 점이 이 값으로 움직인다.
   *
   * 걸음마다 보내면 관제에서 점이 뚝뚝 끊겨 보인다. 사람은 초당 두 걸음쯤 걷고
   * 그 사이 실제로는 부드럽게 이동하므로, **일정 주기로도 함께 보낸다**.
   * (부드럽게 잇는 건 관제 쪽에서 보간한다)
   *
   * 실패는 무시한다. 위치 보고가 안 된다고 안내를 멈추면 본말이 전도된다.
   */
  function report(phase) {
    const f = followerRef.current;
    if (!f) return;
    const pos = f.position();
    const d = f.describe();
    api?.updatePosition?.(userId.current, {
      nodeId: pos?.fromNodeId ?? startNode?.id ?? null,
      nodeName: d.targetName,
      phase: phase || (arrived ? 'arrived' : halted.current ? 'safehold' : 'guiding'),
      x: pos?.x, y: pos?.y,
      edgeId: pos?.edgeId ?? null,
      progress: pos?.progress ?? 0,
      // 판단 계층이 낸 값이다. 걸음만 세던 예전 값과 달리 비콘·기압·지자기가
      // 함께 들어가 있고, 증거 없이 오래 걸으면 스스로 떨어진다.
      confidence: tracking.confidence(),
      source: tracking.source(),        // 'beacon' | 'barometer' | 'magnetic' | 'pdr'
      // **어느 쪽을 보고 있나.** 관제가 «저 사람 반대로 서 있다» 를 볼 수 있어야 하고,
      // 무엇보다 화면의 부채꼴과 경로선이 어긋날 때 그걸 잴 길이 이것뿐이다.
      // 자북 기준 그대로 보낸다 — 도면 기준으로 바꾸는 일은 받는 쪽이 한다.
      heading: Number.isFinite(sensor.heading) ? sensor.heading : null,
      headingStable: sensor.stability >= STABILITY_FLOOR,
      exitName: d.exitName,
      stepsLeft: d.stepsLeft,
      routeNodes: route?.nodes || null,
      routeEdges: route?.edges || null,
    });
  }

  // ---------------------------------------------------- 한 걸음
  function onStep() {
    if (arrived) return;

    // **안전상태에서도 걸음은 센다.**
    //
    // 예전에는 여기서 halted 를 보고 통째로 돌아갔는데, 그러면 빠져나갈 길이
    // 없어진다: 확신도가 떨어져 안전상태에 들어가면 → 걸음이 무시되고 →
    // 판단 계층이 안 움직이고 → 확신도가 영영 회복되지 않는다. 실제로 이것 때문에
    // 걸어도 위치가 「출구」에 붙박여 있었다.
    //
    // 안전상태는 **안내를 멈추는 것**이지 센서를 끄는 것이 아니다. 계속 세다가
    // 위치를 되찾으면 안내를 다시 시작한다.
    // 제자리에서 도는 중인가 — 방위가 빠르게 변하면 걸음이 아니라 회전이다
    const nowMs = Date.now();
    const mark = headingMark.current;
    let turning = false;
    if (Number.isFinite(sensor.heading)) {
      if (mark && nowMs > mark.t) {
        const d = Math.abs(((sensor.heading - mark.deg + 540) % 360) - 180);
        turning = d / ((nowMs - mark.t) / 1000) > TURNING_DPS;
      }
      headingMark.current = { deg: sensor.heading, t: nowMs };
    }

    if (!turning) {
      tracking.step({ heading: sensor.heading, microTesla: magUt.current });
      const trustedH = sensor.stability >= STABILITY_FLOOR ? sensor.heading : undefined;
      walkSim.step(trustedH);
    }
    report();

    if (halted.current) { maybeResume(); return; }   // 안내는 아직 멈춘 상태
    if (turning) return;                              // 제자리 회전 — 방향만 바뀌고 위치는 그대로

    const f = followerRef.current;

    // 걷는 방향이 곧 그 구간의 실제 방위다. 몇 걸음 곧게 걸으면 보정이 잡힌다.
    const got = calib.step({
      heading: sensor.heading,
      planBearing: f.planBearing(),
      stable: sensor.stability >= STABILITY_FLOOR,
    });
    if (got) {
      const wasBlind = f.northOffset === null;
      f.setNorthOffset(got.offset);
      // 판단 계층에도 같은 값을 넣는다 — 이게 빠져 있어서 나침반이 후보를
      // 감점하는 일을 한 번도 못 했다. 안내기만 알고 있으면 «폰을 돌리세요» 는
      // 되지만 «어느 갈래로 갔나» 는 여전히 걸음으로만 판단하게 된다.
      tracking.setNorthOffset(got.offset);
      if (wasBlind) {
        noNorth.current = false;
        chimeGood();
        speak('방향을 잡았습니다. 폰을 돌리면 맞는 쪽에서 진동이 세집니다.');
        // 서버에도 남긴다 — 건물이 돌아가지 않으니 한 번 재면 끝나는 값이다.
        // 다음 사람은 곧게 네 걸음을 걷기 전부터 방향 안내를 받는다.
        if (plan?.id) api?.setPlanNorth?.(plan.id, got.offset, '걸으면서 자동 보정')
          ?.catch?.(() => {});
      }
    }

    const { advanced, arrived: done } = f.step();
    setInfo(f.describe());
    report();
    if (!advanced) return;

    zone.current = null;
    calib.resetSegment();
    if (done) return finish();

    odo.reward();
    chimeLocked();
    cueLocked();
    announceSegment(false);
  }

  function announceSegment(atStart) {
    const f = followerRef.current;
    const d = f.describe();
    const turn = f.turnInto();
    // 좌우 회전은 이전 구간과의 차이라, 도면 방위 보정이 없어도 맞다.
    if (!atStart && turn && turn.side !== 'straight') {
      speak(`${turn.side === 'right' ? '오른쪽' : '왼쪽'}으로 도세요. 그다음 ${fmt(d.metersLeft)}미터.`);
    } else {
      speak(`${d.targetName} 방향으로 ${fmt(d.metersLeft)}미터.`);
    }
  }

  // ---------------------------------------------------- 경로를 벗어났을 때
  /**
   * 지금 있는 곳에서 경로를 다시 짠다.
   *
   * 출발점을 **판단 계층이 말하는 위치**로 잡는다. 경로 추종이 믿는 위치는 방금
   * 틀린 것으로 판명된 값이라, 그걸 기준으로 다시 짜면 같은 곳으로 또 안내한다.
   */
  async function rerouteFromHere() {
    if (halted.current || arrived) return;
    const here = tracking.position()?.nodeId;
    if (!here) return;

    speak('경로를 벗어났습니다. 지금 계신 곳에서 다시 안내합니다.');
    const res = await api?.route?.(here, 'reroute');
    const next = res?.route ?? routeToNearestExit(plan, here);
    if (!next) return safeHold('여기서 갈 수 있는 안전한 경로가 없습니다.');

    routeRef.current = next;
    followerRef.current = new RouteFollower(plan, next, followerOptions(walls));
    zone.current = null;
    calib.resetSegment();
    setInfo(followerRef.current.describe());
    chimeGood();
    announceSegment(true);
  }

  // ---------------------------------------------------- 불이 번졌을 때
  async function checkHazards() {
    if (halted.current || arrived || !api?.configured) return;
    const hazards = await api.getHazards();
    if (!hazards || !routeHitsHazard(routeRef.current, hazards)) return;

    speak('경로에 위험이 감지됐습니다. 다른 길을 찾습니다.');
    const from = followerRef.current.target?.id || startNode?.id;
    const res = await api.route(from, 'reroute');
    if (!res?.route) return safeHold('안전한 경로를 찾지 못했습니다.');

    routeRef.current = res.route;
    followerRef.current = new RouteFollower(plan, res.route, followerOptions(walls));
    zone.current = null;
    setInfo(followerRef.current.describe());
    chimeGood();
    announceSegment(true);
  }

  function finish() {
    setArrived(true);
    haptic.setStrength(0);
    haptic.stop();
    chimeGood();
    speak(`${followerRef.current.describe().exitName}에 도착했습니다. 계단으로 내려가세요.`);
  }

  /**
   * 안내를 멈추고 도움을 요청한다.
   * 위치를 못 믿는 채로 계속 안내하면 사용자를 더 위험한 곳으로 보낼 수 있다.
   */
  /**
   * 위치를 되찾았으면 안내를 다시 시작한다.
   *
   * 이게 없으면 안전상태가 **막다른 길**이 된다. 실제로 `halted` 를 false 로
   * 되돌리는 코드가 한 군데도 없어서, 한 번 들어가면 앱을 다시 켜야 했다.
   * 확신도가 문턱을 **넉넉히** 넘을 때만 푼다 — 문턱 근처에서 오락가락하면
   * 안내가 켜졌다 꺼졌다 하며 더 혼란스럽다.
   */
  function maybeResume() {
    if (!halted.current || arrived) return;
    if (tracking.confidence() < CONFIDENCE_FLOOR + 0.2) return;

    halted.current = false;
    lowConfSince.current = 0;
    setStopped(false);
    haptic.start();
    zone.current = null;
    chimeGood();
    speak('위치를 다시 찾았습니다. 안내를 이어갑니다.');
    announceSegment(true);
  }

  function safeHold(reason) {
    if (halted.current) return;
    halted.current = true;
    setStopped(true);
    haptic.setStrength(0);
    haptic.stop();
    speak(`${reason} 그 자리에 서서 도움을 요청하세요. 보호자에게 알렸습니다.`);
    api?.sos?.({ reason, at: new Date().toISOString(), node: followerRef.current.target?.id });
    onSafeHold?.(reason);
  }

  // ---------------------------------------------------- 화면
  const spin = rotate.interpolate({
    inputRange: [-180, 180], outputRange: ['-180deg', '180deg'],
  });
  const good = align >= 0.92 && !blocked && !stopped;
  const dim = blocked || stopped;

  const side = arrived ? '도착했습니다'
    : stopped ? '그 자리에서 도움을 요청하세요'
    : blocked || err === null ? '방향 확인 중'
    : Math.abs(err) <= ALIGNED_DEG ? '정면'
    : err > 0 ? '사용자의 오른쪽' : '사용자의 왼쪽';

  return (
    <Pressable
      style={styles.root}
      onPress={repeat}
      accessibilityRole="button"
      accessibilityLabel="안내 다시 듣기"
    >
      {/* 안내 화면을 완전히 종료할 때까지 계속 점멸한다. 도착·안전정지 뒤에도
          주변 사람이 대피자를 찾는 신호는 필요하므로 상태로 끄지 않는다. */}
      <EmergencyTorch />

      {/* 위 — 어디 건물인가 */}
      <View style={styles.header} pointerEvents="none">
        {/* 시연용 도면은 실재하지 않는 건물이다. 시각장애인에게는 음성으로 알렸지만
            동행자·저시력자도 알아야 하므로 화면에도 남긴다 (이중화 규칙). */}
        {plan?.demo && (
          <Text style={styles.demoBadge}>
            ⚠️ 시연용 도면 — 실제 건물이 아닙니다
          </Text>
        )}
        <Text style={styles.eyebrow}>현재 위치</Text>
        <Text style={styles.place} numberOfLines={1}>{place}</Text>
      </View>

      {/* 가운데 — 어느 쪽인가.
          눈이 보이는 동행자(소방관·가족)와 저시력자를 위한 것이고,
          시각장애인에게는 같은 정보가 진동·소리로 간다. 이중화를 유지할 것. */}
      <View style={styles.arrowArea} pointerEvents="none">
        {arrived ? (
          <Text style={styles.check}>✓</Text>
        ) : (
          <Animated.View style={{ transform: [{ rotate: spin }], opacity: dim ? 0.22 : 1 }}>
            <Arrow color={good ? theme.ok : '#fff'} />
          </Animated.View>
        )}
      </View>

      {/* 아래 — 얼마나 남았는가 */}
      <View
        style={styles.readout}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={
          arrived ? `${info?.exitName || '출구'}에 도착했습니다`
            : `${fmt(info?.metersLeft ?? 0)}미터, ${side}`
        }
      >
        <Text style={[styles.distance, good && styles.distanceGood]}>
          {arrived ? '도착' : fmt(info?.metersLeft ?? 0)}
          {!arrived && <Text style={styles.unit}>m</Text>}
        </Text>
        <Text style={styles.side}>{side}</Text>
        {info && !arrived && (
          <Text style={styles.dest}>
            {info.exitName} · 출구까지 {fmt(info.totalMetersLeft)}m
          </Text>
        )}
      </View>

      {/* 동행자·개발자용 지도. 소리와 진동이 본 안내이고 이건 확인용이다. */}
      {showMap && (
        <View style={styles.mapWrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <PositionMap
            plan={plan}
            route={routeRef.current}
            tracking={tracking}
            heading={sensor.stability >= STABILITY_FLOOR ? sensor.heading : null}
            imageUri={planImage}
            walls={walls}
            routePoints={followerRef.current?.path}
            scenario={scenario}
            scenarioPosition={scenario ? followerRef.current?.position() : null}
            realBeacons={realBeacons.current}
            mapped={mapped}
          />
        </View>
      )}

      {/* 버튼은 눈이 보이는 사람용. 시각장애인은 화면 아무 데나 누르면 다시 듣는다. */}
      <View style={styles.controls}>
        <Pressable style={styles.circle} onPress={onExit}
                   accessibilityRole="button" accessibilityLabel="안내 종료">
          <Text style={styles.circleIcon}>✕</Text>
        </Pressable>
        <Pressable style={styles.circle} onPress={() => setShowMap(v => !v)}
                   accessibilityRole="button" accessibilityLabel="지도 보기 전환">
          <Text style={styles.circleIcon}>🗺️</Text>
        </Pressable>
        <Pressable style={styles.circle} onPress={repeat}
                   accessibilityRole="button" accessibilityLabel="안내 다시 듣기">
          <Text style={styles.circleIcon}>🔊</Text>
        </Pressable>
      </View>
    </Pressable>
  );
}

/** '나의 찾기' 같은 굵은 화살표. 글꼴마다 모양이 달라지지 않도록 도형으로 그린다. */
function Arrow({ color }) {
  return (
    <View style={styles.arrowWrap}>
      <View style={[styles.arrowHead, { borderBottomColor: color }]} />
      <View style={[styles.arrowStem, { backgroundColor: color }]} />
    </View>
  );
}

/** 10m 이상은 정수로 — 대피 중에 소수점은 읽기만 번거롭다 */
function fmt(m) {
  const v = Math.max(0, Number(m) || 0);
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0a0a0b', paddingHorizontal: 28, paddingVertical: 32 },

  header: { gap: 2 },
  demoBadge: {
    color: '#ffd60a', fontSize: 13, fontWeight: '700', marginBottom: 4,
  },
  eyebrow: { color: '#8e8e93', fontSize: 13, fontWeight: '600' },
  place: { color: '#fff', fontSize: 26, fontWeight: '700', letterSpacing: -0.5 },

  arrowArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // 높이를 명시해야 한다. Svg 의 height prop 만으로는 부모가 크기를 못 잡아
  // flex 컨테이너 안에서 0 으로 접힌다 — 실제로 그래서 지도가 안 보였다.
  mapWrap: { height: 210, marginBottom: 12, flexShrink: 0 },
  arrowWrap: { alignItems: 'center' },
  arrowHead: {
    width: 0, height: 0, backgroundColor: 'transparent',
    borderStyle: 'solid', borderLeftWidth: 52, borderRightWidth: 52,
    borderBottomWidth: 58, borderLeftColor: 'transparent', borderRightColor: 'transparent',
  },
  arrowStem: { width: 30, height: 92, marginTop: -1, borderRadius: 3 },
  check: { color: theme.ok, fontSize: 140, fontWeight: '800' },

  readout: { gap: 2, paddingBottom: 6 },
  distance: { color: '#fff', fontSize: 62, fontWeight: '700', letterSpacing: -2 },
  distanceGood: { color: theme.ok },
  unit: { fontSize: 34, fontWeight: '600' },
  side: { color: '#8e8e93', fontSize: 25, fontWeight: '600' },
  dest: { color: '#5a5a5f', fontSize: 15, marginTop: 6 },

  controls: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 },
  circle: {
    width: 62, height: 62, borderRadius: 31, backgroundColor: '#1c1c1e',
    alignItems: 'center', justifyContent: 'center',
  },
  circleIcon: { color: '#fff', fontSize: 24 },
});
