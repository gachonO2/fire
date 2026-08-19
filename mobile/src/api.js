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

  /** 관제가 준비한 사진 시나리오를 휴대폰 진입 시점부터 90초로 시작한다. */
  startPhotoScenarioTimeline() {
    return this._fetch('/api/demo/photo-scenario/start', { method: 'POST' });
  }

  /** 서버 시각으로 계산된 공용 좌표. 관제와 휴대폰 모두 이 값만 쓴다. */
  getPhotoScenarioTimeline() { return this._fetch('/api/demo/photo-scenario'); }

  /**
   * 내 위치 보고 — 관제 지도에 실시간으로 뜨게 한다.
   *
   * 앱이 위치를 알아내 놓고 자기만 알고 있으면 관제는 대피자가 어디 있는지 모른다.
   * 보호자 알림도 서버가 이 값을 받아야 나간다(phase 가 바뀔 때).
   *
   * 실패해도 조용히 넘어간다 — 위치 보고가 안 됐다고 안내를 멈추면 안 된다.
   */
  updatePosition(userId, payload) {
    return this._fetch(`/api/positions/${encodeURIComponent(userId)}`, {
      method: 'PUT', body: JSON.stringify(payload),
    }).catch(() => null);
  }

  /** 현재 위험 구간 — 화재 감지와 재탐색 판단에 함께 쓴다 */
  getHazards() { return this._fetch('/api/hazards'); }

  /** 구조 요청 — 위치 확신이 무너졌을 때 보호자·관제에 알린다 */
  sos(payload) {
    return this._fetch('/api/sos', { method: 'POST', body: JSON.stringify(payload) });
  }

  /**
   * 맥이 대신 들은 비콘 판정을 받아 온다.
   *
   * 폰이 BLE 를 못 읽는 동안(Expo Go 제약) **실제 전파로 위치를 잡는 유일한 길**이다.
   * SSE 를 쓰지 않고 짧은 주기로 물어보는 이유: 이 앱은 SSE 배선이 없고, 판정은
   * 초 단위면 충분하다. 배선 하나 늘리는 것보다 이쪽이 고장날 여지가 적다.
   */
  getBeaconFix() { return this._fetch('/api/beacon-fix'); }

  /** 답사 결과 — 몇 지점을 등록했는지 보여 주는 데 쓴다 */
  getBeaconMap() { return this._fetch('/api/beacon-map'); }

  /**
   * 지자기 재현성 — 한 지점을 한 번 잰 결과를 서버에 더한다.
   *
   * 같은 지점을 두 번 이상 보내야 판정이 나온다. 그게 «재현성» 의 뜻이고,
   * 이 검사가 통과하지 못하면 지자기는 접는다.
   */
  postMagneticVisit(spot, samples) {
    return this._fetch('/api/magnetic/visit', {
      method: 'POST', body: JSON.stringify({ spot, samples }),
    });
  }

  getMagnetic() { return this._fetch('/api/magnetic'); }

  /** 통로 지문 저장. 재현성이 «쓸 수 없음» 이면 서버가 거부한다. */
  putMagneticPrint(edgeId, samples) {
    return this._fetch(`/api/magnetic/print/${encodeURIComponent(edgeId)}`, {
      method: 'PUT', body: JSON.stringify({ samples }),
    });
  }

  /** 도면에 얹을 지문 묶음 — `MagneticMatcher` 가 이걸 먹는다 */
  getMagneticPrints() { return this._fetch('/api/magnetic/prints'); }

  /**
   * 도면에서 읽어낸 벽 — **선이 벽을 뚫는지 보는 데 쓴다.**
   *
   * 관제는 이미 이 값을 쓰고 있었고 앱만 몰랐다. 그래서 앱 지도는 통로를 곧게
   * 이어 벽을 가로질렀다. 같은 도면을 두 화면이 다르게 그리고 있던 셈이다.
   */
  getPlanWalls(planId) { return this._fetch(`/api/plans/${encodeURIComponent(planId)}/walls`); }

  /** 도면 사진 — 지도 배경으로 깐다. 큰 data URI 라 한 번만 받아 캐시한다. */
  /**
   * 도면 사진.
   *
   * 정리본(`/floor`, 글씨·배경을 지운 PNG)을 먼저 본다 — 원본은 base64 데이터
   * URI 라 867KB 인데 정리본은 198KB 다. 폰이 LAN 으로 받는 값이라 이 차이가
   * 그대로 «도면 뜨는 시간» 이 된다. 정리본이 없는 도면이면 원본으로 물러선다.
   */
  async getPlanImage(planId) {
    const id = encodeURIComponent(planId);
    try {
      const r = await fetch(`${this.baseUrl}/api/plans/${id}/floor`);
      if (r.ok) return { dataUri: `${this.baseUrl}/api/plans/${id}/floor` };
    } catch (_) { /* 서버가 정리본을 안 주면 원본으로 */ }
    return this._fetch(`/api/plans/${id}/image`);
  }
  /** 시뮬레이션에서 "지금 서 있는 곳" — 실물 매핑이 쌓이면 안 쓰인다 */
  getStandNode() { return this._fetch('/api/demo/stand'); }
  /**
   * 걸어서 알아낸 북쪽 보정을 저장한다.
   *
   * 한 번만 재면 되는 값이다 — 건물이 돌아가지 않으니까. 저장해 두면 다음 사람은
   * 곧게 네 걸음을 걷지 않아도 첫 순간부터 방향 안내를 받는다.
   */
  setPlanNorth(planId, northOffset, note) {
    return this._fetch(`/api/plans/${encodeURIComponent(planId)}/north`, {
      method: 'PUT', body: JSON.stringify({ northOffset, note }),
    });
  }

  /** 걸어서 잰 축척을 저장한다 — 모든 거리 안내가 이 값으로 다시 계산된다 */
  setPlanScale(planId, metersPerUnit, note) {
    return this._fetch(`/api/plans/${encodeURIComponent(planId)}/scale`, {
      method: 'PUT', body: JSON.stringify({ metersPerUnit, note }),
    });
  }
}
