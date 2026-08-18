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

  // 인체 차폐 — 2.4GHz 는 물에 잘 흡수된다. 폰과 비콘 사이에 사람이 있으면 깎인다.
  // 제자리에 서서 몸만 돌려도 추정 거리가 몇 배로 뛰는 원인이고, 이게 빠지면
  // 시뮬레이션이 실제보다 한참 낙관적으로 나온다.
  bodyBlockRate: 0.3,
  bodyBlockDb: 14,

  // 벽 관통 손실 — 콘크리트 벽 하나에 10~15dB.
  // 직선거리만 쓰면 "벽 너머 3m"와 "복도 3m"가 같은 세기가 되어, 실제로는
  // 안 잡히는 비콘이 시뮬레이션에서는 1등이 된다. 배치 개수 판단이 통째로 틀어진다.
  wallLossDb: 12,
  wallDetourRatio: 1.6,  // 걸어서 가는 거리가 직선의 이 배를 넘으면 사이에 벽이 있다고 본다
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
  const cfg = { ...SIM_DEFAULTS, ...opts };
  const { txPower, pathLossExp, noiseDb, rangeM, dropRate } = cfg;
  const rng = opts.rng ?? Math.random;
  const scans = [];
  const walk = opts.walkDistance ?? walkDistanceFrom(floorPlan, pos);

  for (const node of floorPlan.beaconNodes()) {
    const meters = Math.hypot(node.x - pos.x, node.y - pos.y) * floorPlan.metersPerUnit;
    if (meters > rangeM) continue;
    if (rng() < dropRate) continue;

    // 로그-거리 모델. 0.5m 미만은 근거리 왜곡이 심해 하한을 둔다
    let rssi = txPower
      - 10 * pathLossExp * Math.log10(Math.max(meters, 0.5))
      + (rng() * 2 - 1) * noiseDb;

    // 벽 — 걸어서 돌아가야 하는 거리가 직선보다 훨씬 길면 사이가 막혀 있다는 뜻이다.
    // 도면에 벽 다각형이 없어도 그래프만으로 근사할 수 있다.
    const detour = walk.get(node.id);
    if (Number.isFinite(detour) && meters > 1 && detour / meters > cfg.wallDetourRatio) {
      const walls = Math.min(3, Math.floor(detour / meters / cfg.wallDetourRatio));
      rssi -= cfg.wallLossDb * walls;
    }

    // 사람 몸이 가리는 경우
    if (rng() < cfg.bodyBlockRate) rssi -= cfg.bodyBlockDb;

    if (rssi < -95) continue;   // 너무 약하면 아예 안 잡힌다
    scans.push({ beaconId: node.beaconId, rssi: Math.round(rssi * 10) / 10, ts: now });
  }
  return scans;
}

/**
 * 현재 위치에서 각 비콘 노드까지 **걸어서 가는 거리**(m).
 *
 * 직선거리와 비교해 「사이에 벽이 있나」를 가늠하는 데 쓴다. 복도를 따라 크게
 * 돌아가야 하는 곳은 대개 벽이 막고 있는 곳이다 — 도면에 벽 정보가 없어도
 * 그래프의 연결 관계만으로 그 사실을 알 수 있다.
 */
function walkDistanceFrom(floorPlan, pos) {
  const nodes = floorPlan.nodes;
  const mpu = floorPlan.metersPerUnit;
  const adj = new Map(nodes.map(n => [n.id, []]));
  for (const e of floorPlan.edges) {
    const a = floorPlan.getNode(e.a), b = floorPlan.getNode(e.b);
    if (!a || !b) continue;
    const w = Math.hypot(b.x - a.x, b.y - a.y) * mpu;
    adj.get(e.a)?.push([e.b, w]);
    adj.get(e.b)?.push([e.a, w]);
  }

  // 사용자와 제일 가까운 노드에서 출발해 다익스트라
  let start = null, sd = Infinity;
  for (const n of nodes) {
    const d = Math.hypot(n.x - pos.x, n.y - pos.y) * mpu;
    if (d < sd) { sd = d; start = n; }
  }
  const dist = new Map(nodes.map(n => [n.id, Infinity]));
  if (!start) return dist;
  dist.set(start.id, sd);

  const seen = new Set();
  while (seen.size < nodes.length) {
    let cur = null, best = Infinity;
    for (const [id, d] of dist) if (!seen.has(id) && d < best) { best = d; cur = id; }
    if (cur === null) break;
    seen.add(cur);
    for (const [next, w] of adj.get(cur) || []) {
      if (best + w < dist.get(next)) dist.set(next, best + w);
    }
  }
  return dist;
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
