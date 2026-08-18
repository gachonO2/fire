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

import { BearingSensor, alignment, proximity, ALIGNED_DEG } from '../bearing';
import { RouteFollower, routeHitsHazard } from '../route';
import { Odometry } from '../odometry';
import { NorthCalibrator } from '../calibrate';
import { HapticCompass, cueStart, cueLocked } from '../haptics';
import { beepDirection, chimeGood, chimeWrong, chimeLocked } from '../sound';
import { say, stopSpeaking } from '../announce';
import { theme } from '../theme';

const TICK_MS = 110;
const STABILITY_FLOOR = 0.25;     // 자기장이 이보다 흔들리면 방향을 믿지 않는다
const CONFIDENCE_FLOOR = 0.35;    // 걸음 확신도가 이보다 낮으면 안내 중단
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

export default function GuideScreen({ api, plan, route, startNode, onExit, onSafeHold }) {
  const [err, setErr] = useState(null);
  const [align, setAlign] = useState(0);
  const [blocked, setBlocked] = useState(false);   // 방향을 믿을 수 없는 상태
  const [arrived, setArrived] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [info, setInfo] = useState(null);

  const sensor = useRef(new BearingSensor()).current;
  const haptic = useRef(new HapticCompass()).current;
  const odo = useRef(new Odometry()).current;
  const followerRef = useRef(new RouteFollower(plan, route));
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
    cueStart();
    setInfo(followerRef.current.describe());

    const d = followerRef.current.describe();
    speak(`대피 안내를 시작합니다. ${d.exitName}까지 ${fmt(d.totalMetersLeft)}미터. `
      + (noNorth.current
        ? '좌우 회전으로 안내합니다.'
        : '폰을 들고 천천히 돌리세요. 방향이 맞으면 진동이 세집니다.'));
    setTimeout(() => alive && announceSegment(true), 2600);

    const timer = setInterval(() => alive && tick(), TICK_MS);
    const hazardTimer = setInterval(() => alive && checkHazards(), HAZARD_POLL_MS);

    return () => {
      alive = false;
      clearInterval(timer);
      clearInterval(hazardTimer);
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

    if (odo.confidence < CONFIDENCE_FLOOR) safeHold('위치를 확인할 수 없습니다.');
  }

  // ---------------------------------------------------- 한 걸음
  function onStep() {
    if (halted.current || arrived) return;
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
      if (wasBlind) {
        noNorth.current = false;
        chimeGood();
        speak('방향을 잡았습니다. 폰을 돌리면 맞는 쪽에서 진동이 세집니다.');
      }
    }

    const { advanced, arrived: done } = f.step();
    setInfo(f.describe());
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
    followerRef.current = new RouteFollower(plan, res.route);
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

      {/* 버튼은 눈이 보이는 사람용. 시각장애인은 화면 아무 데나 누르면 다시 듣는다. */}
      <View style={styles.controls}>
        <Pressable style={styles.circle} onPress={onExit}
                   accessibilityRole="button" accessibilityLabel="안내 종료">
          <Text style={styles.circleIcon}>✕</Text>
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
