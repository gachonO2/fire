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
import { DEFAULT_PLAN } from '../shared/default-plan.js';

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
      alerts: [], sensors: [], plan: [], fires: [], status: [],
    };
    this._es = null;
    this._reopenTimer = null;
    this._watchdog = null;
    this._retryDelay = 1000;

    // 통신이 끊겨도 안내를 이어가려면 도면이 손에 있어야 한다.
    // 마지막으로 받은 도면 → 없으면 번들된 기본 도면 순으로 사용한다.
    this.floorPlan = new FloorPlan(this._loadPlanCache() || DEFAULT_PLAN);
    this.backgroundImage = localStorage.getItem('fireguide:planImage') || null;
  }

  /** 서버의 활성 도면을 받아온다. 실패하면 캐시된 도면을 유지한다. */
  async loadFloorPlan() {
    try {
      const plan = await this._fetch('/api/map');
      this._setPlan(plan);
      // JSON이 캐시와 같아도 설계도 이미지가 새로 등록되었을 수 있다.
      await this._loadPlanImage(plan.id);
    } catch (_) { /* 오프라인 — 캐시/기본 도면 사용 */ }
    return this.floorPlan;
  }

  _setPlan(plan) {
    if (!plan?.nodes?.length) return;
    const changed = JSON.stringify(this.floorPlan.toJSON()) !== JSON.stringify(plan);
    this.floorPlan = new FloorPlan(plan);
    this._savePlanCache(plan);
    if (changed) this._loadPlanImage(plan.id);
    return changed;
  }

  async _loadPlanImage(planId) {
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
    clearTimeout(this._reopenTimer);
    this._reopenTimer = null;

    const url = this.code
      ? `${BASE}/api/stream?code=${encodeURIComponent(this.code)}`
      : `${BASE}/api/stream`;
    const es = new EventSource(url);
    this._es = es;
    // 서버는 연결 직후 각 주제의 현재 상태를 한 번 보낸다.
    // 이 첫 묶음은 새 사건이 아니라 화면 동기화라는 사실을 구독자에게 알려 준다.
    const receivedTopics = new Set();

    // 브라우저 자동 재연결이 안 되는 경우를 대비한 감시자 (아래 onerror 설명 참고)
    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => {
      if (this._es?.readyState === EventSource.CLOSED) this._scheduleReopen();
    }, 5000);

    for (const topic of ['hazards', 'sos', 'positions', 'metrics', 'alerts', 'sensors', 'plan', 'fires']) {
      es.addEventListener(topic, e => {
        const data = JSON.parse(e.data);
        const initial = !receivedTopics.has(topic);
        receivedTopics.add(topic);
        if (topic === 'hazards') {
          this.hazards = data;
          this._saveCache(data);
        }
        // 관제에서 다른 도면을 활성화하면 여기로 내려온다
        if (topic === 'plan') this._setPlan(data);
        this._setOnline(true);
        this._emit(topic, data, { initial, source: 'stream' });
      });
    }

    /**
     * EventSource는 "연결이 끊긴" 경우에만 스스로 재연결한다.
     * 서버가 200이 아닌 응답을 주면 — 백엔드가 죽었을 때 개발 서버 프록시가 내리는
     * 503이 정확히 이 경우다 — 재연결하지 않고 **영구히 닫힌다**.
     * 그러면 백엔드가 다시 살아나도 화면은 계속 "연결 끊김"에 머문다.
     * 그래서 닫힌 것을 직접 감지해 백오프를 두고 다시 연다.
     */
    es.onerror = () => {
      this._setOnline(false);
      if (es.readyState === EventSource.CLOSED) this._scheduleReopen();
    };

    es.onopen = () => {
      this._retryDelay = 1000; // 성공했으니 백오프 초기화
      // 재연결 시 저장소 표시가 "연결 안 됨"에 머물지 않도록 health를 다시 읽는다
      if (!this.online) this._checkHealth();
    };
  }

  /** 끊긴 스트림을 1초 → 2초 → … 최대 10초 간격으로 다시 연다 */
  _scheduleReopen() {
    if (this._reopenTimer) return;
    const delay = this._retryDelay || 1000;
    this._retryDelay = Math.min(delay * 2, 10000);
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = null;
      this._openStream();
    }, delay);
  }

  _setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    this._emit('status', { online: v, storage: this.storage });
  }

  on(topic, cb) {
    this.listeners[topic].push(cb);
    if (topic === 'hazards' && Object.keys(this.hazards).length) {
      queueMicrotask(() => cb(this.hazards, { initial: true, source: 'cache' }));
    }
    return () => {
      this.listeners[topic] = this.listeners[topic].filter(f => f !== cb);
    };
  }

  _emit(topic, data, meta = {}) {
    this.listeners[topic].forEach(cb => cb(data, meta));
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
  setHazard(edgeId, type) {
    return this._fetch(`/api/hazards/${edgeId}`, { method: 'PUT', body: JSON.stringify({ type }) });
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

  // ------------------------------------------------------- 화재 발생 지점
  /** 도면의 임의 좌표에 불을 낸다. 어떤 통로가 막히는지는 서버가 판정한다. */
  startFire({ x, y, radius, label }) {
    return this._fetch('/api/fires', {
      method: 'POST', body: JSON.stringify({ x, y, radius, label }),
    });
  }

  getFires() { return this._fetch('/api/fires'); }

  updateFireRadius(fireId, radius) {
    return this._fetch(`/api/fires/${encodeURIComponent(fireId)}`, {
      method: 'PUT', body: JSON.stringify({ radius }),
    });
  }

  removeFire(fireId) {
    return this._fetch(`/api/fires/${encodeURIComponent(fireId)}`, { method: 'DELETE' });
  }

  resetFires() { return this._fetch('/api/fires/reset', { method: 'POST' }); }

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
