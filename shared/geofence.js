/**
 * 입구 판정 — **건물에 들어온 순간을 잡아 출발 지점을 확정한다.**
 *
 * ## 왜 필요한가
 *
 * 대피를 시작하는 순간 사용자는 **서 있다.** 걸음도 지자기도 그때는 아무것도 못
 * 한다(둘 다 걸어야 성립한다). 그 첫 1~2초를 메우는 것이 즉시 확정 단서고,
 * 비콘이 없는 건물에서는 **입구가 유일한 공짜 앵커**다.
 *
 * ## GPS 오차가 15m 여도 된다
 *
 * 이게 핵심이다. GPS 는 실내로 들어가면 죽지만 **문 앞에서 마지막으로 잡힌 좌표**는
 * 남는다. 그 값의 오차가 15m 라도, 그 반경 안에 **문이 하나뿐이면 지도가 정확히
 * 짚어 준다.** 좌표를 주는 게 아니라 "어느 문으로 들어왔나"를 주는 것이다.
 *
 * 반대로 반경 안에 문이 둘이면 고르지 않는다. 반쯤 확신하는 앵커는 없느니만 못하다 —
 * 잘못 고르면 건물 반대편에서 출발하는 경로가 나온다.
 *
 * ## 도면에 위경도가 있어야 한다
 *
 * 도면 좌표(x, y)는 그림 안에서만 뜻이 있다. 실제 지구 위 어디인지는
 * `plan.geo` 와 출구 노드의 `geo` 가 알려준다. 없으면 이 계층은 조용히 쉰다 —
 * 모르는 채로 추측하면 엉뚱한 문을 짚는다.
 *
 * ## 시간을 부르지 않는다
 *
 * 다른 측위 계층과 같은 원칙. 판정에 필요한 값은 전부 인자로 받는다.
 */

/** 지구 반지름(m) */
const R = 6371000;

/** 두 위경도 사이의 거리(m) */
export function haversineM(a, b) {
  if (!a || !b) return Infinity;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export const GEOFENCE_DEFAULTS = {
  /** GPS 오차에 더해 주는 여유(m). 문 앞에 정확히 서서 잡히지는 않는다 */
  marginM: 12,
  /** 오차가 이보다 나쁘면 아예 쓰지 않는다 — 건물 하나를 통째로 덮는 값이다 */
  maxAccuracyM: 60,
  /**
   * 1등 문과 2등 문이 이만큼은 벌어져야 고른다.
   *
   * 두 문이 8m 옆에 붙어 있으면 GPS 로는 절대 못 가른다. 그때는 고르지 않는 것이
   * 맞다 — 반쯤 맞는 출발점으로 만든 경로는 안 만드느니만 못하다.
   */
  minSeparationM: 25,
};

/**
 * 건물의 지오펜스 — OS 에 등록할 원.
 * @returns {{lat, lon, radiusM}|null} 도면에 위경도가 없으면 null
 */
export function buildingFence(plan, opts = {}) {
  const geo = plan?.geo || plan?.plan?.geo;
  if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) return null;
  // iOS 는 반경이 작으면 진입을 놓친다. 100m 아래로는 내리지 않는다.
  return { lat: geo.lat, lon: geo.lon, radiusM: Math.max(100, geo.radiusM ?? 120) };
}

/** 위경도가 붙어 있는 출입구들 */
export function geoEntrances(floorPlan) {
  return (floorPlan?.nodes || [])
    .filter(n => n.type === 'exit' && Number.isFinite(n.geo?.lat) && Number.isFinite(n.geo?.lon));
}

/**
 * 지금 GPS 좌표로 **어느 문으로 들어왔는지** 고른다.
 *
 * @param {FloorPlan} floorPlan
 * @param {{lat, lon, accuracy}} fix GPS 한 번. accuracy 는 m 단위 오차 반경.
 * @param {Object} opts GEOFENCE_DEFAULTS 덮어쓰기
 * @returns {{nodeId, distanceM, candidates, reason}|null}
 *   고르지 못하면 nodeId 가 null 이고 reason 에 이유가 담긴다.
 */
export function resolveEntrance(floorPlan, fix, opts = {}) {
  const o = { ...GEOFENCE_DEFAULTS, ...opts };
  const doors = geoEntrances(floorPlan);
  if (doors.length === 0) return { nodeId: null, reason: '도면 출구에 위경도가 없습니다' };
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) {
    return { nodeId: null, reason: 'GPS 좌표가 없습니다' };
  }

  const acc = Number.isFinite(fix.accuracy) ? fix.accuracy : o.maxAccuracyM;
  if (acc > o.maxAccuracyM) {
    return { nodeId: null, reason: `GPS 오차가 큽니다 (${Math.round(acc)}m)` };
  }

  const ranked = doors
    .map(n => ({ nodeId: n.id, name: n.name, distanceM: haversineM(fix, n.geo) }))
    .sort((a, b) => a.distanceM - b.distanceM);

  const reach = acc + o.marginM;
  const inReach = ranked.filter(d => d.distanceM <= reach);

  if (inReach.length === 0) {
    return { nodeId: null, candidates: ranked, reason: '가까운 출입구가 없습니다 (아직 건물 밖)' };
  }

  // 반경 안에 하나뿐이면 오차가 커도 확정이다 — 지도가 좁혀 준 것이다
  if (inReach.length === 1) {
    return { nodeId: inReach[0].nodeId, distanceM: inReach[0].distanceM, candidates: ranked };
  }

  // 둘 이상이면 1등이 확실히 앞설 때만 고른다
  const gap = inReach[1].distanceM - inReach[0].distanceM;
  if (gap < o.minSeparationM) {
    return {
      nodeId: null, candidates: ranked,
      reason: `출입구 ${inReach.length}곳이 비슷하게 가깝습니다 (차이 ${Math.round(gap)}m)`,
    };
  }
  return { nodeId: inReach[0].nodeId, distanceM: inReach[0].distanceM, candidates: ranked };
}
