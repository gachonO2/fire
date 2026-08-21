/**
 * 이 기기의 이름 — **한 번 정하면 안 바뀐다.**
 *
 * ## 왜 필요한가
 *
 * 예전에는 화면이 열릴 때마다 `app-${Math.random()}` 로 새 이름을 지었다. 그래서
 * 앱을 새로 띄울 때마다 관제에 **새 사람이 하나씩 생겼다.** 지우는 길도 없어서
 * 그날 새로고침한 횟수만큼 쌓였고, 실제로 한 명이 걷고 있는데 화면에는 열다섯
 * 명이 있었다.
 *
 * 시연에서 이건 그냥 «건물 안 인원 15명» 이라는 틀린 숫자로 보인다. 심사위원이
 * 제일 먼저 보는 숫자가 틀려 있으면 그 뒤 설명이 무슨 소용인가.
 *
 * ## 파일에 적어 둔다
 *
 * `AsyncStorage` 를 쓰려면 패키지를 하나 더 붙여야 한다. `expo-file-system` 은
 * 이미 도면 사진 때문에 들어와 있으므로 그걸 쓴다 — 값 하나 저장하자고 의존성을
 * 늘릴 이유가 없다.
 *
 * 읽기가 끝나기 전에 화면이 먼저 그려질 수 있으므로 **임시 이름을 먼저 주고**
 * 파일에서 읽히면 갈아 끼운다. 임시 이름으로 한두 번 보고가 나갈 수 있지만,
 * 그건 저장된 이름으로 곧 덮인다.
 */

import * as FileSystem from 'expo-file-system';

const FILE = `${FileSystem.documentDirectory ?? ''}device-id.txt`;

let cached = null;
let loading = null;

/** 파일을 읽기 전에도 쓸 수 있는 임시 이름 */
function makeId() {
  return `app-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 이 기기의 이름. 파일에 있으면 그것, 없으면 새로 만들어 적는다.
 * @returns {Promise<string>}
 */
export async function deviceId() {
  if (cached) return cached;
  if (loading) return loading;

  loading = (async () => {
    try {
      const info = await FileSystem.getInfoAsync(FILE);
      if (info.exists) {
        const got = (await FileSystem.readAsStringAsync(FILE)).trim();
        if (got) { cached = got; return got; }
      }
    } catch (_) { /* 못 읽으면 새로 만든다 */ }

    const made = makeId();
    try {
      await FileSystem.writeAsStringAsync(FILE, made);
    } catch (_) {
      // 못 써도 이번 실행 동안은 같은 이름을 쓴다. 다음 실행에 또 바뀔 뿐,
      // 화면마다 달라지는 것보다는 낫다.
    }
    cached = made;
    return made;
  })();

  return loading;
}

/**
 * 지금 당장 쓸 이름. 파일을 아직 안 읽었으면 임시 이름을 주고, 뒤에서 읽어 둔다.
 *
 * 화면이 그려지는 순간 이름이 있어야 하는 곳(`useRef` 초기값)에서 쓴다.
 */
export function deviceIdNow() {
  if (cached) return cached;
  deviceId().catch(() => {});
  if (!cached) cached = makeId();
  return cached;
}
