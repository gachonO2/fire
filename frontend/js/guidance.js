/**
 * 음성·진동 안내 모듈 — MVP 규칙: 명령은 6개만 사용한다.
 *   직진 / 좌회전 / 우회전 / 멈춤 / 위험 / 구조요청
 *
 * Visual_Slam(MIT)의 accessibility.js(SpeechSynthesis + Vibration API) 구조를 참고,
 * 시각장애인 당사자 검증을 전제로 "짧고 오해 없는" 문장 규칙으로 재작성.
 *
 * 진동 규칙:
 *   대피모드 시작  긴 진동 1회
 *   직진          짧은 진동 1회
 *   우회전 지점    짧은 진동 2회
 *   좌회전 지점    짧은 진동 3회
 *   멈춤          긴 진동 1회
 *   위험          긴 진동 3회 (긴급 패턴)
 *   구조요청       매우 긴 진동 2회
 */

const VIBRATION = {
  start:    [800],
  straight: [180],
  right:    [160, 120, 160],
  left:     [160, 120, 160, 120, 160],
  stop:     [700],
  danger:   [400, 150, 400, 150, 400],
  sos:      [1000, 250, 1000],
  arrive:   [250, 120, 250, 120, 700],
  // 자동 화재 경보 — 다른 어떤 신호와도 헷갈리지 않게 길고 반복적으로
  alarm:    [500, 200, 500, 200, 500, 200, 900],
};

export class Guidance {
  constructor() {
    this.enabled = true;
    this.voiceRate = 0.95; // 재난 상황: 또박또박
    this.lastText = '';
    this.onAnnounce = null; // 화면 표시용 콜백 (text, kind)
  }

  vibrate(kind) {
    if (navigator.vibrate && VIBRATION[kind]) {
      navigator.vibrate(VIBRATION[kind]);
    }
  }

  speak(text, { interrupt = true } = {}) {
    this.lastText = text;
    if (this.onAnnounce) this.onAnnounce(text);
    if (!('speechSynthesis' in window)) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ko-KR';
    u.rate = this.voiceRate;
    u.pitch = 1.0;
    speechSynthesis.speak(u);
  }

  repeat() {
    if (this.lastText) this.speak(this.lastText);
  }

  // ------------------------------------------------ 6개 명령
  cmdStart(exitName) {
    this.vibrate('start');
    this.speak(`대피 모드를 시작합니다. 목표는 ${exitName}입니다.`);
  }

  /**
   * 화재 자동 감지 경보 — 사용자가 아무것도 누르지 않았는데 울린다.
   * 그래서 다른 안내와 확실히 구분되는 긴 경보 진동을 먼저 주고,
   * "불이 났다 → 어디에 났다 → 이제 안내한다" 순서로 말한다.
   */
  cmdAlarm(whereText) {
    if (navigator.vibrate) navigator.vibrate(VIBRATION.alarm);
    this.speak(`화재가 발생했습니다. ${whereText} 지금부터 대피를 안내합니다.`);
  }

  /** 위치를 모르는 상태의 경보. 경로 안내나 자동 구조요청을 시작한다고 말하지 않는다. */
  cmdAlarmNeedsLocation(whereText) {
    if (navigator.vibrate) navigator.vibrate(VIBRATION.alarm);
    this.speak(`화재가 감지되었습니다. ${whereText} 현재 위치를 먼저 확인해야 합니다. 벽의 안내 태그나 QR을 확인하세요.`);
  }

  cmdStraight(steps, wall) {
    this.vibrate('straight');
    const wallText =
      wall === 'right' ? ' 오른쪽 벽을 따라가세요.' :
      wall === 'left'  ? ' 왼쪽 벽을 따라가세요.'  : '';
    this.speak(`정면으로 ${steps}걸음 이동하세요.${wallText}`);
  }

  cmdTurn(dir, nextSteps) {
    this.vibrate(dir); // 'left' | 'right'
    const dirText = dir === 'left' ? '왼쪽' : '오른쪽';
    this.speak(`${dirText}으로 도세요. 그다음 ${nextSteps}걸음 직진입니다.`);
  }

  cmdStop(reason) {
    this.vibrate('stop');
    this.speak(`멈추세요. ${reason || ''}`.trim());
  }

  /** 잘못된 방향에서는 금속탐지기식 방향 신호를 끊는다. */
  cmdWrongWay(reason) {
    navigator.vibrate?.(0);
    this.speak(`멈추세요. ${reason || '방향 신호를 다시 찾으세요.'}`.trim());
  }

  cmdDanger(text) {
    this.vibrate('danger');
    this.speak(`위험. ${text}`);
  }

  cmdSOS() {
    this.vibrate('sos');
    this.speak('제자리에서 구조요청을 전송합니다. 이동하지 말고 대기하세요.');
  }

  cmdArrive(exitName) {
    this.vibrate('arrive');
    this.speak(`${exitName}에 도착했습니다. 손잡이를 잡고 계단을 이용해 내려가세요.`);
  }

  cmdReroute(reason) {
    this.vibrate('danger');
    this.speak(`${reason} 경로를 다시 계산합니다.`);
  }
}
