import { DEFAULT_PLAN } from '../../../shared/default-plan.js';
import { publish } from '../events.js';
import { generateCode, normalizeCode } from '../guardian-code.js';

/**
 * 인메모리 저장소 — Firebase 없이 시연할 때 쓰는 데모 모드.
 * FirestoreRepo와 동일한 인터페이스를 구현하므로 라우터는 둘을 구분하지 않는다.
 * (프로세스 재시작 시 초기화됨)
 */
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
  }

  async init() {
    await this.savePlan(DEFAULT_PLAN);
    this.activePlanId = DEFAULT_PLAN.id;
    await this.resetHazards();
  }

  // ------------------------------------------------------------------ plans
  async getActivePlan() {
    return this.plans.get(this.activePlanId) || DEFAULT_PLAN;
  }

  async listPlans() {
    return [...this.plans.values()].map(p => ({
      id: p.id,
      name: p.name,
      nodeCount: p.nodes.length,
      edgeCount: p.edges.length,
      hasImage: this.planImages.has(p.id),
      active: p.id === this.activePlanId,
      updatedAt: p.updatedAt,
    }));
  }

  async getPlan(planId) {
    return this.plans.get(planId) || null;
  }

  async savePlan(plan) {
    const doc = { ...plan, updatedAt: Date.now() };
    this.plans.set(plan.id, doc);
    publish('plan', await this.getActivePlan());
    return doc;
  }

  async deletePlan(planId) {
    this.plans.delete(planId);
    this.planImages.delete(planId);
  }

  async activatePlan(planId) {
    if (!this.plans.has(planId)) return null;
    this.activePlanId = planId;
    // 도면이 바뀌면 이전 도면의 통로 ID로 걸려 있던 위험은 의미가 없다
    await this.resetHazards();
    this.sensors.clear();
    publish('sensors', await this.getSensors());
    publish('plan', await this.getActivePlan());
    return this.plans.get(planId);
  }

  async getPlanImage(planId) {
    return this.planImages.get(planId) || null;
  }

  async setPlanImage(planId, dataUri) {
    this.planImages.set(planId, dataUri);
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
    for (const [edgeId, h] of Object.entries(plan.initialHazards || {})) {
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
