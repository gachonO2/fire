/**
 * 비콘 레이어 — 도면 위에 비콘이 어디 있고 얼마나 멀리 닿는지 그린다.
 *
 * 왜 필요한가:
 * 편집기에는 비콘 ID를 넣는 입력칸만 있어서, 어디에 몇 개가 깔렸는지 볼 방법이 없었다.
 * 「몇 개나 달아야 하나」가 이 프로젝트에서 실제로 돈이 드는 결정인데,
 * 숫자로만 보면 판단이 안 된다. 도달 범위를 겹쳐 그려야 빈 곳이 보인다.
 *
 * 실선 = 실제로 등록한 비콘, 점선 = 아직 안 달았지만 앱이 가상으로 채워 넣는 자리.
 * 앱(frontend/js/beacon.js)의 withVirtualBeacons()와 같은 규칙을 쓴다 —
 * 편집기에서 본 것과 실제 동작이 어긋나면 아무 의미가 없다.
 *
 * 파동 애니메이션은 별도 레이어에서 벽시계 시각으로 돈다. 도면을 다시 그려도
 * 끊기지 않고, 편집 중에도 계속 울린다.
 */

import { SIM_DEFAULTS } from '../shared/beacon-sim.js';

const NS = 'http://www.w3.org/2000/svg';

/** 전파가 한 번 퍼져 나가는 데 걸리는 시간(ms) */
const WAVE_PERIOD_MS = 1800;
const RINGS = 3;

/**
 * 비콘은 **보라 계열 하나로 묶는다.**
 *
 * 예전에는 확정이 파랑(#0090ff), 찾은 것이 초록(#22c55e)이었다. 그런데 파랑은
 * 경로 색이고 초록은 출구 색이다 — 지도에서 «저 파란 점이 경로인가 비콘인가»,
 * «저 초록 점이 출구인가 비콘인가» 가 안 갈렸다.
 *
 * 색은 뜻을 하나씩만 맡아야 흘깃 봐도 읽힌다. 그래서 비콘은 통째로 보라로 옮기고,
 * 셋을 **밝기로** 구분한다. 모양(마름모/원)도 이미 다르므로 둘이 겹쳐 판단된다.
 */
export const BEACON_COLORS = {
  real: '#b06bff',      // 도면에 beaconId를 등록한 비콘 — 확정이라 제일 진하다
  virtual: '#7f6aa8',   // 앱이 자동으로 채우는 가상 비콘 — 진짜가 아니라 탁하다
  found: '#d8a2ff',     // 걸으면서 찾아낸 실물 비콘 (아직 도면에 안 넣음) — 추정이라 옅다
};

/**
 * 걸으면서 찾아낸 비콘을 그린다 — 도면에 등록된 것과 **다른 색·모양**으로.
 *
 * 이 점들은 추정치다. 폰이 말한 위치로 계산한 것이라 폰이 틀렸으면 같이 틀린다.
 * 그래서 확정된 비콘(파랑 마름모)과 섞어 그리면 안 된다. 초록 원 + 흩어짐 반경으로
 * "여기 어디쯤"임을 보여주고, 표본이 쌓여 반경이 줄어드는 것이 눈에 보이게 한다.
 *
 * @param {SVGElement} svg
 * @param {FloorPlan} floorPlan
 * @param {Array} estimates  GET /api/beacon-map 의 estimates
 */
export function drawFoundBeacons(svg, floorPlan, estimates = []) {
  const scale = planScale(floorPlan);
  for (const e of estimates) {
    if (!e.ready || !Number.isFinite(e.x)) continue;
    const tight = e.spreadM <= 6;
    const r = Math.max(scale * 0.8, (e.spreadM || 0) / (floorPlan.metersPerUnit || 1));

    // 흩어짐 반경 — 아직 못 믿는 만큼이 크기로 보인다
    add(svg, 'circle', {
      cx: e.x, cy: e.y, r,
      fill: BEACON_COLORS.found, 'fill-opacity': tight ? 0.14 : 0.07,
      stroke: BEACON_COLORS.found, 'stroke-width': scale * 0.12,
      'stroke-opacity': tight ? 0.7 : 0.35,
      'stroke-dasharray': tight ? 'none' : `${scale * 0.6} ${scale * 0.5}`,
    });
    add(svg, 'circle', {
      cx: e.x, cy: e.y, r: scale * 0.9,
      fill: BEACON_COLORS.found, 'fill-opacity': tight ? 1 : 0.55,
    });
    add(svg, 'text', {
      x: e.x, y: e.y - r - scale * 0.5, 'text-anchor': 'middle',
      'font-size': scale * 1.25, fill: BEACON_COLORS.found, 'font-weight': '700',
    }).textContent = `${e.beaconId.slice(-8)} (${e.samples})`;
  }
}

/**
 * 도면의 비콘 배치를 계산한다 — 앱의 withVirtualBeacons()와 같은 규칙.
 * @returns {Array<{nodeId, name, x, y, beaconId, virtual}>}
 */
export function beaconPlacements(floorPlan) {
  const real = floorPlan.beaconNodes();
  if (real.length) {
    // **`SIM-` 은 시뮬레이션이다.** 도면에 등록돼 있어도 실물이 아니므로
    // `virtual` 로 표시해 옅게·점선으로 그린다. 없는 설비를 있다고 그리는
    // 것이 관제 화면이 할 수 있는 가장 나쁜 거짓말이라, 그리되 **무엇인지는
    // 화면이 말해야** 한다.
    return real.map(n => ({
      nodeId: n.id, name: n.name, x: n.x, y: n.y, beaconId: n.beaconId,
      virtual: String(n.beaconId).startsWith('SIM'),
    }));
  }
  // 하나도 없으면 앱이 엘리베이터를 뺀 모든 지점에 가상 비콘을 놓는다
  return floorPlan.nodes
    .filter(n => n.type !== 'elevator')
    .map(n => ({
      nodeId: n.id, name: n.name, x: n.x, y: n.y, beaconId: `SIM-${n.id}`, virtual: true,
    }));
}

/**
 * 비콘 위치와 도달 범위를 그린다 (정적 레이어 — 도면을 다시 그릴 때 같이 갱신).
 * @param {SVGElement} svg      renderMap() 이 그린 지도. 그 위에 덧그린다.
 * @param {FloorPlan} floorPlan
 * @param {Object} opts { showRange, rangeM, selectedNodeId }
 */
export function drawBeacons(svg, floorPlan, opts = {}) {
  const { showRange = true, rangeM = SIM_DEFAULTS.rangeM, selectedNodeId = null } = opts;
  const places = beaconPlacements(floorPlan);
  if (!places.length) return places;

  const scale = planScale(floorPlan);
  const rangeUnits = rangeM / (floorPlan.metersPerUnit || 1);

  // 도달 범위는 **고른 비콘 하나만** 그린다.
  //
  // 전부 그리면 안 된다. 비콘 도달거리(25m)가 건물 폭과 비슷해서 원 15개가 통째로
  // 겹치고, 도면이 색으로 덮여 아무것도 안 보인다. 게다가 "다 덮여 있다"는 정보는
  // 쓸모가 없다 — 알고 싶은 건 「이 비콘 하나가 어디까지 닿나」이기 때문이다.
  const focus = selectedNodeId && places.find(b => b.nodeId === selectedNodeId);
  if (showRange && focus) {
    const color = focus.virtual ? BEACON_COLORS.virtual : BEACON_COLORS.real;
    add(svg, 'circle', {
      cx: focus.x, cy: focus.y, r: rangeUnits,
      fill: color, 'fill-opacity': 0.06,
      stroke: color, 'stroke-width': scale * 0.16, 'stroke-opacity': 0.55,
      'stroke-dasharray': `${scale} ${scale * 0.7}`,
    });
    add(svg, 'text', {
      x: focus.x, y: focus.y - rangeUnits - scale * 0.6, 'text-anchor': 'middle',
      'font-size': scale * 1.5, fill: color, 'font-weight': '700',
    }).textContent = `도달 ${rangeM}m`;
  }

  for (const b of places) {
    const color = b.virtual ? BEACON_COLORS.virtual : BEACON_COLORS.real;
    const on = b.nodeId === selectedNodeId;
    const s = scale * (on ? 2.4 : 1.9);

    // **비콘이라는 것이 보여야 한다.**
    //
    // 예전에는 작은 마름모 하나였다. 발표 자료에 넣으려고 화면을 줄이면
    // 점으로 뭉개져서 «저게 비콘» 인 줄 모른다. 세 겹으로 그린다 —
    //
    //   후광     어두운 판에서 자리를 잡아 준다
    //   마름모   지점(원)과 헷갈리지 않게 모양을 달리한다
    //   전파선   비콘이 «신호를 낸다» 는 것을 정지 화면에서도 말한다
    //
    // 전파선이 핵심이다. 마름모만으로는 «표식» 이고, 호 두 개가 붙으면
    // «송신기» 로 읽힌다.
    add(svg, 'circle', {
      cx: b.x, cy: b.y, r: s * 2.1,
      fill: color, 'fill-opacity': b.virtual ? 0.1 : 0.16,
    });
    add(svg, 'polygon', {
      points: `${b.x},${b.y - s} ${b.x + s},${b.y} ${b.x},${b.y + s} ${b.x - s},${b.y}`,
      fill: color, 'fill-opacity': b.virtual ? 0.75 : 1,
      stroke: '#0b0f14', 'stroke-width': scale * 0.34,
    });
    // 위로 퍼지는 전파 호 두 개
    for (const k of [1.55, 2.25]) {
      add(svg, 'path', {
        d: `M ${b.x - s * k} ${b.y - s * k * 0.5}`
          + ` A ${s * k * 1.25} ${s * k * 1.25} 0 0 1 ${b.x + s * k} ${b.y - s * k * 0.5}`,
        fill: 'none', stroke: color,
        'stroke-width': scale * 0.3, 'stroke-linecap': 'round',
        'stroke-opacity': b.virtual ? 0.55 : 0.85,
      });
    }
  }

  return places;
}

/**
 * 파동 애니메이션을 시작한다. 별도 레이어에 매 프레임 그린다.
 *
 * 전파는 편집 중이든 아니든 계속 나가고 있는 것이므로, 도면 렌더링 주기와
 * 분리해서 벽시계 시각으로 위상을 계산한다.
 *
 * @param {SVGElement} waveSvg  지도 위에 겹쳐 놓은 빈 SVG
 * @param {() => {floorPlan, enabled, baseSvg, near}} getState
 *   near: [{x, y}] 사람 위치. 주면 그 근처 비콘만 울린다(관제).
 *         안 주면 전부 울린다(도면 편집기 — 배치를 보는 게 목적).
 * @returns {() => void} 정지 함수
 */
export function startBeaconWaves(waveSvg, getState) {
  let raf = null;
  const reduced = typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const frame = now => {
    if (!reduced) raf = requestAnimationFrame(frame);
    const { floorPlan, enabled, baseSvg, near } = getState() || {};
    const box = baseSvg?.getAttribute('viewBox');
    if (box) waveSvg.setAttribute('viewBox', box);
    waveSvg.innerHTML = '';
    if (!enabled || !floorPlan) return;

    const places = beaconPlacements(floorPlan);
    if (!places.length) return;
    const scale = planScale(floorPlan);
    const span = planSpan(floorPlan);
    // 지도 크기에 비례한 파동 — 실제 도달거리(25m)를 그대로 그리면 원 하나가
    // 도면을 덮어버려서 「비콘에서 퍼진다」로 안 읽힌다. 범위는 정적 레이어가 보여준다.
    const reach = span * 0.075;

    // 사람 근처 비콘만 울린다.
    //
    // 전부 울리면 화면이 번잡하기만 하고 정보가 없다 — "다 켜져 있다"는 건 이미 아는 사실이다.
    // 알고 싶은 건 **지금 누구를 잡고 있나**이고, 그건 사람 옆에서만 울려야 읽힌다.
    // near 가 없으면(도면 편집기) 배치를 보는 게 목적이므로 전부 울린다.
    const listen = span * 0.22;      // 이 안에 사람이 있으면 반응한다
    const rank = b => {
      if (!near?.length) return 1;   // 편집기: 전부 같은 세기
      let best = 0;
      for (const p of near) {
        if (!Number.isFinite(p?.x)) continue;
        const d = Math.hypot(b.x - p.x, b.y - p.y);
        if (d < listen) best = Math.max(best, 1 - d / listen);
      }
      return best;
    };

    for (const b of places) {
      const strength = rank(b);
      if (strength <= 0.02) continue;          // 사람이 없는 곳은 조용히 둔다

      const color = b.virtual ? BEACON_COLORS.virtual : BEACON_COLORS.real;
      // 가까울수록 크고 진하게 — 세기 차이가 곧 "어느 비콘이 잡고 있나"다
      for (let k = 0; k < RINGS; k++) {
        const phase = ((now / WAVE_PERIOD_MS) + k / RINGS) % 1;
        add(waveSvg, 'circle', {
          cx: b.x, cy: b.y, r: reach * (0.45 + strength * 0.75) * phase,
          fill: 'none', stroke: color,
          'stroke-width': scale * (0.2 + strength * 0.3),
          'stroke-opacity': (1 - phase * 0.85) * (0.25 + strength * 0.6) * (b.virtual ? 0.85 : 1),
        });
      }
    }
  };

  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

// ------------------------------------------------------------------ 내부

function add(svg, tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  svg.appendChild(e);
  return e;
}

/** 도면 좌표계가 미터냐 픽셀이냐에 따라 값이 크게 달라져서 선 굵기를 정규화한다 */
/**
 * 비콘 표시 크기 배수.
 *
 * 폰은 도면을 손바닥만 하게 띄우므로 도면 폭의 1/40 이 맞다. 관제는 같은
 * 도면을 화면 전체로 띄우는데, 43개 지점에 가상 비콘이 하나씩 있으면 그
 * 크기로는 다이아몬드가 통로를 통째로 덮는다. 관제에서 봐야 하는 것은
 * 비콘이 아니라 **사람과 통로**이므로, 비콘은 배경으로 물러나야 한다.
 */
let beaconScale = 1;
export function setBeaconScale(k) { beaconScale = k; }

function planScale(floorPlan) {
  return ((planSpan(floorPlan) / 40) || 1) * beaconScale;
}

function planSpan(floorPlan) {
  const xs = floorPlan.nodes.map(n => n.x);
  const ys = floorPlan.nodes.map(n => n.y);
  if (!xs.length) return 30;
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 30;
}
