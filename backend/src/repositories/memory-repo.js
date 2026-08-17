import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publish } from '../events.js';
import { generateCode, normalizeCode } from '../guardian-code.js';

/**
 * 로컬 저장소 — Firebase 없이 쓰는 기본 모드.
 * FirestoreRepo와 동일한 인터페이스를 구현하므로 라우터는 둘을 구분하지 않는다.
 *
 * ## 예제 도면을 심지 않는다
 *
 * 예전에는 켜질 때마다 시연용 "병원 3층"을 심고 활성화했다. 그래서 실제 건물을
 * 등록해도 서버를 재시작하면 **병원으로 되돌아갔다.** 데모에는 편했지만 실제
 * 건물을 넣는 순간부터는 거짓말이 된다 — 앱이 있지도 않은 병원 복도를 안내한다.
 *
 * 이제 **빈 상태로 시작한다.** 도면이 없으면 안내를 하지 않고 그렇게 말한다.
 *
 * ## 도면은 파일로 남긴다
 *
 * 도면을 등록하려면 사람이 그 건물까지 가서 사진을 찍어야 한다. 서버를 껐다 켰다고
 * 그게 사라지면 다시 가야 한다. Firebase 없이도 살아남도록 JSON 파일에 적어둔다.
 * (위험 상태·구조요청 같은 화재 중 데이터는 일부러 안 남긴다 — 다음에 켤 때
 * 지난 화재가 되살아나면 안 된다.)
 */
/**
 * 저장 위치. 테스트는 `FIRE_DATA_DIR` 로 임시 폴더를 가리켜서
 * **운영 데이터를 건드리지 않는다** — 테스트가 심은 시연 도면이 실제 서버에
 * 남아 "병원 3층"으로 되돌아가는 일이 실제로 있었다.
 */
const DATA_DIR = process.env.FIRE_DATA_DIR || path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../../data',
);
const PLANS_FILE = path.join(DATA_DIR, 'plans.json');
export class MemoryRepo {
  constructor() {
    this.mode = 'memory';
    this.hazards = {};
    this.sos = [];
    this.positions = new Map();
    this.metrics = [];
    this.guardians = new Map(); // userId -> 보호자 정보
    this.alerts = [];
    this.plans = new Map();     // planId -> 도면
    this.planImages = new Map(); // planId -> data URI
    this.activePlanId = null;
    this.sensors = new Map();   // sensorId -> 온도 판독값
    this.fires = new Map();     // fireId -> 화재 발생 지점
    this.fireSeq = 1;
  }

  async init() {
    this._load();
    await this.resetHazards();
  }

  // ------------------------------------------------------------------ 파일 보존
  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(PLANS_FILE, 'utf8'));
      for (const p of raw.plans || []) this.plans.set(p.id, p);
      for (const [id, uri] of Object.entries(raw.images || {})) this.planImages.set(id, uri);
      this.activePlanId = raw.activePlanId || null;
      console.log(`[repo] 도면 ${this.plans.size}개 불러옴${this.activePlanId ? ` (사용 중: ${this.activePlanId})` : ''}`);
    } catch (_) {
      // 파일이 없으면 빈 상태로 시작한다. 예제 도면을 심지 않는다.
    }
  }

  _persist() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(PLANS_FILE, JSON.stringify({
        plans: [...this.plans.values()],
        images: Object.fromEntries(this.planImages),
        activePlanId: this.activePlanId,
      }));
    } catch (err) {
      // 저장에 실패해도 서비스는 계속돼야 한다. 다만 조용히 넘어가면
      // 재시작 후 도면이 사라진 이유를 아무도 모른다.
      console.error('[repo] 도면 저장 실패:', err.message);
    }
  }

  // ------------------------------------------------------------------ plans
  /** 활성 도면. **없으면 null** — 없는데 있는 척하면 엉뚱한 건물을 안내한다. */
  async getActivePlan() {
    return this.plans.get(this.activePlanId) || null;
  }

  async listPlans() {
    return [...this.plans.values()].map(p => ({
      id: p.id,
      name: p.name,
      nodeCount: p.nodes.length,
      edgeCount: p.edges.length,
      hasImage: this.planImages.has(p.id),
      active: p.id === this.activePlanId,
      // 앱에서 올라온 초안인지. 편집기가 "확인 필요"로 표시하고, 활성화는 막힌다.
      draft: Boolean(p.draft),
      readConfidence: p.readConfidence || null,
      updatedAt: p.updatedAt,
    }));
  }

  async getPlan(planId) {
    return this.plans.get(planId) || null;
  }

  async savePlan(plan) {
    const doc = { ...plan, updatedAt: Date.now() };
    this.plans.set(plan.id, doc);
    this._persist();
    publish('plan', await this.getActivePlan());
    return doc;
  }

  async deletePlan(planId) {
    this.plans.delete(planId);
    this.planImages.delete(planId);
    this._persist();
  }

  async activatePlan(planId) {
    if (!this.plans.has(planId)) return null;
    this.activePlanId = planId;
    this._persist();
    // 도면이 바뀌면 이전 도면의 통로 ID·좌표로 걸려 있던 위험은 의미가 없다
    await this.resetHazards();
    this.sensors.clear();
    publish('sensors', await this.getSensors());
    await this.clearFires();
    publish('plan', await this.getActivePlan());
    return this.plans.get(planId);
  }

  async getPlanImage(planId) {
    return this.planImages.get(planId) || null;
  }

  async setPlanImage(planId, dataUri) {
    this.planImages.set(planId, dataUri);
    this._persist();
  }

  // ---------------------------------------------------------------- hazards
  async getHazards() {
    return { ...this.hazards };
  }

  async setHazard(edgeId, hazard) {
    this.hazards[edgeId] = { ...hazard, active: true, updatedAt: Date.now() };
    publish('hazards', await this.getHazards());
  }

  async clearHazard(edgeId) {
    delete this.hazards[edgeId];
    publish('hazards', await this.getHazards());
  }

  async resetHazards() {
    this.hazards = {};
    const plan = await this.getActivePlan();
    for (const [edgeId, h] of Object.entries(plan?.initialHazards || {})) {
      this.hazards[edgeId] = { ...h, active: true, updatedAt: Date.now() };
    }
    publish('hazards', await this.getHazards());
  }

  // ---------------------------------------------------------------- sensors
  async getSensors() {
    return [...this.sensors.values()];
  }

  async setSensorReading(reading) {
    const doc = { ...reading, ts: Date.now() };
    this.sensors.set(reading.sensorId, doc);
    publish('sensors', await this.getSensors());
    return doc;
  }

  async removeSensor(sensorId) {
    this.sensors.delete(sensorId);
    publish('sensors', await this.getSensors());
  }

  async clearSensors() {
    this.sensors.clear();
    publish('sensors', await this.getSensors());
  }

  // ------------------------------------------------------------------ fires
  async getFires() {
    return [...this.fires.values()];
  }

  async addFire({ x, y, radius, label }) {
    const doc = { id: `F${this.fireSeq++}`, x, y, radius, label, startedAt: Date.now() };
    this.fires.set(doc.id, doc);
    publish('fires', await this.getFires());
    return doc;
  }

  async updateFire(fireId, patch) {
    const fire = this.fires.get(fireId);
    if (!fire) return null;
    const doc = { ...fire, ...patch };
    this.fires.set(fireId, doc);
    publish('fires', await this.getFires());
    return doc;
  }

  async removeFire(fireId) {
    this.fires.delete(fireId);
    publish('fires', await this.getFires());
  }

  async clearFires() {
    this.fires.clear();
    publish('fires', await this.getFires());
  }

  // -------------------------------------------------------------------- sos
  async getSOS() {
    return [...this.sos];
  }

  async addSOS(payload) {
    const doc = { ...payload, ts: Date.now() };
    this.sos.unshift(doc);
    this.sos = this.sos.slice(0, 50);
    publish('sos', await this.getSOS());
    return doc;
  }

  // -------------------------------------------------------------- positions
  async getPositions() {
    return [...this.positions.values()];
  }

  async setPosition(userId, payload) {
    this.positions.set(userId, { userId, ...payload, ts: Date.now() });
    publish('positions', await this.getPositions());
  }

  // ---------------------------------------------------------------- metrics
  async getMetrics() {
    return [...this.metrics];
  }

  async addMetric(payload) {
    const doc = { ...payload, ts: Date.now() };
    this.metrics.unshift(doc);
    this.metrics = this.metrics.slice(0, 50);
    publish('metrics', await this.getMetrics());
    return doc;
  }

  // -------------------------------------------------------------- guardians
  async getGuardian(userId) {
    return this.guardians.get(userId) || null;
  }

  async getGuardianByCode(code) {
    const wanted = normalizeCode(code);
    return [...this.guardians.values()].find(g => g.code === wanted) || null;
  }

  /** 같은 사용자가 다시 등록하면 코드는 유지하고 이름·연락처만 갱신한다. */
  async setGuardian(userId, { name, contact }) {
    const existing = this.guardians.get(userId);
    const doc = {
      userId,
      name,
      contact,
      code: existing?.code || generateCode(),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.guardians.set(userId, doc);
    return doc;
  }

  // ----------------------------------------------------------------- alerts
  async getAlerts() {
    return [...this.alerts];
  }

  async addAlert(payload) {
    const doc = { ...payload, ts: Date.now() };
    this.alerts.unshift(doc);
    this.alerts = this.alerts.slice(0, 50);
    publish('alerts', await this.getAlerts());
    return doc;
  }
}
