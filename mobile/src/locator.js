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
 * 찍어서 돌려주면 엉뚱한 곳에서 출발하는 경로가 나오고, 그건 안내를 안 하느니만 못하다.
 */

let engine = null;

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
  if (engine?.locate) {
    const id = await engine.locate(plan).catch(() => null);
    if (id && hasNode(plan, id)) return id;
  }

  // 서버가 아는 위치. 관제가 지정했거나 비콘 게이트웨이가 올린 값.
  const positions = await api?.getPositions?.().catch(() => null);
  const mine = Array.isArray(positions)
    ? positions.find(p => p.userId === userId) || positions[0]
    : null;
  if (mine?.nodeId && hasNode(plan, mine.nodeId)) return mine.nodeId;

  return null;
}

function hasNode(plan, id) {
  return Boolean(plan?.nodes?.some(n => n.id === id));
}
