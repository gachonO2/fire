/**
 * 비상계단 하강 — **비상구는 도착이 아니라 반환점이다.**
 *
 * ## 왜 이것이 없으면 안내가 거짓말이 되는가
 *
 * 지금까지 안내는 비상구 앞에서 「도착」 이라고 말하고 끝났다. 그런데 6층
 * 계단참에 서 있는 것은 안전한 상태가 아니다. 계단실은 연기가 굴뚝처럼
 * 타고 오르는 통로이고, 불은 아직 같은 층에 있다. **안전한 곳은 건물 밖**
 * 이고, 진짜 대피는 거기까지다.
 *
 * 눈이 보이는 사람에게는 이 구간이 문제가 안 된다. 계단은 눈에 보이고,
 * 층 번호는 벽에 적혀 있고, 1층에 닿으면 출입문이 보인다. **그 셋이 전부
 * 시각 정보다.** 시각장애인에게는 하나도 안 오고, 그래서 이 구간이야말로
 * 이 앱이 필요한 곳인데 여태 비어 있었다.
 *
 * ## 층은 기압으로 센다
 *
 * `AltitudeTracker`(`shared/altitude.js`)가 이미 «몇 층 움직였나» 와
 * «엘리베이터인가 계단인가» 를 낸다. 여기서는 그 결과를 받아 **남은 층수**로
 * 바꾸고, 층이 바뀔 때마다 무엇을 말할지 정한다.
 *
 * 절대 고도는 안 쓴다 — 날씨로 하루에 몇 hPa 씩 움직여서 «지금 3층» 같은
 * 계산이 불가능하다. 변화만 본다.
 *
 * ## 엘리베이터를 타면 막는다
 *
 * 화재 시 엘리베이터는 타면 안 된다. 정전으로 갇히고, 승강로가 연기를
 * 빨아올린다. 그런데 **눈이 안 보이면 계단인지 엘리베이터인지 헷갈릴 수
 * 있다** — 특히 남을 따라 움직일 때. 고도가 내려가는데 걸음이 거의 없으면
 * 엘리베이터이므로, 그때는 «내리세요» 를 말해야 한다.
 *
 * 이 판정은 공짜다. 층을 세려고 이미 재고 있는 값에서 그대로 나온다.
 *
 * ## 기압계가 없으면 없다고 한다
 *
 * 기압계가 없는 폰이 있다. 그때 층수를 **걸음이나 시간으로 추측하지 않는다.**
 * 계단 한 층의 걸음 수는 건물마다 다르고, 틀린 층수를 확신에 차서 말하면
 * 1층인 줄 알고 2층에서 문을 찾는 사람이 생긴다. 셀 수 없으면 «1층까지
 * 내려가세요» 만 말하고 층 수는 침묵한다.
 */

/** 「AI공학관 6층 (COCONE)」 → 6. 못 읽으면 null — 추측하지 않는다. */
export function floorOf(planName) {
  const m = String(planName || '').match(/(?:지하\s*)?(\d+)\s*층/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 대피가 끝나는 층. 지상 출입구가 있는 층이다. */
export const GROUND_FLOOR = 1;

export const DESCENT_PHASE = {
  /** 아직 층에서 비상구로 가는 중 */
  APPROACH: 'approach',
  /** 비상구에 닿았다 — 여기서부터 계단 */
  AT_EXIT: 'at-exit',
  /** 계단을 내려가는 중 */
  DESCENDING: 'descending',
  /** 1층. 이제 건물 밖으로 */
  GROUND: 'ground',
  /** 건물 밖 — 여기서만 «대피 완료» 라고 말한다 */
  OUT: 'out',
};

/**
 * 계단 하강을 따라간다.
 *
 * `AltitudeTracker` 와 같은 원칙으로 **시간을 인자로 받고 스스로 부르지
 * 않는다.** 그래야 시험이 6개 층을 몇 밀리초에 감아 돌릴 수 있다.
 */
export class StairDescent {
  /**
   * @param {number|null} fromFloor 출발 층. `null` 이면 층수를 모른다 —
   *   그때도 안내는 하되 «몇 층 남았다» 를 말하지 않는다.
   * @param {{groundFloor?:number, hasBarometer?:boolean}} [opts]
   */
  constructor(fromFloor, opts = {}) {
    this.fromFloor = Number.isFinite(fromFloor) ? fromFloor : null;
    this.ground = opts.groundFloor ?? GROUND_FLOOR;
    /** 기압계가 없으면 층을 셀 수 없다. 그 사실을 화면이 알아야 한다. */
    this.hasBarometer = opts.hasBarometer !== false;
    this.phase = DESCENT_PHASE.APPROACH;
    /** 지금 몇 층이라고 보는가. 모르면 null. */
    this.floor = this.fromFloor;
    /** 잘못 탄 엘리베이터를 알렸는가 — 한 번만 말한다 */
    this.warnedElevator = false;
  }

  /** 내려가야 할 층 수. 모르면 null. */
  get floorsLeft() {
    if (this.floor === null) return null;
    return Math.max(0, this.floor - this.ground);
  }

  /** 계단을 다 내려왔는가 */
  get atGround() {
    return this.phase === DESCENT_PHASE.GROUND || this.phase === DESCENT_PHASE.OUT;
  }

  /** 진짜로 끝났는가 — **밖으로 나가야 끝이다** */
  get done() { return this.phase === DESCENT_PHASE.OUT; }

  /**
   * 비상구에 닿았다. 여기서 「도착」 이라고 말하면 안 된다.
   * @returns {{say: string, phase: string}}
   */
  reachExit(exitName = '비상구') {
    this.phase = DESCENT_PHASE.AT_EXIT;
    const left = this.floorsLeft;
    // 층수를 알 때만 말한다. 「몇 개 층」 은 마음의 준비를 만드는 정보라
    // 값어치가 크지만, 틀리면 그만큼 해롭다.
    const howFar = left && this.hasBarometer
      ? ` 여기서 1층까지 ${left}개 층입니다.`
      : ' 1층까지 내려가야 합니다.';
    return {
      phase: this.phase,
      say: `${exitName}입니다. 계단으로 내려가세요.${howFar}`
        + ' 엘리베이터는 타지 마세요.',
    };
  }

  /**
   * 고도 판정 하나를 받는다. `AltitudeTracker.push()` 의 결과를 그대로 넣는다.
   *
   * @param {{kind:'elevator'|'stair', floors:number}|null} change
   * @returns {{say?: string, phase: string, floor: number|null, alarm?: boolean}}
   */
  push(change) {
    if (!change || !change.floors) return this._state();

    // **엘리베이터는 막는다.** 고도가 변하는데 걸음이 거의 없으면 그것이다.
    if (change.kind === 'elevator') {
      if (this.warnedElevator) return this._state();
      this.warnedElevator = true;
      return {
        ...this._state(),
        alarm: true,
        say: '엘리베이터입니다. 화재 시에는 위험합니다.'
          + ' 다음 층에서 내려 계단으로 가세요.',
      };
    }

    // 계단으로 움직였다. 내려간 것만 센다 — 올라가는 것은 대피가 아니다.
    if (this.floor !== null) {
      this.floor = Math.max(this.ground, this.floor + change.floors);
    }
    this.phase = this.floorsLeft === 0
      ? DESCENT_PHASE.GROUND : DESCENT_PHASE.DESCENDING;

    if (this.phase === DESCENT_PHASE.GROUND) {
      return { ...this._state(), say: '1층입니다. 건물 밖으로 나가세요.' };
    }
    // 층이 바뀔 때마다 알린다. 눈으로 벽의 층 번호를 읽을 수 없으므로,
    // 이것이 «내가 어디쯤인가» 를 아는 유일한 통로다.
    const left = this.floorsLeft;
    return {
      ...this._state(),
      say: this.floor !== null
        ? `${this.floor}층입니다. ${left}개 층 남았습니다.`
        : '한 층 내려왔습니다.',
    };
  }

  /**
   * 층수를 모르는 폰에서, 사람이 «다 내려왔다» 고 알릴 때.
   * 기계가 못 세면 사람이 말할 길은 열어 둔다 — 못 세는 것과 못 끝내는 것은
   * 다른 문제다.
   */
  markGround() {
    this.floor = this.ground;
    this.phase = DESCENT_PHASE.GROUND;
    return { ...this._state(), say: '1층입니다. 건물 밖으로 나가세요.' };
  }

  /** 건물 밖으로 나왔다. **여기서만 대피 완료다.** */
  markOut() {
    this.phase = DESCENT_PHASE.OUT;
    return { ...this._state(), say: '대피 완료입니다. 안전한 곳입니다.' };
  }

  _state() {
    return { phase: this.phase, floor: this.floor, floorsLeft: this.floorsLeft };
  }
}
