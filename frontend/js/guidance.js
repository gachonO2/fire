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
