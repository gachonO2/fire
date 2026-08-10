/**
 * 보호자 화면 — 등록된 보호자가 대상자의 대피 상황을 실시간으로 확인한다.
 *
 * 화재로 대피가 시작되면(phase: guiding) 배너가 바뀌고 브라우저 알림이 뜬다.
 * 지도에는 대상자 위치·안내 중인 경로·위험 통로가 함께 표시된다.
 *
 * 스트림은 보호자 스코프(?code=)로 구독하므로 다른 대피자의 정보는 내려오지 않는다.
 */

import { Api } from './api.js';
import { renderMap } from './minimap.js';

const $ = id => document.getElementById(id);

const PHASE_VIEW = {
  idle:     { cls: 'idle',   title: '대기 중',       detail: '아직 대피가 시작되지 않았습니다.' },
  guiding:  { cls: 'urgent', title: '🚨 대피 중',    detail: '안내에 따라 이동하고 있습니다.' },
  safehold: { cls: 'danger', title: '🆘 구조 요청',  detail: '제자리에서 구조를 기다리고 있습니다.' },
  arrived:  { cls: 'safe',   title: '✅ 대피 완료',  detail: '출구에 도착했습니다.' },
};

let api = null;
let code = null;
let hazards = {};
let sensors = [];
let position = null;
let lastPhase = null;

async function main() {
  code = new URLSearchParams(location.search).get('code');

  $('btn-code-submit').addEventListener('click', () => {
    const entered = $('code-input').value.trim().toUpperCase();
    if (entered) location.search = `?code=${encodeURIComponent(entered)}`;
  });
  $('code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('btn-code-submit').click();
  });
  $('btn-notify').addEventListener('click', requestNotifyPermission);

  if (!code) {
    $('screen-code').hidden = false;
    return;
  }

  // 코드 검증 + 초기 스냅샷
  try {
    const view = await api_openView(code);
    document.title = `${view.guardian.name} 님의 보호 대상 — 대피 상황`;
    hazards = view.hazards || {};
    await api.loadFloorPlan();
    position = view.position;
    renderAlerts(view.alerts);
  } catch (err) {
    $('screen-code').hidden = false;
    $('code-error').textContent = err.message;
    $('code-error').hidden = false;
    $('code-input').value = code;
    return;
  }

  $('screen-watch').hidden = false;
  updateNotifyButton();

  api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '연결 끊김 — 재연결 중';
    $('mode-badge').classList.toggle('offline', !online);
  });

  api.on('hazards', h => { hazards = h; draw(); });
  api.on('sensors', s => { sensors = s; draw(); });
  api.on('plan', () => draw());

  api.on('positions', list => {
    // 보호자 스코프이므로 대상자 한 명만 내려온다
    if (list.length) position = list[0];
    render();
  });

  api.on('alerts', renderAlerts);

  render();
  await api.connect();
}

/** Api 인스턴스를 코드 스코프로 만들고 초기 상태를 받아온다 */
async function api_openView(c) {
  api = new Api({ code: c });
  return api.openGuardianView(c);
}

// ------------------------------------------------------------------ 렌더링
function render() {
  const phase = position?.phase || 'idle';
  const view = PHASE_VIEW[phase] || PHASE_VIEW.idle;

  const banner = $('alert-banner');
  banner.className = `alert-banner ${view.cls}`;
  $('alert-title').textContent = view.title;
  $('alert-detail').textContent =
    phase === 'safehold' && position?.command ? position.command : view.detail;

  $('g-location').textContent = position?.nodeName || '-';
  $('g-exit').textContent = position?.exitName || '-';
  $('g-steps').textContent = position?.stepsLeft != null ? `${position.stepsLeft}걸음` : '-';
  $('g-conf').textContent = position?.confidence != null
    ? `${Math.round(position.confidence * 100)}%` : '-';
  $('g-updated').textContent = position?.ts ? new Date(position.ts).toLocaleTimeString('ko-KR') : '-';
  $('g-command').textContent = position?.command || '-';

  // 상태가 바뀌는 순간에만 알림 (매 걸음마다 울리지 않도록)
  if (phase !== lastPhase && (phase === 'guiding' || phase === 'safehold')) {
    notify(view.title, `${position?.nodeName || '위치 확인 중'} — ${view.detail}`);
  }
  lastPhase = phase;

  draw();
}

function draw() {
  const floorPlan = api.floorPlan;
  const route = position?.routeNodes && position?.routeEdges
    ? { nodes: position.routeNodes, edges: position.routeEdges.map(id => floorPlan.getEdge(id)).filter(Boolean) }
    : null;

  const userPos = position?.x != null
    ? { x: position.x, y: position.y }
    : position?.nodeId ? floorPlan.getNode(position.nodeId) : null;

  renderMap($('guardian-map'), {
    floorPlan,
    backgroundImage: api.backgroundImage,
    hazards, sensors, route, userPos,
  });
}

function renderAlerts(list) {
  const ul = $('g-alerts');
  ul.innerHTML = list?.length
    ? list.map(a => `<li>
        <strong>${a.message}</strong>
        <div class="time">${a.nodeName ?? ''} ${a.exitName ? `· 목표 ${a.exitName}` : ''} · ${new Date(a.ts).toLocaleTimeString('ko-KR')}</div>
      </li>`).join('')
    : '<li class="empty">아직 없음</li>';
}

// ------------------------------------------------------------------ 알림
function updateNotifyButton() {
  const btn = $('btn-notify');
  if (!('Notification' in window)) { btn.hidden = true; return; }
  btn.hidden = Notification.permission === 'granted';
}

async function requestNotifyPermission() {
  if (!('Notification' in window)) return;
  await Notification.requestPermission();
  updateNotifyButton();
}

function notify(title, body) {
  if (navigator.vibrate) navigator.vibrate([400, 150, 400]);
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: 'icon.svg', tag: 'evac-status', renotify: true });
  }
}

main();
