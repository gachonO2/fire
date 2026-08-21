/**
 * 비콘 지도 만들기 — **걸으면서 비콘이 어디 있는지 알아낸다.**
 *
 * ## 왜 필요한가
 *
 * 건물 도면은 있는데(`planReader` 가 피난안내도에서 옮겨 적는다) 비콘이 어느 지점에
 * 있는지는 모른다. 지금은 사람이 지점마다 서서 태그해야 하는데, 층 하나에 지점이
 * 열댓 개면 지겹고 빠뜨리기 쉽다.
 *
 * **그냥 걸으면 채워지게** 하는 것이 여기 목적이다.
 *
 * ## 폰과 맥이 반쪽씩 낸다
 *
 *   폰   걸음 + 도면  →  "지금 복도 중앙쯤"     (BLE 를 못 읽는다)
 *   맥   BLE 스캔     →  "6760CC10 이 −46"     (자기 위치를 모른다)
 *
 * 둘을 **같은 시각으로 합치면** "복도 중앙에서 6760CC10 이 −46 이었다"가 되고,
 * 이게 여러 번 쌓이면 비콘 위치가 나온다.
 *
 * ## 가장 셌던 자리가 곧 비콘 자리다
 *
 * 거리 환산은 하지 않는다(실내 반사·감쇠로 3~5m 씩 틀린다). 대신 **어디서 가장
 * 세게 들렸나**만 본다. 그 지점 근처에 비콘이 있다.
 *
 * 그래서 가중치를 신호 세기의 **상대 전력**으로 준다. 최댓값보다 10dB 약한 표본은
 * 1/10, 20dB 약하면 1/100 만 반영된다. 멀리서 스친 값이 결과를 끌고 가지 못한다.
 *
 * ## 폰 위치가 틀리면 비콘 위치도 틀린다
 *
 * 순환처럼 보이지만 아니다. 도면 그래프가 폰을 복도 안에 가둬 두므로 오차가
 * 무한정 자라지 않고, 같은 자리를 여러 번 지나며 평균 내면 줄어든다.
 * 다만 **폰이 자기 위치를 못 믿는 동안의 관측은 버린다** — 쓰레기 위치로 비콘을
 * 놓으면 그 뒤로 계속 틀린 곳을 가리키게 되고, 그건 안 만드느니만 못하다.
 */

export const BEACON_MAP_DEFAULTS = {
  /** 폰 확신도가 이보다 낮을 때의 관측은 버린다 */
  minConfidence: 0.5,
  /** 비콘 하나가 들고 있는 표본 상한 (오래된 것부터 버린다) */
  maxSamples: 400,
  /** 이보다 약한 신호는 아예 안 받는다 — 건물 반대편에서 스친 값 */
  minRssi: -95,
  /** 이만큼 표본이 모여야 추정값을 내놓는다 */
  minSamples: 8,
  /**
   * 가중치가 1/e 로 떨어지는 신호 차이(dB).
   * 작을수록 "가장 셌던 순간"만 보고, 클수록 넓게 평균 낸다.
   */
  falloffDb: 6,
};

export class BeaconMapper {
  /**
   * @param {FloorPlan} floorPlan 지점에 붙일 도면
   */
  constructor(floorPlan, opts = {}) {
    this.opts = { ...BEACON_MAP_DEFAULTS, ...opts };
    this.plan = floorPlan;
    this.samples = new Map();   // beaconId -> [{x, y, rssi, w}]
  }

  setFloorPlan(plan) { this.plan = plan; }

  /**
   * 관측 하나 — "이 위치에서 이 비콘들이 이렇게 들렸다".
   * @param {{x:number,y:number}} pos 폰이 말하는 지금 위치
   * @param {Array<{beaconId:string, rssi:number}>} readings 맥이 잡은 신호
   * @param {number} confidence 폰의 위치 확신도 0~1
   * @returns {number} 실제로 받아들인 관측 수
   */
  observe(pos, readings, confidence = 1) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return 0;
    if (confidence < this.opts.minConfidence) return 0;

    let taken = 0;
    for (const r of readings || []) {
      if (!r?.beaconId || !Number.isFinite(r.rssi)) continue;
      if (r.rssi < this.opts.minRssi) continue;

      let arr = this.samples.get(r.beaconId);
      if (!arr) this.samples.set(r.beaconId, (arr = []));
      // 확신도를 가중치에 함께 실어, 애매한 위치의 관측은 덜 반영한다
      arr.push({ x: pos.x, y: pos.y, rssi: r.rssi, conf: confidence });
      if (arr.length > this.opts.maxSamples) arr.shift();
      taken++;
    }
    return taken;
  }

  /**
   * 지금까지 모은 것으로 비콘 위치를 추정한다.
   * @returns {Array<{beaconId, x, y, nodeId, nodeName, samples, bestRssi, spreadM, ready}>}
   */
  estimates() {
    const out = [];
    for (const [beaconId, arr] of this.samples) {
      if (arr.length < this.opts.minSamples) {
        out.push({ beaconId, samples: arr.length, ready: false });
        continue;
      }

      const best = Math.max(...arr.map(s => s.rssi));
      let sw = 0, sx = 0, sy = 0;
      for (const s of arr) {
        // 최댓값 대비 얼마나 약한가로 가중치. 멀리서 스친 값은 거의 안 반영된다.
        const w = Math.exp((s.rssi - best) / this.opts.falloffDb) * s.conf;
        sw += w; sx += s.x * w; sy += s.y * w;
      }
      if (sw <= 0) { out.push({ beaconId, samples: arr.length, ready: false }); continue; }

      const x = sx / sw, y = sy / sw;

      // 흩어진 정도 — 이게 크면 아직 못 믿는다(여러 곳에서 비슷하게 들렸다는 뜻)
      let sv = 0;
      for (const s of arr) {
        const w = Math.exp((s.rssi - best) / this.opts.falloffDb) * s.conf;
        sv += w * ((s.x - x) ** 2 + (s.y - y) ** 2);
      }
      const spreadM = Math.sqrt(sv / sw) * (this.plan?.metersPerUnit ?? 1);

      const node = this._nearestNode(x, y);
      out.push({
        beaconId, x, y,
        nodeId: node?.id ?? null,
        nodeName: node?.name ?? null,
        samples: arr.length,
        bestRssi: best,
        spreadM,
        ready: true,
      });
    }
    return out.sort((a, b) => (b.samples || 0) - (a.samples || 0));
  }

  /**
   * 도면 편집기에 그대로 넣을 수 있는 매핑.
   * 흩어짐이 큰 것은 뺀다 — 반쯤 확신하는 매핑은 없느니만 못하다.
   */
  mapping(maxSpreadM = 6) {
    const map = {};
    for (const e of this.estimates()) {
      if (!e.ready || e.spreadM > maxSpreadM || !e.nodeId) continue;
      // 한 지점에 여러 비콘이 붙을 수 있다. 그건 정상이다(도면이 id 중복만 막는다).
      map[e.beaconId] = e.nodeId;
    }
    return map;
  }

  reset() { this.samples.clear(); }

  _nearestNode(x, y) {
    let best = null, bd = Infinity;
    for (const n of this.plan?.nodes || []) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }
}
