/**
 * 기본 시연 도면 — 병원 3층.
 * 실제 건물을 넣기 전까지 쓰는 예시이며, 도면 편집기(architect.html)에서
 * 다른 건물 도면을 올리면 이 자리를 대체한다.
 *
 * 좌표 단위: 미터 (metersPerUnit = 1)
 * 시나리오: 301호 진료실 앞에서 대피 시작.
 *   계단 A(동쪽)는 연기센서 작동, 엘리베이터는 화재로 정지.
 */
export const DEFAULT_PLAN = {
  id: 'hospital-3f',
  name: '병원 3층',
  metersPerUnit: 1,
  stepLength: 0.7,
  image: null, // 도면 이미지를 올리면 { width, height } 가 채워진다

  nodes: [
    { id: 'N1',  name: '301호 진료실 앞',   x: 12.5, y: 26,   type: 'room' },
    { id: 'N2',  name: '중앙 복도 교차점',  x: 12.5, y: 20,   type: 'junction' },
    { id: 'N3',  name: '간호사실 앞',       x: 20,   y: 20,   type: 'junction' },
    { id: 'N5',  name: '엘리베이터 홀',     x: 26,   y: 20,   type: 'junction' },
    { id: 'EV',  name: '엘리베이터',        x: 26,   y: 23.5, type: 'elevator' },
    { id: 'N4',  name: '동쪽 복도 교차점',  x: 26,   y: 6,    type: 'junction' },
    { id: 'N6',  name: '계단 A (동쪽)',     x: 32,   y: 6,    type: 'exit' },
    { id: 'N9',  name: '서쪽 복도',         x: 6,    y: 20,   type: 'junction' },
    { id: 'N7',  name: '서쪽 복도 교차점',  x: 6,    y: 6,    type: 'junction' },
    { id: 'N8',  name: '계단 B (서쪽)',     x: 2,    y: 6,    type: 'exit' },
    { id: 'N10', name: '남쪽 비상구 램프',  x: 6,    y: 30,   type: 'exit' },
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
