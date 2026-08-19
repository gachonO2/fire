/**
 * 백엔드 API 클라이언트 — 프론트엔드의 유일한 서버 접점.
 *
 * 쓰기: REST (fetch)
 * 읽기: SSE (/api/stream) 로 hazards·sos·positions·metrics 실시간 수신
 *
 * 오프라인 대응: 통신이 끊기면 마지막으로 받은 위험 상태와 번들된 지도로
 * 브라우저에서 직접 경로를 계산한다 (기획서의 "오프라인 최소경로 안내").
 * 이때 degraded 플래그를 올려 화면·음성으로 상태를 알린다.
 */

import { routeToNearestExit } from '../shared/pathfinding.js';
import { FloorPlan } from '../shared/floor-plan.js';
/**
 * 도면이 없을 때 쓰는 **빈 도면**.
 *
 * 예전에는 시연용 "병원 3층"으로 채웠다. 그래서 실제 건물을 등록하기 전까지
 * 앱이 있지도 않은 병원 복도를 자신 있게 안내했다. 빈 도면이면 출구도 시작
 * 위치도 없으니, 화면이 "등록된 도면이 없습니다"로 정직하게 막힌다.
 */
const EMPTY_PLAN = {
  id: '', name: '', metersPerUnit: 1, stepLength: 0.7,
  image: null, nodes: [], edges: [], initialHazards: {},
};

// 같은 출처에서 서빙되면 상대경로, 아니면 ?api=http://... 로 지정 가능
const BASE = new URLSearchParams(location.search).get('api') || '';

const CACHE_KEY = 'fireguide:hazards';
const PLAN_CACHE_KEY = 'fireguide:plan';

export class Api {
  /** @param {{code?: string}} opts code를 주면 보호자 스코프로 스트림을 구독한다 */
  constructor(opts = {}) {
    this.code = opts.code || null;
    this.hazards = this._loadCache();
    this.online = null; // null = 아직 판정 전 (첫 판정이 반드시 status 이벤트를 내도록)
    this.storage = '연결 중…';
    this.listeners = {
      hazards: [], sos: [], positions: [], metrics: [],
      alerts: [], sensors: [], plan: [], status: [], beaconMap: [],
    };
    this._es = null;

    // 통신이 끊겨도 안내를 이어가려면 도면이 손에 있어야 한다.
    // 마지막으로 받은 도면 → 없으면 빈 도면. 예제 건물로 채우지 않는다.
    this.floorPlan = new FloorPlan(this._loadPlanCache() || EMPTY_PLAN);
    this.backgroundImage = null;
  }

  /** 안내에 쓸 수 있는 도면이 있는가 (출구가 하나라도 있어야 한다) */
  get hasPlan() {
    return this.floorPlan.nodes.length > 0 && this.floorPlan.exitNodes().length > 0;
  }

  /** 서버의 활성 도면을 받아온다. 실패하면 캐시된 도면을 유지한다. */
  async loadFloorPlan() {
    try {
      const plan = await this._fetch('/api/map');
      this._setPlan(plan);
    } catch (_) { /* 오프라인 — 캐시/기본 도면 사용 */ }
    return this.floorPlan;
  }

  _setPlan(plan) {
    if (!plan?.nodes?.length) return;
    const changed = JSON.stringify(this.floorPlan.toJSON()) !== JSON.stringify(plan);
    this.floorPlan = new FloorPlan(plan);
    this._savePlanCache(plan);
    // 도면이 **바뀌었을 때만** 받으면, 새로고침 때는 도면이 그대로이므로
    // 영영 안 받아온다. 캐시가 비어 있으면(용량 초과로 저장이 실패했거나
    // 다른 브라우저면) 사진 없는 지도가 뜬다 — 벽도 방도 안 보이는 지도다.
    if (changed || !this.backgroundImage) this._loadPlanImage(plan.id);
    return changed;
  }

  /**
   * 원본 도면 사진을 받지 않는다.
   *
   * 관제는 글씨·배경을 지운 정리본(`/api/plans/:id/floor`, 198KB PNG)을 쓴다.
   * 그런데도 원본(847KB base64 데이터 URI)을 매번 받아 JSON 으로 파싱하고
   * base64 를 디코딩하고 localStorage 에 쓰고 있었다 — 화면에 한 번도 안
   * 쓰이는 값에 그 일을 다 했다.
   */
  skipPlanImage = false;

  async _loadPlanImage(planId) {
    // 사진을 건너뛰더라도 **`plan` 은 반드시 쏜다.**
    //
    // 이 함수가 도면 갱신의 마지막 단계라 화면들이 여기서 나오는 `plan` 을
    // 기다린다. 일찍 돌아가면 사진만 안 받는 게 아니라 도면 자체가 화면에
    // 도착하지 않는다 — 지도는 뜨는데 벽도 방도 안 그려지고 위험 구역도
    // 안 들어온다.
    if (this.skipPlanImage) {
      this._emit('plan', this.floorPlan.toJSON());
      return;
    }
    try {
      const { dataUri } = await this._fetch(`/api/plans/${encodeURIComponent(planId)}/image`);
      this.backgroundImage = dataUri;
      try { localStorage.setItem('fireguide:planImage', dataUri); } catch (_) {}
    } catch (_) {
      this.backgroundImage = null; // 등록된 도면 이미지 없음
    }
    this._emit('plan', this.floorPlan.toJSON());
  }

  // ------------------------------------------------------------ 연결 관리
  async connect() {
    await this._checkHealth();
    this._openStream();
  }

  async _checkHealth() {
    try {
      const health = await this._fetch('/api/health');
      this.storage = health.storage === 'firestore' ? 'Firebase 연동' : '데모 저장소';
      this._setOnline(true);
      return true;
    } catch (_) {
      this.storage = '서버 연결 안 됨';
      this._setOnline(false);
      return false;
    }
  }

  _openStream() {
    if (this._es) this._es.close();
    const url = this.code
      ? `${BASE}/api/stream?code=${encodeURIComponent(this.code)}`
      : `${BASE}/api/stream`;
    const es = new EventSource(url);
    this._es = es;

    for (const topic of ['hazards', 'sos', 'positions', 'metrics', 'alerts', 'sensors', 'plan', 'beaconMap']) {
      es.addEventListener(topic, e => {
        const data = JSON.parse(e.data);
        if (topic === 'hazards') {
          this.hazards = data;
          this._saveCache(data);
        }
        // 관제에서 다른 도면을 활성화하면 여기로 내려온다
        if (topic === 'plan') this._setPlan(data);
        this._setOnline(true);
        this._emit(topic, data);
      });
    }

    // EventSource는 끊기면 스스로 재연결한다. 그동안은 오프라인 모드로 안내.
    es.onerror = () => this._setOnline(false);
    // 재연결 시 저장소 표시가 "연결 안 됨"에 머물지 않도록 health를 다시 읽는다
    es.onopen = () => { if (!this.online) this._checkHealth(); };
  }

  _setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    this._emit('status', { online: v, storage: this.storage });
  }

  on(topic, cb) {
    // 목록에 없는 주제로 구독해도 화면이 죽지 않게 한다. 새 주제를 추가하면서
    // 여기 넣는 것을 빠뜨렸다가 관제가 통째로 멈춘 적이 있다.
    if (!this.listeners[topic]) this.listeners[topic] = [];
    this.listeners[topic].push(cb);
    if (topic === 'hazards' && Object.keys(this.hazards).length) {
      queueMicrotask(() => cb(this.hazards));
    }
    return () => {
      this.listeners[topic] = this.listeners[topic].filter(f => f !== cb);
    };
  }

  _emit(topic, data) {
    for (const cb of this.listeners[topic] || []) {
      // 구독자 하나가 던져도 나머지는 받아야 한다
      try { cb(data); } catch (e) { console.warn(`[api] ${topic} 처리 실패`, e); }
    }
  }

  // ---------------------------------------------------------------- 경로
  /**
   * 대피 경로 계산. 서버가 권위 있는 계산을 하고 KPI도 기록한다.
   * 서버에 닿지 못하면 캐시된 위험 상태로 로컬 계산(오프라인 폴백).
   * @returns { route, ms, offline, reason }
   */
  async computeRoute(from, kind, userId) {
    try {
      const res = await this._fetch('/api/route', {
        method: 'POST',
        body: JSON.stringify({ from, kind, userId }),
      });
      this._setOnline(true);
      return { ...res, offline: false };
    } catch (_) {
      this._setOnline(false);
      const t0 = performance.now();
      const local = routeToNearestExit(this.floorPlan, from, this.hazards);
      const ms = Math.round((performance.now() - t0) * 100) / 100;
      return {
        route: local && {
          nodes: local.nodes,
          edges: local.edges.map(e => e.id),
          distance: local.distance,
          exit: local.exit,
        },
        ms,
        offline: true,
        reason: local ? null : '접근 가능한 대피 경로가 없습니다.',
      };
    }
  }

  // ------------------------------------------------------------ 관제 쓰기
  setHazard(edgeId, type, extra = {}) {
    return this._fetch(`/api/hazards/${edgeId}`, {
      method: 'PUT', body: JSON.stringify({ type, ...extra }),
    });
  }

  clearHazard(edgeId) {
    return this._fetch(`/api/hazards/${edgeId}`, { method: 'DELETE' });
  }

  resetHazards() {
    return this._fetch('/api/hazards/reset', { method: 'POST' });
  }

  getMap() {
    return this._fetch('/api/map');
  }

  // -------------------------------------------------------------- 도면 관리
  listPlans() { return this._fetch('/api/plans'); }

  savePlan(plan) {
    return this._fetch('/api/plans', { method: 'POST', body: JSON.stringify(plan) });
  }

  activatePlan(planId) {
    return this._fetch(`/api/plans/${encodeURIComponent(planId)}/activate`, { method: 'PUT' });
  }

  deletePlan(planId) {
    return this._fetch(`/api/plans/${encodeURIComponent(planId)}`, { method: 'DELETE' });
  }

  getPlanImage(planId) {
    return this._fetch(`/api/plans/${encodeURIComponent(planId)}/image`);
  }

  /** AI 판독을 쓸 수 있는지 (서버에 키가 설정돼 있는지) */
  readerAvailable() { return this._fetch('/api/plans/reader'); }

  /** 도면 사진 → 경로 그래프 초안. 저장하지 않는다 — 사람이 검수한 뒤 savePlan 한다. */
  readPlanImage({ dataUri, width, height }) {
    return this._fetch('/api/plans/read', {
      method: 'POST', body: JSON.stringify({ dataUri, width, height }),
    });
  }

  savePlanImage(planId, dataUri) {
    return this._fetch(`/api/plans/${encodeURIComponent(planId)}/image`, {
      method: 'PUT', body: JSON.stringify({ dataUri }),
    });
  }

  // ------------------------------------------------------------ 온도 센서
  getSensors() { return this._fetch('/api/sensors'); }

  reportTemperature({ sensorId, edgeId, nodeId, celsius }) {
    return this._fetch('/api/sensors/temperature', {
      method: 'POST', body: JSON.stringify({ sensorId, edgeId, nodeId, celsius }),
    });
  }

  removeSensor(sensorId) {
    return this._fetch(`/api/sensors/${encodeURIComponent(sensorId)}`, { method: 'DELETE' });
  }

  resetSensors() { return this._fetch('/api/sensors/reset', { method: 'POST' }); }

  // ------------------------------------------------------------ 보호자 연동
  /** 보호자 등록 → 공유 코드 발급 (같은 사용자면 기존 코드 유지) */
  registerGuardian({ userId, name, contact }) {
    return this._fetch('/api/guardians', {
      method: 'POST',
      body: JSON.stringify({ userId, name, contact }),
    });
  }

  getGuardian(userId) {
    return this._fetch(`/api/guardians/${encodeURIComponent(userId)}`);
  }

  /** 보호자 화면 진입 — 코드로 대상자와 현재 상태를 확인 */
  openGuardianView(code) {
    return this._fetch(`/api/guardian/${encodeURIComponent(code)}`);
  }

  // ---------------------------------------------------------- 사용자 쓰기
  /** 구조요청은 실패해도 앱이 멈추면 안 된다 — 큐에 담아 재시도한다. */
  async sendSOS(payload) {
    try {
      return await this._fetch('/api/sos', { method: 'POST', body: JSON.stringify(payload) });
    } catch (_) {
      this._queueRetry(() => this.sendSOS(payload));
      return null;
    }
  }

  async updatePosition(userId, payload) {
    try {
      await this._fetch(`/api/positions/${userId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } catch (_) { /* 위치 보고 실패는 안내를 막지 않는다 */ }
  }

  /** 관제 시나리오용 위치 쓰기 — 실패를 호출자에게 알려 화면에 표시한다. */
  setPosition(userId, payload) {
    return this._fetch(`/api/positions/${encodeURIComponent(userId)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    });
  }

  removePosition(userId) {
    return this._fetch(`/api/positions/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  clearPositions() {
    return this._fetch('/api/positions', { method: 'DELETE' });
  }

  armPhotoScenario() {
    return this._fetch('/api/demo/photo-scenario/arm', { method: 'POST' });
  }

  startPhotoScenarioTimeline() {
    return this._fetch('/api/demo/photo-scenario/start', { method: 'POST' });
  }

  getPhotoScenarioTimeline() {
    return this._fetch('/api/demo/photo-scenario');
  }

  /** 네이티브 앱의 가상 비콘 출발점을 시나리오 위치에 맞춘다. */
  setDemoStand(nodeId) {
    return this._fetch('/api/demo/stand', {
      method: 'PUT', body: JSON.stringify({ nodeId }),
    });
  }

  _queueRetry(fn, delay = 5000) {
    setTimeout(() => fn().catch(() => this._queueRetry(fn, Math.min(delay * 2, 60000))), delay);
  }

  // ---------------------------------------------------------------- 내부
  async _fetch(pathname, opts = {}) {
    const res = await fetch(BASE + pathname, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    return res.json();
  }

  _loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; }
    catch (_) { return {}; }
  }

  _saveCache(hazards) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(hazards)); } catch (_) {}
  }

  _loadPlanCache() {
    try {
      const plan = JSON.parse(localStorage.getItem(PLAN_CACHE_KEY));
      this.backgroundImage = localStorage.getItem('fireguide:planImage') || null;
      return plan;
    } catch (_) { return null; }
  }

  _savePlanCache(plan) {
    try { localStorage.setItem(PLAN_CACHE_KEY, JSON.stringify(plan)); } catch (_) {}
  }
}
