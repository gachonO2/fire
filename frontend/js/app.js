/**
 * 사용자 앱 (모바일) — 실제 화재 상황에서 시각장애인이 쓰는 화면.
 *
 * 설계 기준은 "화면을 보지 않고 한 손으로 쓸 수 있는가"다.
 *  · 화면 전체가 버튼 — 두드리면 다시 듣기, 두 번이면 현재 위치
 *  · 볼륨 올리기 버튼은 4초 안에 세 번 눌러야 구조 요청이 전송된다
 *  · 대피가 시작되면 방향 찾기가 자동으로 켜지고, 화면이 꺼지지 않는다
 *  · 앱이 죽었다 켜져도 대피 상태를 이어서 복구한다
 *
 * 대피 로직 자체는 evacuation.js에 있다. 이 파일은 그 세션을
 * 화면·센서·제스처에 연결한다.
 */

import { Guidance } from './guidance.js';
import { Odometry } from './odometry.js';
import { Api } from './api.js';
import { EvacuationSession } from './evacuation.js';
import { DirectionScanner } from './direction-scan.js';
import { BeaconSense } from './beacon.js';
import { renderMap } from './minimap.js';
import { createPanels } from './panels.js';
import {
  automaticEvacuationAction, alarmHazardKeys, hasNewFire, hasNewSetValue,
} from './auto-evacuation.js';
import { advanceSosPress, isVolumeUpInput } from './sos-trigger.js';
import { createSafeTrainingScenario } from './training-scenario.js';

const $ = id => document.getElementById(id);

const SOS_PRESS_WINDOW_MS = 4000;
const RESUME_KEY = 'fireguide:session';

const api = new Api();
const guidance = new Guidance();
const odometry = new Odometry();
const scanner = new DirectionScanner({ odometry });
const beacon = new BeaconSense(() => api.floorPlan, trueDemoPosition);

let session = null;
let fires = [];
let sensors = [];
let autoWalkTimer = null;
let wakeLock = null;
let panels = null;
let placeVerified = false;
let verifiedPlanId = null;
let pendingFire = false;
let pendingStartTimer = null;
let knownFireIds = new Set();
let knownAlarmHazards = new Set();
let trainingWaitingForPlace = false;
let trainingFire = null;
let trainingStartTimer = null;
let sosPressCount = 0;
let sosResetTimer = null;
let guardianNotice = '';
/** 비콘이 마지막으로 판정한 지점 — 대피 중 이탈 감지에 쓴다 */
let beaconNodeId = null;
/** 비콘 없는 건물의 시뮬레이션에서 "실제로 서 있는" 지점 */
let standNodeId = null;

/** 보호자 연동이 새로고침 후에도 유지되도록 사용자 ID를 기기에 고정한다. */
function persistentUserId() {
  let id = localStorage.getItem('fireguide:userId');
  if (!id) {
    id = 'user-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('fireguide:userId', id);
  }
  return id;
}

// ══════════════════════════════════════════════════════════════ 초기화
async function main() {
  odometry.start();
  await api.loadFloorPlan();

  session = new EvacuationSession({ api, guidance, odometry, userId: persistentUserId() });
  session.onAnnounce = text => { $('command').textContent = text; };
  session.onChange = render;

  panels = createPanels(api, () => session.userId);
  wireRoleNav();

  buildStartPicker();
  wireIdleScreen();
  wireGestures();
  wireGuardian();
  wireDemoPanel();
  watchPower();

  api.on('plan', plan => {
    $('plan-badge').textContent = plan.name;
    if (session.phase === 'idle') {
      if (placeVerified && verifiedPlanId !== plan.id) {
        session.reset();
        placeVerified = false;
        verifiedPlanId = null;
        $('idle-place').textContent = '위치 확인 필요';
        $('idle-desc').textContent = '도면이 변경되었습니다. 안내 태그나 QR로 현재 위치를 다시 확인하세요.';
        $('idle-source').textContent = '';
        updateIdleUI();
      }
      buildStartPicker();
    }
    // 이전 건물의 비콘 id로 판정하면 엉뚱한 지점을 가리킨다 — 매핑을 다시 만든다
    standNodeId = null;
    startBeacons();
    render();
  });
  api.on('hazards', (h, meta = {}) => {
    const current = alarmHazardKeys(h, api.floorPlan.initialHazards);
    const newIncident = !meta.initial && hasNewSetValue(knownAlarmHazards, current);
    knownAlarmHazards = current;
    const interruptedTraining = newIncident && interruptTrainingForActualIncident();
    session.hazardsChanged(h);
    maybeAutoEvacuate({ newIncident, force: interruptedTraining });
  });
  api.on('sensors', list => { sensors = list; render(); });
  api.on('fires', (list, meta = {}) => {
    const newIncident = !meta.initial && hasNewFire(knownFireIds, list);
    fires = list;
    knownFireIds = new Set(list.map(fire => fire.id).filter(Boolean));
    const interruptedTraining = newIncident && interruptTrainingForActualIncident();
    maybeAutoEvacuate({ newIncident, force: interruptedTraining });
    render();
  });
  api.on('status', ({ online, storage }) => {
    const badge = $('net-badge');
    badge.textContent = online ? storage : '오프라인 · 저장된 지도로 안내';
    badge.classList.toggle('warn', !online);
  });

  $('plan-badge').textContent = api.floorPlan.name;
  armed = localStorage.getItem('fireguide:armed') === '1';
  updateIdleUI();
  await detectPlace();
  render();

  await api.connect();
  await loadGuardian();

  if (await resumeIfInterrupted()) return;

  // 홈 화면 바로가기(?start=1)로 들어오면 위치 고르는 단계를 건너뛴다.
  // 불이 난 상황에서 화면을 두 번 조작하게 만들 이유가 없다.
  if (new URLSearchParams(location.search).get('start') && session.startNodeId) {
    await startEvacuation();
  }
}

// ══════════════════════════════════════════════════════ 대기 화면
function wireIdleScreen() {
  $('btn-start').addEventListener('click', () => startEvacuation());
  $('btn-watch').addEventListener('click', toggleWatch);
  $('btn-training-start').addEventListener('click', startVirtualTraining);
  $('btn-locate').addEventListener('click', locateNow);
  $('btn-nfc').addEventListener('click', async () => {
    $('locate-method-status').textContent = '안내 태그를 기다리고 있습니다.';
    const started = await startNfcScan({ silent: false });
    if (!started) {
      $('locate-method-status').textContent = '이 기기에서는 안내 태그를 사용할 수 없습니다. QR 표지를 촬영하세요.';
    }
  });
  $('btn-qr').addEventListener('click', () => {
    openLocateSheet(false);
    scanQR();
  });
  $('btn-locate-close').addEventListener('click', () => openLocateSheet(false));
  $('btn-pick').addEventListener('click', () => {
    trainingWaitingForPlace = false;
    openSheet(true);
  });
  $('btn-sheet-close').addEventListener('click', cancelPlaceSheet);
  $('btn-restart').addEventListener('click', returnToIdle);
  $('btn-restart-2').addEventListener('click', returnToIdle);
  $('btn-hold-where').addEventListener('click', () => session.describeHere());

  // 시트가 열린 채로 뒤 화면을 누르면 아무 반응이 없어 앱이 멈춘 것처럼 보인다.
  // 배경을 누르거나 ESC를 눌러도 닫히게 한다.
  const sheet = $('place-sheet');
  sheet.addEventListener('click', e => { if (e.target === sheet) cancelPlaceSheet(); });
  const locateSheet = $('locate-sheet');
  locateSheet.addEventListener('click', e => {
    if (e.target === locateSheet) openLocateSheet(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (!sheet.hidden) cancelPlaceSheet();
    if (!locateSheet.hidden) openLocateSheet(false);
  });
}

function openLocateSheet(open) {
  $('locate-sheet').hidden = !open;
  $('locate-method-status').textContent = '';
  if (open) $('btn-nfc').focus();
  else $('btn-locate').focus();
}

function openSheet(open) {
  $('place-sheet').hidden = !open;
  $('place-sheet-title').textContent = trainingWaitingForPlace ? '훈련 시작 위치 선택' : '위치 직접 지정';
  $('place-sheet-hint').textContent = trainingWaitingForPlace
    ? '가상 화재 훈련을 시작할 위치를 선택하세요. 실제 위치나 신고에는 반영되지 않습니다.'
    : '동행자·훈련용입니다. 실제로는 벽의 안내 태그로 자동 확인됩니다.';
  if (open) $('start-picker').querySelector('button')?.focus();
  else $('btn-locate').focus();
}

function cancelPlaceSheet() {
  trainingWaitingForPlace = false;
  openSheet(false);
}

function buildStartPicker() {
  const wrap = $('start-picker');
  wrap.innerHTML = '';
  for (const node of api.floorPlan.nodes) {
    if (node.type === 'exit' || node.type === 'elevator') continue;
    const btn = document.createElement('button');
    btn.className = 'pick-btn';
    btn.textContent = node.name;
    btn.addEventListener('click', () => {
      const startTrainingAfterSelection = trainingWaitingForPlace;
      setStartPlace(node.id, {
        speak: !startTrainingAfterSelection,
        source: startTrainingAfterSelection ? '훈련 시작 위치' : '직접 선택',
      });
      trainingWaitingForPlace = false;
      openSheet(false);
      if (startTrainingAfterSelection) startVirtualTraining();
    });
    wrap.appendChild(btn);
  }
}

// ══════════════════════════════════════════════════ 내 위치 자동 확인
/**
 * 시각장애인에게 "지금 어디 계신가요?"를 목록으로 묻는 것은 앞뒤가 맞지 않는다.
 * 자기가 어디인지 모르니까 이 앱을 쓰는 것이다. 위치는 앱이 알아내야 한다.
 *
 * 우선순위:
 *  1. URL의 ?at=<장소ID> — **벽에 붙인 NFC 태그·QR이 이 주소를 연다.**
 *     폰을 대기만 하면 앱이 열리면서 위치가 확정된다. 가장 현실적인 방법이다.
 *  2. BLE 비콘 — **아무것도 안 해도** 잡힌다. 태그는 벽을 손으로 훑어 찾아야 하지만
 *     비콘은 그 자리에 서 있기만 하면 된다. 설치된 건물에서는 이게 제일 빠르다.
 *  3. Web NFC 능동 스캔 — 앱이 이미 열려 있을 때 태그에 대면 인식
 *  4. QR 카메라
 *  5. 마지막으로 확인된 위치 (건물을 벗어나지 않았다면 대개 맞다)
 *
 * 그래도 모르면 **모른다고 말하고**, 대피는 막지 않는다 (startEvacuation 참고).
 */
let placeSource = null;

function setStartPlace(nodeId, { speak = false, source = '수동 선택' } = {}) {
  const node = api.floorPlan.getNode(nodeId);
  if (!node) return false;

  session.setStart(nodeId);
  placeVerified = true;
  verifiedPlanId = api.floorPlan.id;
  placeSource = source;
  // 시뮬레이션의 "실제로 서 있는 곳"도 함께 옮긴다. 그래야 비콘이 그 자리에서
  // 신호를 만들고, 태그로 위치를 바꾼 뒤에도 측위가 따라온다.
  standNodeId = nodeId;
  localStorage.setItem('fireguide:lastPlace', nodeId);

  $('idle-place').textContent = node.name;
  $('idle-desc').textContent = [node.description, node.landmark].filter(Boolean).join(' ');
  $('idle-source').textContent = `${source}으로 확인`;
  updateIdleUI();

  const shouldStartPendingFire = pendingFire && armed && fireIsActive();
  if (shouldStartPendingFire) {
    pendingFire = false;
    updateIdleUI();
    guidance.speak(`현재 위치가 ${node.name}으로 확인되었습니다. 대피 안내를 시작합니다.`);
    clearTimeout(pendingStartTimer);
    pendingStartTimer = setTimeout(() => {
      pendingStartTimer = null;
      if (fireIsActive()) startEvacuation({ auto: true });
    }, 1200);
  } else if (speak) {
    session.announceStartPlace();
  }
  return true;
}

/** 앱을 열자마자 할 수 있는 자동 확인을 전부 시도한다 */
async function detectPlace() {
  // 1. NFC 태그·QR이 연 주소
  const at = new URLSearchParams(location.search).get('at');
  if (at && setStartPlace(at, { speak: true, source: '안내 태그' })) return;

  // 2. 과거 위치는 참고로만 보여 준다. 현재 위치로 확정하거나 경로 계산에 쓰지 않는다.
  const last = localStorage.getItem('fireguide:lastPlace');
  const lastNode = last && api.floorPlan.getNode(last);
  $('idle-place').textContent = '위치 확인 필요';
  $('idle-desc').textContent = lastNode
    ? `마지막 확인 위치는 ${lastNode.name}입니다. 현재 위치로 사용하려면 안내 태그나 QR을 다시 확인하세요.`
    : '벽이나 문틀의 안내 태그에 휴대폰을 대거나 QR을 확인하세요.';
  $('idle-source').textContent = '';

  // 3. NFC는 사용자 동작 없이도 대기할 수 있으면 미리 켜 둔다
  startNfcScan({ silent: true });

  // 4. 비콘도 함께 돌린다. 먼저 확정되는 쪽이 이긴다 — 둘 다 사용자 조작이 필요 없다.
  startBeacons();
}

// ------------------------------------------------------------ 비콘 측위
/**
 * 비콘으로 현재 위치를 스스로 찾는다.
 *
 * 태그·QR과 경쟁하지 않고 **보완**한다. 태그는 벽의 정해진 자리를 찾아야 하고
 * QR은 카메라를 겨눠야 하지만, 비콘은 서 있기만 하면 잡힌다. 대신 정밀도는
 * 노드 단위이고 확정까지 몇 초가 걸리므로, 태그로 이미 확인된 위치는 덮지 않는다.
 */
function startBeacons() {
  beacon.stop();
  if (!beacon.start()) return;   // 도면이 없으면 조용히 넘어간다 (화면은 이미 그 사실을 말한다)
  // 비콘 기기가 없는 건물에서는 시뮬레이션이 돈다. 그 기준 좌표가 될 지점.
  standNodeId ||= session?.startNodeId
    || (api.floorPlan.nodes.find(n => n.type === 'room') || api.floorPlan.nodes[0])?.id;
  beacon.onLocate = onBeaconLocate;
}

/**
 * 시뮬레이션이 신호를 만들 기준 좌표(= 사용자가 실제로 있는 곳).
 * 안내 중에는 경로상 위치, 대피 전에는 서 있는 지점이다.
 */
function trueDemoPosition() {
  const onRoute = session?.position();
  if (onRoute) return onRoute;
  const node = api.floorPlan.getNode(standNodeId);
  return node ? { x: node.x, y: node.y } : null;
}

function onBeaconLocate(nodeId, { locked, node }) {
  beaconNodeId = nodeId;
  if (!node) return;

  if (session?.phase === 'idle') {
    // 확정 전(locked=false)의 잠정값은 흔들린다. 그때마다 말하면 "여기다 저기다"가 된다.
    if (!locked) return;
    // 태그·QR로 이미 확인된 위치는 덮지 않는다. 그쪽이 더 정확하고,
    // 사용자가 방금 직접 확인한 값이 몇 초 뒤 소리 없이 바뀌면 신뢰를 잃는다.
    if (placeVerified && verifiedPlanId === api.floorPlan.id) return;
    setStartPlace(nodeId, {
      speak: true,
      source: beacon.virtual ? '비콘 시뮬레이션' : '비콘 신호',
    });
    return;
  }

  // 안내 중 경로에 없는 지점에서 신호가 잡히면 실제로 벗어난 것이다.
  // 나침반 이탈 감지보다 확실한 신호라 그대로 이탈로 넘긴다.
  if (session?.phase === 'guiding' && session.route && !session.route.nodes.includes(nodeId)) {
    session.reportOffRoute(node.name);
  }
}

/** 한 버튼에서 인식 방법을 추측하지 않고 사용자가 만진 표지에 맞는 방법을 고르게 한다. */
function locateNow() {
  openLocateSheet(true);
  guidance.speak('현재 위치 확인 방법을 선택하세요. 안내 태그 또는 QR 표지를 사용할 수 있습니다.');
}

/**
 * Web NFC (안드로이드 크롬). 태그에 폰을 대면 위치가 확정된다.
 * 시각장애인이 벽을 손으로 훑어 태그를 찾을 수 있으므로 QR보다 현실적이다.
 */
async function startNfcScan({ silent }) {
  if (!('NDEFReader' in window)) return false;
  try {
    const reader = new NDEFReader();
    await reader.scan();
    if (!silent) guidance.speak('휴대폰을 벽의 안내 태그에 대세요.');

    reader.onreading = ({ message }) => {
      for (const record of message.records) {
        const value = readNdefValue(record);
        const nodeId = value && (api.floorPlan.getNode(value)
          ? value
          : new URL(value, location.href).searchParams?.get('at'));
        if (nodeId && setStartPlace(nodeId, { speak: true, source: '안내 태그' })) {
          openLocateSheet(false);
          navigator.vibrate?.([80, 60, 80]);
          return;
        }
      }
    };
    return true;
  } catch (_) {
    return false; // 권한 거부·미지원 — QR로 넘어간다
  }
}

/** 태그에는 장소 ID(text) 또는 앱 주소(url)를 써 둔다 — 둘 다 문자열로 읽는다 */
function readNdefValue(record) {
  try { return new TextDecoder(record.encoding || 'utf-8').decode(record.data); }
  catch (_) { return null; }
}

/** QR 내용 = 장소 ID 또는 ?at= 주소 */
async function scanQR() {
  if (!('BarcodeDetector' in window)) {
    guidance.speak('이 휴대폰은 태그와 QR 인식을 지원하지 않습니다. 동행자와 함께 위치 직접 지정을 사용하세요.');
    return;
  }
  const video = $('qr-video');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    guidance.speak('카메라를 벽의 QR 표지에 향하게 하세요.');

    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const stopScan = () => {
      clearInterval(timer);
      stream.getTracks().forEach(t => t.stop());
      video.hidden = true;
    };
    const timer = setInterval(async () => {
      const codes = await detector.detect(video).catch(() => []);
      for (const c of codes) {
        const nodeId = api.floorPlan.getNode(c.rawValue)
          ? c.rawValue
          : safeParam(c.rawValue, 'at');
        if (nodeId && setStartPlace(nodeId, { speak: true, source: 'QR 표지' })) {
          stopScan();
          navigator.vibrate?.([80, 60, 80]);
          return;
        }
      }
    }, 400);
    setTimeout(stopScan, 30000); // 30초 넘게 카메라를 켜 두지 않는다
  } catch (_) {
    guidance.speak('카메라를 사용할 수 없습니다. 안내 태그를 사용하거나 동행자와 함께 위치를 직접 지정하세요.');
  }
}

function safeParam(raw, key) {
  try { return new URL(raw, location.href).searchParams.get(key); }
  catch (_) { return null; }
}

// ══════════════════════════════════════════════════════ 가상 화재 훈련
function startVirtualTraining() {
  if (session.phase !== 'idle' || session.trainingMode) return;
  const verified = placeVerified && verifiedPlanId === api.floorPlan.id && session.startNodeId;
  if (!verified) {
    trainingWaitingForPlace = true;
    openSheet(true);
    guidance.speak('가상 화재 훈련을 시작할 위치를 선택하세요.');
    return;
  }

  const scenario = createSafeTrainingScenario(api.floorPlan, session.startNodeId, session.hazards);
  if (!scenario) {
    guidance.speak('이 위치에서는 가상 화재 훈련 경로를 만들 수 없습니다. 다른 위치를 선택하세요.');
    return;
  }

  trainingFire = scenario.fire;
  session.beginTraining(scenario.hazards);
  document.querySelector('.utility-settings')?.removeAttribute('open');
  guidance.cmdTrainingAlarm(`${scenario.where} 부근에서 가상 화재가 발생했습니다.`);
  render();

  clearTimeout(trainingStartTimer);
  trainingStartTimer = setTimeout(() => {
    trainingStartTimer = null;
    if (session.trainingMode && session.phase === 'idle') startEvacuation();
  }, 2600);
}

/** 훈련 중 실제 서버 경보가 오면 훈련을 즉시 끝내고 실제 화재 처리를 우선한다. */
function interruptTrainingForActualIncident() {
  if (!session?.trainingMode) return false;
  const nodeId = session.currentNodeId || session.startNodeId;
  clearTimeout(trainingStartTimer);
  trainingStartTimer = null;
  trainingFire = null;
  trainingWaitingForPlace = false;
  resetSosPress();
  session.reset();
  if (nodeId && api.floorPlan.getNode(nodeId)) {
    setStartPlace(nodeId, { source: '훈련 중 확인 위치' });
  }
  showScreen('idle');
  return true;
}

// ══════════════════════════════════════════════════════ 대피 시작
// ══════════════════════════════════════════════ 화재 자동 감지 → 자동 대피
/**
 * 불이 나면 **사용자가 아무것도 누르지 않아도** 안내가 시작된다.
 *
 * 화재 상황에서 "앱을 열고 버튼을 찾아 누르는" 단계를 요구하면, 정작 그 단계를
 * 수행하기 가장 어려운 사람이 우리 사용자다. 건물에서 화재 신호가 오는 순간
 * 폰이 경보를 울리고, 불이 난 위치를 말해 주고, 곧바로 경로 안내로 넘어간다.
 *
 * 다만 브라우저는 사용자 동작 없이 소리를 내지 못한다. 그래서 평상시에
 * **한 번 "화재 감시 시작"을 눌러 두는 것**으로 음성·진동을 미리 열어 둔다.
 * 그 뒤로는 전부 자동이다.
 */
let armed = false;
let alarmHandled = false;

function fireIsActive() {
  if (fires.length > 0) return true;
  // 도면에 원래 들어 있는 시연용 위험은 새 화재 경보가 아니다.
  const baseline = api.floorPlan.initialHazards;
  return Object.entries(session?.hazards || {}).some(([edgeId, hazard]) => {
    if (!['fire', 'smoke', 'heat'].includes(hazard.type)) return false;
    const isUnchangedBaseline = baseline[edgeId]?.type === hazard.type
      && !hazard.sensorId && !hazard.fireId;
    return !isUnchangedBaseline;
  });
}

/** 화재를 감지하면 스스로 대피를 시작한다 */
async function maybeAutoEvacuate({ newIncident = false, force = false } = {}) {
  const active = fireIsActive();
  if (!active) {
    clearTimeout(pendingStartTimer);
    pendingStartTimer = null;
    pendingFire = false;
    alarmHandled = false;
    updateIdleUI();
    return;
  }

  // 접속 시 받은 기존 상태는 지도와 경로에만 반영한다. 새 경보 화면을 열지는 않는다.
  if (!newIncident) return;

  const action = automaticEvacuationAction({
    armed: armed || force,
    alarmHandled,
    phase: session.phase,
    fireActive: active,
    hasVerifiedPlace: placeVerified
      && verifiedPlanId === api.floorPlan.id
      && Boolean(session.startNodeId),
  });
  if (action === 'ignore') return;

  alarmHandled = true;
  if (action === 'alert-only') {
    pendingFire = true;
    guidance.cmdAlarmNeedsLocation(describeFireLocation());
    updateIdleUI();
    return;
  }

  guidance.cmdAlarm(describeFireLocation());
  clearTimeout(pendingStartTimer);
  // 경보를 다 듣고 나서 이동 안내가 시작되도록 잠깐 둔다
  pendingStartTimer = setTimeout(() => {
    pendingStartTimer = null;
    if (fireIsActive()) startEvacuation({ auto: true });
    else {
      alarmHandled = false;
      updateIdleUI();
    }
  }, 3200);
}

/**
 * 불이 어디에 났는지 사람이 알아들을 말로 바꾼다.
 * 좌표를 그대로 말해봐야 소용없고, "북측 복도 부근, 20미터 앞" 같은 표현이어야 한다.
 */
function describeFireLocation() {
  const plan = api.floorPlan;

  if (fires.length) {
    const parts = fires.map(f => {
      const near = plan.nearestPlace(f.x, f.y);
      if (!near) return '건물 안';
      const from = session.startNodeId
        ? plan.straightDistance(session.startNodeId, near.node.id) : null;
      const away = from != null ? ` 약 ${Math.round(from)}미터 떨어진 곳입니다.` : '입니다.';
      return `${near.node.name} 부근${away}`;
    });
    return parts.slice(0, 2).join(' 그리고 ');
  }

  // 통로 단위 위험만 있는 경우 — 막힌 통로의 이름으로 설명한다
  const blocked = Object.entries(session.hazards)
    .filter(([, h]) => ['fire', 'smoke', 'heat'].includes(h.type))
    .map(([id]) => plan.getEdge(id))
    .filter(Boolean);
  if (blocked.length) {
    const e = blocked[0];
    const a = plan.getNode(e.a)?.name ?? '';
    const b = plan.getNode(e.b)?.name ?? '';
    return `${a}에서 ${b} 사이 통로입니다.`;
  }
  return '위치는 확인 중입니다.';
}

/** 평상시에 한 번 눌러 두면, 이후 화재는 자동으로 감지된다 */
function armWatch() {
  armed = true;
  localStorage.setItem('fireguide:armed', '1');
  updateIdleUI();

  // 이 시점이 "사용자 동작"이다 — 여기서 음성을 한 번 내야 이후 자동 발화가 허용된다
  guidance.speak('화재 감시를 시작합니다. 불이 나면 자동으로 알려드립니다.');
}

function disarmWatch() {
  armed = false;
  pendingFire = false;
  alarmHandled = false;
  clearTimeout(pendingStartTimer);
  pendingStartTimer = null;
  localStorage.removeItem('fireguide:armed');
  updateIdleUI();
  guidance.speak('화재 자동 알림을 껐습니다.');
}

function toggleWatch() {
  if (armed) disarmWatch();
  else armWatch();
}

function updateIdleUI() {
  const verified = placeVerified && verifiedPlanId === api.floorPlan.id && Boolean(session?.startNodeId);
  $('screen-idle').dataset.location = verified ? 'verified' : 'unknown';
  $('screen-idle').dataset.incident = String(pendingFire);
  $('idle-state').textContent = pendingFire
    ? '새 화재 경보 · 위치 확인 필요'
    : armed ? '화재 자동 알림 켜짐' : '화재 자동 알림 꺼짐';

  $('locate-label').textContent = verified ? '현재 위치 다시 확인' : '내 위치 확인';
  $('locate-sub').textContent = verified
    ? '이동했거나 위치가 다르면 다시 확인하세요'
    : '안내 태그 또는 QR 표지 사용';

  $('btn-watch').setAttribute('aria-pressed', String(armed));
  $('btn-watch').textContent = armed ? '끄기' : '켜기';
  $('watch-desc').textContent = armed
    ? verified
      ? '새 화재가 발생하면 진동과 음성으로 알리고 대피 안내를 시작합니다.'
      : '새 화재를 알려드립니다. 자동 대피 안내에는 현재 위치 확인이 필요합니다.'
    : '꺼져 있습니다. 켜 두면 새 화재를 진동과 음성으로 알려드립니다.';

  $('eb-label').textContent = '대피 안내 시작';
  $('eb-icon').textContent = '';
  $('eb-sub').textContent = verified
    ? `${api.floorPlan.getNode(session.startNodeId)?.name ?? '확인된 위치'}에서 안전한 출구를 찾습니다`
    : '현재 위치를 확인하면 사용할 수 있습니다';
  $('btn-start').disabled = !verified;
}

/**
 * 경로 안내는 이번 실행에서 위치가 확인된 경우에만 시작한다.
 * 과거 위치나 추측 위치로 안내하면 잘못된 통로로 보낼 수 있으므로 자동 SOS도 보내지 않는다.
 */
async function startEvacuation({ auto = false } = {}) {
  if (auto) alarmHandled = true;

  if (!placeVerified || verifiedPlanId !== api.floorPlan.id || !session.startNodeId) {
    pendingFire = fireIsActive();
    showScreen('idle');
    updateIdleUI();
    guidance.speak(pendingFire
      ? '화재가 감지되었지만 현재 위치가 확인되지 않았습니다. 안내 태그나 QR로 위치를 먼저 확인하세요.'
      : '현재 위치가 확인되지 않았습니다. 안내 태그나 QR로 위치를 먼저 확인하세요.');
    if (!auto) locateNow();
    return false;
  }

  await keepScreenAwake();
  resetSosPress();
  $('btn-start').disabled = true;
  showScreen('guide');

  if (await session.start()) {
    // 화재 상황에서 "방향 찾기 버튼을 찾는" 단계가 있으면 안 된다. 바로 켠다.
    scanner.start(currentTargetBearing);
    saveSession();
  }
}

function currentTargetBearing() {
  if (!session?.route || session.phase !== 'guiding') return null;
  const i = session.edgeIndex;
  if (i >= session.route.edges.length) return null;
  return api.floorPlan.bearing(session.route.nodes[i], session.route.nodes[i + 1]);
}

// ══════════════════════════════════════════════ 화면 안 보고 쓰는 조작
/**
 * 대피 중에는 버튼을 찾을 수 없다. 화면 전체를 하나의 조작면으로 쓴다.
 *   한 번 두드리기 → 안내 다시 듣기
 *   두 번 두드리기 → 여기가 어디인가요
 *   위로 쓸기      → 방향 찾기 켜기/끄기
 */
function wireGestures() {
  const zone = $('tap-zone');
  let tapTimer = null;
  let touchStartY = null;

  const singleTap = () => guidance.repeat();
  const doubleTap = () => session.describeHere();

  zone.addEventListener('click', () => {
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; doubleTap(); return; }
    tapTimer = setTimeout(() => { tapTimer = null; singleTap(); }, 260);
  });

  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); singleTap(); }
  });

  zone.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
  zone.addEventListener('touchend', e => {
    if (touchStartY === null) return;
    const dy = touchStartY - e.changedTouches[0].clientY;
    touchStartY = null;
    if (dy > 70) toggleScan(); // 위로 쓸기
  }, { passive: true });

  $('btn-guide-repeat').addEventListener('click', e => {
    e.stopPropagation();
    guidance.repeat();
  });
  $('btn-guide-where').addEventListener('click', e => {
    e.stopPropagation();
    session.describeHere();
  });

  wireSosTriggers();
}

/**
 * 볼륨 올리기 버튼을 4초 안에 세 번 누르면 구조 요청을 전송한다.
 * 모바일 웹의 볼륨 키 전달은 기기마다 달라 신뢰할 수 없으므로 네이티브 셸은
 * fireguide:volume-up 이벤트 또는 window.fireGuideVolumeUp()을 호출한다.
 */
function wireSosTriggers() {
  window.addEventListener('keydown', event => {
    if (event.repeat || !isVolumeUpInput(event)) return;
    event.preventDefault();
    receiveVolumeUp();
  });

  window.addEventListener('fireguide:volume-up', receiveVolumeUp);
  window.fireGuideVolumeUp = receiveVolumeUp;
  $('btn-volume-up-demo').addEventListener('click', receiveVolumeUp);
}

function receiveVolumeUp() {
  if (session.phase !== 'guiding') return;
  const state = advanceSosPress(sosPressCount);
  sosPressCount = state.count;

  if (state.complete) {
    clearTimeout(sosResetTimer);
    sosResetTimer = null;
    $('sos-status').textContent = '구조 요청을 전송합니다.';
    navigator.vibrate?.([120, 80, 120, 80, 300]);
    session.enterSafeHold('볼륨 올리기 버튼이 세 번 입력되어 구조를 요청했습니다.');
    return;
  }

  $('sos-status').textContent = `${state.count}번 입력됐습니다. ${state.remaining}번 더 누르세요.`;
  navigator.vibrate?.(state.count === 1 ? [90] : [90, 70, 90]);
  guidance.speak(`${state.count}번 입력됐습니다. ${state.remaining}번 더 누르세요.`, { remember: false });

  if (state.count === 1) {
    clearTimeout(sosResetTimer);
    sosResetTimer = setTimeout(() => resetSosPress({ announce: true }), SOS_PRESS_WINDOW_MS);
  }
}

function resetSosPress({ announce = false } = {}) {
  clearTimeout(sosResetTimer);
  sosResetTimer = null;
  sosPressCount = 0;
  $('sos-status').textContent = '구조가 필요하면 볼륨 올리기 버튼을 빠르게 세 번 누르세요.';
  if (announce && session?.phase === 'guiding') {
    guidance.speak('입력 시간이 지나 구조 요청이 취소되었습니다.', { remember: false });
  }
}

function toggleScan() {
  const on = scanner.toggle(currentTargetBearing);
  if (on) {
    guidance.speak('방향 찾기를 켰습니다. 폰을 좌우로 천천히 훑으세요. 신호가 끊기지 않는 방향으로 이동하세요.');
  } else {
    guidance.speak('방향 찾기를 껐습니다.');
    $('scan-status').textContent = '방향 찾기 꺼짐 — 위로 쓸면 다시 켜집니다';
    $('scan-needle').style.left = '50%';
  }
}

scanner.onUpdate = ({ active, error, level, reason }) => {
  if (!active) return;
  if (reason === 'no-heading') {
    $('scan-status').textContent = '방향 센서 신호를 기다리고 있습니다';
    $('scan-status').dataset.level = 'none';
    return;
  }
  const clamped = Math.max(-90, Math.min(90, error));
  $('scan-needle').style.left = `${50 + (clamped / 90) * 50}%`;
  // 사용자는 화면의 각도 문장을 읽지 않는다. 실제 안내는 진동·비프 간격으로만 준다.
  // 이 텍스트는 동행자가 신호 상태를 확인할 수 있는 정적인 보조 표시다.
  $('scan-status').textContent = level.id === 'lock'
    ? '연속 신호가 이어지는 방향을 유지하세요'
    : '진동이나 소리가 이어지는 방향을 찾으세요';
  $('scan-status').dataset.level = level.id;
};

// ══════════════════════════════════════════════════ 응급 상황 내구성
/** 대피 중에 화면이 꺼지면 안 된다 (음성·진동은 유지되지만 조작을 못 하게 된다) */
async function keepScreenAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch (_) { /* 지원 안 함 — 치명적이지 않다 */ }
}

document.addEventListener('visibilitychange', () => {
  // 화면이 돌아오면 잠금을 다시 잡는다 (브라우저가 자동 해제한다)
  if (document.visibilityState === 'visible' && session?.phase === 'guiding') keepScreenAwake();
});

/** 앱이 죽었다 켜져도 대피 상태를 이어서 복구한다 */
function saveSession() {
  if (!session) return;
  if (session.phase === 'guiding') {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      nodeId: session.currentNodeId, planId: api.floorPlan.id, ts: Date.now(),
    }));
  } else {
    localStorage.removeItem(RESUME_KEY);
  }
}

async function resumeIfInterrupted() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(RESUME_KEY)); } catch (_) { return false; }
  if (!saved?.nodeId) return false;

  // 오래된 기록은 무시한다. 어제 하던 대피를 오늘 이어갈 수는 없다.
  if (Date.now() - saved.ts > 30 * 60 * 1000 || saved.planId !== api.floorPlan.id) {
    localStorage.removeItem(RESUME_KEY);
    return false;
  }
  if (!api.floorPlan.getNode(saved.nodeId)) return false;

  setStartPlace(saved.nodeId, { source: '이어서 진행' });
  showScreen('guide');
  await keepScreenAwake();
  guidance.speak('대피 안내를 이어서 진행합니다.');
  if (await session.start()) scanner.start(currentTargetBearing);
  return true;
}

/** 배터리가 얼마 없으면 알려준다 — 대피 중 꺼지면 안내가 끊긴다 */
async function watchPower() {
  try {
    const battery = await navigator.getBattery?.();
    if (!battery) return;
    const update = () => {
      const pct = Math.round(battery.level * 100);
      const low = pct <= 20 && !battery.charging;
      const badge = $('power-badge');
      badge.hidden = !low;
      badge.textContent = `배터리 ${pct}%`;
      badge.classList.toggle('warn', low);
    };
    battery.addEventListener('levelchange', update);
    battery.addEventListener('chargingchange', update);
    update();
  } catch (_) { /* 미지원 */ }
}

/** 대피 중 실수로 페이지를 닫는 것을 막는다 */
window.addEventListener('beforeunload', e => {
  if (session?.phase === 'guiding') { e.preventDefault(); e.returnValue = ''; }
});

// ══════════════════════════════════════════════════════ 보호자 연동
function wireGuardian() {
  $('btn-guardian-save').addEventListener('click', saveGuardian);
  $('btn-copy-link').addEventListener('click', copyGuardianLink);
}

async function loadGuardian() {
  try { showGuardian(await api.getGuardian(session.userId)); }
  catch (_) { /* 미등록 — 조용히 넘어간다 */ }
}

async function saveGuardian() {
  const name = $('guardian-name').value.trim();
  const contact = $('guardian-contact').value.trim();
  if (!name) {
    guidance.speak('보호자 이름을 입력하세요.');
    $('guardian-name').focus();
    return;
  }
  try {
    const saved = await api.registerGuardian({ userId: session.userId, name, contact });
    showGuardian(saved);
    guidance.speak(`보호자 ${saved.name} 님이 등록되었습니다. 공유 코드는 ${saved.code.split('').join(' ')} 입니다.`);
  } catch (_) {
    guidance.speak('보호자 등록에 실패했습니다. 연결을 확인하세요.');
  }
}

function showGuardian(saved) {
  if (!saved) return;
  $('guardian-name').value = saved.name || '';
  $('guardian-contact').value = saved.contact || '';
  $('guardian-saved-name').textContent = saved.name;
  $('guardian-code').textContent = saved.code;

  const link = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}guardian.html?code=${saved.code}`;
  $('guardian-link').value = link;
  $('btn-open-guardian').href = link;
  $('guardian-result').hidden = false;
  $('btn-guardian-save').textContent = '보호자 정보 수정';
  guardianNotice = `보호자 ${saved.name} 님에게도 알렸습니다.`;
}

async function copyGuardianLink() {
  try {
    await navigator.clipboard.writeText($('guardian-link').value);
    guidance.speak('링크를 복사했습니다.');
  } catch (_) {
    $('guardian-link').select();
    guidance.speak('링크를 직접 복사하세요.');
  }
}

// ══════════════════════════════════════════════════════ 시연 조작
function wireDemoPanel() {
  $('btn-step').addEventListener('click', () => session.step());
  $('btn-auto').addEventListener('click', toggleAutoWalk);
  $('btn-deviate').addEventListener('click', () => {
    if (session.phase === 'guiding') session.reportDeviation(Math.random() > 0.5 ? 60 : -60);
  });
}

function toggleAutoWalk() {
  if (autoWalkTimer) { stopAutoWalk(); return; }
  $('btn-auto').setAttribute('aria-pressed', 'true');
  $('btn-auto').textContent = '자동 이동 중지';
  autoWalkTimer = setInterval(() => {
    if (session.phase === 'guiding') session.step();
    else stopAutoWalk();
  }, 700);
}

function stopAutoWalk() {
  clearInterval(autoWalkTimer);
  autoWalkTimer = null;
  $('btn-auto').setAttribute('aria-pressed', 'false');
  $('btn-auto').textContent = '자동 이동';
}

// ══════════════════════════════════════════════════════════ 표시
const SCREENS = ['idle', 'guide', 'hold', 'done', 'admin', 'guardian'];

/** 대피가 진행 중일 때는 역할 탭을 감춘다 — 안내 화면을 벗어날 이유가 없다 */
const EVACUATING = new Set(['guide', 'hold', 'done']);

function showScreen(name) {
  for (const s of SCREENS) $(`screen-${s}`).hidden = s !== name;
  document.body.dataset.screen = name;

  $('role-nav').hidden = EVACUATING.has(name);
  document.querySelectorAll('.role-tab[data-role]').forEach(btn =>
    btn.setAttribute('aria-selected', String(btn.dataset.role === name)));

  if (name === 'admin' || name === 'guardian') panels?.show(name);
  else panels?.show(null);
}

function wireRoleNav() {
  document.querySelectorAll('.role-tab[data-role]').forEach(btn => {
    btn.addEventListener('click', () => {
      // 대피 중에는 역할을 바꿀 수 없다 (탭도 숨겨져 있다)
      if (EVACUATING.has(document.body.dataset.screen)) return;
      showScreen(btn.dataset.role);
    });
  });
}

function render() {
  if (!session) return;
  const training = Boolean(session.trainingMode);
  $('training-chip').hidden = !training;

  $('g-exit').textContent = session.exitName ? `→ ${session.exitName}` : '—';
  $('g-steps').textContent = session.stepsLeft != null ? `${session.stepsLeft}걸음` : '—';

  if (session.phase === 'safehold') {
    showScreen('hold');
    $('screen-hold').classList.toggle('training-hold', training);
    $('hold-reason').textContent = session.lastCommand;
    $('hold-place').textContent = api.floorPlan.getNode(session.currentNodeId)?.name ?? '—';
    $('hold-icon').textContent = training ? '훈련' : 'SOS';
    $('hold-title').textContent = training ? '훈련 결과: 대피 경로 없음' : '그 자리에서 기다리세요';
    $('hold-where-label').textContent = training ? '훈련 시작 위치' : '구조대에 전달된 내 위치';
    $('hold-guardian').textContent = training
      ? '훈련이므로 구조 요청과 보호자 알림은 전송되지 않았습니다.'
      : guardianNotice;
    stopAutoWalk();
    scanner.stop();   // 제자리에서 기다려야 한다. 방향 신호는 움직이게 만든다.
    releaseAll();
  } else if (session.phase === 'arrived') {
    showScreen('done');
    $('done-exit').textContent = `${session.exitName}에 도착했습니다.`;
    stopAutoWalk();
    scanner.stop();
    releaseAll();
  }

  if (session.phase !== 'safehold') {
    $('screen-hold').classList.remove('training-hold');
    $('hold-icon').textContent = 'SOS';
    $('hold-title').textContent = '그 자리에서 기다리세요';
    $('hold-where-label').textContent = '구조대에 전달된 내 위치';
    $('hold-guardian').textContent = guardianNotice;
  }

  saveSession();

  renderMap($('minimap'), {
    floorPlan: api.floorPlan,
    backgroundImage: api.backgroundImage,
    hazards: session.hazards,
    sensors, fires: trainingFire ? [...fires, trainingFire] : fires,
    route: session.route,
    userPos: session.position(),
  });
}

function releaseAll() {
  alarmHandled = false; // 다음 화재에 다시 반응할 수 있어야 한다
  localStorage.removeItem(RESUME_KEY);
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

function returnToIdle() {
  stopAutoWalk();
  resetSosPress();
  scanner.stop();
  clearTimeout(pendingStartTimer);
  clearTimeout(trainingStartTimer);
  pendingStartTimer = null;
  trainingStartTimer = null;
  trainingFire = null;
  trainingWaitingForPlace = false;
  localStorage.removeItem(RESUME_KEY);
  session.reset();
  placeVerified = false;
  verifiedPlanId = null;
  placeSource = null;
  pendingFire = false;
  // 이미 서버에 있던 화재 때문에 처음 화면에서 경보가 다시 뜨지 않게 유지한다.
  alarmHandled = fireIsActive();
  $('idle-place').textContent = '위치 확인 필요';
  $('idle-desc').textContent = '벽이나 문틀의 안내 태그에 휴대폰을 대거나 QR을 확인하세요.';
  $('idle-source').textContent = '';
  $('btn-start').disabled = false;
  updateIdleUI();
  showScreen('idle');
  render();
}

main();
