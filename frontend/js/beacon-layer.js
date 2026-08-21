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
/**
 * 비콘 색 — **블루투스의 파랑**을 쓴다.
 *
 * 보라였다. 지도에서 다른 것과 안 겹치는 색이라 골랐는데, 블루투스 기호를
 * 그리기 시작하니 «파란 룬을 보라로 칠한» 꼴이 됐다. 기호가 이미 무엇인지
 * 말하고 있으면 색도 그 기호의 색이어야 한다 — 어긋나면 둘 다 약해진다.
 *
 * 대피 경로(`--route`)도 파랑이지만 서로 안 헷갈린다. 경로는 굵은 선이고
 * 비콘은 기호라 모양이 다르다.
 */
export const BEACON_COLORS = {
  real: '#2f8fd6',      // 도면에 beaconId를 등록한 비콘 — 확정이라 제일 진하다
  virtual: '#5aa8dd',   // 시뮬레이션 비콘 — 실물이 아니라 옅다
  found: '#8fcbf0',     // 걸으면서 찾아낸 실물 비콘 (아직 도면에 안 넣음) — 추정이라 옅다
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
      txPower: n.txPower,
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
/**
 * 사람에게 **얼마나 세게 들리는가** (0~1).
 *
 * 비콘의 세기는 비콘만 봐서는 못 정한다 — 받는 사람이 있어야 나오는 값이다.
 * 그래서 «지금 추적 중인 사람» 과의 거리로 잰다. 사람이 여럿이면 **가장
 * 가까운 사람** 기준이다(그 비콘을 실제로 잡고 있는 사람이 그 사람이다).
 *
 * 아무도 없으면 1을 준다. 0을 주면 편집기에서 비콘이 전부 사라지는데,
 * 거기서는 «누가 얼마나 잘 잡히나» 가 아니라 «어디에 달았나» 를 본다.
 *
 * 파동 애니메이션과 **같은 함수를 쓴다.** 따로 계산하면 커진 기호와 약한
 * 파동이 한 자리에서 서로 다른 말을 한다.
 */
export function beaconStrength(b, near, listen) {
  // **사람이 없으면 기기 자신의 송신 세기로 그린다.**
  //
  // 예전에는 1을 돌려줘서 열여덟 개가 지도에서 똑같이 생겼다. 실제로는
  // 기종·전지 상태·설치 높이·주변 금속에 따라 1m 기준 세기가 −55 ~ −78dBm
  // 으로 흩어진다. 그 차이가 보여야 «어느 비콘이 약한가» 를 알고, 약한
  // 것부터 손볼 수 있다.
  const own = txStrength(b.txPower);
  if (!near?.length) return own;

  // 사람이 있으면 «그 사람에게 얼마나 세게 들리나» 다. 거리와 송신 세기가
  // 같이 정한다 — 센 비콘은 멀리서도 잡히고, 약한 비콘은 옆에 있어야 잡힌다.
  let best = 0;
  for (const p of near) {
    if (!Number.isFinite(p?.x)) continue;
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    const reach = listen * (0.55 + own * 0.75);
    if (d < reach) best = Math.max(best, (1 - d / reach) * (0.5 + own * 0.5));
  }
  return best;
}

/** 1m 기준 세기(dBm) → 0~1. −78 이 바닥, −55 가 천장. */
export function txStrength(txPower) {
  const tx = Number.isFinite(txPower) ? txPower : -62;
  return Math.max(0.12, Math.min(1, (tx + 78) / 23));
}

export function drawBeacons(svg, floorPlan, opts = {}) {
  const { showRange = true, rangeM = SIM_DEFAULTS.rangeM, selectedNodeId = null,
    near = null } = opts;
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

  const listen = (SIM_DEFAULTS.rangeM * 0.8) / (floorPlan.metersPerUnit || 1);
  for (const b of places) {
    const color = b.virtual ? BEACON_COLORS.virtual : BEACON_COLORS.real;
    const on = b.nodeId === selectedNodeId;

    // **세게 들리는 비콘이 크다.**
    //
    // 관제가 «지금 어느 비콘이 이 사람을 잡고 있나» 를 흘깃 봐서 알아야
    // 한다. 숫자(dBm)를 열여덟 개 읽게 하면 그 시간만큼 늦는다.
    //
    // 다만 **약한 것도 지운 크기로 남긴다.** 안 그리면 «저기 비콘이 없다»
    // 로 읽히는데, 있는데 안 들리는 것과 없는 것은 전혀 다른 상태다.
    const strength = beaconStrength(b, near, listen);
    const s = scale * (on ? 2.6 : 1.35 + strength * 1.15);

    // **블루투스 기호를 그대로 쓴다.**
    //
    // 마름모는 «표식» 이지 «비콘» 이 아니다. 발표 자료에 넣으면 보는 사람이
    // 저게 뭔지 모른다. 블루투스 룬은 설명이 필요 없는 기호다 — 이걸 쓰면
    // 범례를 안 봐도 «무선 송신기» 로 읽힌다.
    //
    // 전파 호는 **양쪽으로** 낸다. 한쪽에만 있으면 그쪽으로 쏘는 지향성
    // 안테나처럼 보이는데, 비콘은 사방으로 뿌린다.
    const g = add(svg, 'g', {
      transform: `translate(${b.x} ${b.y}) scale(${s / 12})`,
      opacity: (b.virtual ? 0.85 : 1) * (0.45 + strength * 0.55),
    });

    // 어두운 판에서 자리를 잡아 주는 후광
    add(g, 'circle', { cx: 0, cy: 0, r: 13, fill: color, 'fill-opacity': b.virtual ? 0.14 : 0.22 });

    // 블루투스 룬. 12x12 를 원점 가운데로 옮겨 그린다.
    add(g, 'path', {
      d: 'M5.71 -4.29L0 -10h-1v7.59L-5.59 -7L-7 -5.59L-1.41 0L-7 5.59L-5.59 7'
        + 'L-1 2.41V10h1l5.71-5.71L1.41 0l4.3-4.29z'
        + 'M1 -6.17l1.88 1.88L1 -2.41V-6.17z'
        + 'M2.88 4.29L1 6.17V2.41l1.88 1.88z',
      fill: color, stroke: '#0b0f14', 'stroke-width': 0.9, 'stroke-linejoin': 'round',
    });

    // 좌우 전파 호 두 쌍.
    //
    // **원점을 중심으로 한 원의 조각**으로 그린다. 앞서 «양옆에서 위로
    // 부푸는 곡선» 으로 그렸더니 반지름이 커지면서 큰 원처럼 보여, 호가
    // 아니라 도달 범위 원으로 읽혔다. 중심각을 ±42도로 잘라 내면 기호에
    // 붙은 동심호가 된다 — 블루투스 도안의 그 모양이다.
    const A = 42 * Math.PI / 180;
    const sinA = Math.sin(A);
    const cosA = Math.cos(A);
    for (const [i, R] of [12, 16.5].entries()) {
      for (const side of [1, -1]) {
        const x = side * R * cosA;
        add(g, 'path', {
          d: `M ${x.toFixed(2)} ${(-R * sinA).toFixed(2)}`
            + ` A ${R} ${R} 0 0 ${side > 0 ? 1 : 0} ${x.toFixed(2)} ${(R * sinA).toFixed(2)}`,
          fill: 'none', stroke: color,
          'stroke-width': 2.1, 'stroke-linecap': 'round',
          'stroke-opacity': (b.virtual ? 0.6 : 0.9) * (i ? 0.6 : 1),
        });
      }
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
    for (const b of places) {
      const strength = beaconStrength(b, near, listen);
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
