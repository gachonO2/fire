import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { publish } from '../events.js';
import { generateCode, normalizeCode } from '../guardian-code.js';

/**
 * Firestore 저장소 (firebase-admin).
 * 컬렉션: hazards / sos / positions / metrics
 *
 * onSnapshot 리스너를 서버가 대신 유지하고 변경을 SSE로 밀어주므로,
 * 프론트엔드는 Firebase SDK나 API 키를 전혀 갖지 않는다.
 * (자격증명이 브라우저에 노출되지 않는 것이 클라이언트 직결 방식 대비 이점)
 */
export class FirestoreRepo {
  constructor() {
    this.mode = 'firestore';
  }

  async init() {
    const credential = config.credentialsPath
      ? cert(JSON.parse(readFileSync(config.credentialsPath, 'utf8')))
      : applicationDefault();

    initializeApp({ credential, projectId: config.firebaseProjectId });
    this.db = getFirestore();
    this.db.settings({ ignoreUndefinedProperties: true });

    this._watch('hazards', snap => {
      const hazards = {};
      snap.forEach(d => {
        const v = d.data();
        if (v.active) hazards[d.id] = v;
      });
      publish('hazards', hazards);
    });

    this._watch('sos', snap => publish('sos', snap.docs.map(d => d.data())), {
      orderBy: ['ts', 'desc'], limit: 50,
    });

    this._watch('positions', snap =>
      publish('positions', snap.docs.map(d => ({ userId: d.id, ...d.data() }))));

    this._watch('metrics', snap => publish('metrics', snap.docs.map(d => d.data())), {
      orderBy: ['ts', 'desc'], limit: 50,
    });

    this._watch('alerts', snap => publish('alerts', snap.docs.map(d => d.data())), {
      orderBy: ['ts', 'desc'], limit: 50,
    });

    this._watch('sensors', snap => publish('sensors', snap.docs.map(d => d.data())));

    const existing = await this.db.collection('hazards').limit(1).get();
    if (existing.empty) await this.resetHazards();
  }

  // ------------------------------------------------------------------ plans
  async _activePlanId() {
    const doc = await this.db.collection('config').doc('settings').get();
    return doc.exists ? doc.data().activePlanId : null;
  }

  async getActivePlan() {
    // 없으면 null — 없는데 있는 척하면 엉뚱한 건물을 안내한다
    const id = await this._activePlanId();
    return id ? (await this.getPlan(id)) || null : null;
  }

  async getPlan(planId) {
    const doc = await this.db.collection('plans').doc(planId).get();
    return doc.exists ? doc.data() : null;
  }

  async listPlans() {
    const activeId = await this._activePlanId();
    const snap = await this.db.collection('plans').get();
    const images = await this.db.collection('planImages').get();
    const withImage = new Set(images.docs.map(d => d.id));
    return snap.docs.map(d => {
      const p = d.data();
      return {
        id: p.id,
        name: p.name,
        nodeCount: p.nodes.length,
        edgeCount: p.edges.length,
        hasImage: withImage.has(p.id),
        active: p.id === activeId,
        // 앱에서 올라온 초안인지. 편집기가 "확인 필요"로 표시하고, 활성화는 막힌다.
        draft: Boolean(p.draft),
        readConfidence: p.readConfidence || null,
        updatedAt: p.updatedAt,
      };
    });
  }

  async savePlan(plan) {
    const doc = { ...plan, updatedAt: Date.now() };
    await this.db.collection('plans').doc(plan.id).set(doc);
    if (plan.id === (await this._activePlanId())) publish('plan', doc);
    return doc;
  }

  async deletePlan(planId) {
    await this.db.collection('plans').doc(planId).delete();
    await this.db.collection('planImages').doc(planId).delete().catch(() => {});
  }

  async activatePlan(planId) {
    const plan = await this.getPlan(planId);
    if (!plan) return null;
    await this.db.collection('config').doc('settings').set({ activePlanId: planId }, { merge: true });
    // 도면이 바뀌면 이전 도면의 통로 ID로 걸려 있던 위험은 의미가 없다
    await this.resetHazards();
    await this.clearSensors();
    publish('plan', plan);
    return plan;
  }

  async getPlanImage(planId) {
    const doc = await this.db.collection('planImages').doc(planId).get();
    return doc.exists ? doc.data().dataUri : null;
  }

  async setPlanImage(planId, dataUri) {
    await this.db.collection('planImages').doc(planId).set({ dataUri, updatedAt: Date.now() });
  }

  // ---------------------------------------------------------------- sensors
  async getSensors() {
    const snap = await this.db.collection('sensors').get();
    return snap.docs.map(d => d.data());
  }

  async setSensorReading(reading) {
    const doc = { ...reading, ts: Date.now() };
    await this.db.collection('sensors').doc(reading.sensorId).set(doc);
    return doc;
  }

  async removeSensor(sensorId) {
    await this.db.collection('sensors').doc(sensorId).delete();
  }

  async clearSensors() {
    const snap = await this.db.collection('sensors').get();
    const batch = this.db.batch();
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  _watch(name, handler, opts = {}) {
    let q = this.db.collection(name);
    if (opts.orderBy) q = q.orderBy(...opts.orderBy);
    if (opts.limit) q = q.limit(opts.limit);
    q.onSnapshot(handler, err => console.error(`[firestore] ${name} 구독 오류:`, err.message));
  }

  // ---------------------------------------------------------------- hazards
  async getHazards() {
    const snap = await this.db.collection('hazards').get();
    const hazards = {};
    snap.forEach(d => {
      const v = d.data();
      if (v.active) hazards[d.id] = v;
    });
    return hazards;
  }

  async setHazard(edgeId, hazard) {
    await this.db.collection('hazards').doc(edgeId)
      .set({ ...hazard, active: true, updatedAt: Date.now() });
  }

  async clearHazard(edgeId) {
    await this.db.collection('hazards').doc(edgeId).delete();
  }

  async resetHazards() {
    const batch = this.db.batch();
    const snap = await this.db.collection('hazards').get();
    snap.forEach(d => batch.delete(d.ref));
    const plan = await this.getActivePlan();
    for (const [edgeId, h] of Object.entries(plan?.initialHazards || {})) {
      batch.set(this.db.collection('hazards').doc(edgeId),
        { ...h, active: true, updatedAt: Date.now() });
    }
    await batch.commit();
  }

  // -------------------------------------------------------------------- sos
  async getSOS() {
    const snap = await this.db.collection('sos').orderBy('ts', 'desc').limit(50).get();
    return snap.docs.map(d => d.data());
  }

  async addSOS(payload) {
    const doc = { ...payload, ts: Date.now(), serverTs: FieldValue.serverTimestamp() };
    await this.db.collection('sos').add(doc);
    return doc;
  }

  // -------------------------------------------------------------- positions
  async getPositions() {
    const snap = await this.db.collection('positions').get();
    return snap.docs.map(d => ({ userId: d.id, ...d.data() }));
  }

  async setPosition(userId, payload) {
    await this.db.collection('positions').doc(userId).set({ ...payload, ts: Date.now() });
  }

  // ---------------------------------------------------------------- metrics
  async getMetrics() {
    const snap = await this.db.collection('metrics').orderBy('ts', 'desc').limit(50).get();
    return snap.docs.map(d => d.data());
  }

  async addMetric(payload) {
    const doc = { ...payload, ts: Date.now() };
    await this.db.collection('metrics').add(doc);
    return doc;
  }

  // -------------------------------------------------------------- guardians
  async getGuardian(userId) {
    const doc = await this.db.collection('guardians').doc(userId).get();
    return doc.exists ? doc.data() : null;
  }

  async getGuardianByCode(code) {
    const snap = await this.db.collection('guardians')
      .where('code', '==', normalizeCode(code)).limit(1).get();
    return snap.empty ? null : snap.docs[0].data();
  }

  /** 같은 사용자가 다시 등록하면 코드는 유지하고 이름·연락처만 갱신한다. */
  async setGuardian(userId, { name, contact }) {
    const existing = await this.getGuardian(userId);
    const doc = {
      userId,
      name,
      contact,
      code: existing?.code || generateCode(),
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    await this.db.collection('guardians').doc(userId).set(doc);
    return doc;
  }

  // ----------------------------------------------------------------- alerts
  async getAlerts() {
    const snap = await this.db.collection('alerts').orderBy('ts', 'desc').limit(50).get();
    return snap.docs.map(d => d.data());
  }

  async addAlert(payload) {
    const doc = { ...payload, ts: Date.now() };
    await this.db.collection('alerts').add(doc);
    return doc;
  }
}
