/**
 * 서버 통신 — `../fire` 백엔드가 머리, 이 앱이 몸이다.
 *
 * 경로 계산·화재 판정·위험 반영은 **전부 서버가** 한다. 앱은 "다음 지점까지 몇 도,
 * 몇 미터"만 받아 진동과 소리로 바꾼다. 판단을 두 곳에 두면 관제 화면과 앱이
 * 서로 다른 말을 하게 되고, 대피 중에 그건 치명적이다.
 *
 * ## 서버가 없어도 죽지 않는다
 *
 * 도면 수집(촬영)은 화재와 무관한 일상 작업이라 오프라인에서도 돼야 하고,
 * 화재 중에 연결이 끊겨도 **이미 받아둔 경로로 계속 안내**해야 한다.
 * 그래서 모든 호출은 실패를 예외가 아니라 `null` 로 돌려주고, 부르는 쪽이 판단한다.
 */

const TIMEOUT_MS = 6000;

export class Api {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.online = false;
    this.onStatus = null;
  }

  get configured() { return Boolean(this.baseUrl); }

  async _fetch(path, opts = {}) {
    if (!this.configured) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
    try {
      const res = await fetch(this.baseUrl + path, {
        ...opts,
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
      });
      this._setOnline(true);
      // 기본은 실패를 null 로 뭉갠다 — 부르는 쪽이 "연결이 안 됐다"만 알면 되기 때문.
      // 다만 등록처럼 **왜 안 됐는지 사람에게 보여줘야 하는** 호출은 본문을 살린다.
      if (!res.ok) {
        if (!opts.keepError) return null;
        return await res.json().catch(() => ({ error: `서버 오류 (${res.status})` }));
      }
      return await res.json();
    } catch (_) {
      this._setOnline(false);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _setOnline(v) {
    if (this.online === v) return;
    this.online = v;
    this.onStatus?.(v);
  }

  /** 활성 도면 전체 (노드·통로·축척·북쪽 보정) */
  getMap() { return this._fetch('/api/map'); }

  /**
   * 대피 경로. 서버가 위험 구간을 빼고 가장 가까운 출구를 고른다.
   * @returns { route: {nodes, edges, distance, exit} | null, ms }
   */
  route(fromNodeId, kind = 'initial', userId) {
    return this._fetch('/api/route', {
      method: 'POST',
      body: JSON.stringify({ from: fromNodeId, kind, userId }),
      timeoutMs: 8000,
    });
  }

  /**
   * 찍은 피난안내도를 보낸다 — 사진 저장 + AI 판독 + 초안 생성이 서버에서 한 번에.
   *
   * 판독에 시간이 걸리므로 타임아웃을 길게 둔다. 사람이 버튼을 누르고 기다리는
   * 작업이라 1분은 괜찮지만, 실패로 끊겨서 사진이 사라지는 건 안 된다.
   */
  submitDraft(body) {
    return this._fetch('/api/plans/draft', {
      method: 'POST', body: JSON.stringify(body), timeoutMs: 120000, keepError: true,
    });
  }

  /** 서버가 아는 대피자 위치 — 비콘 게이트웨이나 관제가 올린 값 */
  getPositions() { return this._fetch('/api/positions'); }

  /** 현재 위험 구간 — 화재 감지와 재탐색 판단에 함께 쓴다 */
  getHazards() { return this._fetch('/api/hazards'); }

  /** 구조 요청 — 위치 확신이 무너졌을 때 보호자·관제에 알린다 */
  sos(payload) {
    return this._fetch('/api/sos', { method: 'POST', body: JSON.stringify(payload) });
  }
}
