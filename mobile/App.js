/**
 * 대피 안내 앱 — 화면은 하나, 화재가 나면 스스로 바뀐다.
 *
 * ## 화면 구성을 이렇게 둔 이유
 *
 * 평소에 보이는 건 **촬영 화면 하나뿐**이다. 메뉴도 탭도 없다.
 * 시각장애인이 화재 중에 메뉴를 찾아 들어갈 수는 없으므로,
 * 대피 안내는 **사용자가 여는 게 아니라 스스로 열려야** 한다.
 *
 *   평소       촬영 화면 (건축 담당자·보호자·일반 사용자가 도면을 모은다)
 *   화재 감지  경보 화면이 전체를 덮음 (사이렌 + 진동 + 음성 + 손전등)
 *   확인 후    시작 위치 고르기 → 진동 안내
 *
 * ## 서버가 머리, 앱이 몸이다
 *
 * 도면·경로·화재 판정은 전부 `../fire` 백엔드가 한다. 앱은 "다음 지점까지 몇 도,
 * 몇 걸음"을 받아 진동과 소리로 바꾼다. 판단을 두 곳에 두면 관제 화면과 앱이
 * 서로 다른 말을 하게 되고, 대피 중에 그건 치명적이다.
 *
 * ## 서버가 없어도 촬영은 된다
 *
 * 도면 수집은 화재와 무관한 일상 작업이다. 서버 연결을 촬영의 전제로 두면
 * 현장에서 인터넷이 안 될 때 아무것도 못 한다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Alert, SafeAreaView, StyleSheet } from 'react-native';

import HomeScreen from './src/screens/HomeScreen';
import NorthScreen from './src/screens/NorthScreen';
import CaptureScreen from './src/screens/CaptureScreen';
import ReviewScreen from './src/screens/ReviewScreen';
import AlarmScreen from './src/screens/AlarmScreen';
import StartScreen from './src/screens/StartScreen';
import SubmitScreen from './src/screens/SubmitScreen';
import GuideScreen from './src/screens/GuideScreen';
import MagScreen from './src/screens/MagScreen';
import MagSurveyScreen from './src/screens/MagSurveyScreen';
import WalkSurveyScreen from './src/screens/WalkSurveyScreen';
import LiveScreen from './src/screens/LiveScreen';
import FieldScreen from './src/screens/FieldScreen';
import { FireServer, mockFireEvent } from './src/fireServer';
import { Api } from './src/api';
import { locate, locateSource, setLocator } from './src/locator';
import { createBeaconLocator, setVirtualStandNode } from './src/beaconLocator';
import { DEMO_PLAN } from './src/demoPlan';
import { routeToNearestExit } from './src/pathfinding';
import { resolveServerUrl } from './src/serverUrl';
import { initAudio } from './src/sound';
import { initAnnounce, say } from './src/announce';
import { theme } from './src/theme';
import { PHOTO_SCENARIO } from './src/photo-scenario';

/**
 * 서버 주소는 **Expo 개발 서버가 떠 있는 곳**에서 알아낸다 (`src/serverUrl.js`).
 * 맥 IP 를 손으로 적으면 DHCP 로 바뀔 때마다 폰에서 "요청 시간 초과"만 뜬다.
 * 못 찾으면 null — 촬영은 되고 안내만 막힌다.
 */
const SERVER_URL = resolveServerUrl();

/**
 * 위치는 **묻지 않고 알아낸다.** 비콘 신호 세기로 지금 어느 지점인지 판정한다.
 *
 * 이걸 꽂기 전에는 서버가 위치를 모르면 "지금 계신 곳은?" 화면이 떴다 —
 * 불이 난 상황에 시각장애인에게 강의실 13개를 넘겨보라는 뜻이었다.
 *
 * 지금은 시뮬레이션이다(BLE 는 Expo Go 에서 안 된다). 판정 로직은 실기기와
 * 같은 것을 쓰므로, 비콘을 달면 `beaconLocator.js` 의 `scanOnce()` 만 바뀐다.
 */
setLocator(createBeaconLocator());

const PHASE = {
  // **시각장애인이 앱을 열면 만나는 화면.** 예전 기본값은 CAPTURE 였는데, 그러면
  // 앱을 켜자마자 카메라와 측량 도구가 나온다 — 측량 도구가 본체이고 대피가
  // 손님인 구조였다. 라벨을 아무리 붙여도 첫 화면에서 막힌다.
  HOME: 'home',
  CAPTURE: 'capture', REVIEW: 'review', SUBMIT: 'submit',
  ALARM: 'alarm', START: 'start', GUIDE: 'guide',
  // 지자기를 측위에 쓸 수 있는지 재보는 도구 화면. 대피 흐름과 무관하다.
  MAGCHECK: 'magcheck',
  // 보폭·층고·나침반 안정도를 실측하는 도구 화면.
  FIELD: 'field',
  // 맥 스캐너가 잡은 위치를 **대피를 시작하지 않고** 실시간으로 보는 화면.
  LIVE: 'live',
  // 도면 위쪽이 실제 몇 도인지 서서 5초에 잡는다. 이 값이 없으면 방향 안내가
  // 통째로 꺼지므로, 걸어서 재는 현장 측정보다 급할 때 쓴다.
  NORTH: 'north',
  // 통로를 걸으며 자기장 무늬를 남기는 화면. 재현성 검사를 통과한 뒤에 쓴다.
  MAGSURVEY: 'magsurvey',
  // 한 번 걸어서 BLE 답사를 만드는 화면.
  //
  // **이 앱 안에 있어야 한다.** BLE 식별자는 (기기, 출처)마다 다른 값이라,
  // 크롬으로 답사해 놓고 앱으로 안내받으면 매핑이 하나도 안 맞는다.
  // 답사한 폰과 안내받는 폰이 같아야 그 값이 이어진다.
  WALKSURVEY: 'walksurvey',
};


/**
 * 도면에 **지자기 지문을 얹는다.**
 *
 * `MagneticMatcher` 는 통로(엣지)의 `magnetic` 배열을 읽는다. 지문은 도면과
 * 따로 저장되므로(측량이 도면 등록보다 나중이고, 도면을 다시 판독해도 지문은
 * 남아야 한다) 도면을 받을 때마다 합쳐 준다.
 *
 * 지문을 못 받아도 도면은 그대로 쓴다 — 지자기는 있으면 좋은 보조 단서이고,
 * 없으면 비콘과 걸음으로 간다. 여기서 막히면 대피 안내가 아예 안 뜬다.
 */
async function withMagneticPrints(api, plan) {
  if (!plan?.edges?.length) return plan;
  const got = await api?.getMagneticPrints?.().catch(() => null);
  const prints = got?.prints;
  if (!prints || !Object.keys(prints).length) return plan;
  return {
    ...plan,
    edges: plan.edges.map(e => (prints[e.id] ? { ...e, magnetic: prints[e.id] } : e)),
  };
}

export default function App() {
  const [phase, setPhase] = useState(PHASE.HOME);
  const [fireEvent, setFireEvent] = useState(null);
  const [shots, setShots] = useState([]);
  const [pending, setPending] = useState(null);   // 확인 대기 중인 사진
  const [plan, setPlan] = useState(null);         // 서버의 활성 도면 (지자기 지문까지 얹은 것)
  const [route, setRoute] = useState(null);
  const [startNode, setStartNode] = useState(null);
  const [online, setOnline] = useState(false);
  const [walls, setWalls] = useState(null);   // 도면에서 읽어낸 벽 — 꺾는 방향 고르기

  const api = useRef(new Api(SERVER_URL)).current;
  const server = useRef(null);
  const lastStartId = useRef(null);   // 다음에 맨 앞으로 올릴 장소

  useEffect(() => {
    initAudio();
    // VoiceOver 켜짐 여부를 추적한다. 꺼져 있으면 우리가 직접 말해야 한다 —
    // announceForAccessibility 는 VoiceOver 가 켜졌을 때만 소리를 낸다.
    const cleanupAnnounce = initAnnounce();

    api.onStatus = setOnline;
    // 도면을 미리 받아둔다. 화재가 난 뒤에 받으려 하면 그때 망이 죽어 있을 수 있다.
    api.getMap().then(m => m && withMagneticPrints(api, m).then(p => {
      setPlan(p);
      // 벽도 미리 받아 둔다. 통로를 직각으로 꺾을 때 **덜 뚫는 쪽**을 고르는 데
      // 쓰이고, 그리는 쪽과 안내하는 쪽이 같은 꺾임을 써야 둘이 안 갈라진다.
      // 화재가 난 뒤에 받으려 하면 그때 망이 죽어 있을 수 있다.
      if (p?.id) api.getPlanWalls(p.id).then(w => w?.walls?.length && setWalls(w.walls));
    }));

    server.current = new FireServer(SERVER_URL);
    server.current.onFire = evt => {
      // 이미 경보·안내 중이면 다시 덮지 않는다 — 반복 알림이 더 혼란스럽다
      setPhase(p => (
        [PHASE.HOME, PHASE.CAPTURE, PHASE.REVIEW, PHASE.SUBMIT].includes(p) ? PHASE.ALARM : p
      ));
      setFireEvent(evt);
    };
    server.current.connect();

    return () => {
      server.current?.disconnect();
      cleanupAnnounce?.();
    };
  }, []);

  function simulateFire() {
    setFireEvent(mockFireEvent());
    setPhase(PHASE.ALARM);
  }

  /** 경로를 받아 안내를 시작한다. 자동 위치·수동 선택 둘 다 여기로 모인다. */
  const startGuiding = useCallback(async (node, activePlan) => {
    setStartNode(node);
    const p = activePlan || plan;

    // 서버가 정답이다. 닿으면 무조건 서버 경로를 쓴다.
    const res = await api.route(node.id, 'initial');

    // 못 닿았을 때만 직접 계산한다. 망이 죽었다고 안내를 통째로 멈추면
    // 시각장애인은 아무 도움도 못 받는다 — 불난 순간 망이 먼저 죽는 일이 흔하다.
    const route = res?.route ?? (res ? null : routeToNearestExit(p, node.id));

    if (!route) {
      // 서버가 "경로 없음"이라고 했거나, 직접 계산해도 갈 길이 없다.
      // 어느 쪽이든 억지로 안내하지 않는다.
      say('안전한 대피 경로가 없습니다. 그 자리에 머물며 도움을 요청하세요.', { force: true });
      api.sos({ reason: '모든 출구 차단', node: node.id, at: new Date().toISOString() });
      Alert.alert('경로 없음', res?.reason || '접근 가능한 대피 경로가 없습니다.');
      return;
    }

    if (!res) {
      // 서버 없이 도는 중임을 숨기지 않는다. 위험 상태(불붙은 통로)를 반영하지
      // 못한 경로이므로, 사용자가 그 사실을 알고 판단할 수 있어야 한다.
      say('서버에 연결하지 못해 저장된 지도로 안내합니다.', { force: true });
    }

    setRoute(route);
    setPhase(PHASE.GUIDE);
  }, [plan]);

  /** 경보를 확인했다 → 위치를 알아내 안내를 시작한다. */
  const acknowledge = useCallback(async () => {
    let p = plan;
    if (!p) {
      p = await api.getMap();
      if (p) { p = await withMagneticPrints(api, p); setPlan(p); }
    }
    if (!p) {
      // 예전에는 여기서 끝났다 — "도면을 받지 못했습니다"에서 막다른 길이었다.
      // 시연장에서 Wi-Fi 하나 어긋나면 앱이 아무것도 못 하는 것을 보여주게 된다.
      // 대신 시연용 도면으로 잇되, **진짜인 척하지 않는다**(음성·화면 배지로 알린다).
      p = DEMO_PLAN;
      setPlan(p);
      say('서버에 연결하지 못했습니다. 시연용 도면으로 안내합니다. 실제 건물과 다릅니다.',
          { force: true });
    }

    // 시뮬레이션 출발점을 **위치 판정보다 먼저** 받아 온다.
    //
    // 처음에는 GuideScreen 이 받아왔는데, 위치 판정은 그보다 앞선 여기서 끝난다.
    // 그래서 설정한 자리가 반영되지 않고 엉뚱한 곳에서 출발했다.
    // (실물 매핑이 쌓이면 이 값은 안 쓰인다 — 그때는 전파가 위치를 말한다.)
    const stand = await api.getStandNode?.().catch(() => null);
    if (stand?.nodeId) setVirtualStandNode(stand.nodeId);

    // 위치는 **묻지 않고 알아낸다.** 불난 상황에 시각장애인에게 목록을 훑게 하는 건
    // 말이 안 된다. 비콘이 가장 세게 잡히는 지점이 곧 현재 위치다.
    const nodeId = await locate(api, p);
    if (nodeId) {
      const node = p.nodes.find(n => n.id === nodeId);
      lastStartId.current = nodeId;
      // 무엇으로 잡았는지까지 말한다. 시뮬레이션 값을 실측처럼 읽으면 검증이
      // 통째로 무의미해진다 — 듣는 사람이 그 차이를 알 수 없기 때문이다.
      const how = { simulated: ' 가상 비콘 추정입니다.', server: ' 관제가 지정한 위치입니다.' }[locateSource()] || '';
      say(`현재 위치, ${node?.name || '알 수 없음'}.${how} 대피 경로를 찾습니다.`, { force: true });
      return startGuiding(node, p);
    }

    // 어디인지 도무지 모를 때만 묻는다. 아무 데나 찍어서 출발하면
    // 엉뚱한 경로가 나오고, 그건 안내를 안 하느니만 못하다.
    setPhase(PHASE.START);
  }, [plan]);

  /** 위치를 못 찾았을 때만 쓰는 수동 선택 */
  const pickStart = useCallback(node => {
    lastStartId.current = node.id;
    startGuiding(node, plan);
  }, [plan, startGuiding]);

  /**
   * 서버에서 도면을 **다시** 받아 온다.
   *
   * 도면은 켤 때 한 번만 받는다. 그래서 측량 도구가 축척이나 북쪽을 고쳐
   * 서버에 저장해도, **폰이 손에 든 도면은 옛날 것 그대로다.** 값을 저장하고
   * 대피 안내를 눌러도 아무것도 안 바뀌는 이유가 이것이었다 — 저장은 됐는데
   * 쓰는 쪽이 모르고 있었다.
   *
   * 도구를 닫을 때마다 조용히 다시 받는다. GET 하나라 싸고, 안 받으면
   * «분명히 쟀는데 왜 그대로지» 를 사람이 매번 겪는다.
   */
  const refreshPlan = useCallback(async () => {
    const m = await api.getMap();
    if (!m) return null;
    const p = await withMagneticPrints(api, m);
    setPlan(p);
    return p;
  }, []);

  // 안내가 끝나거나 도구를 닫으면 **홈으로** 돌아온다. 예전에는 촬영 화면으로
  // 돌아갔는데, 대피를 마친 시각장애인 앞에 카메라가 켜지는 셈이었다.
  const backHome = useCallback(() => {
    setRoute(null);
    setStartNode(null);
    setPhase(PHASE.HOME);
    refreshPlan().catch(() => {});
  }, [refreshPlan]);

  /** 홈의 측량 도구 목록에서 고른 화면으로 간다 */
  const openTool = useCallback(key => {
    const to = {
      capture: PHASE.CAPTURE, live: PHASE.LIVE, field: PHASE.FIELD,
      magcheck: PHASE.MAGCHECK, magsurvey: PHASE.MAGSURVEY, north: PHASE.NORTH,
      walksurvey: PHASE.WALKSURVEY,
    }[key];
    if (to) setPhase(to);
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />

      {phase === PHASE.HOME && (
        <HomeScreen
          api={api}
          plan={plan}
          online={online}
          onStartEvac={acknowledge}
          onTool={openTool}
          onSimulateFire={simulateFire}
        />
      )}

      {phase === PHASE.CAPTURE && (
        <CaptureScreen
          shotCount={shots.length}
          serverOnline={online}
          onCaptured={shot => { setPending(shot); setPhase(PHASE.REVIEW); }}
          onSimulateFire={simulateFire}
          onMagCheck={() => setPhase(PHASE.MAGCHECK)}
          onField={() => setPhase(PHASE.FIELD)}
          onLive={() => setPhase(PHASE.LIVE)}
          onMagSurvey={() => setPhase(PHASE.MAGSURVEY)}
          onClose={backHome}
        />
      )}

      {phase === PHASE.REVIEW && (
        <ReviewScreen
          photo={pending}
          count={shots.length}
          onConfirm={() => setPhase(PHASE.SUBMIT)}
          onRetake={() => { setPending(null); setPhase(PHASE.CAPTURE); }}
        />
      )}

      {/* 사진을 서버로 보내 초안까지 만든다. 축척·방위는 여기서만 받을 수 있다 —
          도면 앞에 서 있는 사람만 알 수 있는 값이기 때문이다. */}
      {phase === PHASE.SUBMIT && (
        <SubmitScreen
          api={api}
          photo={pending}
          onDone={() => {
            setShots(s => [...s, pending]);
            setPending(null);
            setPhase(PHASE.CAPTURE);
          }}
          onCancel={() => { setPending(null); setPhase(PHASE.CAPTURE); }}
        />
      )}

      {phase === PHASE.MAGCHECK && (
        <MagScreen api={api} onClose={backHome} />
      )}

      {phase === PHASE.MAGSURVEY && (
        <MagSurveyScreen api={api} plan={plan} onClose={backHome} />
      )}

      {phase === PHASE.WALKSURVEY && (
        <WalkSurveyScreen api={api} plan={plan} onClose={backHome} />
      )}

      {phase === PHASE.LIVE && (
        <LiveScreen api={api} plan={plan} onClose={backHome} />
      )}

      {phase === PHASE.NORTH && (
        <NorthScreen api={api} plan={plan} onClose={backHome} onSaved={refreshPlan} />
      )}

      {phase === PHASE.FIELD && (
        <FieldScreen onClose={backHome} api={api} plan={plan} onSaved={refreshPlan} />
      )}

      {phase === PHASE.ALARM && (
        <AlarmScreen event={fireEvent} onAcknowledge={acknowledge} />
      )}

      {phase === PHASE.START && (
        <StartScreen
          plan={plan}
          recentId={lastStartId.current}
          onPick={pickStart}
          onCancel={backHome}
        />
      )}

      {phase === PHASE.GUIDE && (
        <GuideScreen
          api={api}
          plan={plan}
          route={route}
          walls={walls}
          startNode={startNode}
          scenario={fireEvent?.location === PHOTO_SCENARIO.fireLabel ? PHOTO_SCENARIO : null}
          onExit={backHome}
          onSafeHold={() => {}}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
});
