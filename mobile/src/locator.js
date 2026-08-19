/**
 * 내 위치 — "지금 도면의 어느 지점에 있는가".
 *
 * ## 물어보지 않는 것이 목표다
 *
 * 예전에는 대피 시작 전에 "지금 어디 계신가요"를 물었다. 불난 상황에 시각장애인에게
 * 목록을 훑게 하는 건 말이 안 된다. **위치는 앱이 알아내야 한다.**
 *
 * ## 비콘이 답이다
 *
 * 대피로에 비콘을 깔면 **가장 세게 들리는 비콘이 곧 내 위치**다. 물어볼 필요가 없고,
 * 걸어가면 저절로 갱신된다. 온도센서를 BLE 되는 모듈로 고르면 부품 하나가
 * 두 일을 한다 — 온도로 불을 찾고, BLE로 사람을 찾는다.
 *
 * ## 그래서 갈아끼울 수 있게 둔다
 *
 * 지금은 서버가 아는 위치(`/api/positions`)를 쓴다. 관제가 지정하거나, 나중에
 * 비콘 게이트웨이가 올려주면 그대로 흐른다. BLE 를 폰에서 직접 읽게 되면
 * `setLocator()` 에 꽂기만 하면 되고 **나머지 코드는 그대로다.**
 *
 * BLE 는 Expo Go 에서 안 되므로(개발 빌드 필요) 그 전까지는 서버 경유로 쓴다.
 *
 * ## 모르면 모른다고 한다
 *
 * 위치를 못 찾으면 `null` 을 준다. 그때만 사용자에게 묻는다. 아무 지점이나
 * 찍어서 돌려주면 엉뚱한 경로가 나오고, 그건 안내를 안 하느니만 못하다.
 *
 * ## 진짜 수신기가 붙어 있으면 시뮬레이션은 입을 다문다
 *
 * 예전에는 순서가 거꾸로였다. 시뮬레이터를 먼저 부르는데, 시뮬레이터는 **서 있다고
 * 정해 둔 자리**에서 신호를 만들어 그 자리를 맞힌다. 답을 넣어 답을 만들고 그 답을
 * 맞히니 **절대 실패하지 않고**, 그래서 뒤에 있는 진짜 경로는 한 번도 돌지 않았다.
 * 화면에는 위치가 떠 있지만 그 값은 전파에서 온 것이 아니라 누가 타이핑한 것이었다.
 *
 * 그래서 **진짜부터 묻는다.** 수신기가 붙어 있는데 아직 위치를 못 짚는다면 그것이
 * 사실이고, 사실대로 `null` 을 준다. 그 자리를 시뮬레이터로 메우면 못 잡고 있다는
 * 것조차 안 보이게 된다 — 고칠 수 없는 상태가 된다.
 */

let engine = null;
let lastSource = 'unknown';

/**
 * 위치 제공자를 갈아끼운다. BLE 비콘 구현을 여기에 꽂는다.
 * @param {{ locate: (plan) => Promise<string|null> }} impl
 */
export function setLocator(impl) { engine = impl; }

/**
 * 지금 있는 지점의 id.
 * @returns {Promise<string|null>} 모르면 null — 그때만 사용자에게 묻는다
 */
export async function locate(api, plan, userId = 'me') {
  // ① 진짜 전파. 수신기가 붙어 있으면 여기서 끝난다 — 맞히든, 모르든.
  const beacon = await api?.getBeaconFix?.().catch(() => null);
  if (beacon?.scanner) {
    if (beacon.fix?.nodeId && hasNode(plan, beacon.fix.nodeId)) {
      lastSource = 'beacon';
      return beacon.fix.nodeId;
    }
    // 수신기는 있는데 아직 못 짚는다 — 매핑이 모자란 것이다. 시뮬레이터로
    // 메우지 않는다. 메우면 "잡은 척"이 되고, 매핑이 비어 있다는 사실이 가려진다.
    lastSource = 'unknown';
    return null;
  }

  // ② 수신기가 없는 건물 — 가상 비콘으로 돈다. 값은 진짜가 아니다.
  if (engine?.locate) {
    const id = await engine.locate(plan).catch(() => null);
    if (id && hasNode(plan, id)) {
      lastSource = engine.simulated ? 'simulated' : 'beacon';
      return id;
    }
  }

  // ③ 서버가 아는 위치. 관제가 지정했거나 게이트웨이가 올린 값.
  const positions = await api?.getPositions?.().catch(() => null);
  const mine = Array.isArray(positions)
    ? positions.find(p => p.userId === userId) || positions[0]
    : null;
  if (mine?.nodeId && hasNode(plan, mine.nodeId)) {
    lastSource = 'server';
    return mine.nodeId;
  }

  lastSource = 'unknown';
  return null;
}

/**
 * 방금 위치를 **무엇으로** 정했나. 화면이 이걸 그대로 보여 줘야 한다 —
 * 시뮬레이션 값을 실측처럼 읽으면 검증이 통째로 무의미해진다.
 * @returns {'beacon'|'simulated'|'server'|'unknown'}
 */
export function locateSource() { return lastSource; }

function hasNode(plan, id) {
  return Boolean(plan?.nodes?.some(n => n.id === id));
}
