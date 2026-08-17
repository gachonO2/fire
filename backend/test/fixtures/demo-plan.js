/**
 * **테스트 전용** 시연 도면 — 병원 3층.
 *
 * 예전에는 서버가 켜질 때마다 이걸 심고 활성화했다. 그래서 실제 건물을 등록해도
 * 재시작하면 병원으로 되돌아갔고, 앱이 있지도 않은 병원 복도를 안내했다.
 * 이제 운영 코드는 이 파일을 쓰지 않는다 — **테스트와 시연 스크립트만** 쓴다.
 *
 * 좌표 단위: 미터 (metersPerUnit = 1)
 * 시나리오: 301호 진료실 앞에서 대피 시작.
 *   계단 A(동쪽)는 연기센서 작동, 엘리베이터는 화재로 정지.
 */
export const DEMO_PLAN = {
  id: 'hospital-3f',
  name: '병원 3층',
  metersPerUnit: 1,
  stepLength: 0.7,
  image: null, // 도면 이미지를 올리면 { width, height } 가 채워진다

  // description·landmark = 저장된 장소 설명.
  // 사용자가 "여기가 어디인가요?"를 누르면 이 문장들이 음성으로 읽힌다.
  nodes: [
    { id: 'N1', name: '301호 진료실 앞', x: 12.5, y: 26, type: 'room',
      description: '진료실 출입문을 등지고 서면 복도가 정면으로 이어집니다.',
      landmark: '오른쪽 벽에 손잡이가 있습니다.' },
    { id: 'N2', name: '중앙 복도 교차점', x: 12.5, y: 20, type: 'junction',
      description: '복도가 좌우로 갈라지는 곳입니다.',
      landmark: '바닥의 점자블록이 십자 모양으로 바뀝니다.' },
    { id: 'N3', name: '간호사실 앞', x: 20, y: 20, type: 'junction',
      description: '간호사실 창구 앞입니다.',
      landmark: '왼쪽에서 사람 목소리와 기계음이 들립니다.' },
    { id: 'N5', name: '엘리베이터 홀', x: 26, y: 20, type: 'junction',
      description: '엘리베이터 앞 대기 공간입니다.',
      landmark: '정면에 금속문이 있고 바닥이 매끄럽습니다.' },
    { id: 'EV', name: '엘리베이터', x: 26, y: 23.5, type: 'elevator',
      description: '화재 시에는 사용할 수 없습니다.' },
    { id: 'N4', name: '동쪽 복도 교차점', x: 26, y: 6, type: 'junction',
      description: '동쪽 끝에서 복도가 꺾이는 곳입니다.',
      landmark: '오른쪽 벽에 소화전이 있습니다.' },
    { id: 'N6', name: '계단 A (동쪽)', x: 32, y: 6, type: 'exit',
      description: '동쪽 비상계단 입구입니다.',
      landmark: '문을 열면 손잡이가 오른쪽에 있습니다.' },
    { id: 'N9', name: '서쪽 복도', x: 6, y: 20, type: 'junction',
      description: '서쪽 복도가 남북으로 이어지는 곳입니다.',
      landmark: '왼쪽 벽을 따라 손잡이가 계속됩니다.' },
    { id: 'N7', name: '서쪽 복도 교차점', x: 6, y: 6, type: 'junction',
      description: '서쪽 끝 교차점입니다.',
      landmark: '정면에서 환기구 바람이 느껴집니다.' },
    { id: 'N8', name: '계단 B (서쪽)', x: 2, y: 6, type: 'exit',
      description: '서쪽 비상계단 입구입니다.',
      landmark: '문 앞 바닥에 경고 점자블록이 있습니다.' },
    { id: 'N10', name: '남쪽 비상구 램프', x: 6, y: 30, type: 'exit',
      description: '계단 대신 완만한 경사로로 내려가는 비상구입니다.',
      landmark: '내리막이 시작되고 바깥 공기가 느껴집니다.' },
  ],

  // wall: 벽 따라가기 안내에 사용 ('left' | 'right' | null, 진행방향 기준)
  edges: [
    { id: 'E1',  a: 'N1', b: 'N2',  wall: 'right' },
    { id: 'E2',  a: 'N2', b: 'N3',  wall: 'right' },
    { id: 'E3',  a: 'N3', b: 'N5',  wall: 'right' },
    { id: 'E4',  a: 'N5', b: 'EV',  wall: null, elevator: true },
    { id: 'E5',  a: 'N5', b: 'N4',  wall: 'left' },
    { id: 'E6',  a: 'N4', b: 'N6',  wall: 'right' },
    { id: 'E7',  a: 'N2', b: 'N9',  wall: 'left' },
    { id: 'E8',  a: 'N9', b: 'N7',  wall: 'left' },
    { id: 'E9',  a: 'N7', b: 'N8',  wall: 'left' },
    { id: 'E10', a: 'N7', b: 'N4',  wall: 'right' },
    { id: 'E11', a: 'N9', b: 'N10', wall: 'right' },
  ],

  // 시나리오 초기 상태: 계단 A 진입 통로에 연기 감지
  initialHazards: {
    E6: { type: 'smoke', label: '연기 감지' },
  },
};
