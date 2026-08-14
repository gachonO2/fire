/**
 * 시연용 도면 — 서버가 도면을 주지 못할 때 안내가 죽지 않게 하는 최후 수단.
 *
 * ## 왜 필요한가
 *
 * 원래 흐름은 "서버가 도면을 준다"가 전제였다. 그래서 서버가 꺼져 있거나
 * 망이 끊기면 경보를 확인한 순간 **막다른 길**이었다 — "도면을 받지 못해
 * 안내를 시작할 수 없습니다"에서 끝났다. 시연장에서 Wi-Fi 하나 어긋나면
 * 앱이 아무것도 못 하는 것을 보여주게 된다.
 *
 * ## 대신 반드시 지켜야 할 것: 이게 진짜인 척하지 않는다
 *
 * 이 도면은 **실재하지 않는 건물**이다. 실제 화재에서 이 도면으로 안내하면
 * 시각장애인이 없는 복도를 향해 걷는다. 그래서:
 *
 *   · 서버 도면이 하나라도 있으면 **그쪽이 무조건 이긴다** (여긴 최후 수단)
 *   · 쓸 때마다 음성으로 "시연용 도면"이라고 **먼저 말한다**
 *   · 화면에도 배지를 띄운다 (동행자·저시력자도 알아야 한다)
 *   · `demo: true` 로 표시해 어느 코드에서든 구분할 수 있게 한다
 *
 * ## 구조 (좌표 단위 = 미터)
 *
 *        [서쪽 비상구]                              [동쪽 계단]
 *              |                                        |
 *         [복도 서]───────[복도 중앙]───────[복도 동]
 *              |               |                 |
 *          [301호]         [302호]           [303호]
 *
 * `northOffset: 0` — 실재하지 않는 층이라 "도면 위쪽 = 북"으로 **정의**한다.
 * 실제 건물이라면 추측해서 넣으면 안 되는 값이지만(엉뚱한 쪽을 가리키게 된다),
 * 여기서는 어긋날 실물이 없으므로 정의가 곧 참이고 방향 안내를 켜둘 수 있다.
 */

export const DEMO_PLAN = {
  id: 'demo-floor',
  name: '시연용 3층 (실제 건물 아님)',
  demo: true,
  metersPerUnit: 1,
  stepLength: 0.7,
  northOffset: 0,
  image: null,

  nodes: [
    { id: 'R301', name: '301호 앞', x: 6, y: 16, type: 'room', beaconId: 'BC-301' },
    { id: 'R302', name: '302호 앞', x: 16, y: 16, type: 'room', beaconId: 'BC-302' },
    { id: 'R303', name: '303호 앞', x: 26, y: 16, type: 'room', beaconId: 'BC-303' },
    { id: 'HW', name: '서쪽 복도', x: 6, y: 10, type: 'junction', beaconId: 'BC-HW' },
    { id: 'HC', name: '중앙 복도', x: 16, y: 10, type: 'junction', beaconId: 'BC-HC' },
    { id: 'HE', name: '동쪽 복도', x: 26, y: 10, type: 'junction', beaconId: 'BC-HE' },
    { id: 'EXW', name: '서쪽 비상구', x: 2, y: 10, type: 'exit', beaconId: 'BC-EXW' },
    { id: 'EXE', name: '동쪽 계단', x: 30, y: 10, type: 'exit', beaconId: 'BC-EXE' },
  ],

  // wall: 진행 방향 기준으로 어느 쪽 벽을 짚고 갈지 — 시각장애인에게는
  // 방위보다 이게 더 확실한 기준이다.
  edges: [
    { id: 'E1', a: 'R301', b: 'HW', wall: 'right' },
    { id: 'E2', a: 'R302', b: 'HC', wall: 'right' },
    { id: 'E3', a: 'R303', b: 'HE', wall: 'right' },
    { id: 'E4', a: 'HW', b: 'HC', wall: 'left' },
    { id: 'E5', a: 'HC', b: 'HE', wall: 'left' },
    { id: 'E6', a: 'HW', b: 'EXW', wall: 'right' },
    { id: 'E7', a: 'HE', b: 'EXE', wall: 'left' },
  ],
};
