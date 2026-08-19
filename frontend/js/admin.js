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
import { drawBeacons, drawFoundBeacons, setBeaconScale, startBeaconWaves } from './beacon-layer.js';
import { renderMap, temperatureColor } from './minimap.js';
import { WalkGrid, findPath } from '../shared/walk-grid.js';
import { TEMP } from '../shared/hazard-rules.js';
import { PHOTO_SCENARIO, isPhotoScenario } from '../shared/photo-scenario.js';

const $ = id => document.getElementById(id);

const api = new Api();
// 관제는 정리본 도면을 쓴다 — 원본 847KB 를 받아 둘 이유가 없다.
// (정리본이 없는 도면이면 `loadWalls` 가 그때 원본을 따로 받아 온다.)
api.skipPlanImage = true;
let hazards = {};
let foundBeacons = [];
let sensors = [];
let positions = [];
let live = null;
let currentTool = 'smoke';
let surveyedCount = 0;
/** 지금 도면에 없는 지점을 가리키는 경로를 보내는 사용자 — 폰이 옛 도면을 쓰는 중 */
let staleRoutes = new Set();
/** 사람이 답사한 지점 → 그 자리에서 잡힌 신호 개수 */
let surveyedSpots = new Map();
let metrics = [];

/**
 * 이 도면에 **진짜** 비콘이 있는가.
 *
 * 없으면 앱이 지점마다 `SIM-<지점>` 가상 비콘을 만들어 돌린다. 폰에서는
 * 그게 맞다 — 달기 전에 "달면 이렇게 된다"를 보여줘야 설치 여부를 정할 수
 * 있으니까. 하지만 **관제 지도에 그리면 안 된다.** 관제는 현장을 보는
 * 화면이고, 거기 찍힌 다이아몬드는 보는 사람에게 "저기 비콘이 있다"는
 * 뜻이 된다. 없는 설비를 있다고 그리는 것은 관제 화면이 할 수 있는
 * 가장 나쁜 거짓말이다.
 */
function hasRealBeacons() {
  const nodes = api.floorPlan?.nodes || [];
  return nodes.some(n => n.beaconId && !String(n.beaconId).startsWith('SIM'));
}
let selectedUser = null;
let query = '';

/**
 * 레일의 레이어 토글 상태.
 *
 * 체크박스였던 것을 아이콘 버튼으로 바꿨다 — 지도가 화면 전체를 쓰게 되면서
 * 글자 딸린 체크박스를 놓을 자리가 없어졌기 때문이다. 상태는 `aria-pressed`
 * 로 들고 있고(스크린리더가 읽을 수 있는 유일한 방식), 예전 체크박스가
 * 남아 있어도 그대로 동작하도록 둘 다 본다.
 */
function isOn(id, dflt = true) {
  const el = document.getElementById(id);
  if (!el) return dflt;
  if (el.hasAttribute('aria-pressed')) return el.getAttribute('aria-pressed') === 'true';
  return el.checked ?? dflt;
}

async function main() {
  document.querySelectorAll('.tool[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      currentTool = btn.dataset.tool;
      // **도구를 고르면 통로를 보여 준다.**
      //
      // 그래프를 기본으로 꺼 두었더니 화면에 방과 벽만 보였다. 그 상태에서
      // «통로를 클릭하세요» 라고 하면 누를 것이 안 보인다 — 사람은 방을
      // 누르고, 아무 일도 안 일어난다. 실제로 그렇게 막혔다.
      const graph = document.getElementById('show-graph');
      if (graph && !isOn('show-graph', false)) {
        graph.setAttribute('aria-pressed', 'true');
      }
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

  $('btn-photo-scenario').addEventListener('click', startPhotoScenario);
  $('btn-reset').addEventListener('click', resetScenario);
  $('btn-reset-sensors').addEventListener('click', () => api.resetSensors().catch(showError));

  api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '서버 연결 끊김';
    $('mode-badge').classList.toggle('off', !online);
  });

  live = new LiveTrack(document.getElementById('live-layer'), () => ({
    baseSvg: document.getElementById('admin-map'),
    floorPlan: api.floorPlan,
  }));
  setBeaconScale(0.4);
  live.setMarkerScale(0.5);
  live.start();

  ['show-beacons', 'show-waves', 'show-range', 'show-graph', 'show-corridor'].forEach(id => {
    const el = document.getElementById(id);
    el?.addEventListener('click', () => {
      el.setAttribute('aria-pressed', String(!isOn(id)));
      draw();
    });
    el?.addEventListener('change', draw);
  });
  // 파동 애니메이션은 **실물 비콘을 단 도면에서만** 쓴다. 답사로 알아낸 곳은
  // 정지한 표식으로 그린다 — 답사 지점은 «지금 울리고 있다» 가 아니라
  // «여기서 신호를 받아 뒀다» 라서, 움직이면 뜻이 달라진다.
  if (hasRealBeacons()) {
    startBeaconWaves(document.getElementById('beacon-waves'), () => ({
      baseSvg: document.getElementById('admin-map'),
      floorPlan: api.floorPlan,
      enabled: isOn('show-beacons') && isOn('show-waves'),
      near: positions.filter(p => Number.isFinite(p?.x)),
    }));
  }

  api.on('plan', plan => {
    $('building-info').textContent =
      `${plan.name} · 지점 ${plan.nodes.length} · 통로 ${plan.edges.length}`;
    // 상단 컨텍스트와 바닥 상태줄에는 층만 — 이름 전체는 위에 이미 있다
    const floor = (plan.name.match(/(\d+\s*층)/) || [])[1] || plan.name;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ctx-floor', floor);
    set('stat-floor', floor);
    loadWalls(plan.id);
    draw();
  });

  api.on('hazards', h => {
    hazards = h;
    syncPhotoScenarioButton();
    draw();
    renderSummary();
  });

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
    syncPhotoScenarioButton();
    live?.update(livePositions());
    // draw() 안에서 drawRoutes() 가 돌며 «도면 불일치» 판정을 낸다.
    // 목록·상세가 그 판정을 쓰므로 먼저 그려야 한 박자 늦지 않는다.
    draw();
    renderPeople();
    renderDetail();
  });

  api.on('metrics', list => {
    metrics = list;
    renderSummary();
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

  wireChrome();

  $('temp-legend').textContent = `주의 ${TEMP.WARN}°C 이상 · 통행불가 ${TEMP.BLOCK}°C 이상`;

  await refreshSurvey();
  // 답사는 사람이 걸어 다니며 늘린다 — 관제는 그게 쌓이는 것을 보고 있어야 한다
  setInterval(refreshSurvey, 4000);
  // 시나리오 위치가 «45초 전 마지막 관측»으로 바뀌지 않도록 관제가 열려 있는
  // 동안만 새 시각을 보낸다. 실제 앱의 주기 위치 보고와 같은 역할이다.
  setInterval(keepPhotoScenarioAlive, 15_000);
  // 소식이 끊기는 것은 «시간이 지나서» 생기는 변화다. 새 값이 안 와도
  // 화면은 스스로 늙어야 한다.
  setInterval(() => { updateStats(); renderPeople(); renderSummary(); drawPicks(); }, 5000);

  await api.loadFloorPlan();
  draw();
  await api.connect();
}

function draw() {
  renderMap($('admin-map'), {
    floorPlan: api.floorPlan,
    backgroundImage: cleanFloorUrl || api.backgroundImage,
    // 이미 받아 둔 벽을 넘긴다 — 통로가 벽을 덜 뚫도록 꺾는 방향을 고르는 데 쓴다
    walls: wallData?.walls || null,
    walkGrid,
    hazards,
    sensors,
    positions: [],   // 점은 live-track 레이어가 부드럽게 그린다
    onEdgeClick: edge => applyTool({ edge }),
    onNodeClick: node => { if (currentTool === 'temp') applyTool({ node }); },
    // 통로도 지점도 아닌 곳을 눌렀을 때 — 가까운 통로로 받는다
    onBlankClick: (x, y) => {
      const e = nearestEdgeTo(x, y);
      if (e) applyTool({ edge: e });
    },
    // 화면 전체를 쓰는 관제용 값.
    //
    // 이름표는 절반 이하로 줄인다 — 43개가 원래 크기로는 서로 덮어쓴다.
    // 사진은 **진하게** 깐다. 도면 사진이 곧 벽과 방이고, 통로 그래프는 그
    // 위에 얹는 주석이다. 사진을 옅게 깔면 관제가 «어느 방 앞인가»를 못 읽는다.
    // (사진은 CSS 에서 명도를 뒤집어 흰 종이에 검은 선으로 바꿔 쓴다.)
    labelScale: 0.6,
    imageOpacity: 1,
    // 도면 사진에 «OFFICE», «STUDIO», «THE LOUNGE» 가 이미 인쇄돼 있다.
    // 그 위에 같은 이름을 또 얹으면 둘 다 못 읽는다. 사진에 없는 것 —
    // 어디가 비상구인가 — 만 짚는다.
    nodeLabels: 'exits',
    // 그래프는 기본으로 끈다. 방과 벽이 이미 공간을 보여 주므로, 관제 화면에
    // 남길 것은 **상태가 있는 것**뿐이다 — 불난 통로, 대피 경로, 출구, 사람.
    showGraph: isOn('show-graph', false),
  });

  // 비콘 — 실물이 있을 때만 그린다.
  //
  // 자동 추정치(`foundBeacons`)도 안 그린다. 전파는 진짜로 받은 것이지만,
  // 거기 붙인 좌표는 **가짜 출발점에서 밀어낸 걸음 추정치**라 위치가 틀렸다.
  // 틀린 좌표의 비콘을 지도에 찍으면 그 다음부터 아무도 지도를 못 믿는다.
  // 사람이 그 자리에 서서 태그한 것만 그린다.
  if (api.floorPlan && isOn('show-beacons') && hasRealBeacons()) {
    drawBeacons(document.getElementById('admin-map'), api.floorPlan, {
      showRange: isOn('show-range', false),
    });
  }
  drawSurvey();
  updateStats();
  updateBeaconChrome();
  drawRooms();
  drawRoutes();
  drawPhotoScenario();
  drawPicks();
  drawWalls();
  drawSigns();
  drawCorridor();
  applyFootprint();
  requestAnimationFrame(fitStage);
}

/** 상단 숫자 네 개 — 시연에서 상황이 한눈에 읽혀야 하는 줄 */
function updateStats() {
  const blocked = Object.keys(hazards || {}).length;
  const alive = livePositions();
  const walking = alive.filter(p => p.phase === 'guiding').length;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('stat-people', walking);
  set('stat-hazards', blocked);
  set('stat-sos', (window.__sosCount ?? 0));
  set('n-people', alive.length);
  set('n-sos', (window.__sosCount ?? 0));
  set('n-sensors', (sensors || []).length);
}

/** 선택된 도구를 통로/지점에 적용한다 */
/**
 * 도면 아무 데나 눌렀을 때 **가장 가까운 통로**를 찾는다.
 *
 * 통로는 선이라 정확히 그 위를 눌러야 하는데, 기울여 놓은 판에서 몇 픽셀짜리
 * 선을 겨누는 것은 어렵다. 방 한가운데를 눌러도 «이 방 앞 통로» 를 뜻한 것이
 * 분명하므로, 그렇게 받아 준다.
 */
function nearestEdgeTo(x, y) {
  const plan = api.floorPlan;
  if (!plan?.edges?.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const e of plan.edges) {
    const a = plan.getNode?.(e.a) ?? plan.nodes.find(n => n.id === e.a);
    const b = plan.getNode?.(e.b) ?? plan.nodes.find(n => n.id === e.b);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L)) : 0;
    const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

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

function photoScenarioPosition() {
  return positions.find(p => p.userId === PHOTO_SCENARIO.userId) || null;
}

function isPhotoScenarioActive() {
  return isPhotoScenario(api.floorPlan?.id, hazards)
    && Boolean(photoScenarioPosition());
}

function photoScenarioPayload() {
  const [x, y] = PHOTO_SCENARIO.current;
  return {
    nodeId: 'J_NS4',
    nodeName: 'FR 앞 · 현재 위치',
    phase: 'guiding',
    x, y,
    edgeId: 'e9',
    progress: 0.37,
    confidence: 1,
    source: 'beacon',
    exitName: '비상구 (CREATIVE WORKSPACE 옆)',
    stepsLeft: PHOTO_SCENARIO.totalSteps,
    routeNodes: ['J_NS4', 'EXIT_CW'],
    routeEdges: ['e7'],
  };
}

async function startPhotoScenario() {
  const btn = $('btn-photo-scenario');
  btn.disabled = true;
  btn.textContent = '시나리오 구성 중…';
  try {
    if (api.floorPlan?.id !== PHOTO_SCENARIO.planId) {
      await api.activatePlan(PHOTO_SCENARIO.planId);
      await api.loadFloorPlan();
      await loadWalls(PHOTO_SCENARIO.planId);
    }
    // 사용자가 요청한 시나리오 하나만 남긴다. 이전 앱 위치를 남기면 관제에
    // 다른 파란 경로가 다시 생기므로 위험과 위치를 함께 비우고 시작한다.
    await Promise.all([api.resetHazards(), api.clearPositions()]);
    await api.setHazard(PHOTO_SCENARIO.fireEdgeId, 'fire', {
      label: PHOTO_SCENARIO.fireLabel,
    });
    await api.setDemoStand(PHOTO_SCENARIO.startNodeId);
    await api.setPosition(PHOTO_SCENARIO.userId, photoScenarioPayload());
    selectedUser = PHOTO_SCENARIO.userId;
    syncPhotoScenarioButton();
    draw();
    renderPeople();
    renderDetail();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '사진 시나리오 실행';
  }
}

async function resetScenario() {
  const btn = $('btn-reset');
  btn.disabled = true;
  try {
    await Promise.all([
      api.resetHazards(),
      api.removePosition(PHOTO_SCENARIO.userId),
      api.setDemoStand(null),
    ]);
    if (selectedUser === PHOTO_SCENARIO.userId) selectedUser = null;
    syncPhotoScenarioButton();
    draw();
    renderPeople();
    renderDetail();
  } catch (err) {
    showError(err);
  } finally {
    btn.disabled = false;
  }
}

function keepPhotoScenarioAlive() {
  if (!isPhotoScenarioActive()) return;
  api.setPosition(PHOTO_SCENARIO.userId, photoScenarioPayload()).catch(() => {});
}

function syncPhotoScenarioButton() {
  $('btn-photo-scenario')?.setAttribute('aria-pressed', String(isPhotoScenarioActive()));
}

const PHASE = {
  guiding:  { label: '대피 중',   cls: 'accent' },
  arrived:  { label: '대피 완료', cls: 'on' },
  safehold: { label: '안전 대기', cls: 'bad' },
  idle:     { label: '대기',      cls: '' },
  // 답사자 — 대피가 아니라 «전파가 잡히나» 보려고 걷는 사람이다.
  // 지도에는 대피자와 같이 파란 점으로 뜨지만(전파 확정이라는 값어치는 같다),
  // 목록과 «대피 중» 숫자에서는 갈라야 시연 중에 사람 수가 부풀지 않는다.
  survey:   { label: '답사 중',   cls: '' },
};

/**
 * 소식이 끊긴 지 이만큼 지나면 «지금 거기 있다» 고 말하지 않는다.
 *
 * 관제 화면에서 제일 위험한 거짓말이 이것이다 — 20분 전에 떠난 사람을 지금
 * 그 자리에 있는 것처럼 그리면, 구조대가 빈 방을 뒤진다. 폰이 꺼졌는지 그냥
 * 서 있는지는 알 수 없지만, **모른다는 사실은 화면에 나와야 한다.**
 */
const STALE_MS = 45_000;      // 이후로는 «소식 없음» 으로 적는다
const GONE_MS = 5 * 60_000;   // 이후로는 지도와 숫자에서 내린다

const ageOf = p => Date.now() - (p.ts ?? 0);
const isStale = p => ageOf(p) > STALE_MS;

/** 지도와 숫자에 쓰는 «지금 있는 사람» */
function livePositions() {
  const alive = positions.filter(p => ageOf(p) < GONE_MS);
  // 사진 시나리오는 한 사람의 한 경로를 검증하는 화면이다. 연결돼 있던 앱의
  // 옛 경로까지 함께 그리면 파란 선이 여러 개가 되어 어느 길이 답인지 사라진다.
  return isPhotoScenarioActive()
    ? alive.filter(p => p.userId === PHOTO_SCENARIO.userId)
    : alive;
}

const SOURCE = {
  beacon:    '비콘 확정',
  pdr:       '걸음 추정',
  simulated: '가상 비콘',
  server:    '관제 지정',
  manual:    '수동 지정',
};

/** 검색어에 걸리는가 — 사용자 id 와 지점 이름 둘 다 본다 */
function hits(p) {
  if (!query) return true;
  return `${p.userId} ${p.nodeName ?? ''} ${p.nodeId ?? ''}`.toLowerCase().includes(query);
}

/**
 * 대피 인원 목록. 항목을 누르면 오른쪽 상세가 열린다.
 *
 * 목록은 훑는 곳이고 상세는 파는 곳이다. 예전에는 한 줄에 지점·상태·확신도·
 * 시각을 전부 욱여넣어서 스무 명이 되면 아무것도 안 읽혔다. 줄에는 누가
 * 어디 있나만 남기고 나머지는 눌렀을 때 보여 준다.
 */
function renderPeople() {
  const ul = $('pos-list');
  if (!ul) return;
  // 지도에서 내린 사람은 목록에서도 내린다. 남겨 두면 «소식 없음» 줄이
  // 쌓여서, 정작 지금 걷고 있는 사람이 그 아래로 밀린다.
  const shown = livePositions().filter(hits);
  if (!shown.length) {
    ul.innerHTML = `<li class="empty">${query ? '검색 결과 없음' : '아직 없음'}</li>`;
    return;
  }
  ul.innerHTML = shown.map(p => {
    const ph = PHASE[p.phase] || { label: p.phase, cls: '' };
    return `<li data-user="${p.userId}" aria-current="${p.userId === selectedUser}">
      <span class="who">${p.nodeName ?? p.nodeId}</span>
      <span class="sub">${
        isStale(p) ? `소식 없음 ${Math.round(ageOf(p) / 60000)}분`
        : staleRoutes.has(p.userId) ? '⚠ 도면 불일치' : ph.label}</span>
    </li>`;
  }).join('');
  ul.querySelectorAll('[data-user]').forEach(li =>
    li.addEventListener('click', () => selectUser(li.dataset.user)));
}

function selectUser(userId) {
  selectedUser = selectedUser === userId ? null : userId;
  drawRoutes();
  renderPeople();
  renderDetail();
  drawPicks();
}

/**
 * 오른쪽 상세 패널.
 *
 * 관제가 한 사람에 대해 실제로 묻는 것은 넷이다 — **어디 있나, 그 값을
 * 믿어도 되나, 어디로 가고 있나, 얼마나 남았나.** 그 순서로 놓는다.
 * 특히 「믿어도 되나」는 숫자 하나(확신도)로는 부족해서 측위 방식을 나란히
 * 둔다. 걸음 추정 80%와 비콘 확정 80%는 전혀 다른 값이다.
 */
/**
 * 상황 요약 — **사람을 고르기 전에** 관제가 알아야 하는 것.
 *
 * 카드를 다섯 장 쌓아 봤는데 난잡했다. 관제가 급할 때 훑는 화면은 «전부»가
 * 아니라 **다음 판단에 필요한 것**만 있어야 한다. 그래서 셋으로 줄였다:
 *
 *   무슨 일인가        정상 / 화재 발생 — 제일 큰 글씨
 *   사람은 어떤가      대피·구조·막힘 숫자 셋
 *   무엇이 이루어졌나  자동으로 처리된 조치와, 사람이 눌러야 하는 것
 *
 * 답사 진척과 재탐색 성능은 아래 한 줄로 접었다 — 시연에서 필요한 값이지만
 * 불이 났을 때 관제가 보는 값은 아니다.
 */
function renderSummary() {
  const box = document.getElementById('summary');
  if (!box || selectedUser) return;

  const alive = livePositions();
  const guiding = alive.filter(p => p.phase === 'guiding').length;
  const held = alive.filter(p => p.phase === 'safehold').length;
  const survey = alive.filter(p => p.phase === 'survey').length;
  const byBeacon = alive.filter(p => p.source === 'beacon' && !isStale(p)).length;
  const blocked = Object.entries(hazards || {});
  const fires = blocked.filter(([, h]) => h?.type === 'fire').length;

  const recent = metrics.slice(-24);
  const worst = recent.length ? Math.max(...recent.map(m => m.ms)) : 0;
  const over = recent.filter(m => m.ms > 2000).length;
  const spots = surveyedSpots.size;
  const thin = [...surveyedSpots.values()].filter(n => n <= 2).length;

  const alarm = blocked.length > 0;
  const when = blocked.length
    ? time(Math.max(...blocked.map(([, h]) => h?.updatedAt || 0)))
    : null;

  // 조치 — **이미 자동으로 된 것**과 **사람이 해야 할 것**을 갈라 적는다.
  // 다 «할 일» 처럼 적으면 관제가 이미 끝난 일을 또 하려 한다.
  const steps = alarm ? [
    { n: '01', t: '경로 재탐색', done: true,
      d: `막힌 통로를 빼고 모든 앱이 다시 계산했습니다 (최대 ${Math.round(worst)}ms)` },
    { n: '02', t: '대피자 위치 추적', done: guiding + survey > 0,
      d: guiding + survey > 0
        ? `${guiding + survey}명 추적 중 · ${byBeacon}명 전파로 확정`
        : '추적 중인 사람이 없습니다' },
    { n: '03', t: '우선 구조 지정', done: false, manual: held > 0,
      d: held > 0 ? `${held}명이 안내를 멈췄습니다 — 목록에서 지정하세요`
                  : '구조 요청 없음' },
  ] : [];

  const spotList = [...surveyedSpots].sort((x, y) => y[1] - x[1]).slice(0, 5);
  const maxSpot = spotList.length ? spotList[0][1] : 1;
  const total = alive.length;
  const arrivedN = alive.filter(p => p.phase === 'arrived').length;

  // 구성비 띠 — 숫자 넷을 나란히 적는 것보다 «비율» 이 먼저 읽힌다
  const segs = [
    { n: guiding, c: 'var(--accent)' },
    { n: arrivedN, c: 'var(--ok)' },
    { n: held, c: 'var(--danger)' },
    { n: survey, c: 'var(--muted)' },
  ].filter(x => x.n > 0);
  const segBar = segs.length
    ? segs.map(x => `<i style="--c:${x.c};--f:${x.n}"></i>`).join('')
    : '<i class="empty" style="--f:1"></i>';

  box.innerHTML = `
    <div class="headline ${alarm ? 'alarm' : ''}">
      <b>${alarm ? (fires ? '화재 발생' : '통로 차단') : '정상'}</b>
      <span>${alarm ? `발생 ${when} · ${blocked.length}곳 차단` : '막힌 통로 없음'}</span>
    </div>

    <div class="card">
      <span class="cap">건물 안 인원</span>
      <div class="big">
        <b>${total}</b><small>명</small>
        ${guiding ? `<span class="chip">${guiding} 대피 중</span>` : ''}
        ${held ? `<span class="chip bad">${held} 구조</span>` : ''}
      </div>
      <div class="seg">${segBar}</div>
      <div class="cells">
        <div>
          <span class="cap">대피 중</span>
          <b>${guiding}</b><em>안내를 따라 이동</em>
        </div>
        <div>
          <span class="cap" style="--c:var(--ok)">대피 완료</span>
          <b class="${arrivedN ? 'ok' : ''}">${arrivedN}</b><em>출구 도착</em>
        </div>
        <div>
          <span class="cap" style="--c:var(--danger)">구조 필요</span>
          <b class="${held ? 'bad' : ''}">${held}</b><em>안내를 멈춤</em>
        </div>
        <div>
          <span class="cap" style="--c:var(--ok)">전파로 확정</span>
          <b class="${byBeacon ? 'ok' : ''}">${byBeacon}<small style="font-size:13px;color:var(--faint)">/${total}</small></b>
          <em>${total ? '나머지는 걸음 추정' : '추적 중인 사람 없음'}</em>
        </div>
      </div>
    </div>

    ${alarm ? `<div class="card">
      <span class="cap" style="--c:var(--danger)">대응</span>
      <ol class="steps">${steps.map(x => `
        <li class="${x.done ? 'done' : x.manual ? 'manual' : ''}">
          <span class="no">${x.n}</span>
          <div><b>${x.t}</b><p>${x.d}</p></div>
        </li>`).join('')}</ol>
      <button class="btn" id="act-clear">전부 해제</button>
    </div>` : `<div class="card">
      <span class="cap">시나리오</span>
      <p class="none">왼쪽 도구에서 <b style="color:var(--ink)">화재</b>를 고르고 통로를 클릭하면
      상황이 시작됩니다. 모든 앱이 즉시 경로를 다시 계산합니다.</p>
    </div>`}

    <div class="card">
      <span class="cap" style="--c:var(--route)">경로 재탐색</span>
      <div class="big">
        <b>${recent.length ? Math.round(worst) : '—'}</b><small>ms 최대</small>
        ${recent.length ? `<span class="chip ${over ? 'warn' : ''}">${recent.length - over}/${recent.length} 2초 내</span>` : ''}
      </div>
      ${recent.length ? areaChart(recent.map(m => m.ms), 2000)
        : '<p class="none">아직 계산 기록이 없습니다</p>'}
    </div>

    <div class="card">
      <span class="cap" style="--c:var(--ok)">답사 두께</span>
      <div class="big">
        <b>${spots}</b><small>지점</small>
        ${thin ? `<span class="chip warn">${thin}곳 얇음</span>`
                : spots ? '<span class="chip">고르게 쌓임</span>' : ''}
      </div>
      ${spotList.length ? `<div class="bars2">${spotList.map(([id, n]) => {
        const node = api.floorPlan?.nodes?.find(x => x.id === id);
        return `<div class="row${n <= 2 ? ' thin' : ''}">
          <span class="nm">${node?.name ?? id}</span><span class="vl">${n}</span>
          <span class="tr"><i style="width:${Math.round(n / maxSpot * 100)}%"></i></span>
        </div>`;
      }).join('')}</div>` : '<p class="none">아직 답사한 지점이 없습니다</p>'}
    </div>`;

  box.querySelector('#act-clear')?.addEventListener('click', () => {
    // 사진 시나리오는 위험뿐 아니라 가상 대피자도 한 묶음이다.
    // «전부 해제»가 불만 끄고 사람을 남기면 지도에 유령 위치가 생긴다.
    if (isPhotoScenarioActive()) resetScenario();
    else api.resetHazards().catch(showError);
  });
}

/**
 * 면적 그래프 — 추이는 선보다 면이 먼저 읽힌다.
 *
 * 값이 문턱(2초)보다 한참 아래일 때는 선이 바닥에 붙어 «아무 일도 없다» 로
 * 보인다. 면으로 채우면 «바닥에 깔려 있다» 가 되고, 그게 우리가 말하려는
 * 것이다 — 재탐색이 문턱 근처에도 못 간다는 것.
 */
function areaChart(values, limit) {
  if (!values.length) return '';
  const w = 300, h = 62, pad = 4;
  const hi = Math.max(limit, ...values) * 1.15;
  const x = i => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
  const y = v => h - pad - (v / hi) * (h - pad * 2);
  const line = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const fill = `${pad},${h - pad} ${line} ${x(values.length - 1).toFixed(1)},${h - pad}`;
  const yl = y(limit).toFixed(1);
  return `<svg class="area" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="var(--route)" stop-opacity=".38"/>
      <stop offset="1" stop-color="var(--route)" stop-opacity="0"/>
    </linearGradient></defs>
    <line x1="0" x2="${w}" y1="${yl}" y2="${yl}" stroke="var(--warn)" stroke-width="1"
      stroke-dasharray="4 4" opacity=".55"/>
    <polygon points="${fill}" fill="url(#ag)"/>
    <polyline points="${line}" fill="none" stroke="var(--route)" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2.8"
      fill="var(--route)"/>
  </svg>`;
}

/** 값들을 작은 꺾은선으로. `limit` 을 넘는 구간은 경고색으로 칠한다. */
function sparkline(values, limit) {
  if (!values.length) return '';
  const w = 260, h = 44, pad = 3;
  const hi = Math.max(limit * 1.2, ...values);
  const x = i => pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
  const y = v => h - pad - (v / hi) * (h - pad * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const yLimit = y(limit).toFixed(1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="${w}" y1="${yLimit}" y2="${yLimit}" stroke="var(--warn)"
      stroke-width="1" stroke-dasharray="3 3" opacity=".7"/>
    <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.8"
      stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2.6"
      fill="var(--accent)"/>
  </svg>`;
}

function renderDetail() {
  const box = $('detail-body');
  const empty = $('detail-empty');
  if (!box || !empty) return;

  const body = document.querySelector('.ops-body');
  const p = positions.find(x => x.userId === selectedUser);
  if (!p) {
    box.hidden = true;
    empty.hidden = false;
    renderSummary();
    body?.setAttribute('data-panel', 'idle');
    return;
  }
  empty.hidden = true;
  box.hidden = false;
  // 패널은 지도 위에 뜨므로 열리면 도면 오른쪽을 가린다. 캔버스를 그만큼
  // 안쪽으로 밀어 **도면 전체가 계속 보이게** 한다.
  body?.setAttribute('data-panel', 'open');

  const ph = PHASE[p.phase] || { label: p.phase, cls: '' };
  const conf = Math.round((p.confidence ?? 0) * 100);
  const confCls = conf >= 70 ? 'on' : conf >= 45 ? 'warn' : 'bad';
  const src = SOURCE[p.source] || p.source || '알 수 없음';
  const total = (p.routeNodes || []).length;
  const left = p.stepsLeft ?? 0;
  const done = total > 1 ? Math.max(0, Math.min(1, (total - left) / total)) : 0;

  box.innerHTML = `
    <div class="panel-head">
      <div class="panel-title">
        <h2>${p.userId}</h2>
        <button class="close" id="detail-close" aria-label="닫기">✕</button>
      </div>
      <div class="panel-pills">
        <span class="pill ${ph.cls}"><i></i>${ph.label}</span>
        <span class="pill ${p.source === 'beacon' ? 'accent' : 'warn'}">${src}</span>
        <span class="pill ${confCls}">확신도 ${conf}%</span>
        ${staleRoutes.has(p.userId)
          ? '<span class="pill bad" title="폰이 캐시한 옛 도면으로 경로를 계산했습니다. 앱을 다시 불러오면 맞춰집니다.">도면 불일치</span>'
          : ''}
      </div>
    </div>

    <div class="panel-body">
      <div class="acts">
        <button class="solid" data-act="locate"><span>◎</span>지도에서</button>
        <button data-act="priority"><span>★</span>우선 구조</button>
        <button data-act="reroute"><span>↻</span>재탐색</button>
        <button data-act="call"><span>☎</span>호출</button>
      </div>

      <div class="triplet">
        <div><b>${conf}%</b><span>확신도</span></div>
        <div><b>${src}</b><span>측위 방식</span></div>
        <div><b>${left}</b><span>남은 걸음</span></div>
      </div>

      <div class="sub-card">
        <header>현재 위치</header>
        <div class="kv">
          <div><span class="k">지점</span><span class="v">${p.nodeName ?? p.nodeId ?? '—'}</span></div>
          <div><span class="k">지점 id</span><span class="v">${p.nodeId ?? '—'}</span></div>
          <div><span class="k">통로</span><span class="v">${p.edgeId ?? '—'}${
            Number.isFinite(p.progress) ? ` · ${Math.round(p.progress * 100)}%` : ''}</span></div>
          <div><span class="k">좌표</span><span class="v">${
            Number.isFinite(p.x) ? `${p.x.toFixed(0)}, ${p.y.toFixed(0)}` : '—'}</span></div>
          <div><span class="k">갱신</span><span class="v">${time(p.ts)}</span></div>
        </div>
      </div>

      <div class="route-card">
        <span class="lbl">대피 경로</span>
        <div class="route-ends" style="margin-top:7px">
          <b>${p.nodeName ?? p.nodeId ?? '현재'}</b>
          <b>${p.exitName ?? '출구'}</b>
        </div>
        <div class="route-bar">
          <i style="width:${(done * 100).toFixed(0)}%"></i>
          <u style="left:${(done * 100).toFixed(0)}%"></u>
        </div>
        <div class="route-ends">
          <span style="color:var(--faint)">경유 ${total}지점</span>
          <span style="color:var(--faint)">남은 ${left}걸음</span>
        </div>
      </div>
    </div>`;

  box.querySelector('#detail-close')?.addEventListener('click', () => selectUser(selectedUser));
  box.querySelector('[data-act="locate"]')?.addEventListener('click', () => {
    document.getElementById('map-stack')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  box.querySelector('[data-act="reroute"]')?.addEventListener('click', () =>
    api.reroute?.(p.userId).catch(showError));
}

/**
 * 대피 경로를 칠한다.
 *
 * 관제가 지도를 보는 이유의 절반은 «이 사람이 어디로 나가는가» 다. 점만
 * 찍혀 있으면 그건 위치일 뿐이고, 위험구역을 새로 막았을 때 **경로가
 * 실제로 바뀌었는지**를 눈으로 확인할 방법이 없다. 선을 칠해야 그게 보인다.
 *
 * 두 겹으로 그린다 — 모두의 경로는 옅게, 고른 사람의 경로는 진하게.
 * 스무 명이 전부 진하면 지도가 실뭉치가 되고, 전부 옅으면 지금 보고 있는
 * 사람의 경로를 못 짚는다.
 *
 * 출발점은 **지금 서 있는 좌표**다. `routeNodes[0]` 부터 그리면 방금 지나온
 * 통로까지 앞으로 갈 길인 것처럼 칠해진다.
 */
function drawRoutes() {
  const svg = document.getElementById('route-layer');
  const base = document.getElementById('admin-map');
  if (!svg || !base) return;
  const vb = base.getAttribute('viewBox');
  if (!vb) { svg.innerHTML = ''; return; }
  svg.setAttribute('viewBox', vb);

  const plan = api.floorPlan;
  const u = Number(vb.split(/\s+/)[2]) / 400;
  const parts = [];
  const stale = new Set();

  for (const p of livePositions()) {
    if (p.phase !== 'guiding' || !p.routeNodes?.length) continue;
    // 이 한 시나리오는 사용자가 사진에 직접 그린 선을 그대로 보여 준다.
    // 아래의 일반 경로 계산까지 겹치면 서로 다른 파란 선 두 개가 생긴다.
    if (p.userId === PHOTO_SCENARIO.userId && isPhotoScenarioActive()) continue;

    const resolved = p.routeNodes
      .map(id => plan?.getNode?.(id) || plan?.nodes?.find(n => n.id === id));
    if (resolved.some(n => !n || !Number.isFinite(n.x))) { stale.add(p.userId); continue; }
    const nodes = resolved;

    let from = nodes.findIndex(n => n.id === p.nodeId);
    if (from < 0 && Number.isFinite(p.x)) {
      let best = Infinity;
      nodes.forEach((n, i) => {
        const d = Math.hypot(n.x - p.x, n.y - p.y);
        if (d < best) { best = d; from = i; }
      });
    }
    const way = nodes.slice(Math.max(0, from));
    const anchors = way.map(n => [n.x, n.y]);
    if (Number.isFinite(p.x)) anchors.unshift([p.x, p.y]);
    if (anchors.length < 2) continue;

    // **복도를 따라 잇는다.**
    //
    // 지점끼리 곧게 이으면 벽을 뚫는다 — 이 도면에서 45개 중 35개가 그랬다.
    // 도면에서 뽑은 «걸을 수 있는 칸» 위에서 길을 찾으면 복도를 돌아 나간다.
    // 격자가 없는 도면(아직 벽을 안 뽑은 것)에서는 곧은 선으로 물러선다.
    const pts = [];
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = { x: anchors[i][0], y: anchors[i][1] };
      const b = { x: anchors[i + 1][0], y: anchors[i + 1][1] };
      const leg = walkGrid?.ok ? findPath(walkGrid, a, b) : null;
      const part = leg || [[a.x, a.y], [b.x, b.y]];
      for (const q of part) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(last[0] - q[0], last[1] - q[1]) > 0.5) pts.push(q);
      }
    }
    if (pts.length < 2) continue;

    const on = p.userId === selectedUser;
    const d = pts.map(([x, y]) => `${x},${y}`).join(' ');
    const dim = on ? 1 : 0.45;

    // **경로는 흘러야 한다.**
    //
    // 얇은 한 줄로 그렸더니 어두운 판 위에서 «선이 하나 있다» 정도로만 보였고,
    // 무엇보다 **어느 쪽으로 가는지**를 담지 못했다. 대피 경로에서 방향은
    // 부수적인 정보가 아니라 본체다.
    //
    // 그래서 세 겹으로 그린다:
    //   번짐   어두운 바닥에서 선이 뜨게 한다
    //   본선   길 자체
    //   흐름   출구 쪽으로 움직이는 파선 — 방향을 시간으로 말한다
    const w2 = u * (on ? 3.4 : 2.2);
    parts.push(`<polyline points="${d}" fill="none" stroke="var(--route)"
      stroke-width="${w2 * 3}" opacity="${dim * 0.18}"
      stroke-linejoin="round" stroke-linecap="round"/>`);
    parts.push(`<polyline points="${d}" fill="none" stroke="var(--route)"
      stroke-width="${w2}" stroke-linejoin="round" stroke-linecap="round"
      opacity="${dim}"/>`);
    parts.push(`<polyline points="${d}" fill="none" stroke="#dff0ff"
      stroke-width="${w2 * 0.5}" stroke-linecap="round" opacity="${dim * 0.95}"
      stroke-dasharray="${u * 5} ${u * 9}">
      <animate attributeName="stroke-dashoffset" from="${u * 14}" to="0"
        dur="1.1s" repeatCount="indefinite"/>
    </polyline>`);

    // 꺾이는 곳에 점 — 경로가 «어디서 돌아야 하나» 를 담고 있다는 표시
    for (let i = 1; i < pts.length - 1; i++) {
      parts.push(`<circle cx="${pts[i][0]}" cy="${pts[i][1]}" r="${u * 2.4}"
        fill="var(--slab)" stroke="var(--route)" stroke-width="${u * 1.2}" opacity="${dim}"/>`);
    }

    // 출발 — 지금 서 있는 자리. 맥동으로 «여기» 를 말한다.
    parts.push(`<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="${u * 3.4}"
      fill="var(--route)" opacity="${dim}">
      <animate attributeName="r" values="${u * 3.4};${u * 5.2};${u * 3.4}"
        dur="1.8s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="${dim};${dim * 0.35};${dim}"
        dur="1.8s" repeatCount="indefinite"/>
    </circle>`);

    // 도착 — 어느 출구로 나가는가가 경로의 결론이다. 퍼지는 고리로 «여기로».
    const last = pts[pts.length - 1];
    parts.push(`<circle cx="${last[0]}" cy="${last[1]}" r="${u * 6}"
      fill="none" stroke="var(--ok)" stroke-width="${u * 2}" opacity="${dim}">
      <animate attributeName="r" values="${u * 5};${u * 10};${u * 5}"
        dur="2.2s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="${dim};0;${dim}"
        dur="2.2s" repeatCount="indefinite"/>
    </circle>`);
    parts.push(`<circle cx="${last[0]}" cy="${last[1]}" r="${u * 5.5}"
      fill="none" stroke="var(--ok)" stroke-width="${u * 1.6}" opacity="${dim * 0.8}"/>`);
    parts.push(`<circle cx="${last[0]}" cy="${last[1]}" r="${u * 2.2}"
      fill="var(--ok)" opacity="${dim}"/>`);
  }
  svg.innerHTML = parts.join('');
  staleRoutes = stale;
}

/** 사진에 표시된 화재·현재 위치·탈출선을 도면 좌표로 정확히 재현한다. */
function drawPhotoScenario() {
  const svg = document.getElementById('photo-scenario-layer');
  const base = document.getElementById('admin-map');
  if (!svg || !base) return;
  const vb = base.getAttribute('viewBox');
  if (!vb || !isPhotoScenarioActive()) { svg.innerHTML = ''; return; }
  svg.setAttribute('viewBox', vb);

  const width = Number(vb.split(/\s+/)[2]);
  const u = width / 400;
  const route = PHOTO_SCENARIO.route.map(([x, y]) => `${x},${y}`).join(' ');
  const [fx, fy] = PHOTO_SCENARIO.fire;
  const [cx, cy] = PHOTO_SCENARIO.current;
  const end = PHOTO_SCENARIO.route.at(-1);

  svg.innerHTML = `
    <defs>
      <filter id="photoFireGlow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur stdDeviation="${u * 4.2}" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="photoRouteGlow" x="-30%" y="-60%" width="160%" height="220%">
        <feGaussianBlur stdDeviation="${u * 1.4}"/>
      </filter>
      <marker id="photoRouteArrow" viewBox="0 0 10 10" refX="8" refY="5"
        markerWidth="${u * 2.6}" markerHeight="${u * 2.6}" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--route)"/>
      </marker>
    </defs>

    <polyline points="${route}" fill="none" stroke="var(--route)"
      stroke-width="${u * 5.2}" stroke-linecap="round" stroke-linejoin="round"
      opacity=".22" filter="url(#photoRouteGlow)"/>
    <polyline points="${route}" fill="none" stroke="var(--route)"
      stroke-width="${u * 2.2}" stroke-linecap="round" stroke-linejoin="round"
      marker-end="url(#photoRouteArrow)"/>
    <polyline points="${route}" fill="none" stroke="#dff0ff"
      stroke-width="${u * .62}" stroke-linecap="round" opacity=".9"
      stroke-dasharray="${u * 4} ${u * 7}">
      <animate attributeName="stroke-dashoffset" from="${u * 11}" to="0"
        dur="1.05s" repeatCount="indefinite"/>
    </polyline>

    <g filter="url(#photoFireGlow)">
      <circle cx="${fx}" cy="${fy}" r="${u * 12}" fill="var(--danger)" fill-opacity=".16"
        stroke="var(--danger)" stroke-width="${u * 2.4}"/>
      <circle cx="${fx}" cy="${fy}" r="${u * 5.5}" fill="var(--danger)" fill-opacity=".92"/>
    </g>
    <circle cx="${fx}" cy="${fy}" r="${u * 12}" fill="none" stroke="#ffb0a8"
      stroke-width="${u * .7}" stroke-dasharray="${u * 2.2} ${u * 2.2}"/>

    <circle cx="${cx}" cy="${cy}" r="${u * 6.2}" fill="var(--route)" fill-opacity=".18"
      stroke="var(--route)" stroke-width="${u * 1.5}"/>
    <circle cx="${cx}" cy="${cy}" r="${u * 2.7}" fill="var(--route)" stroke="#fff"
      stroke-width="${u * .7}"/>

    <circle cx="${end[0]}" cy="${end[1]}" r="${u * 5.8}" fill="none"
      stroke="var(--ok)" stroke-width="${u * 1.5}"/>
    <circle cx="${end[0]}" cy="${end[1]}" r="${u * 2.1}" fill="var(--ok)"/>
  `;
}

/**
 * 선택용 투명 원.
 *
 * 사람 마커는 `live-track` 이 부드럽게 애니메이션하는 레이어에 있고, 그 레이어는
 * `pointer-events: none` 이라야 밑의 통로를 클릭할 수 있다. 그래서 클릭만 받는
 * 얇은 레이어를 따로 얹는다 — 마커 그리는 쪽을 건드리지 않고 선택을 붙이는
 * 가장 싼 방법이다.
 */
function drawPicks() {
  const svg = document.getElementById('pick-layer');
  const base = document.getElementById('admin-map');
  if (!svg || !base) return;
  const vb = base.getAttribute('viewBox');
  if (!vb) return;
  svg.setAttribute('viewBox', vb);
  const r = Number(vb.split(/\s+/)[2]) / 55;
  svg.innerHTML = livePositions().filter(p => Number.isFinite(p.x)).map(p => {
    const on = p.userId === selectedUser;
    return `<circle cx="${p.x}" cy="${p.y}" r="${r}" fill="transparent"
      stroke="${on ? 'var(--accent)' : 'transparent'}" stroke-width="${r * 0.18}"
      data-user="${p.userId}"><title>${p.userId}</title></circle>`;
  }).join('');
  svg.querySelectorAll('[data-user]').forEach(c =>
    c.addEventListener('click', () => selectUser(c.dataset.user)));
}

/**
 * 지도 주변 장치들 — 탭·확대·검색.
 *
 * 넷 다 지도를 가리지 않으려고 떠 있는 작은 조각이라 한곳에 모아 둔다.
 */
/**
 * 비콘 레이어의 상태를 화면에 정직하게 반영한다.
 *
 * 그릴 게 없을 때 그냥 아무것도 안 그리면, 보는 사람은 «켜져 있는데 안 보이네»
 * 로 읽고 고장으로 여긴다. **왜 없는지**를 버튼과 범례가 말해야 한다.
 */
/**
 * 답사 현황을 받아 온다.
 *
 * 지점마다 **신호가 몇 개** 붙었는지까지 센다. 한 지점에 신호가 하나뿐이면
 * 그 기기 주인이 자리를 뜨는 순간 그 지점을 못 잡는다 — 답사는 «했다/안 했다»
 * 가 아니라 «얼마나 두텁게 했나» 라서, 개수가 보여야 어디를 다시 갈지 정한다.
 */
async function refreshSurvey() {
  try {
    const d = await (await fetch('/api/beacon-map')).json();
    const sv = d?.surveyed || {};
    const m = new Map();
    for (const nodeId of Object.values(sv)) m.set(nodeId, (m.get(nodeId) || 0) + 1);
    surveyedSpots = m;
    surveyedCount = Object.keys(sv).length;
    renderSummary();
    drawSurvey();
    updateBeaconChrome();
  } catch (_) { /* 서버가 잠깐 없을 수 있다 — 다음 주기에 다시 온다 */ }
}

/**
 * 답사한 지점을 지도에 표시한다.
 *
 * 예전에는 «가상 비콘» 레이어가 43개 지점 전부에서 파동을 울렸다. 실제로 답사한
 * 곳은 7곳인데 화면은 온 층에 비콘이 깔린 것처럼 보였다 — 관제 화면이 할 수
 * 있는 가장 나쁜 거짓말이다. 답사한 곳만, 두께까지 그린다.
 */
function drawSurvey() {
  const svg = document.getElementById('beacon-waves');
  const base = document.getElementById('admin-map');
  const plan = api.floorPlan;
  if (!svg || !base || !plan) return;
  const vb = base.getAttribute('viewBox');
  if (!vb) return;
  svg.setAttribute('viewBox', vb);

  if (!isOn('show-beacons') || surveyedSpots.size === 0) { svg.innerHTML = ''; return; }
  const u = Number(vb.split(/\s+/)[2]) / 300;

  svg.innerHTML = [...surveyedSpots].map(([nodeId, n]) => {
    const node = plan.getNode?.(nodeId) || plan.nodes.find(x => x.id === nodeId);
    if (!node || !Number.isFinite(node.x)) return '';
    // 신호가 두터울수록 크고 진하게 — 어디가 얇은지가 한눈에 보여야 한다
    const w = Math.min(1, n / 6);
    const r = u * (3 + w * 3);
    const weak = n <= 2;
    // 답사 지점은 **보라**(--beacon)다. 예전에는 민트였는데 출구도 민트라서
    // 지도에서 «저 점이 출구인가 답사 지점인가» 가 안 갈렸다.
    // 얇은 곳은 주황 그대로 — 이 화면의 색 규칙에서 주황이 «봐야 하지만
    // 위험은 아닌 것» 이고, 얇은 답사가 정확히 그것이다.
    const c = weak ? 'var(--warn)' : 'var(--beacon)';
    return `<circle cx="${node.x}" cy="${node.y}" r="${r * 2.1}" fill="${c}" opacity="${0.08 + w * 0.10}"/>
      <circle cx="${node.x}" cy="${node.y}" r="${r}" fill="none" stroke="${c}"
        stroke-width="${u * 0.9}" opacity="${0.5 + w * 0.45}"/>
      <text x="${node.x}" y="${node.y + u * 1.3}" text-anchor="middle"
        font-size="${u * 3.4}" font-weight="700" fill="${c}"
        paint-order="stroke" stroke="#fff" stroke-width="${u}">${n}</text>`;
  }).join('');
}

/**
 * 도면에서 뽑은 벽을 세운다.
 *
 * 좌표는 **도면 사진의 픽셀** 그대로다. 그래서 벽 컨테이너를 사진 크기로
 * 만들고 통째로 축소해 지도 위에 겹친다 — 벽마다 배율을 곱하면 값이 어긋나
 * 사진의 선과 벽이 미세하게 안 맞는다.
 *
 * 벽 높이는 도면에 없다. 층고를 모르니 **전부 같은 높이**로 세운다. 이건
 * 실측 3D 가 아니라 평면도를 세운 것이고, 관제에 필요한 것도 그만큼이다 —
 * 방의 경계가 보이고 사람이 어느 방 안에 있는지 읽히면 된다.
 */
let wallData = null;
async function loadWalls(planId) {
  if (!planId) return;
  try {
    wallData = await (await fetch(`/api/plans/${encodeURIComponent(planId)}/walls`)).json();
  } catch (_) { wallData = null; }

  // 글씨·배경을 지운 도면이 있으면 그것을 깐다. 없으면 원본 사진 그대로 —
  // 아직 정리를 안 돌린 도면에서도 관제는 떠야 한다.
  const url = `/api/plans/${encodeURIComponent(planId)}/floor`;
  try {
    const r = await fetch(url, { method: 'HEAD' });
    cleanFloorUrl = r.ok ? url : null;
  } catch (_) { cleanFloorUrl = null; }

  // 정리본이 없는 도면이면 그때서야 원본을 받는다 — 벽도 없을 테니 평면으로 쓴다
  if (!cleanFloorUrl && !api.backgroundImage) {
    api.skipPlanImage = false;
    await api._loadPlanImage?.(planId);
  }
  document.querySelector('.ops-body')?.setAttribute('data-floor', cleanFloorUrl ? 'clean' : 'raw');
  indexRooms();
  walkGrid = wallData?.grid
    ? new WalkGrid(wallData.grid, { width: wallData.width, height: wallData.height })
    : null;
  drawWalls();
  draw();
}
let cleanFloorUrl = null;
/** 도면에서 뽑은 «걸을 수 있는 칸». 경로가 벽을 안 뚫게 하는 근거다. */
let walkGrid = null;

/**
 * 방을 칠한다.
 *
 * 벽만 세우면 «어느 방에 누가 있나» 가 안 읽힌다. 방을 면으로 칠해야 상태를
 * 담을 수 있다 — 불난 방은 붉게, 사람이 있는 방은 강조색으로.
 *
 * 방과 지점을 잇는 것은 **점이 다각형 안에 있나** 로 판정한다. 도면 판독기가
 * 낸 지점 좌표와 사진에서 뽑은 방 다각형이 같은 픽셀 좌표계라 그대로 맞는다.
 */
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 지점 id → 그 지점이 들어 있는 방의 번호 */
let nodeRoom = new Map();
function indexRooms() {
  nodeRoom = new Map();
  const rooms = wallData?.rooms || [];
  for (const n of api.floorPlan?.nodes || []) {
    if (!Number.isFinite(n.x)) continue;
    const i = rooms.findIndex(r => pointInPoly(n.x, n.y, r.points));
    if (i >= 0) nodeRoom.set(n.id, i);
  }
}

/** 지금 불난 방 번호 — 방 칠하기와 벽 물들이기가 같은 값을 봐야 한다 */
let hotRooms = new Set();

function drawRooms() {
  const svg = document.getElementById('room-layer');
  const base = document.getElementById('admin-map');
  if (!svg || !base) return;
  const vb = base.getAttribute('viewBox');
  const rooms = wallData?.rooms || [];
  if (!vb || !rooms.length) { svg.innerHTML = ''; return; }
  svg.setAttribute('viewBox', vb);

  // 지금 어느 방이 위험한가 / 누가 있나
  const hot = new Set();
  for (const [edgeId] of Object.entries(hazards || {})) {
    const e = api.floorPlan?.edges?.find(x => x.id === edgeId);
    for (const nid of [e?.a, e?.b]) {
      const r = nodeRoom.get(nid);
      if (r !== undefined) hot.add(r);
    }
  }
  hotRooms = hot;
  const busy = new Set();
  for (const p of livePositions()) {
    const r = nodeRoom.get(p.nodeId);
    if (r !== undefined) busy.add(r);
  }

  // 불난 방은 **빛난다.** 색만 바꾸면 «빨간 방» 이지만, 번지는 빛이 붙으면
  // «타고 있는 방» 이 된다 — 관제하는 사람이 화면을 흘깃 봐도 먼저 눈에 든다.
  const u = Number(vb.split(/\s+/)[2]) / 400;
  const glow = `<filter id="fireGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="${u * 7}" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>`;

  const body = rooms.map((r, i) => {
    const d = r.points.map(([x, y]) => `${x},${y}`).join(' ');
    const fire = hot.has(i);
    const here = busy.has(i);
    if (fire) {
      return `<g filter="url(#fireGlow)">
        <polygon points="${d}" fill="var(--danger)" fill-opacity="0.5"/>
        <polygon points="${d}" fill="none" stroke="#ff7a6b" stroke-width="${u * 2.2}"
          stroke-opacity="0.95"/>
      </g>`;
    }
    if (here) {
      return `<polygon points="${d}" fill="var(--route)" fill-opacity="0.16"
        stroke="var(--route)" stroke-opacity="0.5" stroke-width="${u * 1.2}"/>`;
    }
    // 평상시 방은 **아주 옅게.** 다 진하면 상태가 생겨도 드러나지 않는다.
    return `<polygon points="${d}" fill="#cfe0f2" fill-opacity="0.05"/>`;
  }).join('');
  svg.innerHTML = `<defs>${glow}</defs>${body}`;
}

/**
 * 비상구 표지판을 세운다.
 *
 * 화재존과 비상구를 **색이 아니라 형태로** 가른다 — 화재는 바닥에 퍼진 면,
 * 비상구는 그 자리에 서 있는 물체. 색만 다르면 흘깃 볼 때 둘 다 «칠해진 방»
 * 으로 읽히지만, 하나가 서 있으면 그 순간 갈린다.
 */
function drawSigns() {
  const box = document.getElementById('signs');
  const stack = document.getElementById('map-stack');
  const plan = api.floorPlan;
  if (!box || !stack || !plan) return;
  const w = wallData?.width || plan.image?.width;
  if (!w) { box.innerHTML = ''; return; }

  box.style.width = `${w}px`;
  box.style.height = `${wallData?.height || plan.image?.height || w}px`;
  box.style.transform = `scale(${stack.offsetWidth / w})`;
  // 실제 비상구 표지판은 천장에 달린 작은 판이다. 크게 그리면 «표지판» 이
  // 아니라 «간판» 이 되고, 여섯 개가 도면을 덮는다.
  const sh = w / 48;
  box.style.setProperty('--sh', `${sh}px`);
  box.style.setProperty('--sw', `${sh * 1.5}px`);

  const exits = plan.nodes.filter(n => n.type === 'exit' && Number.isFinite(n.x));
  box.innerHTML = exits.map(n =>
    `<b style="--x:${n.x}px;--y:${n.y}px" title="${n.name}"><span>EXIT</span></b>`).join('');
}

/**
 * 바닥판을 **건물 모양으로 자른다.**
 *
 * 도면 이미지는 사각형이지만 건물은 쐐기다. 사각형 그대로 깔면 건물 밖
 * 여백까지 «걸어 다닐 수 있는 바닥» 으로 보이고, 그 여백이 화면에서 건물이
 * 차지할 자리를 먹는다.
 *
 * `clip-path` 로 자른다 — 판과 두께 여섯 겹에 같은 모양을 물려야 옆면까지
 * 건물 윤곽을 따라간다. 백분율로 주므로 확대·축소해도 따라온다.
 */
function applyFootprint() {
  const foot = wallData?.footprint;
  const w = wallData?.width, h = wallData?.height;
  const stack = document.getElementById('map-stack');
  const slab = document.getElementById('slab');
  if (!stack) return;

  if (!foot?.length || !w || !h) {
    stack.style.clipPath = '';
    if (slab) slab.style.clipPath = '';
    return;
  }
  const poly = `polygon(${foot
    .map(([x, y]) => `${(x / w * 100).toFixed(2)}% ${(y / h * 100).toFixed(2)}%`)
    .join(', ')})`;
  stack.style.clipPath = poly;
  if (slab) slab.style.clipPath = poly;
}

/**
 * 시스템이 «복도» 라고 믿는 것을 그린다.
 *
 * 길이 이상하게 날 때 원인이 둘이다 — 길찾기가 잘못했거나, **복도를 잘못
 * 알고 있거나.** 보이지 않으면 둘을 가릴 수 없어서 «고쳤다» 는 말만 오간다.
 * 그려 놓으면 보는 사람이 «여긴 복도가 아닌데» 를 바로 짚을 수 있다.
 */
function drawCorridor() {
  const svg = document.getElementById('corridor-layer');
  const base = document.getElementById('admin-map');
  if (!svg || !base) return;
  const vb = base.getAttribute('viewBox');
  if (!vb || !walkGrid?.ok || !isOn('show-corridor', false)) { svg.innerHTML = ''; return; }
  svg.setAttribute('viewBox', vb);

  const cw = walkGrid.sx;
  const ch = walkGrid.sy;
  const cells = [];
  for (let y = 0; y < walkGrid.h; y++) {
    for (let x = 0; x < walkGrid.w; x++) {
      if (!walkGrid.corridor(x, y)) continue;
      cells.push(`<rect x="${(x * cw).toFixed(1)}" y="${(y * ch).toFixed(1)}"
        width="${(cw + 0.6).toFixed(1)}" height="${(ch + 0.6).toFixed(1)}"/>`);
    }
  }
  svg.innerHTML = `<g fill="var(--ok)" fill-opacity="0.22">${cells.join('')}</g>`;
}

function drawWalls() {
  const box = document.getElementById('walls');
  const stack = document.getElementById('map-stack');
  if (!box || !stack) return;
  const w = wallData?.width, h = wallData?.height;
  if (!w || !wallData.walls?.length) { box.innerHTML = ''; return; }

  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  const k = stack.offsetWidth / w;
  box.style.transform = `scale(${k})`;
  // 벽 높이는 도면 픽셀로 준다.
  //
  // 처음에 폭의 1/52(26px)로 뒀더니 화면에서 14px밖에 안 올라와 124장이
  // 있으나 마나였다. 판을 46도로 눕히면 실제 높이의 sin(46°)=0.72 만 보이고,
  // 거기에 축소 배율까지 곱해지기 때문이다. 눈에 «벽» 으로 읽히려면
  // 도면 폭의 1/20 은 되어야 한다.
  // 1/20 은 벽이 너무 높아 방 안이 안 보였다. 관제는 «방 안에 누가 있나» 를
  // 보는 화면이라 벽은 경계를 알려 줄 만큼만 있으면 된다.
  box.style.setProperty('--wh', `${Math.max(18, w / 34)}px`);

  // 불난 방에 닿은 벽은 붉게 물든다. 빛은 면에서 멈추지 않고 벽에 닿는다 —
  // 그게 없으면 붉은 바닥 위에 흰 벽이 떠 있어 «칠했다» 로 보인다.
  // 방 **안이나 그 벽에 닿은** 것만 물든다.
  //
  // 처음에는 방 중심에서 √넓이 만큼을 «닿았다» 로 봤는데, 그러면 긴 방
  // 하나가 불나면 옆 방 벽까지 통째로 붉어졌다. 벽의 양 끝이 방 다각형
  // 안이나 바로 옆인지를 본다.
  // 복도(그래프 엣지) 가까이 있는 벽 = 사람이 걷는 곳을 두르는 벽
  const plan = api.floorPlan;
  // 복도 폭의 절반쯤. 넓게 잡으면(1/22 로 뒀을 때) 벽 124장 중 111장이
  // «복도에 면했다» 로 나와 계급이 생기지 않았다.
  const near = (wallData.width || 1000) / 55;
  const segs = (plan?.edges || []).map(e => {
    const a2 = plan.getNode(e.a), b2 = plan.getNode(e.b);
    return a2 && b2 ? [a2.x, a2.y, b2.x, b2.y] : null;
  }).filter(Boolean);
  const distToSeg = (px, py, [x1, y1, x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / L)) : 0;
    return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
  };
  const onCorridor = w => {
    const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
    return segs.some(sg => distToSeg(mx, my, sg) < near);
  };

  const fireRooms = (wallData.rooms || []).filter((_, i) => hotRooms.has(i));
  const pad = (wallData.width || 1000) / 130;
  const touchesFire = (x1, y1, x2, y2) => fireRooms.some(r => {
    for (const [x, y] of [[x1, y1], [x2, y2], [(x1 + x2) / 2, (y1 + y2) / 2]]) {
      if (pointInPoly(x, y, r.points)) return true;
      // 다각형 바로 밖(벽 두께만큼)도 그 방의 벽이다
      if (r.points.some(([px, py]) => Math.hypot(px - x, py - y) < pad)) return true;
    }
    return false;
  });

  box.innerHTML = wallData.walls.map(s => {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
    const len = Math.hypot(dx, dy);
    const a = Math.atan2(dy, dx) * 180 / Math.PI;
    const hot = touchesFire(s.x1, s.y1, s.x2, s.y2);
    // 복도에 면한 벽은 제 높이로, 방 안쪽 칸막이는 낮게.
    //
    // 벽 수를 줄이자는 생각도 해봤지만, 그러면 «어느 방에 있나» 를 못 답한다.
    // 벽을 지우는 대신 **계급을 준다** — 사람이 걷는 곳을 두르는 벽만 밝게
    // 세우고 나머지는 물러나게 하면, 벽은 다 남아 있는데 화면은 조용해진다.
    const cls = hot ? ' class="hot"' : (onCorridor(s) ? '' : ' class="inner"');
    return `<i${cls} style="--x:${s.x1}px;--y:${s.y1}px;--len:${len.toFixed(1)}px;--a:${a.toFixed(2)}deg"></i>`;
  }).join('');
}

function updateBeaconChrome() {
  const real = hasRealBeacons();
  const any = real || surveyedCount > 0;
  const btn = document.getElementById('show-beacons');
  if (btn) {
    btn.disabled = !any;
    btn.style.opacity = any ? '' : '.35';
    btn.title = any
      ? `비콘 표시 (실물 ${real ? '있음' : '없음'} · 답사 ${surveyedCount}개)`
      : '표시할 비콘이 없습니다 — 도면에 비콘 id 가 없고, 답사로 태그한 지점도 없습니다';
  }
  const wave = document.getElementById('show-waves');
  if (wave) { wave.disabled = !any; wave.style.opacity = any ? '' : '.35'; }

  const legend = document.querySelector('.legend .beacon')?.parentElement;
  if (legend) legend.hidden = !any;
  const note = document.getElementById('beacon-note');
  if (note) {
    note.hidden = surveyedSpots.size === 0 ? false : false;
    const thin = [...surveyedSpots.values()].filter(n => n <= 2).length;
    note.textContent = surveyedSpots.size === 0
      ? '비콘 없음 — 답사 전'
      : `답사 ${surveyedSpots.size}지점` + (thin ? ` · ${thin}곳 신호 얇음` : '');
    note.style.color = thin ? 'var(--warn)' : 'var(--muted)';
  }
}

/**
 * 기울인 판이 화면에 들어오도록 배율을 맞춘다.
 *
 * 처음에는 삼각함수로 회전 후 크기를 계산했는데 판이 계속 넘쳤다. **원근**
 * 때문이다 — 눕힌 판은 가까운 쪽(아래) 모서리가 먼 쪽보다 넓게 그려져서,
 * 평면 회전으로 구한 폭보다 실제가 크다. 그 차이를 식으로 맞추려면 원근
 * 거리와 회전 원점까지 넣어야 하는데, 그렇게 구한 값도 근사다.
 *
 * 그래서 **그려진 것을 잰다.** `getBoundingClientRect()` 는 변형이 적용된
 * 뒤의 화면상 사각형을 주므로 원근이 이미 포함돼 있다. 지금 배율에서 잰
 * 크기와 쓸 수 있는 크기의 비를 곱하면 한 번에 맞고, 어긋나도 다음 호출에서
 * 스스로 수렴한다.
 */
function fitStage() {
  const canvas = document.getElementById('canvas');
  const inner = document.getElementById('stage-inner');
  const body = document.querySelector('.ops-body');
  if (!canvas || !inner) return;

  if (body?.getAttribute('data-view') === 'flat') {
    inner.style.setProperty('--fit', 1);
    return;
  }

  const cs = getComputedStyle(canvas);
  const availW = canvas.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = canvas.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;

  // **배율 1 에서 재고 한 번에 정한다.**
  //
  // 처음에는 «지금 배율에서 재고 비율을 곱하기» 로 했는데, 도면 사진이 늦게
  // 도착하는 바람에 사진 없는 상태의 작은 판을 재고 그 값을 곱하는 일이
  // 생겼다. 곱셈이 누적되면 판이 계속 작아지기만 하고 되돌아오지 않는다.
  // 매번 기준점(1배)에서 재면 언제 불려도 같은 답이 나온다.
  const prev = inner.style.transition;
  inner.style.transition = 'none';
  // 확대는 잠깐 1로 두고 잰다 — 확대까지 포함해서 재면 «확대한 만큼 맞춤이
  // 깎이는» 상쇄가 다시 생긴다. 맞춤은 1배 기준값이어야 한다.
  const zoomWas = inner.style.getPropertyValue('--zoom');
  inner.style.setProperty('--zoom', 1);
  inner.style.setProperty('--fit', 1);
  const r = inner.getBoundingClientRect();
  const fit = (r.width && r.height)
    ? Math.max(0.15, Math.min(2, Math.min(availW / r.width, availH / r.height) * 0.97))
    : 1;
  inner.style.setProperty('--fit', fit.toFixed(4));
  if (zoomWas) inner.style.setProperty('--zoom', zoomWas);
  else inner.style.removeProperty('--zoom');

  // 크기를 맞춰도 **자리가 어긋난다.**
  //
  // 판을 눕히면 가까운 쪽(아래) 모서리가 화면에서 내려가서, 보이는 상자가
  // 레이아웃 상자보다 아래에 놓인다. 배치는 레이아웃 상자를 가운데에 두므로
  // 눈에는 판이 아래로 밀려 보이고, 각도를 바꿀 때마다 밀리는 양도 바뀐다.
  // 그래서 다시 재서 **보이는 상자**를 가운데로 되민다.
  const stage = document.getElementById('stage');
  if (stage) {
    // 옮긴 양을 뺀 «맨 상태» 에서 재야 가운데 값이 사람이 끈 만큼 밀리지 않는다
    stage.style.transform = 'none';
    const r2 = inner.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    stageCenter = {
      x: (cr.left + cr.right) / 2 - (r2.left + r2.right) / 2,
      y: (cr.top + cr.bottom) / 2 - (r2.top + r2.bottom) / 2,
    };
    applyStageTransform();
  }

  // 다음 프레임에 되돌려야 방금 준 값이 애니메이션 없이 즉시 반영된다
  requestAnimationFrame(() => { inner.style.transition = prev; });
}

/** 끌어서 옮긴 양. 가운데 맞춤과 따로 들고 있다가 합쳐서 적용한다. */
let pan = { x: 0, y: 0 };

/**
 * 마우스로 층을 **옮기고** 돌린다.
 *
 *   끌기          좌우·위아래로 이동
 *   Shift + 끌기  시점 회전
 *   휠            확대
 *
 * 이동을 기본으로 둔 이유는, 확대해서 한 구역을 들여다보는 일이 각도를 바꾸는
 * 일보다 훨씬 잦기 때문이다. 회전은 겹쳐 보이는 지점을 갈라 볼 때만 쓴다.
 *
 * **빈 곳을 끌 때만 동작한다.** 통로나 사람을 끌면 위험 주입·선택이 안 되니,
 * 클릭 대상 위에서 시작한 드래그는 무시한다. 그리고 조금이라도 끌었으면 놓을
 * 때의 클릭을 막는다 — 옮기려던 것이 통로 클릭으로 끝나면 엉뚱한 곳에 연기가
 * 주입된다.
 */
function wireOrbit() {
  const stage = document.getElementById('stage');
  const inner = document.getElementById('stage-inner');
  const body = document.querySelector('.ops-body');
  if (!stage || !inner) return;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const read = k => parseFloat(getComputedStyle(inner).getPropertyValue(k)) || 0;
  let drag = null;

  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    // **어디를 끌든 이동한다.**
    //
    // 처음에는 지도 요소(통로·지점) 위에서 시작한 드래그를 무시했다. 그런데
    // 도면 사진이 판 전체를 덮고 있어서, 사람 눈에 «지도» 인 곳은 전부
    // 무시 대상이 됐다 — 끌 수 있는 곳이 판 바깥의 빈 여백뿐이었다.
    //
    // 그래서 반대로 한다. 어디서든 끌기를 시작하되, **움직였을 때만** 이동으로
    // 치고 놓을 때의 클릭을 삼킨다. 제자리에서 누르면 그대로 통로 클릭이다.
    // 끌었나 아닌가는 손이 이미 답을 알려 준다.
    drag = {
      x: e.clientX, y: e.clientY, moved: 0,
      spin: e.shiftKey, tilt0: read('--tilt'), spin0: read('--spin'),
      panx: pan.x, pany: pan.y,
    };
    stage.classList.add('dragging');
    stage.setPointerCapture(e.pointerId);
  });

  stage.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));

    if (drag.spin) {
      // 0도(완전 평면)~78도. 그 너머는 판이 선처럼 얇아져 아무것도 안 보인다.
      inner.style.setProperty('--tilt', clamp(drag.tilt0 + dy * 0.35, 0, 78).toFixed(2) + 'deg');
      inner.style.setProperty('--spin', (drag.spin0 - dx * 0.35).toFixed(2) + 'deg');
      if (drag.moved > 3) body?.setAttribute('data-view', 'iso');
      fitStage();
    } else {
      pan = { x: drag.panx + dx, y: drag.pany + dy };
      applyStageTransform();
    }
  });

  const end = e => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    stage.classList.remove('dragging');
    try { stage.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved > 3) {
      const eat = ev => { ev.stopPropagation(); ev.preventDefault(); };
      stage.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => stage.removeEventListener('click', eat, { capture: true }), 0);
    }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const cur = parseFloat(getComputedStyle(inner).getPropertyValue('--zoom')) || 1;
    setZoomValue(clamp(cur * (e.deltaY > 0 ? 0.92 : 1.08), 1, 6));
  }, { passive: false });
}

/** 가운데 맞춤(계산값) + 끌어서 옮긴 양(사람) 을 합쳐 무대에 적용한다 */
let stageCenter = { x: 0, y: 0 };
function applyStageTransform() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  stage.style.transform =
    `translate(${(stageCenter.x + pan.x).toFixed(1)}px, ${(stageCenter.y + pan.y).toFixed(1)}px)`;
}

/** 확대 배율을 한 곳에서 정한다 — 버튼과 휠이 같은 값을 만진다 */
function setZoomValue(z) {
  const inner = document.getElementById('stage-inner');
  inner?.style.setProperty('--zoom', z);
  // 맞춤은 다시 재지 않는다 — 확대는 맞춤 위에 곱해지는 값이라 서로 건드릴
  // 이유가 없고, 여기서 fitStage 를 부르면 확대분이 그대로 상쇄된다.
  applyStageTransform();
}

function wireChrome() {
  wireOrbit();
  // 감시 목록 탭 — 네 목록을 세로로 쌓으면 서랍이 화면 절반을 먹는다
  const tabs = [...document.querySelectorAll('.drawer-tabs [data-pane]')];
  tabs.forEach(btn => btn.addEventListener('click', () => {
    tabs.forEach(b => {
      const on = b === btn;
      b.setAttribute('aria-selected', String(on));
      const pane = document.getElementById(b.dataset.pane);
      if (pane) pane.hidden = !on;
    });
  }));

  // 평면 ↔ 입체. 기본은 입체 — 관제가 보는 것은 도면이 아니라 «사람이 있는 층» 이다.
  // 다만 통로를 정확히 찍어 위험을 주입할 때는 기울어진 판이 방해가 되므로
  // 언제든 평면으로 되돌릴 수 있어야 한다.
  const body = document.querySelector('.ops-body');
  const viewBtn = document.getElementById('btn-view');
  viewBtn?.addEventListener('click', () => {
    const flat = body.getAttribute('data-view') === 'flat';
    body.setAttribute('data-view', flat ? 'iso' : 'flat');
    viewBtn.setAttribute('aria-pressed', String(!flat));
    viewBtn.title = flat ? '평면으로 보기' : '입체로 보기';
    requestAnimationFrame(fitStage);
    setTimeout(fitStage, 500);
  });
  window.addEventListener('resize', () => requestAnimationFrame(fitStage));
  // 도면 사진은 늦게 도착한다. 그 전에 재면 판이 납작한 상태로 맞춰진다.
  document.getElementById('admin-map')?.addEventListener('load', fitStage, true);
  setTimeout(fitStage, 900);

  // 확대 — 도면은 가로로 길어서 화면 폭에 맞추면 방 이름이 안 읽힌다
  const inner = document.getElementById('stage-inner');
  const curZoom = () => parseFloat(getComputedStyle(inner).getPropertyValue('--zoom')) || 1;
  document.getElementById('zoom-in')?.addEventListener('click', () => setZoomValue(Math.min(4, curZoom() * 1.25)));
  document.getElementById('zoom-out')?.addEventListener('click', () => setZoomValue(Math.max(1, curZoom() / 1.25)));
  document.getElementById('btn-fit')?.addEventListener('click', () => {
    // 시점 초기화 — 돌리다 길을 잃었을 때 돌아올 자리가 있어야 마음 놓고 돌린다
    inner.classList.add('animate');
    inner.style.setProperty('--tilt', '46deg');
    inner.style.setProperty('--spin', '0deg');
    pan = { x: 0, y: 0 };
    setZoomValue(1);
    setTimeout(() => { inner.classList.remove('animate'); fitStage(); }, 480);
  });

  // 검색 — 사람이 스무 명 넘어가면 목록을 눈으로 훑는 게 불가능해진다
  document.getElementById('q')?.addEventListener('input', e => {
    query = e.target.value.trim().toLowerCase();
    renderPeople();
  });
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
