/**
 * 사용자 앱 — 시각장애인 실내 대피 내비게이션.
 *
 * 흐름: 시작위치 확정(QR/수동) → 백엔드에 경로 요청 → 음성·진동 안내
 *       → 걸음·방위로 진행 추적 → 이탈 감지 → 위험 변경 시 재탐색
 *       → 위치확신도 저하 시 안전상태(구조요청) 전환.
 *
 * 서버가 경로를 계산하고(권위) KPI를 기록하지만, 통신이 끊기면
 * api.js가 캐시된 위험 상태로 브라우저에서 직접 계산해 안내를 이어간다.
 */

import { Guidance } from './guidance.js';
import { Odometry } from './odometry.js';
import { Api } from './api.js';
import { renderMap, positionOnRoute } from './minimap.js';

const $ = id => document.getElementById(id);

const plan = () => state.api.floorPlan;   // 활성 도면 (관제에서 바꾸면 갱신된다)
const getNode = id => plan().getNode(id);
const edgeSteps = edge => plan().edgeSteps(edge);
const bearing = (a, b) => plan().bearing(a, b);

const CONFIDENCE_FLOOR = 0.4;   // 이하로 떨어지면 안전상태 전환
const TURN_THRESHOLD = 30;      // 도 — 이 이상 방위가 꺾이면 회전 안내
const DEVIATION_THRESHOLD = 45; // 도 — 진행방향 이탈 판정

/** 보호자 연동이 새로고침 후에도 유지되도록 사용자 ID를 기기에 고정한다. */
function persistentUserId() {
  let id = localStorage.getItem('fireguide:userId');
  if (!id) {
    id = 'user-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('fireguide:userId', id);
  }
  return id;
}

const state = {
  api: new Api(),
  guidance: new Guidance(),
  odometry: new Odometry(),
  hazards: {},
  sensors: [],
  userId: persistentUserId(),
  guardian: null,      // 등록된 보호자 { name, contact, code }
  lastCommand: '',     // 보호자 화면에 "지금 무슨 안내를 받고 있는지" 보여주기 위함

  phase: 'idle',        // idle | guiding | arrived | safehold
  startNodeId: null,
  route: null,
  edgeIndex: 0,
  stepsTaken: 0,
  deviationStreak: 0,
  autoWalkTimer: null,
};

// ------------------------------------------------------------------ 초기화
async function main() {
  state.guidance.onAnnounce = text => {
    $('command-text').textContent = text;
    state.lastCommand = text;
    // 보호자가 "지금 어떤 안내를 받고 있는지"까지 볼 수 있도록 함께 보고한다
    if (state.phase !== 'idle') reportPosition();
  };

  state.odometry.onStep = () => { if (state.phase === 'guiding') onStep(); };
  state.odometry.start();

  // 시작 위치 목록은 도면에서 나온다 — 도면을 먼저 받아온 뒤 화면을 만든다
  await state.api.loadFloorPlan();
  buildStartPicker();

  // 관제에서 다른 건물 도면을 활성화하면 대기 중인 앱도 따라간다
  state.api.on('plan', () => {
    if (state.phase === 'idle') buildStartPicker();
    drawMap();
  });

  state.api.on('sensors', sensors => {
    state.sensors = sensors;
    drawMap();
  });

  state.api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '오프라인 — 저장된 지도로 안내';
    $('mode-badge').classList.toggle('offline', !online);
  });

  state.api.on('hazards', hazards => {
    const sig = h => JSON.stringify(Object.keys(h).sort().map(k => [k, h[k].type]));
    const changed = sig(state.hazards) !== sig(hazards);
    state.hazards = hazards;
    if (state.phase === 'guiding' && changed) onHazardsChanged();
    else drawMap();
  });

  $('btn-start').addEventListener('click', startEvacuation);
  $('btn-step').addEventListener('click', () => { if (state.phase === 'guiding') onStep(); });
  $('btn-auto').addEventListener('click', toggleAutoWalk);
  $('btn-repeat').addEventListener('click', () => state.guidance.repeat());
  $('btn-sos').addEventListener('click', () => enterSafeHold('사용자가 직접 구조를 요청했습니다.'));
  $('btn-deviate').addEventListener('click', simulateDeviation);
  $('btn-restart').addEventListener('click', () => location.reload());
  $('btn-qr').addEventListener('click', scanQR);
  $('btn-guardian-save').addEventListener('click', saveGuardian);
  $('btn-copy-link').addEventListener('click', copyGuardianLink);

  drawMap();
  await state.api.connect();
  await loadGuardian();
}

// ----------------------------------------------------------- 보호자 연동
/** 이전에 등록해 둔 보호자가 있으면 화면에 복원한다. */
async function loadGuardian() {
  try {
    showGuardian(await state.api.getGuardian(state.userId));
  } catch (_) { /* 미등록이거나 서버 미연결 — 조용히 넘어간다 */ }
}

async function saveGuardian() {
  const name = $('guardian-name').value.trim();
  const contact = $('guardian-contact').value.trim();
  if (!name) {
    state.guidance.speak('보호자 이름을 입력하세요.');
    $('guardian-name').focus();
    return;
  }

  try {
    const guardian = await state.api.registerGuardian({ userId: state.userId, name, contact });
    showGuardian(guardian);
    state.guidance.speak(`보호자 ${guardian.name} 님이 등록되었습니다. 공유 코드는 ${guardian.code.split('').join(' ')} 입니다.`);
  } catch (err) {
    state.guidance.speak('보호자 등록에 실패했습니다. 연결을 확인하세요.');
    console.error(err);
  }
}

function showGuardian(guardian) {
  if (!guardian) return;
  state.guardian = guardian;

  $('guardian-name').value = guardian.name || '';
  $('guardian-contact').value = guardian.contact || '';
  $('guardian-saved-name').textContent = guardian.name;
  $('guardian-code').textContent = guardian.code;

  const link = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}guardian.html?code=${guardian.code}`;
  $('guardian-link').value = link;
  $('btn-open-guardian').href = link;
  $('guardian-result').hidden = false;
  $('btn-guardian-save').textContent = '보호자 정보 수정';
}

async function copyGuardianLink() {
  const link = $('guardian-link').value;
  try {
    await navigator.clipboard.writeText(link);
    state.guidance.speak('링크를 복사했습니다.');
  } catch (_) {
    // 클립보드 권한이 없는 환경 (비 HTTPS 등) — 선택 상태로 두어 수동 복사 유도
    $('guardian-link').select();
    state.guidance.speak('링크를 직접 복사하세요.');
  }
}

// ------------------------------------------------------------- 시작 위치
function buildStartPicker() {
  const wrap = $('start-picker');
  wrap.innerHTML = '';
  for (const node of plan().nodes) {
    if (node.type === 'exit' || node.type === 'elevator') continue;
    const btn = document.createElement('button');
    btn.className = 'pick-btn';
    btn.textContent = node.name;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      state.startNodeId = node.id;
      wrap.querySelectorAll('.pick-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      $('btn-start').disabled = false;
      state.guidance.speak(`시작 위치: ${node.name}. 대피 시작 버튼을 누르세요.`);
    });
    wrap.appendChild(btn);
  }
}

/** QR 내용 = 노드 ID (예: "N1"). 지원 브라우저에서만 동작, 아니면 수동 선택 안내 */
async function scanQR() {
  if (!('BarcodeDetector' in window)) {
    state.guidance.speak('이 브라우저는 QR 인식을 지원하지 않습니다. 목록에서 위치를 선택하세요.');
    return;
  }
  const video = $('qr-video');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    const timer = setInterval(async () => {
      const codes = await detector.detect(video).catch(() => []);
      const hit = codes.find(c => getNode(c.rawValue));
      if (hit) {
        clearInterval(timer);
        stream.getTracks().forEach(t => t.stop());
        video.hidden = true;
        state.startNodeId = hit.rawValue;
        $('btn-start').disabled = false;
        state.guidance.speak(`위치 확인: ${getNode(hit.rawValue).name}. 대피 시작 버튼을 누르세요.`);
      }
    }, 400);
  } catch (_) {
    state.guidance.speak('카메라를 사용할 수 없습니다. 목록에서 위치를 선택하세요.');
  }
}

// ------------------------------------------------------------- 대피 시작
async function startEvacuation() {
  if (!state.startNodeId) return;
  $('btn-start').disabled = true;

  const route = await requestRoute(state.startNodeId, 'initial');
  if (!route) return; // requestRoute가 안전상태로 전환함

  state.phase = 'guiding';
  $('screen-start').hidden = true;
  $('screen-guide').hidden = false;

  state.guidance.cmdStart(route.exit.name);
  setTimeout(() => announceSegment(true), 2200); // 시작 안내가 끝날 즈음 첫 이동 명령
  reportPosition();
}

/** 백엔드에 경로 요청(실패 시 오프라인 로컬 계산). 경로가 없으면 안전상태 전환 후 null */
async function requestRoute(fromNodeId, kind) {
  const { route, ms, offline, reason } = await state.api.computeRoute(fromNodeId, kind, state.userId);
  $('kpi-recalc').textContent = `${ms} ms${offline ? ' (오프라인)' : ''}`;

  if (!route) {
    enterSafeHold(reason || '접근 가능한 대피 경로가 없습니다.');
    return null;
  }
  state.route = plan().hydrateRoute(route);
  state.edgeIndex = 0;
  state.stepsTaken = 0;
  $('kpi-exit').textContent = route.exit.name;
  drawMap();
  return state.route;
}

// ------------------------------------------------------------- 안내 진행
function currentEdge() {
  return state.route.edges[state.edgeIndex] || null;
}

function currentBearing() {
  const r = state.route;
  if (state.edgeIndex >= r.edges.length) return null;
  return bearing(r.nodes[state.edgeIndex], r.nodes[state.edgeIndex + 1]);
}

/** 현재 구간 안내. atStart=true면 회전 없이 직진 명령부터 */
function announceSegment(atStart = false) {
  const r = state.route;
  if (state.edgeIndex >= r.edges.length) { arrive(); return; }

  const edge = currentEdge();
  const steps = edgeSteps(edge);

  if (!atStart && state.edgeIndex > 0) {
    const prevB = bearing(r.nodes[state.edgeIndex - 1], r.nodes[state.edgeIndex]);
    let diff = currentBearing() - prevB;
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    if (Math.abs(diff) >= TURN_THRESHOLD) {
      state.guidance.cmdTurn(diff > 0 ? 'right' : 'left', steps);
      updateHud();
      return;
    }
  }
  state.guidance.cmdStraight(steps, edge.wall);
  updateHud();
}

function onStep() {
  const edge = currentEdge();
  if (!edge) return;
  state.stepsTaken++;

  checkDeviation();

  if (state.stepsTaken >= edgeSteps(edge)) {
    // 노드 도착 — 확정 지점이므로 확신도 회복
    state.edgeIndex++;
    state.stepsTaken = 0;
    state.deviationStreak = 0;
    state.odometry.resetAt();
    reportPosition();
    announceSegment();
  } else {
    updateHud();
  }
  drawMap();
}

/** 방위 센서가 있으면 경로 방위와 비교해 이탈 감지 */
function checkDeviation() {
  const expected = currentBearing();
  if (expected === null) return;
  const err = state.odometry.headingError(expected);
  if (err === null) return; // 데스크톱 데모: 센서 없음

  if (Math.abs(err) > DEVIATION_THRESHOLD) {
    if (++state.deviationStreak >= 2) {
      handleDeviation(err);
      state.deviationStreak = 0;
    }
  } else {
    state.deviationStreak = 0;
    state.odometry.restoreConfidence(0.05);
    updateHud();
  }
}

function handleDeviation(err) {
  const dirText = err > 0 ? '오른쪽' : '왼쪽';
  const deg = Math.min(90, Math.round(Math.abs(err) / 10) * 10);
  state.guidance.cmdStop(`${dirText}으로 ${deg}도 돌려 통로를 찾으세요.`);
  const conf = state.odometry.degradeConfidence(0.25);
  updateHud();
  if (conf < CONFIDENCE_FLOOR) {
    enterSafeHold('위치 확신도가 기준보다 낮습니다.');
  }
}

/** 데모용: 센서 없는 환경에서 이탈 상황 재현 */
function simulateDeviation() {
  if (state.phase !== 'guiding') return;
  handleDeviation(Math.random() > 0.5 ? 60 : -60);
}

// ------------------------------------------------------------- 재탐색
async function onHazardsChanged() {
  const r = state.route;
  const lastNode = r.nodes[state.edgeIndex]; // 마지막으로 확정 통과한 노드
  const oldEdgeIds = r.edges.map(e => e.id).join(',');
  const oldBearing = currentBearing();

  const route = await requestRoute(lastNode, 'reroute');
  if (!route) return;

  if (route.edges.map(e => e.id).join(',') === oldEdgeIds) {
    drawMap();
    return; // 경로 변화 없음
  }

  state.guidance.cmdReroute('전방 통로 상태가 변경되었습니다.');

  setTimeout(() => {
    // 되돌아가야 하면 멈춤+방향전환부터
    const newBearing = currentBearing();
    if (oldBearing !== null && newBearing !== null) {
      let diff = newBearing - oldBearing;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      if (Math.abs(diff) > 150) {
        state.guidance.cmdStop('뒤로 돌아서세요.');
        setTimeout(() => announceSegment(true), 2000);
        return;
      }
    }
    announceSegment(state.edgeIndex === 0);
  }, 1800);
}

// ------------------------------------------------------------- 종료 상태
function arrive() {
  state.phase = 'arrived';
  stopAutoWalk();
  state.guidance.cmdArrive(state.route.exit.name);
  $('kpi-status').textContent = '대피 완료';
  $('btn-restart').hidden = false;
  reportPosition();
}

function enterSafeHold(reason) {
  state.phase = 'safehold';
  stopAutoWalk();
  state.guidance.cmdDanger(reason);
  setTimeout(() => state.guidance.cmdSOS(), 1800);

  const node = state.route ? getNode(state.route.nodes[state.edgeIndex]) : getNode(state.startNodeId);
  state.api.sendSOS({
    userId: state.userId,
    nodeId: node?.id || '?',
    nodeName: node?.name || '알 수 없음',
    reason,
    confidence: state.odometry.confidence,
  });

  $('screen-start').hidden = true;
  $('screen-guide').hidden = false;
  $('screen-guide').classList.add('safehold');
  $('kpi-status').textContent = '안전상태 — 구조요청 전송됨';
  $('btn-restart').hidden = false;
}

// ------------------------------------------------------------- 데모 이동
function toggleAutoWalk() {
  if (state.autoWalkTimer) { stopAutoWalk(); return; }
  $('btn-auto').setAttribute('aria-pressed', 'true');
  $('btn-auto').textContent = '자동 이동 중지';
  state.autoWalkTimer = setInterval(() => {
    if (state.phase === 'guiding') onStep();
    else stopAutoWalk();
  }, 700);
}

function stopAutoWalk() {
  clearInterval(state.autoWalkTimer);
  state.autoWalkTimer = null;
  $('btn-auto').setAttribute('aria-pressed', 'false');
  $('btn-auto').textContent = '자동 이동 (데모)';
}

// ------------------------------------------------------------- 표시·보고
function updateHud() {
  const edge = state.route ? currentEdge() : null;
  $('kpi-steps').textContent = edge
    ? `${Math.max(0, edgeSteps(edge) - state.stepsTaken)}걸음`
    : '-';

  const conf = Math.round(state.odometry.confidence * 100);
  $('kpi-conf').textContent = `${conf}%`;
  $('kpi-conf').style.color = conf < 50 ? 'var(--danger)' : 'inherit';
}

function myPosition() {
  if (!state.route) return null;
  const edge = currentEdge();
  return positionOnRoute(plan(), state.route, state.edgeIndex,
    edge ? state.stepsTaken / edgeSteps(edge) : 1);
}

function drawMap() {
  renderMap($('minimap'), {
    floorPlan: plan(),
    backgroundImage: state.api.backgroundImage,
    hazards: state.hazards,
    sensors: state.sensors,
    route: state.route,
    userPos: myPosition(),
  });
}

function reportPosition() {
  const nodeId = state.route
    ? state.route.nodes[Math.min(state.edgeIndex, state.route.nodes.length - 1)]
    : state.startNodeId;
  const node = getNode(nodeId);
  const pos = myPosition() || { x: node?.x, y: node?.y };

  state.api.updatePosition(state.userId, {
    nodeId,
    nodeName: node?.name,
    phase: state.phase,
    confidence: state.odometry.confidence,
    x: pos.x, y: pos.y,
    // 보호자 화면이 경로와 현재 안내를 그대로 재현할 수 있도록 함께 보낸다
    command: state.lastCommand,
    exitName: state.route?.exit?.name || null,
    routeNodes: state.route?.nodes || null,
    routeEdges: state.route?.edges.map(e => e.id) || null,
    stepsLeft: state.route && currentEdge()
      ? Math.max(0, edgeSteps(currentEdge()) - state.stepsTaken)
      : null,
  });
}

main();
