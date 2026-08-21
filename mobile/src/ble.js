/**
 * 폰이 **직접** 전파를 듣는다.
 *
 * ## 왜 만드나
 *
 * 지금까지는 맥이 BLE 를 듣고 서버가 판정해서 폰에 내려줬다. Expo Go 가 네이티브
 * 모듈을 못 싣기 때문이었다. 그런데 그러면 앱이 말하는 «내 위치» 가 사실은
 * **«맥 위치»** 다. 맥을 책상에 두고 혼자 복도에 나가면 위치가 안 따라온다.
 *
 * 시각장애인이 혼자 쓰는 대피 앱인데 «노트북을 들고 다니세요» 는 성립하지 않는다.
 * 그래서 폰이 직접 듣게 한다.
 *
 * ## 여기는 배선만 한다
 *
 * 광고를 비콘 이름으로 바꾸는 **규칙은 `shared/ble-decode.js`** 에 있다. 맥
 * 스캐너(파이썬)와 같은 규칙이어야 같은 비콘이 같은 이름을 갖고, 그래야 맥으로
 * 잰 답사를 폰이 그대로 쓴다. 규칙을 여기 두면 시험할 수 없어서 갈라진다.
 *
 * ## 없으면 조용히 없는 대로 돈다
 *
 * Expo Go 에는 이 네이티브 모듈이 없다. 그때 `import` 가 터지면 앱이 통째로 안
 * 뜬다. 그래서 늦게, 감싸서 불러온다. 못 쓰면 `available()` 이 false 를 내고,
 * 부르는 쪽은 맥 경로로 돌아간다.
 */

import { Platform } from 'react-native';

import { decodeAdvertisement } from './ble-decode';

let Manager = null;
let manager = null;
let loadError = null;

function load() {
  if (Manager || loadError) return Manager;
  try {
    // eslint-disable-next-line global-require
    Manager = require('react-native-ble-plx').BleManager;
  } catch (e) {
    loadError = e;
    Manager = null;
  }
  return Manager;
}

/** 이 앱이 BLE 를 직접 들을 수 있는가 (Expo Go 면 false) */
export function available() {
  return Boolean(load());
}

/** 왜 못 쓰는지 — 화면에 이유를 보여줄 때 쓴다 */
export function unavailableReason() {
  if (available()) return null;
  return 'Expo Go 에서는 전파를 직접 못 듣습니다. 개발 빌드가 필요합니다.';
}

/** 이 기기가 붙이는 출처 이름 */
export function sourceTag() {
  return Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : Platform.OS;
}

/** 광고 하나 → 비콘 이름 (규칙은 shared 에 있다) */
export function decode(device) {
  return decodeAdvertisement(device, sourceTag());
}

/**
 * 스캔을 시작한다.
 *
 * @param {(reading: {beaconId, rssi, kind}) => void} onReading 광고 하나마다
 * @param {(err: Error) => void} onError
 * @returns {() => void} 멈추는 함수
 */
export function startScan(onReading, onError = null) {
  const M = load();
  if (!M) { onError?.(new Error(unavailableReason())); return () => {}; }

  if (!manager) manager = new M();
  let stopped = false;

  // 블루투스가 켜질 때까지 기다렸다 시작한다. 꺼진 상태에서 바로 스캔하면
  // 그냥 실패하고, 사용자에게는 «왜 안 되지» 만 남는다.
  const sub = manager.onStateChange(state => {
    if (stopped || state !== 'PoweredOn') return;
    sub.remove();
    manager.startDeviceScan(null, { allowDuplicates: true }, (err, device) => {
      if (stopped) return;
      if (err) { onError?.(err); return; }
      const r = decode(device);
      if (r) onReading(r);
    });
  }, true);

  return () => {
    stopped = true;
    try { sub.remove(); } catch (_) { /* 이미 지워졌으면 그만 */ }
    try { manager?.stopDeviceScan(); } catch (_) { /* 스캔 중이 아니면 그만 */ }
  };
}
