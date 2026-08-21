/**
 * BLE 광고 → 비콘 이름. **맥 스캐너와 같은 규칙.**
 *
 * ## 왜 따로 빼나
 *
 * 판정(`positioning.js`)은 «비콘 id 와 세기» 만 본다. 그 id 를 만드는 규칙이
 * 듣는 기기마다 다르면, 같은 비콘이 여러 이름을 갖게 되어 답사가 조용히 갈라진다.
 * 실제로 맥은 파이썬(`scripts/scan-beacons.py` 의 `decode()`)으로, 폰은
 * 자바스크립트로 번역하는데 **규칙이 같아야** 맥으로 잰 답사를 폰이 그대로 쓴다.
 *
 * 그래서 규칙을 여기 한 곳에 두고 시험으로 지킨다. `react-native` 를 import 하지
 * 않으므로 node 에서 그대로 돌아간다 — 측위 계층이 시간을 인자로 받는 것과 같은
 * 이유다.
 *
 * ## 출처를 붙이는 것과 안 붙이는 것
 *
 *   iBeacon·Eddystone   비콘이 스스로 방송하는 이름 → **출처 없음**
 *                       맥이 잰 답사를 폰이 그대로 쓴다
 *   일반 BLE 광고        플랫폼이 붙인 이름  → `ble:<출처>:<id>`
 *                       iOS 는 앱마다 다른 UUID, 안드로이드는 MAC, 맥은 또 다른 UUID
 *
 * 출처를 안 붙이면 폰 답사가 맥 답사를 덮어써서 시연 폴백이 통째로 날아간다.
 */

/** 애플 제조사 코드 — iBeacon 광고가 여기 실린다 */
export const APPLE_ID = 0x004c;
/** Eddystone 서비스 UUID */
export const EDDYSTONE = 'feaa';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * base64 → 바이트 배열.
 *
 * 폰에는 Buffer 가 없고 atob 도 없을 수 있어 직접 푼다.
 */
export function base64ToBytes(str) {
  if (!str) return null;
  const clean = String(str).replace(/=+$/, '');
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return out;
}

export function hex(bytes) {
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 광고 하나를 비콘 이름으로.
 *
 * @param device  { id, rssi, manufacturerData(base64), serviceData({uuid: base64}), localName, name }
 * @param source  'ios' | 'android' | 'mac' — 일반 BLE 광고에만 붙는다
 * @returns {{beaconId, rssi, kind}|null}
 */
export function decodeAdvertisement(device, source = 'unknown') {
  const rssi = device?.rssi;
  if (!Number.isFinite(rssi)) return null;

  // iBeacon — 애플 제조사 데이터, 타입 0x02, 길이 0x15
  const md = device.manufacturerData ? base64ToBytes(device.manufacturerData) : null;
  if (md && md.length >= 24) {
    const company = md[0] | (md[1] << 8);
    if (company === APPLE_ID && md[2] === 0x02 && md[3] === 0x15) {
      const uuid = hex(md.slice(4, 20));
      const major = (md[20] << 8) | md[21];
      const minor = (md[22] << 8) | md[23];
      return { beaconId: `ibeacon:${uuid}:${major}:${minor}`, rssi, kind: 'iBeacon' };
    }
  }

  // Eddystone — 서비스 데이터. 이것도 기기와 무관한 이름이다.
  const sd = device.serviceData || null;
  if (sd) {
    for (const [key, val] of Object.entries(sd)) {
      if (!String(key).toLowerCase().includes(EDDYSTONE)) continue;
      const bytes = base64ToBytes(val);
      if (bytes?.length) {
        return { beaconId: `eddystone:${hex(bytes).slice(0, 20)}`, rssi, kind: 'Eddystone' };
      }
    }
  }

  // 그 밖 — 플랫폼이 붙인 이름이라 출처를 붙인다.
  const id = device.id || device.localName || device.name;
  if (!id) return null;
  return { beaconId: `ble:${source}:${id}`, rssi, kind: 'BLE' };
}
