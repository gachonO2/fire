/**
 * 시연 콘솔 — 한 화면에서 대피와 화재를 모두 조작한다.
 *
 * 사용자 앱·관제·보호자를 오가지 않고도 핵심을 보여줄 수 있어야 해서 만든 화면이다.
 * 1) 출발지 고르고  2) 대피 시작하고  3) 지도를 클릭해 불을 낸다.
 * 그러면 사용자가 듣는 안내가 그대로 오른쪽에 뜨고, 경로가 다시 잡힌다.
 *
 * 대피 로직은 사용자 앱과 같은 EvacuationSession을 쓴다 (두 갈래로 갈라지면 안 되는 부분).
 */

import { Api } from './api.js';
import { Guidance } from './guidance.js';
import { EvacuationSession } from './evacuation.js';
import { DirectionScanner } from './direction-scan.js';
import { renderMap } from './minimap.js';
import { TEST_PLAN_IDS } from '../shared/test-plans.js';

const $ = id => document.getElementById(id);
const TEST_MODE = new URLSearchParams(location.search).get('test') === '1';
const TEST_PLACES_KEY = 'fireguide:testPlaces';

const api = new Api();
const guidance = new Guidance();
// 데스크톱에는 나침반이 없으므로 다이얼로 방위를 직접 준다
const scanner = new DirectionScanner();
let session = null;
let fires = [];
let sensors = [];
let autoTimer = null;
let mapTool = 'fire';
let moveSequence = 0;
let setManualHeading = () => {};

async function main() {
  await api.loadFloorPlan();

  await configureTestMode();

  session = new EvacuationSession({
    api, guidance,
    userId: localStorage.getItem('fireguide:userId') || newUserId(),
  });
  session.onAnnounce = text => { $('command').textContent = text; };
  session.onChange = render;

  buildStartPicker();
  initializeTestPerson();
  wireControls();
  wireDial();

  api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '서버 연결 끊김';
    $('mode-badge').classList.toggle('offline', !online);
  });

  // 관제나 다른 화면에서 도면을 바꾸면 여기도 따라간다
  api.on('plan', () => {
    buildStartPicker();
    refreshPlanSelect();
    resetLocal();
    initializeTestPerson();
    render();
  });

  api.on('hazards', hazards => session.hazardsChanged(hazards));
  api.on('fires', list => { fires = list; render(); });
  api.on('sensors', list => { sensors = list; render(); });

  await refreshPlanSelect();
  render();
  await api.connect();
}

/** 테스트 공간은 전용 도면 5개와 각 도면의 저장 위치 5곳만 사용한다. */
async function configureTestMode() {
  if (!TEST_MODE) return;

  document.body.classList.add('test-mode');
  document.title = '화재 대피 테스트 공간';
  $('page-title').textContent = '화재 대피 테스트 공간';
  $('back-to-app').hidden = false;
  $('plan-label').textContent = '테스트 도면';
  $('place-heading').textContent = '저장된 테스트 위치 (5곳)';
  $('test-place-note').hidden = false;
  $('test-map-tools').hidden = false;
  $('free-move-card').hidden = false;

  // 일반 운영 도면에서 들어왔다면 첫 번째 테스트 도면으로 이동한다.
  // 서버 연결이 없을 때는 현재 캐시 도면으로 나머지 기능을 계속 체험한다.
  if (!TEST_PLAN_IDS.includes(api.floorPlan.id)) {
    try {
      const plans = await api.listPlans();
      const first = plans.find(plan => TEST_PLAN_IDS.includes(plan.id));
      if (first) {
        await api.resetFires();
        await api.activatePlan(first.id);
        await api.loadFloorPlan();
      }
    } catch (_) { /* 오프라인에서는 캐시 도면 사용 */ }
  }
}

function newUserId() {
  const id = 'user-' + Math.random().toString(36).slice(2, 8);
  localStorage.setItem('fireguide:userId', id);
  return id;
}

// ------------------------------------------------------------------ 조작
function wireControls() {
  const radius = $('radius');
  radius.addEventListener('input', () => { $('radius-out').textContent = `${radius.value}m`; });

  $('btn-start').addEventListener('click', async () => {
    $('btn-start').disabled = true;
    if (await session.start()) scanner.start(currentTargetBearing);
  });

  $('btn-step').addEventListener('click', () => session.step());
  $('btn-auto').addEventListener('click', toggleAuto);
  $('btn-where').addEventListener('click', () => session.describeHere());
  $('btn-repeat').addEventListener('click', () => guidance.repeat());
  $('btn-put-out').addEventListener('click', () => api.resetFires().catch(showError));
  $('btn-reset').addEventListener('click', resetAll);

  document.querySelectorAll('[data-move-x]').forEach(button => {
    button.addEventListener('click', () => moveOneStep(
      Number(button.dataset.moveX),
      Number(button.dataset.moveY),
    ));
  });

  document.addEventListener('keydown', event => {
    if (!TEST_MODE || event.ctrlKey || event.altKey || event.metaKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) return;
    const directions = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
      q: [-1, -1], e: [1, -1], z: [-1, 1], c: [1, 1],
    };
    const direction = directions[event.key] || directions[event.key.toLowerCase()];
    if (!direction) return;
    event.preventDefault();
    moveOneStep(...direction);
  });

  document.querySelectorAll('[data-map-tool]').forEach(button => {
    button.addEventListener('click', () => setMapTool(button.dataset.mapTool));
  });

  $('plan-select').addEventListener('change', async e => {
    try {
      if (TEST_MODE) await api.resetFires();
      await api.activatePlan(e.target.value);  // 나머지는 plan 이벤트가 처리한다
    } catch (err) { showError(err); }
  });
}

function setMapTool(tool) {
  if (!TEST_MODE || !['fire', 'move'].includes(tool)) return;
  mapTool = tool;
  document.querySelectorAll('[data-map-tool]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mapTool === tool));
  });
  $('map').classList.toggle('move-person', tool === 'move');
  $('map-tip').innerHTML = tool === 'move'
    ? '<strong>파란 사람을 드래그하거나 지도에서 원하는 위치를 클릭하세요.</strong> 가까운 저장 위치를 기준으로 경로를 다시 계산합니다.'
    : '<strong>지도를 클릭하면 그 자리에 불이 납니다.</strong> 불이 난 곳을 피해 경로가 자동으로 다시 잡힙니다.';
  render();
}

// ------------------------------------------------------- 방향 찾기 체험
/**
 * 폰을 좌우로 훑는 동작을 다이얼로 대신한다.
 * 실제 기기에서는 나침반이 이 값을 준다 — 신호 규칙은 완전히 동일하다.
 */
function wireDial() {
  const dial = $('dial');

  const setHeading = deg => {
    scanner.manualHeading = ((deg % 360) + 360) % 360;
    dial.setAttribute('aria-valuenow', Math.round(scanner.manualHeading));
    $('dial-arrow').style.transform = `rotate(${scanner.manualHeading}deg)`;
  };
  setManualHeading = setHeading;
  setHeading(0);

  const fromPointer = ev => {
    const r = dial.getBoundingClientRect();
    const x = ev.clientX - (r.left + r.width / 2);
    const y = ev.clientY - (r.top + r.height / 2);
    setHeading((Math.atan2(x, -y) * 180) / Math.PI);
  };

  dial.addEventListener('pointerdown', ev => {
    dial.setPointerCapture(ev.pointerId);
    fromPointer(ev);
  });
  dial.addEventListener('pointermove', ev => {
    if (dial.hasPointerCapture(ev.pointerId)) fromPointer(ev);
  });
  // 키보드로도 돌릴 수 있어야 한다 (마우스만 쓰는 UI는 접근성 프로젝트에 어울리지 않는다)
  dial.addEventListener('keydown', ev => {
    const step = ev.shiftKey ? 15 : 3;
    if (ev.key === 'ArrowLeft') { setHeading(scanner.manualHeading - step); ev.preventDefault(); }
    if (ev.key === 'ArrowRight') { setHeading(scanner.manualHeading + step); ev.preventDefault(); }
  });

  $('scan-sound').addEventListener('change', e => { scanner.sound = e.target.checked; });
}

/** 지금 걷고 있는 통로의 방위 — 회전 지점을 지나면 자동으로 다음 통로를 향한다 */
function currentTargetBearing() {
  if (!session?.route || session.phase !== 'guiding') return null;
  return session.targetBearing();
}

scanner.onUpdate = ({ active, error, level, target, reason }) => {
  if (!active) return;

  if (reason === 'no-heading') {
    $('scan-level').textContent = '신호 대기';
    $('scan-detail').textContent = '대피를 먼저 시작하세요.';
    $('dial-target').style.opacity = '0';
    return;
  }

  $('dial-target').style.opacity = '1';
  $('dial-target').style.transform = `rotate(${target}deg)`;

  const clamped = Math.max(-90, Math.min(90, error));
  $('scan-needle').style.left = `${50 + (clamped / 90) * 50}%`;

  $('scan-level').textContent = level.id === 'lock'
    ? '연속 신호 · 방향 고정'
    : level.pattern ? '간헐 신호 · 계속 탐색' : '신호 없음 · 계속 탐색';
  $('scan-level').dataset.level = level.id;
  $('scan-detail').textContent = level.id === 'lock'
    ? '신호가 이어지는 방향을 유지하세요.'
    : '폰을 천천히 훑으며 신호가 이어지는 지점을 찾으세요.';
};

/** 등록된 도면 목록을 건물 선택에 채운다 */
async function refreshPlanSelect() {
  const select = $('plan-select');
  try {
    const allPlans = await api.listPlans();
    const plans = TEST_MODE
      ? allPlans.filter(plan => TEST_PLAN_IDS.includes(plan.id))
      : allPlans;
    select.innerHTML = plans
      .map(p => `<option value="${p.id}" ${p.active ? 'selected' : ''}>${p.name}</option>`)
      .join('');
  } catch (_) {
    select.innerHTML = `<option>${api.floorPlan.name}</option>`;
  }
}

/** 도면이 바뀌면 진행 중이던 안내는 의미가 없다 */
function resetLocal() {
  stopAuto();
  scanner.stop();
  session.reset();
  $('btn-start').disabled = true;
  $('command').textContent = '출발 위치를 고르세요.';
}

function toggleAuto() {
  if (autoTimer) { stopAuto(); return; }
  $('btn-auto').textContent = '멈추기';
  autoTimer = setInterval(() => {
    if (session.phase === 'guiding') session.step();
    else stopAuto();
  }, 700);
}

function stopAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  $('btn-auto').textContent = '자동으로 걷기';
}

async function resetAll() {
  stopAuto();
  scanner.stop();
  try {
    await api.resetHazards();  // 위험·센서·화재를 한 번에 되돌린다
  } catch (err) { showError(err); }
  session.reset();
  document.querySelectorAll('.pick-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
  $('btn-start').disabled = true;
  $('command').textContent = '출발 위치를 고르세요.';
  initializeTestPerson();
  render();
}

/** 지도의 임의 지점에 불을 낸다 */
async function ignite(x, y) {
  try {
    const res = await api.startFire({ x, y, radius: Number($('radius').value) });
    if (res.blockedEdges.length === 0 && session.phase === 'guiding') {
      $('command').textContent = '불이 통로에서 멀어 경로가 그대로입니다. 크기를 키우거나 복도 쪽을 클릭해 보세요.';
    }
  } catch (err) { showError(err); }
}

/** 테스트 인물을 임의 좌표로 이동한다. 안내 중이면 현재 경로와의 이탈을 실제 좌표로 판정한다. */
async function movePerson(x, y) {
  if (!TEST_MODE) return;
  const previous = session.position();
  if (previous && Math.hypot(x - previous.x, y - previous.y) > 0.001) {
    setManualHeading(bearingBetween(previous, { x, y }));
  }

  if (session.phase === 'guiding') {
    stopAuto();
    session.moveFreelyTo(x, y);
    render();
    return;
  }

  const nearest = api.floorPlan.nodes
    .filter(node => node.type !== 'exit' && node.type !== 'elevator')
    .reduce((best, node) => {
      const distance = Math.hypot(node.x - x, node.y - y);
      return !best || distance < best.distance ? { node, distance } : best;
    }, null)?.node;
  if (!nearest) return;

  const sequence = ++moveSequence;
  stopAuto();
  try {
    const moved = await session.relocateTo(nearest.id, { x, y });
    if (!moved || sequence !== moveSequence) return;

    document.querySelectorAll('.pick-btn').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.nodeId === nearest.id));
    });
    $('btn-start').disabled = false;
    if (session.phase === 'idle') {
      guidance.speak(`테스트 인물을 ${nearest.name} 부근으로 이동했습니다. 대피 시작 버튼을 누르세요.`);
    }
    render();
  } catch (err) { showError(err); }
}

// ------------------------------------------------------------- 출발지 선택
function buildStartPicker() {
  const wrap = $('start-picker');
  wrap.innerHTML = '';
  const available = api.floorPlan.nodes
    .filter(node => node.type !== 'exit' && node.type !== 'elevator');
  const places = TEST_MODE ? getSavedTestPlaces(available) : available;

  for (const node of places) {
    const btn = document.createElement('button');
    btn.className = `pick-btn${TEST_MODE ? ' test-place' : ''}`;
    if (TEST_MODE) {
      const name = document.createElement('strong');
      name.textContent = node.name;
      const description = document.createElement('small');
      description.textContent = node.description || node.landmark || '테스트용으로 저장된 장소';
      btn.append(name, description);
    } else {
      btn.textContent = node.name;
    }
    btn.setAttribute('aria-pressed', 'false');
    btn.dataset.nodeId = node.id;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.pick-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      session.setStart(node.id);
      session.announceStartPlace();
      $('btn-start').disabled = false;
    });
    wrap.appendChild(btn);
  }
}

/** 버튼 한 번마다 보폭만큼 이동한다. 대각선도 이동 거리는 한 걸음으로 동일하다. */
function moveOneStep(dx, dy) {
  if (!TEST_MODE || session?.phase !== 'guiding') return;
  const current = session.position();
  if (!current) return;

  const length = Math.hypot(dx, dy) || 1;
  const units = api.floorPlan.stepLength / api.floorPlan.metersPerUnit;
  const width = api.floorPlan.image?.width ?? Math.max(...api.floorPlan.nodes.map(node => node.x));
  const height = api.floorPlan.image?.height ?? Math.max(...api.floorPlan.nodes.map(node => node.y));
  const next = {
    x: Math.max(0, Math.min(width, current.x + (dx / length) * units)),
    y: Math.max(0, Math.min(height, current.y + (dy / length) * units)),
  };

  setManualHeading(bearingBetween(current, next));
  stopAuto();
  session.moveFreelyTo(next.x, next.y);
  render();
}

function bearingBetween(a, b) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * 도면별 테스트 위치 5곳을 브라우저에 저장한다.
 * 도면이 바뀌거나 장소가 삭제된 경우에는 현재 도면에서 다시 5곳을 골라 저장한다.
 */
function getSavedTestPlaces(available) {
  const storageKey = `${TEST_PLACES_KEY}:${api.floorPlan.id}`;
  let savedIds = [];
  try { savedIds = JSON.parse(localStorage.getItem(storageKey)) || []; }
  catch (_) { /* 손상된 테스트 설정은 아래에서 자동 복구 */ }

  let places = savedIds
    .map(id => available.find(node => node.id === id))
    .filter(Boolean)
    .slice(0, 5);

  if (places.length < 5) {
    places = available.slice(0, 5);
    try { localStorage.setItem(storageKey, JSON.stringify(places.map(node => node.id))); }
    catch (_) { /* 저장소가 막혀도 현재 테스트는 계속할 수 있다 */ }
  }

  return places;
}

/** 테스트 화면은 열자마자 첫 위치에 사람을 보여 준다. */
function initializeTestPerson() {
  if (!TEST_MODE || session.startNodeId) return;
  const available = api.floorPlan.nodes
    .filter(node => node.type !== 'exit' && node.type !== 'elevator');
  const first = getSavedTestPlaces(available)[0];
  if (!first) return;

  session.setStart(first.id);
  document.querySelectorAll('.pick-btn').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.nodeId === first.id));
  });
  $('btn-start').disabled = false;
  $('command').textContent = `테스트 인물이 ${first.name}에 배치되었습니다.`;
}

// ------------------------------------------------------------------ 표시
function render() {
  const guiding = session?.phase === 'guiding';

  $('btn-step').disabled = !guiding;
  $('btn-auto').disabled = !guiding;
  document.querySelectorAll('[data-move-x]').forEach(button => { button.disabled = !guiding; });
  $('btn-where').disabled = !session?.route && !session?.startNodeId;

  $('meta-exit').textContent = session?.exitName ? `목표 ${session.exitName}` : '목표 —';
  $('meta-steps').textContent = session?.recovery
    ? `경로에서 ${session.recovery.distanceMeters.toFixed(1)}m 이탈`
    : session?.stepsLeft != null ? `${session.stepsLeft}걸음 남음` : '—';
  $('meta-ms').textContent = session?.lastMs != null
    ? `경로 계산 ${session.lastMs}ms${session.offline ? ' (오프라인)' : ''}` : '—';

  const card = $('card-2');
  card.classList.toggle('done', Boolean(session?.route));
  $('card-1').classList.toggle('done', Boolean(session?.startNodeId));

  const banner = { arrived: '대피 완료', safehold: '구조 요청 중' }[session?.phase];
  if (banner) {
    $('command').textContent = `${banner} — ${session.lastCommand}`;
    // 도착했거나 제자리 대기 중이면 방향 신호는 오히려 방해가 된다
    if (scanner.active) scanner.stop();
  }


  if (TEST_MODE) {
    const moveStatus = $('move-status');
    moveStatus.classList.toggle('off-route', Boolean(session?.recovery || session?.directionMismatch));
    moveStatus.textContent = !guiding
      ? '대피를 시작하면 자유 이동을 사용할 수 있습니다.'
      : session.recovery
        ? `경로에서 ${session.recovery.distanceMeters.toFixed(1)}m 벗어났습니다. 파란 복귀선 방향으로 이동하세요.`
        : session.directionMismatch
          ? '경로 위에 있지만 진행 방향이 잘못되었습니다. 방향 신호를 다시 찾으세요.'
          : '경로 안에서 올바른 방향으로 이동 중입니다.';
  }

  renderMap($('map'), {
    floorPlan: api.floorPlan,
    backgroundImage: api.backgroundImage,
    backgroundOpacity: TEST_MODE ? 0.86 : 0.55,
    hazards: session?.hazards || {},
    fires,
    sensors,
    route: session?.route,
    userPos: session?.position(),
    recoveryTarget: session?.recovery,
    onMapClick: TEST_MODE && mapTool === 'move' ? movePerson : ignite,
    onNodeClick: TEST_MODE && mapTool === 'move'
      ? node => movePerson(node.x, node.y)
      : null,
    onUserMove: TEST_MODE && mapTool === 'move' ? movePerson : null,
  });
}

function showError(err) {
  $('mode-badge').textContent = `오류: ${err.message}`;
  $('mode-badge').classList.add('offline');
}

main();
