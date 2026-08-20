/**
 * 층 지도 SVG 렌더링 — 사용자 앱 미니맵·관제 대시보드·보호자 화면이 공유.
 * (시각장애인 사용자용 화면이 아니라 동행 안전요원·발표 시연·관제용 시각화)
 *
 * 도면 이미지가 등록돼 있으면 배경으로 깔고 그 위에 그래프를 그린다.
 */

import { HAZARD_RULES, TEMP } from '../shared/hazard-rules.js';
import { elbowPoints } from '../shared/orthogonal.js';
import { findPath } from '../shared/walk-grid.js';

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
    hazards = {}, route = null, userPos = null, positions = [], scenario = null,
    sensors = [], backgroundImage = null,
    onEdgeClick = null, onNodeClick = null, highlightEdgeId = null,
    // 통로도 지점도 아닌 곳을 눌렀을 때 도면 좌표를 준다.
    onBlankClick = null,
    // 관제는 도면을 화면 전체로 띄운다. 지점 이름이 도면 폭의 1/40 이면
    // 43개가 서로 덮어써서 아무것도 안 읽힌다. 폰은 도면을 손바닥만 하게
    // 띄우므로 같은 값이 맞다 — 그래서 크기를 화면 쪽에서 정하게 열어 둔다.
    labelScale = 1, imageOpacity = 0.55,
    // 'all' | 'exits' | 'none'.
    // 도면 사진에 방 이름이 이미 인쇄돼 있으면 우리 이름표는 그 위에 겹쳐
    // 쓰는 낙서가 된다. 그럴 때는 사진에 없는 것 — 출구 — 만 짚어 준다.
    nodeLabels = 'all',
    // 통로 그래프를 그릴 것인가.
    //
    // 그래프(회색 막대와 지점 점)는 도면을 **엮을 때** 보는 것이다. 관제는
    // 방과 벽이 이미 서 있는 화면을 보므로, 거기에 막대 45개와 점 43개를 더
    // 얹으면 정작 봐야 할 것 — 불난 방, 사람, 대피 경로 — 이 묻힌다.
    // 위험한 통로와 경로 위 통로는 **상태가 있으므로** 그래프를 꺼도 남는다.
    showGraph = true,
    // 도면에서 읽어낸 벽. 있으면 통로를 그릴 때 **덜 뚫는 쪽으로** 꺾는다.
    // 없으면 긴 축을 먼저 가는 모양으로 그린다 — 그래도 대각선보다는 낫다.
    walls = null,
    // 도면에서 뽑은 «걸을 수 있는 칸». 주면 통로를 **복도를 따라** 그린다.
    // 없으면 예전처럼 ㄱ자로 꺾는다.
    walkGrid = null,
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

  // **빈 곳 클릭 — 도면 좌표로 바꿔 넘긴다.**
  //
  // 이게 없으면 화재 도구가 사실상 안 먹는다. 통로는 몇 픽셀짜리 선이고
  // 그 위에만 클릭이 붙어 있어서, 방 한가운데나 도면 사진을 누르면 아무
  // 일도 일어나지 않는다. 관제에서 «불을 여기 놓겠다» 는 방을 가리키는
  // 동작이지 선을 겨누는 동작이 아니다.
  //
  // 통로·지점 핸들러가 `stopPropagation()` 을 하므로, 루트에 붙인 이것은
  // **진짜 빈 곳일 때만** 불린다.
  //
  // 좌표 변환에 `getScreenCTM()` 을 쓴다. 관제는 판을 CSS 3D 로 눕혀 놓아서
  // 화면 좌표와 도면 좌표가 회전·원근만큼 어긋나는데, 이 행렬은 조상의
  // 변형까지 반영한 «지금 화면에 그려진 그대로» 를 준다. 원근이 섞이면
  // 완전히 정확하진 않지만(실측 오차 수 px), 받는 쪽이 어차피 가장 가까운
  // 통로로 붙이므로 그 정도면 충분하다.
  //
  // `renderMap` 은 상태가 바뀔 때마다 다시 불린다. 그때마다 리스너를 새로
  // 붙이면 한 번의 클릭이 수십 번 처리되므로, **핸들러는 한 번만 달고**
  // 최신 콜백은 요소에 얹어 두고 꺼내 쓴다.
  svg.__onBlankClick = onBlankClick;
  if (onBlankClick && !svg.__blankClickWired) {
    svg.__blankClickWired = true;
    svg.style.pointerEvents = 'auto';
    svg.addEventListener('click', ev => {
      const fn = svg.__onBlankClick;
      if (!fn) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const p = svg.createSVGPoint();
      p.x = ev.clientX; p.y = ev.clientY;
      const { x, y } = p.matrixTransform(ctm.inverse());
      if (Number.isFinite(x) && Number.isFinite(y)) fn(x, y);
    });
  }

  // 도면 크기에 비례한 선 굵기·글자 크기 (픽셀 좌표계면 값이 커지므로 정규화한다)
  const s = Math.max(width, height) / 40;

  if (backgroundImage) {
    el('image', {
      href: backgroundImage, x: minX, y: minY, width, height,
      preserveAspectRatio: 'none', opacity: imageOpacity,
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

    // 곧게 이으면 **벽을 뚫고 지나간다.** 지점 좌표는 도면 사진에서 읽은
    // 근사값이라 격자에 안 맞고, 이 도면은 통로 45개 중 22개가 15° 넘게 기울어
    // 있다. 대피 경로가 화면에서 벽을 가로지르면 보는 사람이 안내를 안 믿는다.
    //
    // 기하는 `shared/orthogonal.js` 한 곳에 두고 **앱도 같은 것을 쓴다.** 두 곳에서
    // 따로 그리면 관제와 폰이 같은 통로를 다르게 그리게 된다 — 실제로 그랬다.
    // 앱과 같은 규칙 — 꺾임점이 경로의 정식 지점이라 그림과 안내가 같은 길을 말한다
    // **통로도 복도를 따라 그린다.**
    //
    // 예전에는 지점끼리 곧게(또는 ㄱ자로) 이었다. 그러면 대각선 복도가 있는
    // 이 도면에서 선이 방을 가로질러 벽을 뚫는다 — 화면에서 제일 먼저 눈에
    // 띄는 잘못이고, 보는 사람은 «이 시스템이 건물을 모르는구나» 로 읽는다.
    let pts = elbowPoints(a, b, { walls });
    if (walkGrid?.ok) {
      const road = findPath(walkGrid, a, b);
      if (road?.length > 1) pts = road.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' ');
    }

    // 그래프를 껐어도 **상태가 있는 통로는 그린다** — 그게 관제가 볼 것이다
    if (showGraph || hazard || onRoute) {
      el('polyline', {
        points: pts, fill: 'none',
        stroke: hazard ? hazardStyle(hazard.type).color
          : onRoute ? 'var(--route, #30a46c)' : 'var(--corridor, #c8c8ce)',
        // 위험한 통로는 **가늘게** 긋는다.
        //
        // 예전에는 제일 굵고(1.3배) 큼직한 점선이라, 둥근 끝과 겹쳐 «빨간
        // 구슬 목걸이» 가 됐다. 관제 화면에서 그게 제일 눈에 띄는 물체였는데
        // 정작 뜻은 «이 구간이 막혔다» 뿐이다. 불이 어디서 얼마나 번지는지는
        // 위험 레이어(`admin.js drawHazards`)의 덩어리가 말한다. 선은 그
        // 덩어리를 **어느 구간까지 끊어 놓았나** 로만 남는다.
        'stroke-width': (onRoute ? 1.6 : hazard ? 0.5 : 1.0) * s * 0.55,
        'stroke-opacity': hazard && !onRoute ? 0.8 : 1,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': hazard ? `${s * 0.5} ${s * 0.85}` : 'none',
        'pointer-events': 'none',
      });
    }

    if (isHighlight) {
      el('polyline', {
        points: pts, fill: 'none',
        stroke: '#fff', 'stroke-width': s * 0.2, 'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-dasharray': `${s * 0.3} ${s * 0.3}`, 'pointer-events': 'none',
      });
    }

    if (onEdgeClick) {
      const hit = el('polyline', {
        points: pts, fill: 'none',
        stroke: 'transparent', 'stroke-width': s * 2, cursor: 'pointer',
      });
      hit.addEventListener('click', ev => { ev.stopPropagation(); onEdgeClick(edge); });
    }

    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;

    // 위험 글씨(「화재 발생」)는 **기울인 판에서 안 읽힌다.**
    //
    // 글씨가 바닥에 누워 있으니 원근에 눌려 찌그러지고, 붉은 발광 위에
    // 붉은 글씨라 대비도 없다. 어느 방이 타는지는 **빛나는 면**이 이미
    // 말하고 있고, 통로 id 와 종류는 오른쪽 패널이 적는다.
    // 평면으로 볼 때만 남긴다 — 그때는 도면처럼 읽히므로 쓸모가 있다.
    //
    // 그리고 **감지기가 만든 위험에는 글씨를 안 붙인다.** 감지기 하나가
    // 문턱을 넘으면 그 분기점에 닿은 통로가 한꺼번에 위험이 되는데(여섯
    // 개까지 간다), 통로마다 「온도 상승」 을 적으면 같은 글씨가 도면에
    // 여섯 번 찍힌다. 몇 도인지는 감지기 배지가 이미 말하고 있다.
    if (hazard && showGraph && hazard.source !== 'temperature') {
      label(el, mx, my - s * 0.8 * labelScale, hazardStyle(hazard.type).label,
        { size: s * 0.95 * labelScale, fill: hazardStyle(hazard.type).color, weight: 700 });
    }

    // 온도 판독값 배지
    const reading = sensorByEdge.get(edge.id);
    if (reading) {
      tempBadge(el, mx, my + s * 1.1 * labelScale, reading, s, labelScale);
    }
  }

  // ------------------------------------------------------------------ 노드
  for (const node of floorPlan.nodes) {
    // 사진 시나리오에서는 목적지 하나만 남긴다. 다른 출구 다섯 개를 함께 찍으면
    // «어디로 나가라는 것인가»가 다시 모호해진다.
    if (scenario && node.id !== scenario.exitNodeId) continue;
    const isExit = node.type === 'exit';
    const isEv = node.type === 'elevator';

    // 그래프를 꺼도 **출구는 남긴다.** 대피 안내 화면에서 출구가 어디인가는
    // 배경이 아니라 본문이다.
    const keep = showGraph || isExit;
    const circle = el('circle', {
      cx: node.x, cy: node.y, r: (isExit ? 1.7 : 1.0) * s * 0.55,
      fill: isExit ? '#30a46c' : isEv ? '#8f8f8f' : 'var(--node, #6f6f77)',
      stroke: 'var(--map-bg, #fff)', 'stroke-width': s * (isExit ? 0.26 : 0.18),
      cursor: onNodeClick ? 'pointer' : 'default',
      opacity: keep ? 1 : 0,
      'pointer-events': keep ? 'auto' : 'none',
    });
    if (onNodeClick) {
      circle.addEventListener('click', ev => { ev.stopPropagation(); onNodeClick(node); });
    }

    const wantLabel = nodeLabels === 'all' || (nodeLabels === 'exits' && isExit);
    if (wantLabel) {
      // 「비상구 (THE POINT)」 처럼 이름이 길면 출구끼리 겹쳐 셋 다 못 읽는다.
      // 초록 표식과 범례가 이미 «출구» 라고 말하고 있으므로, 이름표는
      // **어느 출구인가**만 지면 된다 — 괄호 안이 그 답이다.
      const short = isExit
        ? (node.name.match(/\(([^)]+)\)/)?.[1] || node.name.replace(/^비상구\s*/, ''))
        : node.name;
      label(el, node.x, node.y - s * 1.1, short, {
        size: s * 0.8 * labelScale, fill: 'var(--map-text, #46464c)',
        bounds: [minX, minX + width],
        weight: isExit ? 700 : 400,
      });
    }

    const reading = sensorByNode.get(node.id);
    if (reading) tempBadge(el, node.x, node.y + s * 1.6 * labelScale, reading, s, labelScale);
  }

  // 관제 사진 시나리오 — 앱에서도 불·현재 위치·탈출선을 같은 좌표로 그린다.
  // 일반 경로와 동시에 그리지 않는 것은 호출자가 보장한다.
  if (scenario?.route?.length > 1) {
    const points = scenario.route.map(([x, y]) => `${x},${y}`).join(' ');
    const [fx, fy] = scenario.fire;
    const [cx, cy] = scenario.current;
    const [ex, ey] = scenario.route[scenario.route.length - 1];
    el('polyline', {
      points, fill: 'none', stroke: '#4d9fff',
      'stroke-width': s * 2.4, 'stroke-opacity': 0.22,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    el('polyline', {
      points, fill: 'none', stroke: '#4d9fff',
      'stroke-width': s * 0.86,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    el('circle', {
      cx: fx, cy: fy, r: s * 2.8, fill: '#ff4438', 'fill-opacity': 0.22,
      stroke: '#ff4438', 'stroke-width': s * 0.7,
    });
    el('circle', { cx: fx, cy: fy, r: s * 1.15, fill: '#ff4438' });
    el('circle', {
      cx: cx, cy: cy, r: s * 1.55, fill: '#4d9fff', 'fill-opacity': 0.2,
      stroke: '#4d9fff', 'stroke-width': s * 0.42,
    });
    el('circle', {
      cx: cx, cy: cy, r: s * 0.72, fill: '#4d9fff',
      stroke: '#fff', 'stroke-width': s * 0.2,
    });
    el('circle', {
      cx: ex, cy: ey, r: s * 1.35, fill: 'none',
      stroke: '#2fd6a6', 'stroke-width': s * 0.46,
    });
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

/**
 * @param {[number,number]} [bounds] 도면 좌우 끝 [minX, maxX].
 *   주면 가장자리 지점의 이름표를 **안쪽으로** 붙인다.
 *
 *   가운데 정렬만 하면 오른쪽 끝 방의 이름표가 도면 밖으로 절반쯤 나가고,
 *   지도 카드가 `overflow:hidden` 이라 거기서 잘린다. 출구 이름이 잘리면
 *   그게 어느 출구인지 못 읽는데, 관제에서 출구 이름은 무전으로 부르는
 *   이름이라 잘리면 안 된다.
 */
function label(el, x, y, text, { size, fill, weight = 400, bounds = null }) {
  let anchor = 'middle';
  if (bounds) {
    const [minX, maxX] = bounds;
    const edge = (maxX - minX) * 0.12;
    if (x > maxX - edge) anchor = 'end';
    else if (x < minX + edge) anchor = 'start';
  }
  const t = el('text', {
    x, y, 'text-anchor': anchor, 'font-size': size, fill,
    'font-weight': weight, 'paint-order': 'stroke',
    stroke: 'var(--map-bg, #fff)', 'stroke-width': size * 0.32,
    'pointer-events': 'none',
  });
  t.textContent = text;
  return t;
}

/**
 * 온도 판독값 배지.
 *
 * **배율을 이름표와 같이 받는다.** 폰은 도면을 손바닥만 하게 띄우므로 큼직해야
 * 읽히지만, 관제는 도면을 화면 전체로 띄운다. 같은 크기로 그렸더니 감지기
 * 여섯 개의 «23°C» 가 도면을 덮어 정작 어느 방이 타는지가 안 보였다.
 */
function tempBadge(el, x, y, reading, s, scale = 1) {
  const u = s * scale;
  const color = temperatureColor(reading.celsius);
  const text = `${Math.round(reading.celsius)}°C${reading.stale ? ' ⚠' : ''}`;
  el('rect', {
    x: x - u * 1.4, y: y - u * 0.7, width: u * 2.8, height: u * 1.25, rx: u * 0.35,
    fill: color, opacity: reading.stale ? 0.4 : 0.92, 'pointer-events': 'none',
  });
  const t = el('text', {
    x, y: y + u * 0.22, 'text-anchor': 'middle', 'font-size': u * 0.82,
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
