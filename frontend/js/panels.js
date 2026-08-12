/**
 * 앱 안의 관제·보호자 패널.
 *
 * 세 역할을 앱 하나로 관리한다. 별도 페이지(admin.html·guardian.html)는 큰 화면용으로
 * 남겨 두고, 여기서는 **폰에서 손가락으로 쓸 수 있는 최소한**만 담는다.
 *
 * 사용자 앱이 이미 열어 둔 SSE 연결과 도면을 그대로 쓴다. 패널마다 따로 연결하면
 * 같은 데이터를 받으려고 스트림을 세 개 여는 셈이 된다.
 */

import { renderMap } from './minimap.js';

const $ = id => document.getElementById(id);

const PHASE_VIEW = {
  idle:     { cls: 'idle',   title: '대기 중',      detail: '아직 대피가 시작되지 않았습니다.' },
  guiding:  { cls: 'urgent', title: '대피 중',      detail: '안내에 따라 이동하고 있습니다.' },
  safehold: { cls: 'danger', title: '구조 요청',    detail: '제자리에서 구조를 기다립니다.' },
  arrived:  { cls: 'safe',   title: '대피 완료',    detail: '출구에 도착했습니다.' },
};

/**
 * @param {Api} api  사용자 앱이 쓰는 것과 같은 인스턴스
 * @param {() => string} getMyUserId
 */
export function createPanels(api, getMyUserId) {
  const state = {
    hazards: {}, fires: [], sensors: [], positions: [], sos: [],
    watchUserId: null,   // 보호자 패널이 지켜보는 대상
    watchName: null,
    visible: null,       // 'admin' | 'guardian' | null
  };

  // ─────────────────────────────────────────────── 관제
  const radius = $('admin-radius');
  radius.addEventListener('input', () => { $('admin-radius-out').textContent = `${radius.value}m`; });

  $('btn-admin-putout').addEventListener('click', () => api.resetFires().catch(showAdminError));
  $('btn-admin-reset').addEventListener('click', () => api.resetHazards().catch(showAdminError));

  function drawAdmin() {
    if (state.visible !== 'admin') return;
    renderMap($('admin-map'), {
      floorPlan: api.floorPlan,
      backgroundImage: api.backgroundImage,
      hazards: state.hazards,
      fires: state.fires,
      sensors: state.sensors,
      positions: state.positions,
      onMapClick: (x, y) => {
        api.startFire({ x, y, radius: Number(radius.value) }).catch(showAdminError);
      },
    });
  }

  function renderPeople() {
    const live = state.positions.filter(p => p.phase && p.phase !== 'idle');
    $('admin-count').textContent = String(live.length);
    fill($('admin-people'), live, p => {
      const v = PHASE_VIEW[p.phase] || PHASE_VIEW.idle;
      return `<strong>${esc(p.nodeName ?? p.nodeId ?? '위치 미상')}</strong> — ${v.title}
        <div class="time">${esc(p.userId)} · ${time(p.ts)}</div>`;
    });
  }

  function renderSos() {
    fill($('admin-sos'), state.sos, s => {
      const guardian = s.guardianName
        ? `<div class="time">보호자 ${esc(s.guardianName)}${s.guardianContact ? ` · <a href="tel:${esc(s.guardianContact)}">${esc(s.guardianContact)}</a>` : ''}</div>`
        : '';
      return `<strong class="danger-text">SOS ${esc(s.nodeName ?? '위치 미상')}</strong>
        <div class="time">${esc(s.reason ?? '')}</div>${guardian}`;
    });
  }

  function showAdminError(err) {
    $('admin-count').textContent = '!';
    console.error(err);
  }

  // ─────────────────────────────────────────────── 보호자
  $('btn-gp-apply').addEventListener('click', async () => {
    const code = $('gp-code').value.trim().toUpperCase();
    if (!code) { watchSelf(); return; }
    try {
      const view = await api.openGuardianView(code);
      state.watchUserId = view.userId;
      state.watchName = view.guardian.name;
      $('gp-target').textContent = `${view.guardian.name} 님이 지켜보는 대상을 보고 있습니다.`;
      renderGuardian();
    } catch (err) {
      $('gp-target').textContent = `코드를 확인할 수 없습니다: ${err.message}`;
    }
  });

  function watchSelf() {
    state.watchUserId = getMyUserId();
    state.watchName = null;
    $('gp-target').textContent = '내 계정을 지켜보는 중입니다 (보호자에게 보이는 화면 그대로).';
  }

  function watched() {
    return state.positions.find(p => p.userId === (state.watchUserId || getMyUserId())) || null;
  }

  function renderGuardian() {
    if (state.visible !== 'guardian') return;
    const p = watched();
    const view = PHASE_VIEW[p?.phase] || PHASE_VIEW.idle;

    $('gp-banner').className = `gp-banner ${view.cls}`;
    $('gp-title').textContent = view.title;
    $('gp-detail').textContent =
      p?.phase === 'safehold' && p.command ? p.command : view.detail;

    const place = p?.nodeId ? api.floorPlan.getNode(p.nodeId) : null;
    $('gp-place').textContent = p?.nodeName ?? '—';
    $('gp-exit').textContent = p?.exitName ?? '—';
    $('gp-steps').textContent = p?.stepsLeft != null ? `${p.stepsLeft}걸음` : '—';
    $('gp-updated').textContent = p?.ts ? time(p.ts) : '—';
    $('gp-command').textContent = p?.command
      || (place ? [place.description, place.landmark].filter(Boolean).join(' ') : '—');

    const route = p?.routeNodes && p?.routeEdges
      ? { nodes: p.routeNodes, edges: p.routeEdges.map(id => api.floorPlan.getEdge(id)).filter(Boolean) }
      : null;
    const userPos = p?.x != null ? { x: p.x, y: p.y } : (place || null);

    renderMap($('gp-map'), {
      floorPlan: api.floorPlan,
      backgroundImage: api.backgroundImage,
      hazards: state.hazards,
      fires: state.fires,
      sensors: state.sensors,
      route, userPos,
    });
  }

  // ─────────────────────────────────────────────── 데이터 구독
  api.on('hazards', h => { state.hazards = h; drawAdmin(); renderGuardian(); });
  api.on('fires', f => { state.fires = f; drawAdmin(); renderGuardian(); });
  api.on('sensors', s => { state.sensors = s; drawAdmin(); renderGuardian(); });
  api.on('positions', list => {
    state.positions = list;
    renderPeople();
    drawAdmin();
    renderGuardian();
  });
  api.on('sos', list => { state.sos = list; renderSos(); });
  api.on('plan', () => { drawAdmin(); renderGuardian(); });

  watchSelf();

  /** 역할 화면이 열릴 때 호출 — 숨어 있는 동안은 그리지 않는다 */
  return {
    show(role) {
      state.visible = role;
      if (role === 'admin') { drawAdmin(); renderPeople(); renderSos(); }
      if (role === 'guardian') renderGuardian();
    },
  };
}

// ─────────────────────────────────────────────── 유틸
function fill(ul, items, fmt) {
  ul.innerHTML = items?.length
    ? items.map(i => `<li>${fmt(i)}</li>`).join('')
    : '<li class="empty">없음</li>';
}

function time(ts) {
  return ts ? new Date(ts).toLocaleTimeString('ko-KR') : '';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
