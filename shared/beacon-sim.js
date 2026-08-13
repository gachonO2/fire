/**
 * 가상 비콘 — 비콘 기기가 없어도 측위 파이프라인 전체를 돌리기 위한 신호 생성기.
 *
 * 도면 위 가상 사용자 좌표에서 각 비콘 노드까지의 거리를 재고,
 * 로그-거리 경로손실 모델로 RSSI를 만든 뒤 실측 수준의 노이즈를 섞는다.
 * 출력 형식이 실제 BLE 스캔과 같으므로({beaconId, rssi, ts}) BeaconLocator는
 * 입력이 가짜인지 모른다 — 기기가 생기면 이 모듈만 스캔 API로 바뀐다.
 *
 * 노이즈를 실측(±6dB)보다 줄이지 말 것. 시뮬레이션에서만 통과하는 측위는
 * 현장에서 처음 실패하고, 그때는 원인을 노이즈인지 로직인지 가릴 수 없다.
 *
 * rng를 인자로 받는 이유: 테스트가 시드 고정 난수로 같은 시퀀스를 재현해야
 * "이 노이즈에서 깜빡이지 않는다"를 단언할 수 있다.
 */

export const SIM_DEFAULTS = {
  txPower: -59,     // 1m 거리 기준 RSSI(dBm) — iBeacon 보정값 관례
  pathLossExp: 2.5, // 경로손실 지수 — 자유공간 2.0, 실내 복도 2.5~3.0
  noiseDb: 6,       // 균등 노이즈 진폭(±dB) — 실내 실측 수준
  rangeM: 25,       // 수신 한계 거리 — BLE 비콘 실내 실효 범위
  dropRate: 0.15,   // 광고 패킷 유실률 — 스캔 주기와 어긋나 못 받는 몫
};

/**
 * 한 번의 스캔 주기 결과를 만든다.
 * @param {FloorPlan} floorPlan  beaconId 붙은 노드가 있는 도면
 * @param {{x,y}} pos            가상 사용자 좌표 (도면 단위)
 * @param {number} now           스캔 시각(ms)
 * @param {Object} opts          SIM_DEFAULTS 덮어쓰기 + { rng }
 * @returns {Array<{beaconId, rssi, ts}>}
 */
export function simulateScan(floorPlan, pos, now, opts = {}) {
  const { txPower, pathLossExp, noiseDb, rangeM, dropRate } = { ...SIM_DEFAULTS, ...opts };
  const rng = opts.rng ?? Math.random;
  const scans = [];

  for (const node of floorPlan.beaconNodes()) {
    const meters = Math.hypot(node.x - pos.x, node.y - pos.y) * floorPlan.metersPerUnit;
    if (meters > rangeM) continue;
    if (rng() < dropRate) continue;

    // 로그-거리 모델. 0.5m 미만은 근거리 왜곡이 심해 하한을 둔다
    const rssi = txPower
      - 10 * pathLossExp * Math.log10(Math.max(meters, 0.5))
      + (rng() * 2 - 1) * noiseDb;
    scans.push({ beaconId: node.beaconId, rssi: Math.round(rssi * 10) / 10, ts: now });
  }
  return scans;
}

/**
 * 경로를 따라 걷는 가상 사용자의 좌표.
 * @param {FloorPlan} floorPlan
 * @param {string[]} nodeIds   지나갈 노드 순서 (경로탐색 결과의 route.nodes)
 * @param {number} progress    0(출발)~1(도착)
 * @returns {{x,y}}
 */
export function positionAlongRoute(floorPlan, nodeIds, progress) {
  const pts = nodeIds.map(id => floorPlan.getNode(id));
  const segs = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segs.push(len);
    total += len;
  }
  if (total === 0) return { x: pts[0].x, y: pts[0].y };

  let remain = Math.min(Math.max(progress, 0), 1) * total;
  for (let i = 0; i < segs.length; i++) {
    if (remain <= segs[i]) {
      const t = segs[i] === 0 ? 0 : remain / segs[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * t,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * t,
      };
    }
    remain -= segs[i];
  }
  return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
}

/** 시드 고정 난수(mulberry32) — 테스트·재현용 */
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
