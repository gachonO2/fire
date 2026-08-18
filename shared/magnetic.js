/**
 * 지자기 지문 — 자기장 세기의 **순서**로 위치를 좁힌다.
 *
 * ## 원리
 *
 * 건물 안에서는 철골·전선·배관이 지구 자기장을 휘게 만든다. 그 휘어짐이 자리마다
 * 다르고, 철골은 움직이지 않으므로 시간이 지나도 같다. 그래서 지문이 된다.
 *
 * **크기(|B|)만 쓴다.** 자력계는 벡터(x,y,z)를 주는데 폰을 돌리면 셋이 모두
 * 바뀐다. 하지만 크기는 안 바뀐다. 지팡이를 짚고 한 손으로 폰을 든 사람에게
 * 이건 결정적이다 — 나침반이 "기울여 들면 틀어진다"로 겪는 문제를 통째로 피한다.
 *
 * ## 값 하나로는 못 쓴다
 *
 * 복도 60m 를 0.5m 간격으로 나누면 120지점인데, 센서 노이즈와 기종 편차를 감안한
 * 구분 가능 단계는 15개쯤이다. 즉 **한 값이 같은 곳이 평균 8군데** 있다.
 *
 * 그래서 연달아 본다. 음 하나 "도"는 어느 노래에나 있지만 "도–미–솔–도–라–파"는
 * 거의 특정 노래인 것과 같다. 열 걸음의 오르내림은 거의 유일하다.
 *
 * ## 폰마다 값이 다른 문제
 *
 * 폰 안의 스피커 자석·카메라가 자력계를 밀어놓는다(하드아이언 오프셋). 기종마다,
 * 개체마다 다르다. 아이폰으로 측량한 지문을 갤럭시로 대조하면 전체가 몇 μT
 * 어긋나 있다.
 *
 *   측량(아이폰)  48.2  51.7  49.1  44.3
 *   사용(갤럭시)  51.4  54.9  52.3  47.5     ← 전부 +3.2
 *   차이            +3.5  −2.6  −4.8         ← 오르내림은 같다
 *
 * 그래서 **절대값이 아니라 모양을 비교한다.** 창 안의 평균을 빼면 오프셋이
 * 사라지고 오르내림만 남는다.
 *
 * ## 이 모듈은 아직 검증되지 않았다
 *
 * 위 전제는 전부 "같은 자리에서 같은 값이 나온다"에 기대고 있는데, 그것을 실제로
 * 재본 적이 없다. `reproducibilityReport()` 가 그 판정을 위한 것이고, 통과하지
 * 못하면 이 기능은 접는다. 먼저 재보고 나중에 만드는 순서다.
 */

export const MAGNETIC_DEFAULTS = {
  /** 대조에 쓰는 창 길이(걸음) */
  windowSteps: 8,
  /** 창이 이보다 짧으면 판단하지 않는다 — 짧은 조각은 어디에나 맞는다 */
  minSteps: 5,
  /** 이만큼(μT) 어긋나면 점수가 1/e 로 떨어진다 */
  toleranceUt: 1.5,

  /** 누적 확정으로 승격할 조건 */
  anchorScore: 0.75,      // 1등 후보의 닮음이 이 이상이고
  anchorMargin: 0.25,     // 2등과 이만큼 벌어져야 앵커를 놓는다

  /** 재현성 판정 문턱 (지점 간 차이 ÷ 방문 간 차이) */
  goodRatio: 3.0,
  marginalRatio: 1.5,
};

// ───────────────────────────────────────────────── 순수 함수

/** 평균을 빼서 폰별 오프셋을 없앤다 — 남는 것은 오르내림뿐 */
export function normalizeWindow(values) {
  if (!values?.length) return [];
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.map(v => v - mean);
}

/**
 * 두 수열이 얼마나 닮았나. 0~1, 1이 완전 일치.
 * 길이가 다르면 짧은 쪽에 맞춘다(끝을 기준으로 — 최근 걸음이 중요하다).
 */
export function matchScore(a, b, toleranceUt = MAGNETIC_DEFAULTS.toleranceUt) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  if (n === 0) return 1;                       // 비교할 게 없으면 감점하지 않는다
  const x = normalizeWindow(a.slice(a.length - n));
  const y = normalizeWindow(b.slice(b.length - n));
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (x[i] - y[i]) ** 2;
  const rmse = Math.sqrt(sq / n);
  return Math.exp(-((rmse / toleranceUt) ** 2));
}

/**
 * 측량 결과를 걸음 단위 지문으로 만든다.
 * @param {number[]} samples 통로를 한 번 걸으며 고르게 받은 |B| 값들
 * @param {number} steps     그 통로의 걸음 수
 * @returns {number[]} 길이 steps+1 (양 끝 노드 포함)
 */
export function buildFingerprint(samples, steps) {
  const out = [];
  if (!samples?.length) return out;
  for (let i = 0; i <= steps; i++) {
    const at = (i / steps) * (samples.length - 1);
    const lo = Math.floor(at), hi = Math.min(samples.length - 1, lo + 1);
    out.push(samples[lo] + (samples[hi] - samples[lo]) * (at - lo));
  }
  return out;
}

/**
 * 재현성 판정 — **이 기능을 만들지 말지 정하는 검사.**
 *
 * 같은 자리를 두 번 이상 방문한 기록을 넣으면, 「같은 자리가 같은 값을 내는가」와
 * 「다른 자리가 다른 값을 내는가」를 비교해 준다. 앞이 뒤보다 크면 지문이 성립하지
 * 않으므로 여기서 접는다.
 *
 * @param {Array<{spot:string, samples:number[]}>} visits 방문 기록 (같은 spot 반복 가능)
 */
export function reproducibilityReport(visits, opts = {}) {
  const o = { ...MAGNETIC_DEFAULTS, ...opts };
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

  const bySpot = new Map();
  for (const v of visits || []) {
    if (!v?.samples?.length) continue;
    if (!bySpot.has(v.spot)) bySpot.set(v.spot, []);
    bySpot.get(v.spot).push(mean(v.samples));
  }

  const spots = [...bySpot.entries()]
    .filter(([, ms]) => ms.length >= 2)
    .map(([spot, ms]) => ({
      spot,
      visits: ms.length,
      mean: mean(ms),
      // 같은 자리를 다시 갔을 때 얼마나 어긋났나
      spread: Math.max(...ms) - Math.min(...ms),
    }));

  if (spots.length < 2) {
    return { verdict: 'insufficient', spots, withinUt: null, betweenUt: null, ratio: null,
      message: '지점 두 곳 이상을 각각 두 번 이상 재야 판정할 수 있습니다.' };
  }

  const withinUt = mean(spots.map(s => s.spread));
  let pairs = 0, sum = 0;
  for (let i = 0; i < spots.length; i++) {
    for (let j = i + 1; j < spots.length; j++) { sum += Math.abs(spots[i].mean - spots[j].mean); pairs++; }
  }
  const betweenUt = sum / pairs;
  const ratio = withinUt > 0 ? betweenUt / withinUt : Infinity;

  const verdict = ratio >= o.goodRatio ? 'good'
    : ratio >= o.marginalRatio ? 'marginal'
    : 'unusable';
  const message = {
    good: '지문이 성립합니다. 지자기를 누적 확정 단서로 쓸 수 있습니다.',
    marginal: '경계선입니다. 지점을 더 촘촘히 잡거나 참고 단서로만 쓰세요.',
    unusable: '같은 자리가 같은 값을 내지 않습니다. 지자기는 접는 편이 낫습니다.',
  }[verdict];

  return { verdict, ratio, withinUt, betweenUt, spots, message };
}

// ───────────────────────────────────────────────── 실시간 대조

export class MagneticMatcher {
  /**
   * @param {FloorPlan} floorPlan 엣지에 `magnetic` 배열(a→b 방향)이 붙어 있어야 한다
   */
  constructor(floorPlan, opts = {}) {
    this.opts = { ...MAGNETIC_DEFAULTS, ...opts };
    this.setFloorPlan(floorPlan);
    this.reset();
  }

  setFloorPlan(floorPlan) {
    this.plan = floorPlan;
    this.prints = new Map();
    for (const e of floorPlan.edges) {
      if (Array.isArray(e.magnetic) && e.magnetic.length >= 2) this.prints.set(e.id, e.magnetic);
    }
  }

  reset() { this.recent = []; }

  /** 도면에 지문이 하나라도 있나 — 없으면 이 계층을 통째로 건너뛰면 된다 */
  get hasFingerprints() { return this.prints.size > 0; }

  /** 걸음마다 한 번. |B| (μT) */
  push(microTesla) {
    if (!Number.isFinite(microTesla)) return;
    this.recent.push(microTesla);
    if (this.recent.length > this.opts.windowSteps) this.recent.shift();
  }

  /**
   * 후보 하나의 닮음 점수. `Fusion.observe()` 에 그대로 넘길 수 있다.
   * 지문이 없거나 창이 짧으면 **1**(감점 없음)을 낸다 — 모르는 것과 틀린 것은 다르다.
   */
  scoreFor(cand) {
    const seg = this._segment(cand, this.recent.length);
    if (!seg) return 1;
    return matchScore(this.recent, seg, this.opts.toleranceUt);
  }

  /**
   * 지금 창으로 누적 확정을 걸 수 있나.
   *
   * **노드가 아니라 통로 위의 한 점**을 돌려준다. 지자기는 "어디쯤"을 아는
   * 신호라서, 지문이 통로 한가운데와 맞았는데 끝 노드로 확정하면 남은 절반을
   * 순간이동한다.
   *
   * @param {Array} cands Fusion.snapshot() 결과
   * @returns {{position:{from,to,step,steps}, score, margin}|null}
   */
  verdict(cands) {
    if (this.recent.length < this.opts.minSteps) return null;
    const scored = cands
      .map(c => ({ c, s: this.scoreFor(c) }))
      .sort((p, q) => q.s - p.s);
    if (scored.length === 0) return null;

    const top = scored[0];
    // 비교 대상은 **다른 통로에 있는** 후보다. 같은 통로에서 한두 걸음 어긋난
    // 후보는 어차피 비슷한 점수가 나오는데, 그걸 경쟁자로 보면 영영 확정을 못 한다.
    const rival = scored.find(x => x.c.from !== top.c.from || x.c.to !== top.c.to);
    if (!rival) return null;   // 비교 대상이 없으면 "다른 데는 안 닮았다"가 증명 안 된다

    const margin = top.s - rival.s;
    if (top.s < this.opts.anchorScore || margin < this.opts.anchorMargin) return null;
    return {
      position: { from: top.c.from, to: top.c.to, step: top.c.step, steps: top.c.steps },
      score: top.s,
      margin,
    };
  }

  /**
   * 후보가 서 있는 통로의 지문에서 최근 `len` 걸음에 해당하는 구간을 뽑는다.
   * 통로를 b→a 로 걷는 중이면 지문을 뒤집어 쓴다.
   */
  _segment(cand, len) {
    const edgeId = this._edgeId(cand.from, cand.to);
    const fp = edgeId && this.prints.get(edgeId);
    if (!fp) return null;

    const edge = this.plan.getEdge(edgeId);
    const forward = edge.a === cand.from;
    // 지문 색인: 정방향이면 step 그대로, 역방향이면 끝에서부터
    const idxAt = s => (forward ? s : cand.steps - s);

    // 창이 이 통로 안에 들어오는 만큼만 쓴다. 노드를 넘어가는 구간은 다음 통로의
    // 지문이라 여기서 이어붙이지 않는다 — 잘못 이으면 없던 무늬가 생긴다.
    const avail = Math.min(len, cand.step + 1);
    if (avail < this.opts.minSteps) return null;

    const out = [];
    for (let k = avail - 1; k >= 0; k--) {
      const i = idxAt(cand.step - k);
      if (i < 0 || i >= fp.length) return null;
      out.push(fp[i]);
    }
    return out;
  }

  _edgeId(a, b) {
    for (const e of this.plan.edges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e.id;
    }
    return null;
  }
}
