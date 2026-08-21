/**
 * 안드로이드 폰으로 **진짜 전파를 받는다.**
 *
 * ## 왜 폰이어야 하나
 *
 * 지금까지 스캔은 맥북(`scripts/scan-beacons.py`)이 했다. 답사는 그걸로
 * 됐지만 대피 안내는 안 된다 — 시각장애인이 맥북을 들고 대피할 리 없다.
 * 안내를 받는 기기와 위치를 잡는 기기가 같아야 «걸으면 따라온다» 가 된다.
 *
 * ## 식별자가 기기마다 다르다 — 이게 설계를 정한다
 *
 * Web Bluetooth 의 `device.id` 는 MAC 이 아니라 **(출처, 기기) 쌍마다 크롬이
 * 만드는 불투명한 값**이다. 맥북 CoreBluetooth 의 peripheral UUID 도
 * 마찬가지고, iOS 도 그렇다. 즉 같은 공유기를 세 기기가 보면 **세 값이 다
 * 다르다.**
 *
 * 그래서 맥북으로 만든 24신호 답사를 폰이 물려받을 수 없다. 폰은 **자기
 * 답사를 자기가 만들어야** 한다. 그 일을 사람 손으로 시키면 지점마다 서서
 * 태그하는 노동이 기기 수만큼 늘어나므로, 자동 답사(`/api/observations`)가
 * 선택이 아니라 전제가 된다.
 *
 * 뒤집어 보면 이건 제약이 아니라 성질이다. 폰이 자기 눈으로 본 것을 자기가
 * 적으므로, 남의 기기에서 만든 값을 믿을 필요가 없다.
 *
 * ## 켜지지 않는 이유가 네 가지다 — 전부 화면에 적는다
 *
 * 이 API 는 조건이 많아서, 안 되는 이유를 «지원 안 함» 한 줄로 뭉뚱그리면
 * 현장에서 못 고친다. 무엇이 막았는지 하나씩 갈라서 돌려준다.
 *
 *   1  안드로이드 크롬이 아님        iOS 사파리에는 Web Bluetooth 자체가 없다
 *   2  실험 플래그가 꺼져 있음       chrome://flags/#enable-experimental-web-platform-features
 *   3  보안 컨텍스트가 아님          http://172.x.x.x:8080 은 https 도 localhost 도 아니다
 *   4  사용자 제스처 없이 부름       스캔 시작은 반드시 탭 안에서
 *
 * 3번이 특히 걸린다. 폰은 맥북의 LAN 주소로 접속하므로 평문 http 다.
 * `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 에 그 주소를
 * 적어 주면 열린다. 이 사실을 코드가 알고 있어야 화면에 적어 줄 수 있다.
 */

/** 모아서 한 번에 올린다. 광고 하나마다 요청을 던지면 초당 수십 번이 된다. */
const FLUSH_MS = 1500;
/** 이보다 오래된 관측은 버린다 — 지나간 신호로 지금 위치를 말하면 안 된다 */
const KEEP_MS = 4000;

/** 왜 못 켜는가. 화면이 이 값을 그대로 사람 말로 옮긴다. */
export const BLE_BLOCKED = {
  NO_API: 'no-api',
  INSECURE: 'insecure',
  DENIED: 'denied',
  OK: null,
};

/**
 * 지금 이 브라우저에서 스캔이 가능한가. **부르기 전에** 답할 수 있어야
 * 버튼을 흐리게 두고 이유를 적을 수 있다.
 */
export function bleScanSupport() {
  if (typeof navigator === 'undefined') return { ok: false, why: BLE_BLOCKED.NO_API };
  // 보안 컨텍스트가 아니면 `navigator.bluetooth` 자체가 없다. 두 이유를
  // 갈라야 «플래그를 켜라» 와 «주소를 등록하라» 중 맞는 쪽을 안내한다.
  if (!window.isSecureContext) {
    return { ok: false, why: BLE_BLOCKED.INSECURE, origin: location.origin };
  }
  if (!navigator.bluetooth?.requestLEScan) {
    return { ok: false, why: BLE_BLOCKED.NO_API };
  }
  return { ok: true, why: BLE_BLOCKED.OK };
}

/** 화면에 그대로 띄울 수 있는 안내문 */
export function bleBlockedMessage(support) {
  if (support?.ok) return '';
  if (support?.why === BLE_BLOCKED.INSECURE) {
    return `평문 http 라 블루투스가 막혀 있습니다. 크롬 주소창에`
      + ` chrome://flags/#unsafely-treat-insecure-origin-as-secure 를 열고`
      + ` ${support.origin || location.origin} 를 등록한 뒤 크롬을 다시 시작하세요.`;
  }
  if (support?.why === BLE_BLOCKED.DENIED) {
    return '블루투스 권한이 거부됐습니다. 크롬 사이트 설정에서 허용해 주세요.';
  }
  return '이 브라우저에는 BLE 스캔이 없습니다. 안드로이드 크롬에서'
    + ' chrome://flags/#enable-experimental-web-platform-features 를 켜세요.'
    + ' (iOS 사파리는 Web Bluetooth 자체를 지원하지 않습니다)';
}

/**
 * 광고를 받아 모았다가 주기적으로 넘긴다.
 *
 * **위치를 계산하지 않는다.** 여기서 하는 일은 «무엇이 얼마나 세게 들리나»
 * 를 정확히 옮기는 것뿐이고, 그것을 지점으로 바꾸는 일은 서버와
 * `shared/positioning.js` 가 한다. 층을 섞으면 전파가 나쁜 건지 판정이
 * 나쁜 건지 못 가린다.
 */
export class WebBleScanner {
  /**
   * @param {(readings: Array<{beaconId:string,rssi:number,label?:string,txPower?:number}>) => any} onBatch
   */
  constructor(onBatch) {
    this.onBatch = onBatch || (() => {});
    this.scan = null;
    this.timer = null;
    /** beaconId → 최근 관측들. 같은 기기가 초당 여러 번 오므로 눌러 담는다. */
    this.seen = new Map();
    this.lastError = null;
    this.startedAt = 0;
    this.adCount = 0;
  }

  get running() { return !!this.scan; }

  /** 지금까지 몇 개 기기를 봤나 — 화면이 «잡히고 있다» 를 말하는 근거 */
  get deviceCount() { return this.seen.size; }

  /**
   * **탭 안에서 불러야 한다.** 사용자 제스처 없이는 브라우저가 거부한다.
   * @returns {Promise<{ok:boolean, why?:string, error?:string}>}
   */
  async start() {
    const support = bleScanSupport();
    if (!support.ok) { this.lastError = support.why; return support; }
    if (this.scan) return { ok: true };

    try {
      this.scan = await navigator.bluetooth.requestLEScan({
        // 무엇이 있는지 모르는 상태에서 찾는 것이므로 전부 받는다.
        acceptAllAdvertisements: true,
        // **끄면 안 된다.** 기본값은 기기마다 처음 한 번만 주는데, 우리에게
        // 필요한 것은 «지금 얼마나 세게 들리나» 라서 같은 기기의 반복 광고가
        // 곧 데이터다. 끄면 걸어도 RSSI 가 안 바뀐다.
        keepRepeatedDevices: true,
      });
    } catch (err) {
      // 사용자가 거부했거나 권한이 없다
      this.lastError = BLE_BLOCKED.DENIED;
      return { ok: false, why: BLE_BLOCKED.DENIED, error: String(err?.message || err) };
    }

    this._onAd = ev => this._record(ev);
    navigator.bluetooth.addEventListener('advertisementreceived', this._onAd);
    this.startedAt = Date.now();
    this.timer = setInterval(() => this._flush(), FLUSH_MS);
    this.lastError = null;
    return { ok: true };
  }

  stop() {
    try { this.scan?.stop?.(); } catch (_) { /* 이미 멈춘 스캔 */ }
    if (this._onAd) navigator.bluetooth?.removeEventListener?.('advertisementreceived', this._onAd);
    this._onAd = null;
    this.scan = null;
    clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
  }

  _record(ev) {
    const id = ev?.device?.id;
    if (!id || !Number.isFinite(ev.rssi)) return;
    this.adCount++;
    const key = `ble:${id}`;
    const list = this.seen.get(key) || [];
    list.push({ rssi: ev.rssi, at: Date.now() });
    this.seen.set(key, list);
    // 이름과 송신 세기는 바뀌지 않으므로 마지막 값만 들고 있는다
    if (ev.device.name) this._label(key, ev.device.name);
    if (Number.isFinite(ev.txPower)) this._tx(key, ev.txPower);
  }

  _label(key, v) { (this.meta ??= new Map()).set(key, { ...(this.meta.get(key) || {}), label: v }); }
  _tx(key, v) { (this.meta ??= new Map()).set(key, { ...(this.meta.get(key) || {}), txPower: v }); }

  /**
   * 창 안의 관측을 기기마다 **중앙값**으로 눌러 넘긴다.
   *
   * 평균이 아니라 중앙값인 이유: 원시 RSSI 는 서 있어도 ±10dBm 튀고, 그
   * 튐이 한쪽으로 크게 빠지는 이상치 형태로 온다. 평균은 이상치 하나에
   * 끌려가지만 중앙값은 안 끌려간다.
   */
  _flush() {
    const cut = Date.now() - KEEP_MS;
    const readings = [];
    for (const [beaconId, list] of this.seen) {
      const fresh = list.filter(s => s.at >= cut);
      if (!fresh.length) { this.seen.delete(beaconId); continue; }
      this.seen.set(beaconId, fresh);
      const v = fresh.map(s => s.rssi).sort((a, b) => a - b);
      const mid = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
      readings.push({
        beaconId,
        rssi: Math.round(mid),
        samples: fresh.length,
        ...(this.meta?.get(beaconId) || {}),
      });
    }
    if (readings.length) this.onBatch(readings);
  }
}
