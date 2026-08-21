// BLE 광고 → 비콘 이름: **맥과 폰이 같은 이름을 불러야 한다.**
//
// 판정 계층은 «비콘 id 와 세기» 만 본다. 그 id 를 만드는 규칙이 듣는 기기마다
// 다르면 같은 비콘이 여러 이름을 갖게 되고, 맥으로 한 답사(지금 108개)를 폰이
// 못 쓴다. 규칙이 갈라지면 조용히 갈라지므로 시험으로 묶어 둔다.
import { decodeAdvertisement, base64ToBytes, hex, APPLE_ID } from '../shared/ble-decode.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

const b64 = bytes => Buffer.from(bytes).toString('base64');

// base64 를 직접 푼다 — 폰에는 Buffer 도 atob 도 없을 수 있다
{
  const bytes = [0x4c, 0x00, 0x02, 0x15, 0xff];
  expect('base64 를 바이트로 푼다',
    JSON.stringify(base64ToBytes(b64(bytes))) === JSON.stringify(bytes),
    hex(base64ToBytes(b64(bytes))));
  expect('빈 값은 null', base64ToBytes('') === null);
}

// iBeacon — **출처를 안 붙인다.** 비콘이 스스로 방송하는 이름이라 어느 기기가
// 들어도 같고, 그래서 맥으로 잰 답사를 폰이 그대로 쓸 수 있다.
{
  const uuid = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
                0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00];
  const md = [APPLE_ID & 0xff, APPLE_ID >> 8, 0x02, 0x15, ...uuid, 0x00, 0x07, 0x00, 0x09, 0xc5];
  const r = decodeAdvertisement({ id: 'X', rssi: -55, manufacturerData: b64(md) }, 'ios');
  expect('iBeacon 을 알아본다', r?.kind === 'iBeacon', r?.kind);
  expect('id 에 출처가 안 붙는다',
    r?.beaconId === 'ibeacon:112233445566778899aabbccddeeff00:7:9', r?.beaconId);

  // 같은 광고를 다른 기기가 들어도 같은 이름이어야 한다
  const mac = decodeAdvertisement({ id: 'Y', rssi: -70, manufacturerData: b64(md) }, 'mac');
  expect('맥이 들어도 같은 이름', mac?.beaconId === r?.beaconId, mac?.beaconId);
}

// Eddystone — 서비스 데이터. 이것도 기기와 무관하다.
{
  const r = decodeAdvertisement(
    { id: 'X', rssi: -60, serviceData: { '0000feaa-0000-1000-8000-00805f9b34fb': b64([0x00, 0x12, 0xab, 0xcd]) } },
    'ios');
  expect('Eddystone 을 알아본다', r?.kind === 'Eddystone', r?.kind);
  expect('Eddystone 도 출처가 안 붙는다', r?.beaconId?.startsWith('eddystone:'), r?.beaconId);
}

// 일반 BLE — **출처를 붙인다.** 플랫폼마다 같은 기기를 다르게 부르기 때문이다.
{
  const dev = { id: 'AA:BB:CC:DD:EE:FF', rssi: -48 };
  const ios = decodeAdvertisement(dev, 'ios');
  const and = decodeAdvertisement(dev, 'android');
  expect('일반 BLE 는 출처가 붙는다', ios?.beaconId === 'ble:ios:AA:BB:CC:DD:EE:FF', ios?.beaconId);
  expect('출처가 다르면 이름도 다르다', ios.beaconId !== and.beaconId, and.beaconId);
}

// 맥이 만든 기존 답사 id 와 부딪히지 않는다.
// 맥은 `ble:<uuid>` 로 저장했고 폰은 `ble:ios:<...>` 를 만든다 — 접두어가 달라
// 겹칠 수 없다. 겹치면 폰 답사가 맥 답사(시연 폴백)를 덮어쓴다.
{
  const macId = 'ble:75677E0C-CE5C-03B7-17EF-C5E27860B69F';
  const phone = decodeAdvertisement({ id: '75677E0C-CE5C-03B7-17EF-C5E27860B69F', rssi: -50 }, 'ios');
  expect('폰 답사가 맥 답사를 덮지 않는다', phone.beaconId !== macId, phone.beaconId);
  expect('맥 id 는 출처 조각이 없다', macId.split(':').length === 2);
}

// 세기가 없으면 쓸 수 없다 — 판정이 세기 비교로 이뤄지기 때문
{
  expect('rssi 없으면 버린다', decodeAdvertisement({ id: 'X' }, 'ios') === null);
  expect('id 도 이름도 없으면 버린다', decodeAdvertisement({ rssi: -50 }, 'ios') === null);
}

// 애플 제조사 데이터인데 iBeacon 이 아닌 것 (에어드롭 등) 은 일반 BLE 로 본다
{
  const md = [APPLE_ID & 0xff, APPLE_ID >> 8, 0x09, 0x06, 0x01, 0x02, 0x03];
  const r = decodeAdvertisement({ id: 'Z', rssi: -55, manufacturerData: b64(md) }, 'ios');
  expect('애플이라고 다 iBeacon 은 아니다', r?.kind === 'BLE', r?.kind);
}

console.log(failed === 0 ? '\n비콘 이름 규칙 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
