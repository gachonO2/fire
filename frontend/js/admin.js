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
import { renderMap, temperatureColor } from './minimap.js';
import { TEMP } from '../shared/hazard-rules.js';

const $ = id => document.getElementById(id);

const api = new Api();
let hazards = {};
let sensors = [];
let positions = [];
let currentTool = 'smoke';

async function main() {
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTool = btn.dataset.tool;
      document.querySelectorAll('.tool-btn[data-tool]').forEach(b =>
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
    $('mode-badge').classList.toggle('offline', !online);
  });

  api.on('plan', plan => {
    $('building-info').textContent =
      `${plan.name} · 노드 ${plan.nodes.length} · 통로 ${plan.edges.length}`;
    draw();
  });

  api.on('hazards', h => { hazards = h; draw(); });

  api.on('sensors', list => {
    sensors = list;
    renderSensors(list);
    draw();
  });

  api.on('sos', list => {
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
    renderList($('pos-list'), list, p => {
      const phase = { guiding: '대피 중', arrived: '대피 완료 ✅', safehold: '안전상태 🆘', idle: '대기' }[p.phase] || p.phase;
      return `<strong>${p.nodeName ?? p.nodeId}</strong> — ${phase}
        <div class="time">${p.userId} · 확신도 ${Math.round((p.confidence ?? 1) * 100)}% · ${time(p.ts)}</div>`;
    });
    draw();
  });

  api.on('metrics', list => {
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
    positions,
    onEdgeClick: edge => applyTool({ edge }),
    onNodeClick: node => { if (currentTool === 'temp') applyTool({ node }); },
  });
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
