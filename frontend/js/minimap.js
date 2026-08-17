/**
 * 층 지도 SVG 렌더링 — 사용자 앱 미니맵·관제 대시보드·보호자 화면이 공유.
 * (시각장애인 사용자용 화면이 아니라 동행 안전요원·발표 시연·관제용 시각화)
 *
 * 도면 이미지가 등록돼 있으면 배경으로 깔고 그 위에 그래프를 그린다.
 */

import { HAZARD_RULES, TEMP } from '../shared/hazard-rules.js';

const NS = 'http://www.w3.org/2000/svg';

const HAZARD_COLOR = {
  fire: '#e5484d',
  smoke: '#8f8f8f',
  heat: '#ff6a00',
  warm: '#ffb224',
  crowd: '#ffb224',
  blocked: '#e5484d',
};

export function hazardStyle(type) {
  return { color: HAZARD_COLOR[type] || '#e5484d', label: HAZARD_RULES[type]?.label || '차단' };
}

/** 온도에 따른 색 — 관제 온도 오버레이용 */
export function temperatureColor(celsius) {
  if (celsius >= TEMP.BLOCK) return '#ff3b30';
  if (celsius >= TEMP.WARN) return '#ff9500';
  if (celsius >= 30) return '#ffd60a';
  return '#4a9eff';
}

/**
 * @param {SVGElement} svg
 * @param {Object} state {
 *   floorPlan,           FloorPlan 인스턴스 (필수)
 *   hazards, route, userPos, positions,
 *   sensors,             온도 판독값 오버레이
 *   backgroundImage,     도면 이미지 data URI
 *   onEdgeClick, onNodeClick,
 *   highlightEdgeId
 * }
 */
export function renderMap(svg, state = {}) {
  const {
    floorPlan,
    hazards = {}, route = null, userPos = null, positions = [],
    sensors = [], backgroundImage = null,
    onEdgeClick = null, onNodeClick = null, highlightEdgeId = null,
  } = state;

  svg.innerHTML = '';
  if (!floorPlan) return;

  const el = (tag, attrs, parent = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };

  // ---------------------------------------------------------------- 좌표계
  const img = floorPlan.image;
  let minX, minY, width, height;
  if (img?.width && img?.height) {
    minX = 0; minY = 0; width = img.width; height = img.height;
  } else {
    const PAD = 3;
    const xs = floorPlan.nodes.map(n => n.x);
    const ys = floorPlan.nodes.map(n => n.y);
    minX = Math.min(...xs) - PAD; minY = Math.min(...ys) - PAD;
    width = Math.max(...xs) + PAD - minX;
    height = Math.max(...ys) + PAD - minY;
  }
  svg.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);

  // 도면 크기에 비례한 선 굵기·글자 크기 (픽셀 좌표계면 값이 커지므로 정규화한다)
  const s = Math.max(width, height) / 40;

  if (backgroundImage) {
    el('image', {
      href: backgroundImage, x: minX, y: minY, width, height,
      preserveAspectRatio: 'none', opacity: 0.55,
    });
  }

  const routeEdgeIds = new Set((route?.edges || []).map(e => e?.id).filter(Boolean));
  const sensorByEdge = new Map(sensors.filter(x => x.edgeId).map(x => [x.edgeId, x]));
  const sensorByNode = new Map(sensors.filter(x => x.nodeId).map(x => [x.nodeId, x]));

  // ------------------------------------------------------------------ 통로
  for (const edge of floorPlan.edges) {
    const a = floorPlan.getNode(edge.a);
    const b = floorPlan.getNode(edge.b);
    if (!a || !b) continue;

    const hazard = hazards[edge.id];
    const onRoute = routeEdgeIds.has(edge.id);
    const isHighlight = edge.id === highlightEdgeId;

    el('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: hazard ? hazardStyle(hazard.type).color
        : onRoute ? 'var(--route, #30a46c)' : 'var(--corridor, #c8c8ce)',
      'stroke-width': (onRoute ? 1.6 : 1.0) * s * 0.55,
      'stroke-linecap': 'round',
      'stroke-dasharray': hazard ? `${s * 0.7} ${s * 0.7}` : 'none',
      'pointer-events': 'none',
    });

    if (isHighlight) {
      el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: '#fff', 'stroke-width': s * 0.2, 'stroke-linecap': 'round',
        'stroke-dasharray': `${s * 0.3} ${s * 0.3}`, 'pointer-events': 'none',
      });
    }

    if (onEdgeClick) {
      const hit = el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: 'transparent', 'stroke-width': s * 2, cursor: 'pointer',
      });
      hit.addEventListener('click', ev => { ev.stopPropagation(); onEdgeClick(edge); });
    }

    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;

    if (hazard) {
      label(el, mx, my - s * 0.8, hazardStyle(hazard.type).label,
        { size: s * 0.95, fill: hazardStyle(hazard.type).color, weight: 700 });
    }

    // 온도 판독값 배지
    const reading = sensorByEdge.get(edge.id);
    if (reading) {
      tempBadge(el, mx, my + s * 1.1, reading, s);
    }
  }

  // ------------------------------------------------------------------ 노드
  for (const node of floorPlan.nodes) {
    const isExit = node.type === 'exit';
    const isEv = node.type === 'elevator';

    const circle = el('circle', {
      cx: node.x, cy: node.y, r: (isExit ? 1.5 : 1.0) * s * 0.55,
      fill: isExit ? '#30a46c' : isEv ? '#8f8f8f' : 'var(--node, #6f6f77)',
      stroke: 'var(--map-bg, #fff)', 'stroke-width': s * 0.18,
      cursor: onNodeClick ? 'pointer' : 'default',
    });
    if (onNodeClick) {
      circle.addEventListener('click', ev => { ev.stopPropagation(); onNodeClick(node); });
    }

    label(el, node.x, node.y - s * 1.1, node.name, { size: s * 0.8, fill: 'var(--map-text, #46464c)' });

    const reading = sensorByNode.get(node.id);
    if (reading) tempBadge(el, node.x, node.y + s * 1.6, reading, s);
  }

  // ------------------------------------------------ 다른 사용자 위치 (관제)
  for (const p of positions) {
    const n = p.x != null ? p : floorPlan.getNode(p.nodeId);
    if (!n) continue;
    el('circle', { cx: n.x, cy: n.y, r: s * 0.6, fill: '#0091ff', opacity: 0.9 });
  }

  // ---------------------------------------------------------------- 내 위치
  if (userPos && userPos.x != null) {
    el('circle', {
      cx: userPos.x, cy: userPos.y, r: s * 0.7,
      fill: '#0091ff', stroke: '#fff', 'stroke-width': s * 0.2,
    });
    el('circle', {
      cx: userPos.x, cy: userPos.y, r: s * 1.3,
      fill: 'none', stroke: '#0091ff', 'stroke-width': s * 0.16, opacity: 0.6,
    });
  }
}

function label(el, x, y, text, { size, fill, weight = 400 }) {
  const t = el('text', {
    x, y, 'text-anchor': 'middle', 'font-size': size, fill,
    'font-weight': weight, 'paint-order': 'stroke',
    stroke: 'var(--map-bg, #fff)', 'stroke-width': size * 0.32,
    'pointer-events': 'none',
  });
  t.textContent = text;
  return t;
}

function tempBadge(el, x, y, reading, s) {
  const color = temperatureColor(reading.celsius);
  const text = `${Math.round(reading.celsius)}°C${reading.stale ? ' ⚠' : ''}`;
  el('rect', {
    x: x - s * 1.4, y: y - s * 0.7, width: s * 2.8, height: s * 1.25, rx: s * 0.35,
    fill: color, opacity: reading.stale ? 0.4 : 0.92, 'pointer-events': 'none',
  });
  const t = el('text', {
    x, y: y + s * 0.22, 'text-anchor': 'middle', 'font-size': s * 0.82,
    fill: '#1a1a1a', 'font-weight': 700, 'pointer-events': 'none',
  });
  t.textContent = text;
}

/** 경로 진행도 → 지도 좌표 */
export function positionOnRoute(floorPlan, route, edgeIndex, progress01) {
  if (!route || route.nodes.length === 0) return null;
  if (route.edges.length === 0 || edgeIndex >= route.edges.length) {
    const last = floorPlan.getNode(route.nodes[route.nodes.length - 1]);
    return last ? { x: last.x, y: last.y } : null;
  }
  const a = floorPlan.getNode(route.nodes[edgeIndex]);
  const b = floorPlan.getNode(route.nodes[edgeIndex + 1]);
  if (!a || !b) return null;
  const t = Math.min(1, Math.max(0, progress01));
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
