/**
 * 가상 비콘 — 비콘 기기를 사기 전에 측위 전체를 돌려보기 위한 신호 생성기.
 *
 * 도면 위 가상 사용자 좌표에서 각 비콘까지의 거리를 재고, 로그-거리 경로손실
 * 모델로 RSSI 를 만든 뒤 실측 수준의 노이즈를 섞는다. 출력이 실제 BLE 스캔과
 * 같은 모양이라({beaconId, rssi, ts}) BeaconLocator 는 입력이 가짜인지 모른다.
 * 실기기가 생기면 이 모듈만 실제 스캔으로 바뀌고 나머지는 그대로다.
 *
 * **노이즈를 실측(±6dB)보다 줄이지 말 것.** 시뮬레이션에서만 통과하는 측위는
 * 현장에서 처음 실패하고, 그때는 원인이 노이즈인지 로직인지 가릴 수 없다.
 */

export const SIM_DEFAULTS = {
  txPower: -59,     // 1m 거리 기준 RSSI(dBm) — iBeacon 보정값 관례
  pathLossExp: 2.5, // 경로손실 지수 — 자유공간 2.0, 실내 복도 2.5~3.0
  noiseDb: 6,       // 균등 노이즈 진폭(±dB)
  rangeM: 25,       // 수신 한계 — BLE 실내 실효 범위
  dropRate: 0.15,   // 광고 패킷 유실률
};

/** 비콘이 붙은 지점들. 도면에 비콘 id 가 없으면 빈 배열 */
export function beaconNodes(plan) {
  return (plan?.nodes || []).filter(n => n.beaconId);
}

/**
 * 비콘을 아직 안 단 도면이면 지점마다 가상 비콘이 있다고 치고 돌린다.
 *
 * 도면을 올릴 때마다 편집기로 돌아가 비콘 id 를 타이핑해야 한다면 아무도 이
 * 기능을 켜보지 않는다. 실제 설치 전에 "달면 이렇게 된다"를 먼저 보여줄 수
 * 있어야 설치 여부를 판단할 수 있다.
 *
 * 엘리베이터는 뺀다 — 화재 시 목적지가 될 수 없어 거기 서 있을 일이 없다.
 */
export function withVirtualBeacons(plan) {
  if (beaconNodes(plan).length > 0) return plan;
  return {
    ...plan,
    nodes: (plan?.nodes || []).map(n =>
      n.type === 'elevator' ? n : { ...n, beaconId: `SIM-${n.id}` }),
  };
}

/**
 * 한 번의 스캔 주기 결과.
 * @param plan  비콘 id 가 채워진 도면
 * @param pos   가상 사용자 좌표 {x, y} (도면 단위)
 * @param now   스캔 시각(ms)
 */
export function simulateScan(plan, pos, now, opts = {}) {
  const { txPower, pathLossExp, noiseDb, rangeM, dropRate } = { ...SIM_DEFAULTS, ...opts };
  const rng = opts.rng ?? Math.random;
  const mpu = plan?.metersPerUnit ?? 1;
  const scans = [];

  for (const node of beaconNodes(plan)) {
    const meters = Math.hypot(node.x - pos.x, node.y - pos.y) * mpu;
    if (meters > rangeM) continue;
    if (rng() < dropRate) continue;

    // 0.5m 미만은 근거리 왜곡이 심해 하한을 둔다
    const rssi = txPower
      - 10 * pathLossExp * Math.log10(Math.max(meters, 0.5))
      + (rng() * 2 - 1) * noiseDb;
    scans.push({ beaconId: node.beaconId, rssi: Math.round(rssi * 10) / 10, ts: now });
  }
  return scans;
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
