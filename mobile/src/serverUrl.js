/**
 * 서버 주소 찾기 — 맥 IP 를 손으로 적지 않는다.
 *
 * 개발 중에는 맥의 IP 가 DHCP 때문에 수시로 바뀐다. 그때마다 코드를 고치면
 * 폰에서 "요청 시간 초과"만 뜨고 왜 그런지 알기 어렵다(실제로 이 프로젝트에서
 * 두 번 겪었다).
 *
 * 그런데 답이 이미 있다 — **폰이 Expo 개발 서버에 붙어 있는 그 주소**가 곧 맥이다.
 * Expo 가 `hostUri`("10.0.1.5:8081")로 알려주므로, 포트만 백엔드 것으로 바꾸면 된다.
 *
 * 배포할 때는 이 추측이 통하지 않으므로 `EXPO_PUBLIC_FIRE_SERVER` 로 못박는다.
 */

import Constants from 'expo-constants';

/** `../fire` 백엔드 기본 포트 */
const BACKEND_PORT = 8080;

export function resolveServerUrl() {
  // 1) 환경변수로 지정했으면 그게 우선 (배포·다른 망에서 시험할 때)
  const fromEnv = process.env.EXPO_PUBLIC_FIRE_SERVER;
  if (fromEnv) return fromEnv.replace(/\/+$/, '');

  // 2) app.json 의 extra 로 박아둔 값
  const fromExtra = Constants.expoConfig?.extra?.fireServer;
  if (fromExtra) return String(fromExtra).replace(/\/+$/, '');

  // 3) Expo 개발 서버가 떠 있는 곳 = 맥. 개발 중에는 이게 항상 맞다.
  const hostUri = Constants.expoConfig?.hostUri
    || Constants.expoGoConfig?.debuggerHost
    || Constants.manifest2?.extra?.expoGo?.debuggerHost
    || '';
  const host = String(hostUri).split(':')[0];
  if (host && host !== 'localhost' && host !== '127.0.0.1') {
    return `http://${host}:${BACKEND_PORT}`;
  }

  // 4) 아무것도 못 찾으면 오프라인. 촬영은 되고 안내만 막힌다.
  return null;
}
