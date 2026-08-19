/**
 * 실시간 위치 추적 레이어 — 관제 지도 위에서 대피자가 움직이는 것을 보여준다.
 *
 * ## 왜 별도 레이어인가
 *
 * 앱은 걸음마다(또는 2초마다) 위치를 올린다. 그 값이 올 때만 지도를 다시 그리면
 * 점이 **뚝뚝 끊겨 순간이동**한다. 실제 사람은 그 사이에도 계속 걷고 있으므로,
 * 화면은 매 프레임 목표 지점을 향해 **부드럽게 따라가야** 한다.
 *
 * 그래서 지도(정적)와 점(매 프레임)을 분리한다. 지도는 위험 상태가 바뀔 때만,
 * 점은 60fps 로 그린다.
 *
 * ## 색이 정보다
 *
 * 비콘이 위치를 확정한 순간과 걸음 수로 밀고 있는 구간은 신뢰도가 다르다.
 * 그 차이가 안 보이면 "지금 잘 따라가고 있나"를 판단할 수 없다.
 *
 *   파랑   방금 비콘이 확정한 위치
 *   주황   비콘 없이 걸음 수로 추정 중 (시간이 갈수록 어긋난다)
 *
 * 꼬리(궤적)를 남기는 이유도 같다 — 점 하나만 보면 튀는 순간을 놓친다.
 */

const NS = 'http://www.w3.org/2000/svg';

/** 목표 위치로 따라가는 속도. 1에 가까울수록 즉시 따라간다 */
const EASE = 0.12;
/** 꼬리에 남기는 점 개수 */
const TRAIL_MAX = 40;
/** 이 시간 넘게 소식 없는 사용자는 흐리게 (초) */
const STALE_SEC = 12;

const COLORS = {
  beacon: '#0090ff',   // 비콘이 확정
  pdr: '#ff9500',      // 걸음 수 추정
  safehold: '#e5484d', // 안전상태 — 멈춰서 구조 대기
  arrived: '#30a46c',  // 대피 완료
};

export class LiveTrack {
  /**
   * @param {SVGElement} svg      지도 위에 겹쳐 놓은 빈 SVG
   * @param {() => Object} getCtx () => ({ baseSvg, floorPlan })
   */
  constructor(svg, getCtx) {
    this.svg = svg;
    this.getCtx = getCtx;
    this.tracks = new Map();   // userId -> { x, y, tx, ty, trail, ... }
    this.raf = null;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  /** 서버가 보낸 위치 목록을 목표값으로 넣는다 (SSE positions) */
  update(positions = []) {
    const seen = new Set();
    for (const p of positions) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      seen.add(p.userId);

      let t = this.tracks.get(p.userId);
      if (!t) {
        // 처음 보는 사용자는 순간이동처럼 밀려오지 않게 그 자리에서 시작
        t = { x: p.x, y: p.y, trail: [] };
        this.tracks.set(p.userId, t);
      }
      t.tx = p.x;
      t.ty = p.y;
      t.phase = p.phase;
      t.source = p.source || 'pdr';
      t.confidence = p.confidence ?? 1;
      t.name = p.nodeName || p.nodeId || p.userId;
      t.exitName = p.exitName || null;
      t.at = Date.now();
    }
    // 사라진 사용자는 지운다 (관제 목록에서 빠지면 지도에서도 빠져야 한다)
    for (const id of [...this.tracks.keys()]) if (!seen.has(id)) this.tracks.delete(id);
  }

  start() {
    this.stop();
    const frame = () => {
      this.raf = this.reduced ? null : requestAnimationFrame(frame);
      this._draw();
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  // ---------------------------------------------------------------- 그리기

  _draw() {
    const { baseSvg, floorPlan } = this.getCtx() || {};
    if (!this.svg || !baseSvg) return;

    const box = baseSvg.getAttribute('viewBox');
    if (box) this.svg.setAttribute('viewBox', box);
    this.svg.innerHTML = '';
    if (!floorPlan || !this.tracks.size) return;

    const scale = this._scale(floorPlan) * (this.markerScale ?? 1);
    const now = Date.now();

    for (const [userId, t] of this.tracks) {
      // 목표 위치로 조금씩 다가간다 — 보고가 띄엄띄엄 와도 화면은 이어진다
      t.x += (t.tx - t.x) * EASE;
      t.y += (t.ty - t.y) * EASE;

      // 눈에 띄게 움직였을 때만 꼬리에 남긴다 (제자리에서 점이 쌓이지 않게)
      const last = t.trail[t.trail.length - 1];
      if (!last || Math.hypot(t.x - last.x, t.y - last.y) > scale * 0.35) {
        t.trail.push({ x: t.x, y: t.y, source: t.source });
        if (t.trail.length > TRAIL_MAX) t.trail.shift();
      }

      const stale = (now - t.at) / 1000 > STALE_SEC;
      const color = t.phase === 'safehold' ? COLORS.safehold
        : t.phase === 'arrived' ? COLORS.arrived
        : COLORS[t.source] || COLORS.pdr;
      const dim = stale ? 0.35 : 1;

      this._trail(t, scale, dim);

      // 확신도를 테두리 두께로 — 오래 걸을수록 얇아진다
      const conf = Math.max(0.15, Math.min(1, t.confidence));
      this._el('circle', {
        cx: t.x, cy: t.y, r: scale * 2.6,
        fill: color, 'fill-opacity': 0.16 * dim,
      });
      this._el('circle', {
        cx: t.x, cy: t.y, r: scale * 1.15,
        fill: color, 'fill-opacity': dim,
        stroke: '#fff', 'stroke-width': scale * 0.34 * conf, 'stroke-opacity': 0.9 * dim,
      });

      // 안전상태면 눈에 띄어야 한다 — 구조가 필요한 사람이다
      if (t.phase === 'safehold' && !this.reduced) {
        const pulse = (Math.sin(now / 260) + 1) / 2;
        this._el('circle', {
          cx: t.x, cy: t.y, r: scale * (2.6 + pulse * 2.2),
          fill: 'none', stroke: COLORS.safehold,
          'stroke-width': scale * 0.3, 'stroke-opacity': (1 - pulse) * 0.9,
        });
      }

      this._label(t, scale, color, dim);
    }
  }

  _trail(t, scale, dim) {
    if (t.trail.length < 2) return;
    // 오래된 쪽일수록 옅게 — 어디서 왔는지가 자연스럽게 읽힌다
    for (let i = 1; i < t.trail.length; i++) {
      const a = t.trail[i - 1], b = t.trail[i];
      const age = i / t.trail.length;
      this._el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: COLORS[b.source] || COLORS.pdr,
        'stroke-width': scale * 0.5 * age,
        'stroke-opacity': age * 0.55 * dim,
        'stroke-linecap': 'round',
      });
    }
  }

  _label(t, scale, color, dim) {
    // 지도의 이름표는 **누가 어디 있나**만 답한다.
    //
    // 예전에는 «지점 → 목적지»를 통째로 넣었는데, 두 지점 이름이 다 긴
    // 한국어라 이름표 하나가 도면 절반을 가로질렀다. 사람이 둘만 돼도
    // 서로를 덮는다. 목적지는 상세 패널이 답하는 질문이라 거기로 옮겼다.
    const text = t.phase === 'safehold' ? `${t.name} · 구조 필요`
      : t.phase === 'arrived' ? `${t.name} · 완료`
      : t.name;
    const w = scale * (text.length * 0.95 + 1.6);
    const y = t.y - scale * 3.4;

    this._el('rect', {
      x: t.x - w / 2, y: y - scale * 1.5, width: w, height: scale * 2.3,
      rx: scale * 0.5, fill: '#000', 'fill-opacity': 0.62 * dim,
    });
    this._el('text', {
      x: t.x, y: y + scale * 0.25, 'text-anchor': 'middle',
      'font-size': scale * 1.15, fill: color, 'font-weight': '700',
      'fill-opacity': dim,
    }).textContent = text;
  }

  _el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    this.svg.appendChild(e);
    return e;
  }

  /** 도면 좌표계가 미터냐 픽셀이냐에 따라 값이 크게 달라져 선 굵기를 정규화한다 */
  /** 마커·이름표 크기 배수. 관제는 도면을 크게 띄우므로 작게 줄여 쓴다. */
  setMarkerScale(k) { this.markerScale = k; }

  _scale(floorPlan) {
    const xs = floorPlan.nodes.map(n => n.x);
    const ys = floorPlan.nodes.map(n => n.y);
    if (!xs.length) return 1;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return (span / 40) || 1;
  }
}
