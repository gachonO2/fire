/**
 * 화재감지기 — **실제 설비가 하는 방식대로.**
 *
 * ## 왜 «온도 숫자 하나» 로는 부족한가
 *
 * 지금까지 관제는 감지기를 «℃ 를 보내는 것» 으로만 다뤘다. 그런데 실제
 * 건물의 화재감지 설비는 그렇게 생기지 않았고, 세 가지가 빠져 있었다.
 *
 *   1  **연기감지기가 없었다.** 실제 건물에 제일 많이 달리는 것이 연기감지기고,
 *      불이 나면 **연기가 먼저 운다.** 열이 먼저 울리는 화재는 거의 없다 —
 *      연기가 천장을 타고 퍼지는 속도가 열이 퍼지는 속도보다 훨씬 빠르다.
 *      열만 있으면 «감지가 늦는 시스템» 을 보여 주는 셈이다.
 *
 *   2  **한 번 넘으면 바로 화재였다.** 실제 수신기는 그렇게 안 한다. 담배
 *      연기·수증기·먼지에 감지기가 한 번 튀는 일이 흔해서, 처음 넘으면
 *      «예비경보» 로 잡아 두고 **일정 시간 지속돼야** 화재로 확정한다
 *      (축적 기능). 이 두 단계가 없으면 오보 하나에 대피로가 끊긴다.
 *
 *   3  **기기가 자기 상태를 말하지 않았다.** 실제 R형 수신기는 회로마다
 *      주소를 갖고 «정상/예비/화재/통신불량» 을 보고한다. 통신이 끊긴
 *      감지기를 «정상» 으로 세면, 정작 불난 자리를 못 보고 있으면서 다
 *      보고 있다고 착각한다.
 *
 * ## 기준값은 국내 소방 기준을 따른다
 *
 *   정온식 감지기   공칭작동온도 60~150℃. 실내 복도는 보통 70℃ 품을 쓴다.
 *   차동식 감지기   온도가 **빠르게 오르면** 절대값이 낮아도 작동한다.
 *                   실온에서 분당 15℃ 이상이 대표적인 값이다.
 *   연기감지기      광전식 스포트형 2종의 작동 감광률이 **15%/m** 다.
 *                   («1m 지날 때 빛의 15%가 가려짐»)
 *
 * 이 값들을 코드에 박아 두는 이유는, 나중에 «왜 70℃ 인가» 를 물었을 때
 * 답이 있어야 하기 때문이다. 임의로 고른 숫자는 시연에서 한 번은 질문을
 * 받는다.
 *
 * ## 시간을 부르지 않는다
 *
 * `now` 를 인자로 받는다. 그래야 시험이 «60초 지속되면 화재확정» 을 몇
 * 밀리초에 감아 돌릴 수 있다 (`positioning.js`·`altitude.js` 와 같은 원칙).
 */

/** 감지기 종류 */
export const DETECTOR = {
  SMOKE: 'smoke',
  HEAT: 'heat',
};

/**
 * 국내 소방 기준에서 가져온 작동값.
 *
 * @see 정온식 공칭작동온도 60~150℃ · 광전식 스포트형 2종 감광률 15%/m
 */
export const SPEC = Object.freeze({
  smoke: {
    label: '광전식 연기감지기 2종',
    unit: '%/m',
    /** 감광률 — 이 값을 넘으면 작동 */
    alarm: 15,
    /** 여기부터 «뭔가 있다» — 실제 아날로그 감지기의 예비 문턱 */
    pre: 6,
    /** 평상시 값. 완전히 0 이 아니다 — 먼지가 늘 조금 있다. */
    base: 0.4,
  },
  heat: {
    label: '정온식 스포트형 1종',
    unit: '℃',
    /** 공칭작동온도 */
    alarm: 70,
    /** 이 온도부터 «올라가고 있다» */
    pre: 45,
    base: 23,
    /** 차동식 — 분당 이만큼 오르면 절대값이 낮아도 작동한다 */
    riseAlarmPerMin: 15,
  },
});

/** 감지기 상태 */
export const STATE = {
  /** 평상시 */
  NORMAL: 'normal',
  /** 문턱을 넘었지만 아직 확정 전 — 실제 수신기의 «축적» 구간 */
  PRE_ALARM: 'pre-alarm',
  /** 화재 확정 */
  ALARM: 'alarm',
  /** 회선이 끊겼다 — **정상이 아니라 «모름»이다** */
  FAULT: 'fault',
};

/**
 * 축적 시간(ms) — 문턱을 넘은 뒤 이만큼 지속돼야 화재로 확정한다.
 *
 * 실제 수신기의 축적시간은 5~60초 범위에서 조정한다. 20초로 둔 것은
 * 두 요구가 만나는 값이라서다 — 담배 연기 한 모금이나 문 여닫는 바람은
 * 그보다 짧게 지나가고, 진짜 화재는 그보다 훨씬 오래 간다.
 */
export const VERIFY_MS = 20_000;

/** 이 시간 넘게 소식이 없으면 «통신불량». 보고 주기의 몇 배로 잡는다. */
export const FAULT_MS = 60_000;

/**
 * 감지기 하나의 상태 기계.
 *
 * 값을 판단으로 바꾸는 일을 **여기 한 곳에** 모은다. 화면과 서버가 각자
 * 문턱을 들고 있으면 언젠가 서로 다른 말을 하고, 그때 어느 쪽이 맞는지
 * 가릴 방법이 없다.
 */
export class Detector {
  /**
   * @param {{id:string, kind:string, nodeId:string, address:string, label?:string}} spec
   */
  constructor(spec) {
    this.id = spec.id;
    this.kind = SPEC[spec.kind] ? spec.kind : DETECTOR.HEAT;
    this.nodeId = spec.nodeId;
    /** 수신기 회선 주소 — R형 수신기가 기기를 부르는 이름 */
    this.address = spec.address;
    this.label = spec.label || '';
    this.value = SPEC[this.kind].base;
    this.state = STATE.NORMAL;
    /** 문턱을 처음 넘은 시각 — 축적 판정의 기준 */
    this.since = null;
    this.updatedAt = null;
    /** 직전 값과 시각 — 차동식(상승률) 판정용 */
    this._prev = null;
  }

  get spec() { return SPEC[this.kind]; }

  /** 분당 상승률(℃/min). 열감지기에서만 뜻이 있다. */
  get risePerMin() {
    if (this.kind !== DETECTOR.HEAT || !this._prev) return 0;
    const dt = (this.updatedAt - this._prev.at) / 60_000;
    if (dt <= 0) return 0;
    return (this.value - this._prev.value) / dt;
  }

  /**
   * 판독값 하나를 넣는다.
   * @returns {{changed: boolean, state: string}} 상태가 바뀌었는가
   */
  push(value, now) {
    const before = this.state;
    if (Number.isFinite(value)) {
      this._prev = this.updatedAt === null
        ? { value, at: now } : { value: this.value, at: this.updatedAt };
      this.value = value;
      this.updatedAt = now;
    }
    this._settle(now);
    return { changed: this.state !== before, state: this.state };
  }

  /** 값이 안 들어와도 시간은 간다 — 축적 확정과 통신불량이 여기서 나온다 */
  tick(now) {
    const before = this.state;
    this._settle(now);
    return { changed: this.state !== before, state: this.state };
  }

  _settle(now) {
    // **소식이 없으면 «정상» 이 아니라 «모름» 이다.**
    // 죽은 감지기를 정상으로 세면, 정작 불난 자리를 못 보고 있으면서
    // 다 보고 있다고 착각한다.
    if (this.updatedAt === null || now - this.updatedAt > FAULT_MS) {
      this.state = STATE.FAULT;
      this.since = null;
      this._over = false;
      return;
    }

    const s = this.spec;
    // 차동식 — 온도가 빠르게 오르면 70℃ 를 안 넘어도 작동한다. 실제로
    // 화재 초기에 절대온도보다 먼저 나타나는 신호가 이것이다.
    const fastRise = this.kind === DETECTOR.HEAT
      && s.riseAlarmPerMin && this.risePerMin >= s.riseAlarmPerMin;
    const over = this.value >= s.alarm || fastRise;
    const near = this.value >= s.pre;

    if (!near) {
      this.state = STATE.NORMAL;
      this.since = null;
      this._over = false;
      return;
    }
    if (this.since === null) this.since = now;

    // **한 번 작동 조건을 만나면 그 사실을 붙들고 있는다.**
    //
    // 차동식은 «분당 몇 ℃» 로 판정하는데, 급히 올랐다가 온도가 평평해지면
    // 상승률이 곧바로 떨어진다. 그때 판정을 놓아 버리면 «급상승 → 확정 직전
    // → 없던 일» 이 되어 축적이 영영 안 끝난다. 실제 감지기도 작동한 뒤에는
    // 온도가 내려가야 복구된다 — 상승이 멎었다고 풀리지 않는다.
    //
    // 복구는 위의 `!near` 한 곳에서만 일어난다. 값이 예비 문턱 아래로
    // 내려가는 것, 그것만이 «불이 없다» 는 뜻이다.
    if (over) this._over = true;

    // **넘자마자 화재로 확정하지 않는다.** 담배 연기 한 모금, 문 여닫는
    // 바람, 수증기에 감지기는 흔히 한 번 튄다. 그때마다 대피로를 끊으면
    // 아무도 이 시스템을 안 믿게 된다.
    this.state = this._over && now - this.since >= VERIFY_MS
      ? STATE.ALARM : STATE.PRE_ALARM;
  }

  /** 축적이 끝나기까지 남은 ms. 화면이 «확정까지 12초» 를 적을 수 있다. */
  verifyLeftMs(now) {
    if (this.state !== STATE.PRE_ALARM || this.since === null) return 0;
    return Math.max(0, VERIFY_MS - (now - this.since));
  }

  /** 화면·서버가 같이 쓰는 한 줄 요약 */
  toJSON(now = this.updatedAt ?? 0) {
    return {
      sensorId: this.id,
      address: this.address,
      kind: this.kind,
      typeLabel: this.spec.label,
      nodeId: this.nodeId,
      label: this.label,
      value: Math.round(this.value * 10) / 10,
      unit: this.spec.unit,
      alarmAt: this.spec.alarm,
      state: this.state,
      risePerMin: Math.round(this.risePerMin * 10) / 10,
      verifyLeftMs: this.verifyLeftMs(now),
      ts: this.updatedAt,
    };
  }
}

/** 상태를 사람 말로 — 관제와 앱이 같은 낱말을 쓰게 한다 */
export const STATE_LABEL = {
  [STATE.NORMAL]: '정상',
  [STATE.PRE_ALARM]: '예비경보',
  [STATE.ALARM]: '화재',
  [STATE.FAULT]: '통신불량',
};

/**
 * 여러 감지기의 상태를 수신기 한 줄로 요약한다.
 *
 * 실제 수신기 표시반이 하는 일이 이것이다 — 백 개의 회선 중 **지금 봐야
 * 하는 것**만 위로 올린다.
 */
export function panelSummary(list = []) {
  const by = s => list.filter(d => d.state === s).length;
  const alarm = by(STATE.ALARM);
  const pre = by(STATE.PRE_ALARM);
  const fault = by(STATE.FAULT);
  return {
    total: list.length,
    alarm, pre, fault,
    normal: list.length - alarm - pre - fault,
    // 수신기 표시반의 큰 글씨. 화재가 하나라도 있으면 그것이 이긴다.
    headline: alarm ? '화재' : pre ? '예비경보' : fault ? '점검 필요' : '정상',
    state: alarm ? STATE.ALARM : pre ? STATE.PRE_ALARM
      : fault ? STATE.FAULT : STATE.NORMAL,
  };
}
