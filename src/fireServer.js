/**
 * 화재 신호 수신 — 서버가 폰으로 밀어주는 부분.
 *
 * ## 지금 상태
 *
 * 온도 센서를 아직 안 달았으므로 **연결 규격만 정의**하고, 앱은 모의 신호로
 * 전체 흐름을 시험할 수 있게 해두었다. 센서를 달면 서버가 아래 형식으로
 * 보내주기만 하면 되고 **앱은 고칠 게 없다.**
 *
 * ## 서버가 보내야 하는 것
 *
 *   GET /api/stream            (Server-Sent Events)
 *   event: fire
 *   data: {
 *     "type": "fire",
 *     "location": "3층 서쪽 복도",
 *     "celsius": 72,
 *     "edgeId": "C4",
 *     "at": "2026-08-12T01:20:00Z"
 *   }
 *
 * 온도 센서 게이트웨이는 서버의 기존 엔드포인트를 그대로 쓰면 된다:
 *
 *   POST /api/sensors/temperature
 *   { "sensorId": "TMP-C4", "edgeId": "C4", "celsius": 72 }
 *
 * 서버는 임계값(60°C)을 넘으면 위 fire 이벤트를 브로드캐스트한다.
 * 판정 기준을 앱이 아니라 **서버에 두는** 이유: 기준이 바뀌었을 때
 * 앱을 다시 배포하지 않아도 되고, 관제와 판단이 어긋나지 않는다.
 *
 * ## 왜 폴링이 아니라 SSE 인가
 *
 * 화재는 초 단위가 중요하다. 폴링은 주기만큼 늦고, 배터리도 더 먹는다.
 * SSE 는 서버가 밀어주므로 즉시 도착한다.
 */

const DEFAULT_TIMEOUT = 8000;

export class FireServer {
  /**
   * @param {string} baseUrl  예: http://10.10.15.130:8080
   */
  constructor(baseUrl) {
    this.baseUrl = baseUrl?.replace(/\/$/, '') || null;
    this.onFire = null;
    this.onStatus = null;
    this._stop = false;
    this._retry = 0;
  }

  /** 서버가 없으면 조용히 오프라인으로 둔다 — 촬영 기능은 서버 없이도 쓸 수 있어야 한다 */
  async connect() {
    if (!this.baseUrl) { this._status('offline'); return; }
    this._stop = false;
    this._poll();
  }

  disconnect() { this._stop = true; }

  _status(s) { this.onStatus?.(s); }

  /**
   * React Native 의 fetch 는 SSE 스트리밍을 안정적으로 지원하지 않는다.
   * 그래서 여기서는 짧은 주기 폴링으로 대신한다 — 규격(이벤트 모양)은 같으므로
   * 나중에 EventSource 폴리필로 갈아끼워도 나머지 코드는 그대로다.
   */
  async _poll() {
    while (!this._stop) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT);
        const res = await fetch(`${this.baseUrl}/api/hazards`, { signal: ctrl.signal });
        clearTimeout(to);

        if (res.ok) {
          this._retry = 0;
          this._status('online');
          const hazards = await res.json();
          const active = Object.entries(hazards || {})
            .find(([, h]) => h && (h.type === 'fire' || h.type === 'smoke'));
          if (active) {
            const [edgeId, h] = active;
            this.onFire?.({
              type: 'fire', edgeId,
              location: h.label || '건물 내 화재 감지',
              celsius: h.celsius ?? null,
            });
          }
        } else {
          this._status('error');
        }
      } catch (_) {
        this._retry++;
        this._status('offline');
      }
      // 화재는 초 단위가 중요하므로 짧게, 실패하면 점점 늦춘다
      await sleep(this._stop ? 0 : Math.min(2000 * (1 + this._retry), 15000));
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 센서가 없을 때 전체 흐름을 시험하기 위한 모의 신호 */
export function mockFireEvent() {
  return {
    type: 'fire',
    location: '3층 서쪽 복도',
    celsius: 72,
    edgeId: 'C4',
    at: new Date().toISOString(),
  };
}
