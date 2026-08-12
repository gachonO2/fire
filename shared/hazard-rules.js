/**
 * 통로 위험 판정 규칙 — 경로탐색이 어디를 피할지 결정하는 단일 기준.
 *
 * 위험의 출처는 두 가지다.
 *  1) 수동/관제 입력 (화재수신기 웹훅, 관제 대시보드 시뮬레이션)
 *  2) 온도 센서 판독값 — 이 파일의 임계값으로 자동 변환된다
 *
 * 두 출처를 합칠 때는 **더 위험한 쪽**을 채택한다. 센서가 정상이라고 해서
 * 관제가 막아둔 통로를 열어주면 안 되기 때문이다.
 */

import { pointToSegmentDistance } from './geometry.js';

// 통행 가능 여부와 우회 가중치
export const HAZARD_RULES = {
  fire:    { passable: false, severity: 5, label: '화재' },
  smoke:   { passable: false, severity: 4, label: '연기' },
  heat:    { passable: false, severity: 4, label: '과열' },  // 온도 센서 임계 초과
  blocked: { passable: false, severity: 3, label: '차단' },
  warm:    { passable: true,  severity: 2, penalty: 4.0, label: '온도 상승' },
  crowd:   { passable: true,  severity: 1, penalty: 5.0, label: '혼잡' },
};

/** 온도 임계값(°C) */
export const TEMP = {
  /** 이 온도 이상이면 통행 불가로 본다 (화재 확산 구간) */
  BLOCK: 60,
  /** 이 온도 이상이면 통행은 가능하되 강하게 회피한다 */
  WARN: 45,
  /** 이 시간(ms) 넘게 갱신이 없으면 판독값을 신뢰하지 않는다 */
  STALE_MS: 60_000,
};

/** 온도 판독값 → 위험 등급. 정상이면 null */
export function temperatureHazard(celsius) {
  if (!Number.isFinite(celsius)) return null;
  if (celsius >= TEMP.BLOCK) return 'heat';
  if (celsius >= TEMP.WARN) return 'warm';
  return null;
}

export function isStale(reading, now = Date.now()) {
  return !reading?.ts || now - reading.ts > TEMP.STALE_MS;
}

/**
 * 온도 센서 판독값을 통로 위험 맵으로 변환한다.
 * 센서는 통로(edgeId) 또는 지점(nodeId)에 붙는다.
 * 지점 센서가 과열되면 그 지점에 연결된 모든 통로를 막는다 —
 * 교차점이 뜨거우면 어느 방향으로도 지나갈 수 없기 때문이다.
 *
 * @param {Array} sensors  [{ sensorId, edgeId?, nodeId?, celsius, ts }]
 * @param {FloorPlan} floorPlan
 * @returns {Object} edgeId -> { type, label, celsius, sensorId }
 */
export function hazardsFromSensors(sensors = [], floorPlan, now = Date.now()) {
  const hazards = {};

  const put = (edgeId, hazard) => {
    const prev = hazards[edgeId];
    if (!prev || HAZARD_RULES[hazard.type].severity > HAZARD_RULES[prev.type].severity) {
      hazards[edgeId] = hazard;
    }
  };

  for (const reading of sensors) {
    // 오래된 판독값은 현재 상태의 근거가 되지 못한다.
    // (센서 고장·통신 두절 자체는 관제 화면에서 따로 표시한다)
    if (isStale(reading, now)) continue;

    const type = temperatureHazard(reading.celsius);
    if (!type) continue;

    const hazard = {
      type,
      label: `${HAZARD_RULES[type].label} ${Math.round(reading.celsius)}°C`,
      celsius: reading.celsius,
      sensorId: reading.sensorId,
      source: 'temperature',
    };

    if (reading.edgeId && floorPlan.hasEdge(reading.edgeId)) {
      put(reading.edgeId, hazard);
    } else if (reading.nodeId && floorPlan.hasNode(reading.nodeId)) {
      for (const edge of floorPlan.edgesAtNode(reading.nodeId)) put(edge.id, hazard);
    }
  }

  return hazards;
}

/** 화재 반경 규칙 */
export const FIRE = {
  /** 기본 위험 반경(m) — 관제에서 조절한다 */
  DEFAULT_RADIUS: 6,
  /** 반경의 이 배수까지는 열기 때문에 지나갈 수는 있어도 강하게 피한다 */
  HEAT_RATIO: 1.7,
};

/**
 * 화재 발생 지점 → 통로 위험 맵.
 *
 * 불은 통로 위가 아니라 **도면의 임의 지점**에서 난다. 그 지점에서 반경 안에
 * 걸리는 통로를 모두 막고, 그 바깥 열기 구간은 통행은 되지만 크게 우회하게 한다.
 * 통로의 양 끝점이 아니라 **선분까지의 최단거리**로 재기 때문에,
 * 복도 한가운데에서 난 불도 정확히 그 복도를 막는다.
 *
 * @param {Array} fires [{ id, x, y, radius(m) }] — 좌표는 도면 단위
 * @param {FloorPlan} floorPlan
 */
export function hazardsFromFires(fires = [], floorPlan) {
  const hazards = {};

  const put = (edgeId, hazard) => {
    const prev = hazards[edgeId];
    if (!prev || HAZARD_RULES[hazard.type].severity > HAZARD_RULES[prev.type].severity) {
      hazards[edgeId] = hazard;
    }
  };

  for (const fire of fires) {
    const radius = (fire.radius ?? FIRE.DEFAULT_RADIUS) / floorPlan.metersPerUnit;
    const heatRadius = radius * FIRE.HEAT_RATIO;

    for (const edge of floorPlan.edges) {
      const a = floorPlan.getNode(edge.a);
      const b = floorPlan.getNode(edge.b);
      if (!a || !b) continue;

      const dist = pointToSegmentDistance(fire.x, fire.y, a.x, a.y, b.x, b.y);
      const meters = dist * floorPlan.metersPerUnit;

      if (dist <= radius) {
        put(edge.id, {
          type: 'fire', label: '화재', source: 'fire', fireId: fire.id,
          distance: Math.round(meters * 10) / 10,
        });
      } else if (dist <= heatRadius) {
        put(edge.id, {
          type: 'warm', label: `화재 인접 ${Math.round(meters)}m`, source: 'fire', fireId: fire.id,
          distance: Math.round(meters * 10) / 10,
        });
      }
    }
  }

  return hazards;
}

/** 화재 반경 안에 들어간 지점(장소)들 — 그 자리에 머물면 안 되는 곳 */
export function nodesInFire(fires = [], floorPlan) {
  const hit = new Set();
  for (const fire of fires) {
    const radius = (fire.radius ?? FIRE.DEFAULT_RADIUS) / floorPlan.metersPerUnit;
    for (const n of floorPlan.nodes) {
      if (Math.hypot(n.x - fire.x, n.y - fire.y) <= radius) hit.add(n.id);
    }
  }
  return [...hit];
}

/** 여러 위험 출처를 합친다 — 통로마다 더 심각한 쪽이 이긴다. */
export function mergeHazards(...sources) {
  const merged = {};
  for (const source of sources) {
    for (const [edgeId, hazard] of Object.entries(source || {})) {
      const rule = HAZARD_RULES[hazard.type];
      if (!rule) continue;
      const prev = merged[edgeId];
      if (!prev || rule.severity > HAZARD_RULES[prev.type].severity) merged[edgeId] = hazard;
    }
  }
  return merged;
}
