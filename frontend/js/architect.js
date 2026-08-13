/**
 * 도면 편집기 — 건물의 도면·설계도를 대피 경로 그래프로 주입한다.
 *
 * Anyplace의 architect 클라이언트가 하는 일(실내 공간 등록 → POI → 연결)을
 * 대피 안내에 필요한 최소한으로 옮겨왔다.
 *
 * 흐름: 도면 이미지 업로드 → 실제 가로 폭 입력(축척) → 지점 찍기 →
 *       통로 연결 → 지점 유형(출구·엘리베이터 등) 지정 → 저장 → 활성화
 *
 * 좌표는 도면 이미지의 픽셀 좌표로 저장하고, metersPerUnit으로 실제 거리를 환산한다.
 * 이 값이 틀리면 "몇 걸음"이 전부 틀어지므로 축척 입력이 중요하다.
 */

import { Api } from './api.js';
import { renderMap } from './minimap.js';
import { FloorPlan, validatePlan, findUnreachableNodes, NODE_TYPES } from '../shared/floor-plan.js';

const $ = id => document.getElementById(id);

/** 도면 이미지 상한 (백엔드와 동일 기준) */
const MAX_IMAGE_BYTES = 900_000;
const MAX_IMAGE_DIM = 1600;

const NODE_TYPE_LABELS = {
  room: '실(방)', junction: '교차점', exit: '출구·비상구',
  elevator: '엘리베이터', stair: '계단',
};

const api = new Api();

const state = {
  plan: emptyPlan(),
  image: null,          // data URI
  mode: 'node',
  pendingEdgeFrom: null, // 통로 연결 중인 시작 지점
  selected: null,        // { kind: 'node'|'edge', id }
  dragging: null,
  seq: 1,
};

function emptyPlan() {
  return {
    id: '', name: '', metersPerUnit: 1, stepLength: 0.7,
    image: null, nodes: [], edges: [], initialHazards: {},
  };
}

// ------------------------------------------------------------------ 초기화
async function main() {
  document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  $('image-input').addEventListener('change', onImageSelected);
  $('ai-read').addEventListener('click', readPlanWithAi);

  // 키가 아예 없으면 버튼을 감춘다 — 눌러도 안 되는 버튼은 없느니만 못하다.
  // 키는 있는데 모델이 그림을 못 보는 경우는 **감추지 않고 이유를 보여준다.**
  // 사용자가 고칠 수 있는 문제이고, 조용히 사라지면 왜 없는지 알 수가 없다.
  api.readerAvailable()
    .then(r => {
      if (!r?.configured) return;
      $('ai-read-box').hidden = false;
      if (!r.available) {
        // "지금 붐빔"과 "못 쓴다"는 다르다. 전자는 버튼을 살려둬야 다시 눌러볼 수 있다.
        $('ai-read').disabled = !r.retryable;
        setAiStatus(
          r.retryable
            ? `지금은 판독 서버가 붐빕니다. 잠시 뒤 버튼을 눌러보세요.\n${r.reason}`
            : `판독을 쓸 수 없습니다.\n${r.reason}`,
          true,
        );
      }
    })
    .catch(() => {});
  $('floor-width').addEventListener('input', recomputeScale);
  $('north-offset').addEventListener('input', () => {
    const v = Number($('north-offset').value);
    // 빈 칸은 "모른다"는 뜻이다. 0(북)과 구분해야 한다 — 모르는 걸 0으로 저장하면
    // 앱이 자신 있게 엉뚱한 방향을 가리킨다.
    state.plan.northOffset = $('north-offset').value.trim() === '' || !Number.isFinite(v)
      ? null : ((v % 360) + 360) % 360;
  });
  $('step-length').addEventListener('input', () => {
    state.plan.stepLength = Number($('step-length').value) || 0.7;
    draw();
  });

  $('btn-save').addEventListener('click', savePlan);
  $('btn-activate').addEventListener('click', activatePlan);
  $('btn-export').addEventListener('click', exportJson);
  $('btn-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', importJson);

  api.on('status', ({ online, storage }) => {
    $('mode-badge').textContent = online ? storage : '서버 연결 끊김';
    $('mode-badge').classList.toggle('offline', !online);
  });

  // 현재 활성 도면을 편집 대상으로 불러온다
  await api.loadFloorPlan();
  // 도면이 없으면 빈 편집기로 시작한다 (예제를 심지 않는다)
  loadIntoEditor(api.floorPlan.toJSON(), api.backgroundImage);

  await api.connect();
  await refreshPlanList();
}

function loadIntoEditor(plan, image) {
  state.plan = JSON.parse(JSON.stringify(plan));
  state.image = image || null;
  state.seq = state.plan.nodes.length + 1;

  $('plan-id').value = state.plan.id || '';
  $('plan-name').value = state.plan.name || '';
  $('step-length').value = state.plan.stepLength ?? 0.7;
  $('north-offset').value = Number.isFinite(state.plan.northOffset) ? state.plan.northOffset : '';

  const width = state.plan.image?.width;
  $('floor-width').value = width
    ? Math.round(width * (state.plan.metersPerUnit ?? 1) * 10) / 10
    : Math.round(planExtentX() * (state.plan.metersPerUnit ?? 1) * 10) / 10 || 40;

  updateScaleInfo();
  draw();
  validate();
}

function planExtentX() {
  if (!state.plan.nodes.length) return 0;
  const xs = state.plan.nodes.map(n => n.x);
  return Math.max(...xs) - Math.min(...xs);
}

// ------------------------------------------------------------- 이미지·축척
async function onImageSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const { dataUri, width, height } = await downscaleImage(file);
  if (dataUri.length > MAX_IMAGE_BYTES) {
    setStatus(`이미지가 여전히 큽니다 (${Math.round(dataUri.length / 1024)}KB). 더 작은 파일을 써주세요.`, true);
    return;
  }

  state.image = dataUri;
  state.plan.image = { width, height };
  // 이미지가 바뀌면 축척도 다시 계산해야 한다
  recomputeScale();
  setStatus(`도면 이미지 등록: ${width}×${height}px, ${Math.round(dataUri.length / 1024)}KB`);
  draw();
}

// ------------------------------------------------------------- AI 판독

/**
 * 도면 사진에서 지점·통로를 대신 찍어온다.
 *
 * 피난안내도에는 비상구도 현 위치도 피난경로 화살표도 **이미 그려져 있다.**
 * 없던 걸 만드는 게 아니라, 그림으로만 있는 것을 좌표로 옮겨 적는 일이고,
 * 지금까지 사람이 클릭으로 하던 그 옮겨 적기를 대신하는 것이다.
 *
 * 결과는 **초안**이므로 저장하지 않고 편집기에 올려놓기만 한다. 비상구를 하나
 * 잘못 찍으면 시각장애인이 벽으로 걸어가므로, 사람이 눈으로 확인한 뒤에야 저장된다.
 */
async function readPlanWithAi() {
  if (!state.image) {
    setAiStatus('먼저 도면 이미지를 올려주세요.', true);
    return;
  }
  const had = state.plan.nodes.length;
  if (had && !confirm(`이미 찍어둔 지점 ${had}개가 있습니다.\n읽어온 결과로 바꿀까요?`)) return;

  const btn = $('ai-read');
  btn.disabled = true;
  setAiStatus('도면을 읽는 중입니다… (20초~1분 걸립니다)');

  try {
    const draft = await api.readPlanImage({
      dataUri: state.image,
      width: state.plan.image?.width,
      height: state.plan.image?.height,
    });

    state.plan.nodes = draft.nodes;
    state.plan.edges = draft.edges;
    state.selected = null;
    state.pendingEdgeFrom = null;
    // 읽어온 id 와 겹치지 않게 이후 자동 번호를 뒤로 민다
    state.seq = draft.nodes.length + 1;

    if (draft.buildingName && !$('plan-name').value) {
      $('plan-name').value = [draft.buildingName, draft.floorLabel].filter(Boolean).join(' ');
      state.plan.name = $('plan-name').value;
    }

    recomputeScale();
    renderInspector();
    draw();

    const exits = draft.nodes.filter(n => n.type === 'exit').length;
    setAiStatus(
      [
        `지점 ${draft.nodes.length}개 · 통로 ${draft.edges.length}개 · 출구 ${exits}곳을 읽었습니다.`,
        CONFIDENCE_NOTE[draft.confidence] || '',
        draft.notes,
        ...(draft.warnings || []),
      ].filter(Boolean).join('\n'),
      draft.confidence === 'low' || (draft.warnings || []).length > 0,
    );
  } catch (err) {
    setAiStatus(err.message || '판독에 실패했습니다. 손으로 그려주세요.', true);
  } finally {
    btn.disabled = false;
  }
}

const CONFIDENCE_NOTE = {
  high: '⚠️ 그래도 출구 위치는 눈으로 한 번 확인하세요.',
  medium: '⚠️ 일부가 불확실합니다. 통로 연결을 꼭 확인하세요.',
  low: '⚠️ 신뢰도가 낮습니다. 사진이 흐리거나 가려졌을 수 있으니 전부 확인하세요.',
};

function setAiStatus(text, isError = false) {
  const el = $('ai-read-status');
  el.textContent = text;
  el.style.color = isError ? '#b91c1c' : '#374151';
  el.style.whiteSpace = 'pre-line';
}

/** Firestore 문서 한도에 맞도록 브라우저에서 미리 축소·압축한다 */
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      // 도면은 선 위주라 품질을 조금 낮춰도 알아보기 충분하다
      let quality = 0.82;
      let dataUri = canvas.toDataURL('image/jpeg', quality);
      while (dataUri.length > MAX_IMAGE_BYTES && quality > 0.4) {
        quality -= 0.12;
        dataUri = canvas.toDataURL('image/jpeg', quality);
      }
      resolve({ dataUri, width, height });
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function recomputeScale() {
  const meters = Number($('floor-width').value);
  const units = state.plan.image?.width || planExtentX();
  if (meters > 0 && units > 0) {
    state.plan.metersPerUnit = meters / units;
  }
  updateScaleInfo();
  draw();
}

function updateScaleInfo() {
  const mpu = state.plan.metersPerUnit ?? 1;
  const unit = state.plan.image ? '픽셀' : '단위';
  $('scale-info').textContent =
    `1${unit} = ${mpu.toFixed(4)}m · 평균 보폭 ${state.plan.stepLength ?? 0.7}m 기준으로 걸음 수를 계산합니다.`;
}

// -------------------------------------------------------------------- 편집
function setMode(mode) {
  state.mode = mode;
  state.pendingEdgeFrom = null;
  document.querySelectorAll('.tool-btn[data-mode]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('mode-hint').textContent = {
    node: '도면을 클릭하면 지점이 추가됩니다.',
    edge: '통로로 이을 두 지점을 차례로 클릭하세요.',
    move: '지점을 드래그해 위치를 옮기세요.',
    delete: '삭제할 지점이나 통로를 클릭하세요.',
  }[mode];
  draw();
}

/** 화면 좌표 → 도면 좌표 */
function toPlanCoords(evt, svg) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX;
  pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

function addNode(x, y) {
  const id = nextNodeId();
  state.plan.nodes.push({ id, name: `지점 ${id}`, x, y, type: 'junction' });
  select('node', id);
  draw();
  validate();
}

function nextNodeId() {
  let id;
  do { id = `N${state.seq++}`; } while (state.plan.nodes.some(n => n.id === id));
  return id;
}

function connectNodes(aId, bId) {
  if (aId === bId) return;
  const exists = state.plan.edges.some(e =>
    (e.a === aId && e.b === bId) || (e.a === bId && e.b === aId));
  if (exists) { setStatus('이미 연결된 통로입니다.', true); return; }

  let n = 1;
  let id;
  do { id = `E${n++}`; } while (state.plan.edges.some(e => e.id === id));
  state.plan.edges.push({ id, a: aId, b: bId, wall: null });
  select('edge', id);
  draw();
  validate();
}

function deleteNode(id) {
  state.plan.nodes = state.plan.nodes.filter(n => n.id !== id);
  state.plan.edges = state.plan.edges.filter(e => e.a !== id && e.b !== id);
  state.selected = null;
  draw();
  validate();
}

function deleteEdge(id) {
  state.plan.edges = state.plan.edges.filter(e => e.id !== id);
  state.selected = null;
  draw();
  validate();
}

// ------------------------------------------------------------------ 렌더링
function draw() {
  const svg = $('editor-map');
  const floorPlan = new FloorPlan(state.plan);

  renderMap(svg, {
    floorPlan,
    backgroundImage: state.image,
    highlightEdgeId: state.selected?.kind === 'edge' ? state.selected.id : null,
    onNodeClick: node => onNodeClick(node),
    onEdgeClick: edge => onEdgeClick(edge),
  });

  // 캔버스 빈 곳 클릭 → 지점 추가
  svg.onclick = evt => {
    if (state.mode !== 'node') return;
    const { x, y } = toPlanCoords(evt, svg);
    addNode(x, y);
  };

  // 지점 이동(드래그)
  svg.onpointerdown = evt => {
    if (state.mode !== 'move') return;
    const { x, y } = toPlanCoords(evt, svg);
    const hit = nearestNode(x, y, floorPlan);
    if (hit) { state.dragging = hit.id; svg.setPointerCapture(evt.pointerId); }
  };
  svg.onpointermove = evt => {
    if (!state.dragging) return;
    const { x, y } = toPlanCoords(evt, svg);
    const node = state.plan.nodes.find(n => n.id === state.dragging);
    if (node) { node.x = x; node.y = y; draw(); }
  };
  svg.onpointerup = () => { if (state.dragging) { state.dragging = null; validate(); } };

  renderInspector();
}

function nearestNode(x, y, floorPlan) {
  const img = floorPlan.image;
  const span = img ? Math.max(img.width, img.height) : 40;
  const radius = span * 0.03;
  let best = null;
  for (const n of state.plan.nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < radius && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best;
}

function onNodeClick(node) {
  if (state.mode === 'delete') return deleteNode(node.id);
  if (state.mode === 'edge') {
    if (!state.pendingEdgeFrom) {
      state.pendingEdgeFrom = node.id;
      $('mode-hint').textContent = `${node.name} → 이을 지점을 클릭하세요.`;
      return;
    }
    connectNodes(state.pendingEdgeFrom, node.id);
    state.pendingEdgeFrom = null;
    $('mode-hint').textContent = '통로로 이을 두 지점을 차례로 클릭하세요.';
    return;
  }
  select('node', node.id);
}

function onEdgeClick(edge) {
  if (state.mode === 'delete') return deleteEdge(edge.id);
  select('edge', edge.id);
}

function select(kind, id) {
  state.selected = { kind, id };
  draw();
}

// ---------------------------------------------------------------- 인스펙터
function renderInspector() {
  const box = $('inspector');
  if (!state.selected) {
    box.innerHTML = '<p class="hint">지점이나 통로를 선택하세요.</p>';
    return;
  }

  if (state.selected.kind === 'node') {
    const node = state.plan.nodes.find(n => n.id === state.selected.id);
    if (!node) { box.innerHTML = '<p class="hint">선택 항목이 없습니다.</p>'; return; }
    box.innerHTML = `
      <label>지점 이름 (음성으로 읽힙니다)</label>
      <input id="ins-name" type="text" value="${escapeHtml(node.name)}" />
      <label>유형</label>
      <select id="ins-type">
        ${NODE_TYPES.map(t => `<option value="${t}" ${t === node.type ? 'selected' : ''}>${NODE_TYPE_LABELS[t]}</option>`).join('')}
      </select>
      <label>비콘 ID (측위용 · 선택)</label>
      <input id="ins-beacon" type="text" value="${escapeHtml(node.beaconId ?? '')}" placeholder="예: BC-302" />
      <p class="hint">이 지점에 설치한 비콘의 식별자. 폰이 이 비콘을 가장 세게 수신하면 여기가 현재 위치가 됩니다.</p>
      <p class="hint">좌표 ${node.x}, ${node.y} · id ${node.id}</p>
      <button id="ins-delete" class="tool-btn">🗑️ 이 지점 삭제</button>`;

    $('ins-name').addEventListener('input', e => { node.name = e.target.value; });
    $('ins-type').addEventListener('change', e => { node.type = e.target.value; draw(); validate(); });
    $('ins-beacon').addEventListener('input', e => {
      const v = e.target.value.trim();
      if (v) node.beaconId = v; else delete node.beaconId;
      validate();
    });
    $('ins-delete').addEventListener('click', () => deleteNode(node.id));
    return;
  }

  const edge = state.plan.edges.find(e => e.id === state.selected.id);
  if (!edge) { box.innerHTML = '<p class="hint">선택 항목이 없습니다.</p>'; return; }
  const floorPlan = new FloorPlan(state.plan);
  box.innerHTML = `
    <p><strong>${edge.a} ↔ ${edge.b}</strong> (${edge.id})</p>
    <p class="hint">길이 ${floorPlan.edgeLength(edge).toFixed(1)}m · 약 ${floorPlan.edgeSteps(edge)}걸음</p>
    <label>따라갈 벽 (진행 방향 기준)</label>
    <select id="ins-wall">
      <option value="" ${!edge.wall ? 'selected' : ''}>지정 안 함</option>
      <option value="left" ${edge.wall === 'left' ? 'selected' : ''}>왼쪽 벽</option>
      <option value="right" ${edge.wall === 'right' ? 'selected' : ''}>오른쪽 벽</option>
    </select>
    <label><input id="ins-elevator" type="checkbox" ${edge.elevator ? 'checked' : ''} /> 엘리베이터 구간 (화재 시 제외)</label>
    <button id="ins-delete" class="tool-btn">🗑️ 이 통로 삭제</button>`;

  $('ins-wall').addEventListener('change', e => { edge.wall = e.target.value || null; });
  $('ins-elevator').addEventListener('change', e => { edge.elevator = e.target.checked; draw(); });
  $('ins-delete').addEventListener('click', () => deleteEdge(edge.id));
}

// ------------------------------------------------------------------ 검증
function validate() {
  const plan = collectPlan();
  const box = $('validation');
  const errors = validatePlan(plan);
  const warnings = [];

  if (!errors.length) {
    const unreachable = findUnreachableNodes(new FloorPlan(plan));
    if (unreachable.length) {
      warnings.push(`출구까지 이어지지 않는 지점: ${unreachable.join(', ')} — 통로 연결을 확인하세요.`);
    }
  }

  if (!errors.length && !warnings.length) {
    box.hidden = true;
    return true;
  }
  box.hidden = false;
  box.className = `validation ${errors.length ? 'error' : 'warn'}`;
  box.innerHTML = [
    ...errors.map(e => `<div>❌ ${escapeHtml(e)}</div>`),
    ...warnings.map(w => `<div>⚠️ ${escapeHtml(w)}</div>`),
  ].join('');
  return errors.length === 0;
}

function collectPlan() {
  return {
    ...state.plan,
    id: $('plan-id').value.trim(),
    name: $('plan-name').value.trim(),
    stepLength: Number($('step-length').value) || 0.7,
  };
}

// ------------------------------------------------------------------ 저장
async function savePlan() {
  const plan = collectPlan();
  if (!validate()) { setStatus('도면 오류를 먼저 해결하세요.', true); return; }

  try {
    const { warnings } = await api.savePlan(plan);
    state.plan = plan;
    if (state.image) await api.savePlanImage(plan.id, state.image);
    setStatus(`저장 완료: ${plan.name}${warnings?.length ? ` (경고 ${warnings.length}건)` : ''}`);
    await refreshPlanList();
  } catch (err) {
    setStatus(`저장 실패: ${err.message}`, true);
  }
}

async function activatePlan() {
  const planId = $('plan-id').value.trim();
  if (!planId) { setStatus('도면 ID를 입력하세요.', true); return; }
  try {
    await savePlan();
    await api.activatePlan(planId);
    setStatus(`이제 "${$('plan-name').value}" 도면으로 안내합니다.`);
    await refreshPlanList();
  } catch (err) {
    setStatus(`활성화 실패: ${err.message}`, true);
  }
}

async function refreshPlanList() {
  const ul = $('plan-list');
  try {
    const plans = await api.listPlans();
    // 앱에서 올라온 초안은 눈에 띄게 구분한다. 확인 전에는 활성화가 막혀 있으므로
    // "사용하기" 버튼도 내주지 않는다 — 눌러도 안 되는 버튼은 혼란만 준다.
    ul.innerHTML = plans.map(p => `<li>
      <strong>${escapeHtml(p.name)}</strong>
      ${p.active ? '<span class="badge-active">사용 중</span>' : ''}
      ${p.draft ? '<span class="badge-active" style="background:#f59e0b;color:#1f2937">📱 앱에서 접수 · 확인 필요</span>' : ''}
      <div class="time">${p.id} · 지점 ${p.nodeCount} · 통로 ${p.edgeCount}${p.hasImage ? ' · 도면 이미지 있음' : ''}${p.draft && p.readConfidence ? ` · 판독 신뢰도 ${p.readConfidence}` : ''}</div>
      <div class="actions-inline">
        <button class="tool-btn" data-load="${p.id}">${p.draft ? '확인하기' : '불러오기'}</button>
        ${p.active || p.draft ? '' : `<button class="tool-btn" data-activate="${p.id}">사용하기</button>`}
      </div>
    </li>`).join('') || '<li class="empty">등록된 도면 없음</li>';

    ul.querySelectorAll('[data-load]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const plan = await api._fetch(`/api/plans/${encodeURIComponent(btn.dataset.load)}`);
        let image = null;
        try { image = (await api.getPlanImage(plan.id)).dataUri; } catch (_) {}
        loadIntoEditor(plan, image);
        setStatus(`"${plan.name}" 도면을 불러왔습니다.`);
      });
    });
    ul.querySelectorAll('[data-activate]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await api.activatePlan(btn.dataset.activate);
        await refreshPlanList();
      });
    });
  } catch (_) {
    ul.innerHTML = '<li class="empty">서버에 연결할 수 없습니다.</li>';
  }
}

// ------------------------------------------------------------- JSON 입출력
function exportJson() {
  const plan = collectPlan();
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${plan.id || 'floor-plan'}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importJson(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const plan = JSON.parse(await file.text());
    const errors = validatePlan(plan);
    if (errors.length) {
      setStatus(`가져오기 실패: ${errors[0]}`, true);
      return;
    }
    loadIntoEditor(plan, null);
    setStatus(`"${plan.name}" 도면을 가져왔습니다. 저장 버튼을 눌러 등록하세요.`);
  } catch (err) {
    setStatus(`JSON을 읽을 수 없습니다: ${err.message}`, true);
  } finally {
    e.target.value = '';
  }
}

// -------------------------------------------------------------------- 유틸
function setStatus(text, isError = false) {
  const el = $('save-status');
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : 'var(--route)';
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

main();
