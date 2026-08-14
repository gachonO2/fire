/**
 * 방위 자동 보정 — 걷기만 하면 도면과 나침반이 이어진다.
 *
 * ## 왜 필요한가
 *
 * 도면은 종이에 아무 방향으로나 그려진다. 도면 위쪽이 실제로 몇 도인지(`northOffset`)를
 * 모르면 "폰을 이쪽으로 돌리세요"를 할 수 없다.
 *
 * 예전에는 등록할 때 사람에게 물어봤다. 그 입력을 없앴더니 **진동 안내가 통째로
 * 죽었다** — 목표 방위가 null 이라 아무 신호도 안 나갔다. 사람에게 다시 묻는 대신
 * 앱이 알아내게 한다.
 *
 * ## 어떻게 알아내는가
 *
 * 복도를 걸으면 그 방향이 곧 그 구간의 실제 방위다.
 *
 *   northOffset = (걸으면서 잰 실제 방위) − (도면 안에서 그 구간이 놓인 각도)
 *
 * 몇 걸음 동안 **방향이 흔들리지 않고** 이어졌을 때만 채택한다. 두리번거리거나
 * 제자리에서 도는 동안 잡으면 엉뚱한 값이 박힌다.
 *
 * ## 틀리게 잡히면 어떻게 되나
 *
 * 반대로 걸었다면 보정이 180° 틀어진다. 그래서 **한 번 잡고 끝내지 않는다** —
 * 이후 구간에서도 계속 재고, 값이 크게 어긋나면 다시 잡는다. 잘못 잡힌 채로
 * 굳는 것이 가장 위험하다.
 *
 * ## 비콘이 붙으면 필요 없어진다
 *
 * 비콘은 신호 세기로 "가까워진다/멀어진다"를 직접 준다. 나침반도 도면 방위도
 * 필요 없다. 이 파일은 그때까지 쓰는 다리다.
 */

// 순수 계산만 쓴다 — 네이티브 센서 모듈에 기대지 않아야 따로 시험할 수 있다
import { norm360, normalizeDelta } from './route.js';

/** 이 걸음 수 이상 곧게 걸어야 한 표본으로 인정한다 */
const STEPS_PER_SAMPLE = 4;

/** 그동안 방위가 이보다 흔들렸으면 버린다 (두리번거린 것) */
const WOBBLE_DEG = 30;

/** 이보다 어긋나면 보정을 다시 잡는다 */
const REDO_DEG = 50;

export class NorthCalibrator {
  constructor() {
    this.offset = null;      // 확정된 보정값(도). null 이면 아직 모름
    this.samples = 0;        // 채택한 표본 수 — 많을수록 믿을 만하다
    this._steps = 0;
    this._headings = [];
  }

  get calibrated() { return this.offset !== null; }

  /** 구간이 바뀌면 모으던 표본을 버린다 — 다른 방향이 섞이면 의미가 없다 */
  resetSegment() {
    this._steps = 0;
    this._headings = [];
  }

  /**
   * 한 걸음 걸었다.
   *
   * @param heading      지금 나침반 방위(도). 없으면 무시
   * @param planBearing  지금 걷고 있는 구간이 도면 안에서 놓인 각도(도)
   * @param stable       방위를 믿을 만한 상태인가
   * @returns {null | {offset, redone}} 보정이 갱신됐을 때만 값을 준다
   */
  step({ heading, planBearing, stable }) {
    if (heading === null || planBearing === null || !stable) {
      this.resetSegment();
      return null;
    }

    this._headings.push(heading);
    this._steps++;
    if (this._steps < STEPS_PER_SAMPLE) return null;

    // 걷는 동안 방향이 흔들렸으면 버린다
    const headings = this._headings.slice();
    const base = headings[0];
    const wobble = Math.max(...headings.map(h => Math.abs(normalizeDelta(h - base))));
    this.resetSegment();
    if (wobble > WOBBLE_DEG) return null;

    const measured = norm360(circularMean(headings) - planBearing);

    if (this.offset === null) {
      this.offset = measured;
      this.samples = 1;
      return { offset: this.offset, redone: false };
    }

    const drift = Math.abs(normalizeDelta(measured - this.offset));
    if (drift > REDO_DEG) {
      // 크게 어긋났다 — 처음 보정이 틀렸을 가능성이 높다. 새 값으로 갈아탄다.
      this.offset = measured;
      this.samples = 1;
      return { offset: this.offset, redone: true };
    }

    // 조금씩만 다듬는다. 한 표본이 튀어도 크게 흔들리지 않게.
    this.offset = norm360(this.offset + normalizeDelta(measured - this.offset) / (this.samples + 1));
    this.samples++;
    return { offset: this.offset, redone: false };
  }
}

/** 각도의 평균 — 359°와 1°의 평균이 180°가 되지 않도록 벡터로 더한다 */
function circularMean(degs) {
  if (!degs.length) return 0;
  let sx = 0; let sy = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  return norm360((Math.atan2(sy, sx) * 180) / Math.PI);
}
