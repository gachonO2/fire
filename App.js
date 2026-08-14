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

import CaptureScreen from './src/screens/CaptureScreen';
import ReviewScreen from './src/screens/ReviewScreen';
import AlarmScreen from './src/screens/AlarmScreen';
import StartScreen from './src/screens/StartScreen';
import SubmitScreen from './src/screens/SubmitScreen';
import GuideScreen from './src/screens/GuideScreen';
import { FireServer, mockFireEvent } from './src/fireServer';
import { Api } from './src/api';
import { locate, setLocator } from './src/locator';
import { createBeaconLocator } from './src/beaconLocator';
import { DEMO_PLAN } from './src/demoPlan';
import { routeToNearestExit } from './src/pathfinding';
import { resolveServerUrl } from './src/serverUrl';
import { initAudio } from './src/sound';
import { initAnnounce, say } from './src/announce';
import { theme } from './src/theme';

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
  CAPTURE: 'capture', REVIEW: 'review', SUBMIT: 'submit',
  ALARM: 'alarm', START: 'start', GUIDE: 'guide',
};

export default function App() {
  const [phase, setPhase] = useState(PHASE.CAPTURE);
  const [fireEvent, setFireEvent] = useState(null);
  const [shots, setShots] = useState([]);
  const [pending, setPending] = useState(null);   // 확인 대기 중인 사진
  const [plan, setPlan] = useState(null);         // 서버의 활성 도면
  const [route, setRoute] = useState(null);
  const [startNode, setStartNode] = useState(null);
  const [online, setOnline] = useState(false);

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
    api.getMap().then(m => m && setPlan(m));

    server.current = new FireServer(SERVER_URL);
    server.current.onFire = evt => {
      // 이미 경보·안내 중이면 다시 덮지 않는다 — 반복 알림이 더 혼란스럽다
      setPhase(p => ([PHASE.CAPTURE, PHASE.REVIEW, PHASE.SUBMIT].includes(p) ? PHASE.ALARM : p));
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
      if (p) setPlan(p);
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

    // 위치는 **묻지 않고 알아낸다.** 불난 상황에 시각장애인에게 목록을 훑게 하는 건
    // 말이 안 된다. 비콘이 가장 세게 잡히는 지점이 곧 현재 위치다.
    const nodeId = await locate(api, p);
    if (nodeId) {
      const node = p.nodes.find(n => n.id === nodeId);
      lastStartId.current = nodeId;
      // 어디에서 출발하는지 먼저 알린다 — 앱이 위치를 잘못 잡았다면 사용자가
      // 그 자리에서 알아차려야 한다. 잘못된 출발점은 곧 잘못된 경로다.
      say(`현재 위치, ${node?.name || '알 수 없음'}. 대피 경로를 찾습니다.`, { force: true });
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

  const backToCapture = useCallback(() => {
    setRoute(null);
    setStartNode(null);
    setPhase(PHASE.CAPTURE);
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />

      {phase === PHASE.CAPTURE && (
        <CaptureScreen
          shotCount={shots.length}
          serverOnline={online}
          onCaptured={shot => { setPending(shot); setPhase(PHASE.REVIEW); }}
          onSimulateFire={simulateFire}
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

      {phase === PHASE.ALARM && (
        <AlarmScreen event={fireEvent} onAcknowledge={acknowledge} />
      )}

      {phase === PHASE.START && (
        <StartScreen
          plan={plan}
          recentId={lastStartId.current}
          onPick={pickStart}
          onCancel={backToCapture}
        />
      )}

      {phase === PHASE.GUIDE && (
        <GuideScreen
          api={api}
          plan={plan}
          route={route}
          startNode={startNode}
          onExit={backToCapture}
          onSafeHold={() => {}}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
});
