/**
 * 관제 대시보드 — 화재·연기·혼잡·온도 시뮬레이션과 대피 모니터링.
 *
 * 통로(엣지) 클릭 → 백엔드 REST로 위험 상태 변경 또는 온도 주입
 * → SSE로 모든 사용자 앱에 즉시 전파 → 사용자 앱이 재탐색.
 * (MVP 가설 검증: 재탐색 2초 이내)
 *
 * 온도 도구는 실제 온도 센서가 보내는 것과 **동일한 API**를 호출한다.
 * 시뮬레이션과 실제 연동의 경로를 분리하지 않아야 실증에서 그대로 쓸 수 있다.
 */

import { Api } from './api.js';
import { LiveTrack } from './live-track.js';
import { drawBeacons, drawFoundBeacons, startBeaconWaves } from './beacon-layer.js';
import { renderMap, temperatureColor } from './minimap.js';
import { TEMP } from '../shared/hazard-rules.js';

const $ = id => document.getElementById(id);

const api = new Api();
let hazards = {};
let foundBeacons = [];
let sensors = [];
let positions = [];
let live = null;
let currentTool = 'smoke';

async function main() {
  document.querySelectorAll('.tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTool = btn.dataset.tool;
      const label = { fire: '화재', smoke: '연기', crowd: '혼잡', temp: '온도', clear: '해제' }[currentTool];
      const badge = document.getElementById('map-mode');
      if (badge && label) badge.textContent = label;
      document.querySelectorAll('.tool[data-tool]').forEach(b =>
        b.setAttribute('aria-pressed', String(b === btn)));
      $('temp-controls').hidden = currentTool !== 'temp';
    });
  });

  const slider = $('temp-value');
  slider.addEventListener('input', () => {
    $('temp-readout').textContent = `${slider.value}°C`;
    $('temp-readout').style.color = temperatureColor(Number(slider.value));
  });
  slider.dispatchEvent(new Event('input'));

  $('btn-reset').addEventListener('click', () => api.resetHazards().catch(showError));
  $('btn-reset-sensors').addEventListener('click', () => api.resetSensors().catch(showError));

  api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '서버 연결 끊김';
    $('mode-badge').classList.toggle('off', !online);
  });

  live = new LiveTrack(document.getElementById('live-layer'), () => ({
    baseSvg: document.getElementById('admin-map'),
    floorPlan: api.floorPlan,
  }));
  live.start();

  ['show-beacons', 'show-range'].forEach(id =>
    document.getElementById(id)?.addEventListener('change', draw));
  startBeaconWaves(document.getElementById('beacon-waves'), () => ({
    baseSvg: document.getElementById('admin-map'),
    floorPlan: api.floorPlan,
    enabled: (document.getElementById('show-beacons')?.checked ?? true)
      && (document.getElementById('show-waves')?.checked ?? true),
    // 사람이 있는 곳의 비콘만 울린다 — 전부 울리면 정보가 아니라 소음이다
    near: positions.filter(p => Number.isFinite(p?.x)),
  }));

  api.on('plan', plan => {
    $('building-info').textContent =
      `${plan.name} · 노드 ${plan.nodes.length} · 통로 ${plan.edges.length}`;
    draw();
  });

  api.on('hazards', h => { hazards = h; draw(); });

  // 걸으면서 찾아낸 비콘 — 맥 스캐너가 올린 관측을 서버가 폰 위치와 짝지은 결과
  api.on('beaconMap', list => { foundBeacons = list || []; draw(); });

  api.on('sensors', list => {
    sensors = list;
    renderSensors(list);
    draw();
  });

  api.on('sos', list => {
    window.__sosCount = list.length;
    renderList($('sos-list'), list, s => {
      // 구조대가 보호자에게 바로 연락할 수 있도록 등록된 연락처를 함께 띄운다
      const guardian = s.guardianName
        ? `<div class="guardian-line">👨‍👩‍👧 보호자 ${s.guardianName}${s.guardianContact ? ` · <a href="tel:${s.guardianContact}">${s.guardianContact}</a>` : ''}</div>`
        : '';
      return `<span class="sos-item">🆘 ${s.nodeName ?? s.nodeId}</span> — ${s.reason}
        ${guardian}
        <div class="time">${s.userId} · 확신도 ${Math.round((s.confidence ?? 0) * 100)}% · ${time(s.ts)}</div>`;
    });
  });

  api.on('positions', list => {
    positions = list;
    live?.update(list);
    renderList($('pos-list'), list, p => {
      const phase = { guiding: '대피 중', arrived: '대피 완료 ✅', safehold: '안전상태 🆘', idle: '대기' }[p.phase] || p.phase;
      return `<strong>${p.nodeName ?? p.nodeId}</strong> — ${phase}
        <div class="time">${p.userId} · 확신도 ${Math.round((p.confidence ?? 1) * 100)}% · ${time(p.ts)}</div>`;
    });
    draw();
  });

  api.on('metrics', list => {
    const last = list[list.length - 1];
    const el = document.getElementById('stat-recalc');
    if (el && last) el.textContent = `${Math.round(last.ms)}ms`;
    renderList($('metric-list'), list, m => {
      const kind = m.kind === 'reroute' ? '재탐색' : '최초 계산';
      const ok = m.ms <= 2000 ? '✅' : '⚠️';
      return `${kind}: <strong>${m.ms} ms</strong> ${ok}
        <div class="time">${m.from ?? ''} 기준 · ${m.userId ?? ''} · ${time(m.ts)}</div>`;
    });
  });

  $('temp-legend').textContent = `주의 ${TEMP.WARN}°C 이상 · 통행불가 ${TEMP.BLOCK}°C 이상`;

  await api.loadFloorPlan();
  draw();
  await api.connect();
}

function draw() {
  renderMap($('admin-map'), {
    floorPlan: api.floorPlan,
    backgroundImage: api.backgroundImage,
    hazards,
    sensors,
    positions: [],   // 점은 live-track 레이어가 부드럽게 그린다
    onEdgeClick: edge => applyTool({ edge }),
    onNodeClick: node => { if (currentTool === 'temp') applyTool({ node }); },
  });

  // 비콘 — 어디에 깔려 있는지 보여야 "왜 저기서 위치가 잡히나"가 이해된다
  if (api.floorPlan && document.getElementById('show-beacons')?.checked) {
    drawBeacons(document.getElementById('admin-map'), api.floorPlan, {
      showRange: document.getElementById('show-range')?.checked ?? false,
    });
    // 찾아낸 실물 비콘은 그 위에 얹는다 (초록 — 추정치라 확정 비콘과 구분한다)
    drawFoundBeacons(document.getElementById('admin-map'), api.floorPlan, foundBeacons);
  }
  updateStats();
}

/** 상단 숫자 네 개 — 시연에서 상황이 한눈에 읽혀야 하는 줄 */
function updateStats() {
  const blocked = Object.keys(hazards || {}).length;
  const walking = positions.filter(p => p.phase === 'guiding').length;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-people', walking);
  set('stat-hazards', blocked);
  set('stat-sos', (window.__sosCount ?? 0));
  set('n-people', positions.length);
  set('n-sos', (window.__sosCount ?? 0));
  set('n-sensors', (sensors || []).length);
}

/** 선택된 도구를 통로/지점에 적용한다 */
function applyTool({ edge, node }) {
  if (edge?.elevator) return; // 엘리베이터는 화재 모드에서 항상 제외

  if (currentTool === 'temp') {
    const celsius = Number($('temp-value').value);
    const target = edge ? { edgeId: edge.id } : { nodeId: node.id };
    const sensorId = `SIM-${edge ? edge.id : node.id}`;
    api.reportTemperature({ sensorId, ...target, celsius }).catch(showError);
    return;
  }

  if (!edge) return;
  const req = currentTool === 'clear'
    ? api.clearHazard(edge.id)
    : api.setHazard(edge.id, currentTool);
  req.catch(showError);
}

function renderSensors(list) {
  const ul = $('sensor-list');
  if (!list?.length) {
    ul.innerHTML = '<li class="empty">판독값 없음</li>';
    return;
  }
  ul.innerHTML = [...list]
    .sort((a, b) => b.celsius - a.celsius)
    .map(s => {
      const where = s.edgeId ? `통로 ${s.edgeId}` : `지점 ${s.nodeId}`;
      const state = s.stale ? '⚠️ 판독 끊김'
        : s.celsius >= TEMP.BLOCK ? '🚫 통행 불가'
        : s.celsius >= TEMP.WARN ? '⚠️ 우회 권고' : '정상';
      return `<li>
        <strong style="color:${temperatureColor(s.celsius)}">${Math.round(s.celsius)}°C</strong>
        · ${where} — ${state}
        <div class="time">${s.sensorId} · ${time(s.ts)}</div>
      </li>`;
    }).join('');
}

function renderList(ul, items, fmt) {
  ul.innerHTML = items?.length
    ? items.map(i => `<li>${fmt(i)}</li>`).join('')
    : '<li class="empty">아직 없음</li>';
}

function time(ts) {
  return ts ? new Date(ts).toLocaleTimeString('ko-KR') : '';
}

function showError(err) {
  $('mode-badge').textContent = `오류: ${err.message}`;
  $('mode-badge').classList.add('offline');
}

main();
