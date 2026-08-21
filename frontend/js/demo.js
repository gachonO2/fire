/**
 * 통합 시연 화면 — 사용자·관제·보호자 세 화면을 한 페이지에서 함께 본다.
 *
 * 세 화면은 iframe으로 띄우되 같은 출처라 localStorage를 공유한다.
 * 그래서 사용자 앱이 쓰는 userId를 이 페이지가 먼저 확정하고, 그 사용자의
 * 보호자를 자동으로 준비한 뒤 보호자 화면을 그 코드로 열어준다.
 * 시연할 때 코드를 손으로 옮겨 적는 단계를 없애기 위한 것이다.
 *
 * 아래 이벤트 로그는 세 화면 사이에 실제로 오가는 신호를 보여준다 —
 * 화면만 봐서는 "관제 클릭 → 사용자 재탐색 → 보호자 알림"의 연결이 잘 안 보이기 때문.
 */

import { Api } from './api.js';
import { TEMP } from '../shared/hazard-rules.js';

const $ = id => document.getElementById(id);

const api = new Api();
const MAX_LOG = 60;

const prev = { hazards: null, sensors: null, phase: null, alerts: 0, sos: 0, metrics: 0 };

async function main() {
  const userId = ensureUserId();
  const guardian = await ensureGuardian(userId);

  // 사용자 앱은 localStorage의 userId를 그대로 쓴다 (위에서 확정해 둠)
  $('frame-user').src = 'index.html';

  if (guardian) {
    $('frame-guardian').src = `guardian.html?code=${guardian.code}`;
    $('guardian-code-badge').textContent = `보호자 코드 ${guardian.code}`;
  } else {
    $('guardian-code-badge').textContent = '보호자 연결 실패 — 백엔드 확인';
    $('guardian-code-badge').classList.add('offline');
    $('frame-guardian').src = 'guardian.html';
  }

  $('btn-reset').addEventListener('click', resetScenario);

  document.querySelectorAll('.demo-expand').forEach(btn => {
    btn.addEventListener('click', () => toggleExpand(btn.dataset.target));
  });

  api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '서버 연결 끊김';
    $('mode-badge').classList.toggle('offline', !online);
  });

  await api.loadFloorPlan();
  wireLog();
  await api.connect();
}

/** 사용자 앱과 같은 키를 쓴다 — iframe이 같은 출처라 그대로 공유된다 */
function ensureUserId() {
  let id = localStorage.getItem('fireguide:userId');
  if (!id) {
    id = 'user-' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('fireguide:userId', id);
  }
  return id;
}

/**
 * 이미 등록된 보호자가 있으면 그 코드를 쓰고, 없을 때만 시연용으로 만든다.
 * (사용자가 실제로 등록해 둔 보호자 이름·연락처를 덮어쓰지 않기 위해)
 */
async function ensureGuardian(userId) {
  try {
    return await api.getGuardian(userId);
  } catch (_) { /* 미등록 — 아래에서 생성 */ }

  try {
    return await api.registerGuardian({
      userId, name: '보호자 (시연)', contact: '010-0000-0000',
    });
  } catch (_) {
    return null;
  }
}

async function resetScenario() {
  try {
    await api.resetHazards();
    await api.resetSensors();
    log('시나리오를 초기화했습니다. (위험·온도 판독값 삭제)', 'info');
  } catch (err) {
    log(`초기화 실패: ${err.message}`, 'danger');
  }
}

/** 한 패널을 전체 폭으로 키웠다 줄인다 */
function toggleExpand(frameId) {
  const grid = document.querySelector('.demo-grid');
  const panel = $(frameId).closest('.demo-panel');
  const already = panel.classList.contains('expanded');
  grid.querySelectorAll('.demo-panel').forEach(p => p.classList.remove('expanded', 'hidden'));
  if (already) return;
  panel.classList.add('expanded');
  grid.querySelectorAll('.demo-panel').forEach(p => {
    if (p !== panel) p.classList.add('hidden');
  });
}

// ------------------------------------------------------------- 이벤트 로그
function wireLog() {
  api.on('hazards', hazards => {
    const now = summarizeHazards(hazards);
    if (prev.hazards === null) { prev.hazards = now; return; }
    if (now.key === prev.hazards.key) return;

    for (const line of diffHazards(prev.hazards.map, now.map)) log(line.text, line.kind);
    prev.hazards = now;
  });

  api.on('sensors', sensors => {
    for (const s of sensors) {
      const key = `${s.sensorId}:${Math.round(s.celsius)}`;
      if (prev.sensors?.has(key)) continue;
      const verdict = s.celsius >= TEMP.BLOCK ? '통행 불가'
        : s.celsius >= TEMP.WARN ? '우회 권고' : '정상';
      log(`🌡️ 온도 ${Math.round(s.celsius)}°C @ ${where(s)} — ${verdict}`,
        s.celsius >= TEMP.BLOCK ? 'danger' : s.celsius >= TEMP.WARN ? 'warn' : 'info');
    }
    prev.sensors = new Set(sensors.map(s => `${s.sensorId}:${Math.round(s.celsius)}`));
  });

  api.on('positions', list => {
    for (const p of list) {
      if (p.phase === prev.phase) continue;
      const label = {
        guiding: '🚶 사용자가 대피를 시작했습니다',
        arrived: '✅ 사용자가 대피를 완료했습니다',
        safehold: '🆘 사용자가 안전상태로 전환했습니다',
      }[p.phase];
      if (label) log(`${label} — ${p.nodeName ?? p.nodeId}`, p.phase === 'safehold' ? 'danger' : 'info');
      prev.phase = p.phase;
    }
  });

  api.on('metrics', list => {
    if (list.length <= prev.metrics) { prev.metrics = list.length; return; }
    prev.metrics = list.length;
    const m = list[0];
    if (!m) return;
    const kind = m.kind === 'reroute' ? '경로 재탐색' : '최초 경로 계산';
    log(`🧭 ${kind} ${m.ms}ms ${m.found ? '' : '— 경로 없음'}`, m.found ? 'info' : 'danger');
  });

  api.on('alerts', list => {
    if (list.length <= prev.alerts) { prev.alerts = list.length; return; }
    prev.alerts = list.length;
    if (list[0]) log(`👨‍👩‍👧 보호자 알림: ${list[0].message}`, 'warn');
  });

  api.on('sos', list => {
    if (list.length <= prev.sos) { prev.sos = list.length; return; }
    prev.sos = list.length;
    if (list[0]) log(`🆘 구조요청 전송: ${list[0].nodeName ?? ''} — ${list[0].reason}`, 'danger');
  });
}

function summarizeHazards(hazards) {
  const map = new Map(Object.entries(hazards).map(([id, h]) => [id, h.type]));
  return { map, key: [...map].sort().map(e => e.join(':')).join(',') };
}

function diffHazards(before, after) {
  const lines = [];
  for (const [id, type] of after) {
    if (before.get(id) === type) continue;
    lines.push({ text: `🔥 ${edgeLabel(id)} — ${typeLabel(type)}`, kind: 'danger' });
  }
  for (const [id] of before) {
    if (!after.has(id)) lines.push({ text: `✅ ${edgeLabel(id)} — 통행 재개`, kind: 'info' });
  }
  return lines;
}

function edgeLabel(edgeId) {
  const edge = api.floorPlan.getEdge(edgeId);
  if (!edge) return `통로 ${edgeId}`;
  const a = api.floorPlan.getNode(edge.a)?.name ?? edge.a;
  const b = api.floorPlan.getNode(edge.b)?.name ?? edge.b;
  return `${a} ↔ ${b}`;
}

function where(sensor) {
  if (sensor.edgeId) return edgeLabel(sensor.edgeId);
  return api.floorPlan.getNode(sensor.nodeId)?.name ?? sensor.nodeId;
}

function typeLabel(type) {
  return { fire: '화재', smoke: '연기', heat: '과열로 통행 불가', warm: '온도 상승', crowd: '혼잡', blocked: '차단' }[type] || type;
}

function log(text, kind = 'info') {
  const ul = $('event-log');
  ul.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  li.className = `log-${kind}`;

  // 문구에는 지점 이름·구조요청 사유가 섞여 들어온다 — 도면 판독이 만든 값이고
  // 위치 보고는 인증 없이 들어오므로, 마크업으로 해석되지 않게 텍스트로 넣는다.
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString('ko-KR');
  li.append(time, ` ${text}`);

  ul.prepend(li);
  while (ul.children.length > MAX_LOG) ul.lastChild.remove();
}

main();
