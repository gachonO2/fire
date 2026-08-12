/**
 * 가천관 3층 — 3D(2.5D) 도면 기반 샘플 도면과 **저장된 장소 5곳**.
 *
 * 도면 이미지: shared/plans/gachon-3f.svg
 * 좌표는 그 도면의 픽셀 좌표이고, 1px = 0.03m (도면 가로 1400px = 42m).
 *
 * 각 장소의 description·landmark 가 "저장된 장소 설명"이다.
 * 사용자가 앱에서 "여기가 어디인가요?"를 누르면 이 문장들이 음성으로 읽힌다.
 * 시각장애인이 실제로 확인할 수 있는 단서(촉각·소리·공기)만 적는 것이 원칙이다 —
 * "파란 문 옆"처럼 눈으로만 확인되는 표현은 쓰지 않는다.
 */
export const GACHON_3F_PLAN = {
  id: 'gachon-3f',
  name: '가천관 3층',
  metersPerUnit: 0.03,
  stepLength: 0.7,
  image: { width: 1400, height: 900 },

  nodes: [
    {
      id: 'G1',
      name: '312호 강의실 앞',
      x: 340, y: 640, type: 'room',
      description: '강의실 문을 등지고 서면 복도가 좌우로 이어집니다.',
      landmark: '오른쪽 벽에 손잡이가 있고, 발밑에 점자블록이 시작됩니다.',
    },
    {
      id: 'G2',
      name: '중앙 로비',
      x: 700, y: 640, type: 'junction',
      description: '남측 복도와 중앙 복도가 만나는 넓은 곳입니다.',
      landmark: '천장이 높아 발소리가 울리고, 오른쪽에서 휴게 라운지 소리가 들립니다.',
    },
    {
      id: 'G3',
      name: '북측 복도 교차점',
      x: 700, y: 280, type: 'junction',
      description: '복도가 좌우로 갈라지는 교차점입니다. 왼쪽이 서편, 오른쪽이 동편 계단입니다.',
      landmark: '바닥의 점자블록이 십자 모양으로 바뀌고, 정면에 사무실 문이 있습니다.',
    },
    {
      id: 'G4',
      name: '동편 비상계단',
      x: 1170, y: 280, type: 'exit',
      description: '동쪽 끝 비상계단 입구입니다.',
      landmark: '문 앞 바닥에 경고 점자블록이 있고, 손잡이는 오른쪽에 있습니다.',
    },
    {
      id: 'G5',
      name: '서편 비상계단',
      x: 330, y: 280, type: 'exit',
      description: '서쪽 끝 비상계단 입구입니다. 여기서 1층까지 계단으로 내려갑니다.',
      landmark: '문을 열면 아래에서 찬 공기가 올라오고, 난간이 왼쪽에 있습니다.',
    },
  ],

  edges: [
    { id: 'GL1', a: 'G1', b: 'G2', wall: 'right' },
    { id: 'GL2', a: 'G2', b: 'G3', wall: 'left' },
    { id: 'GL3', a: 'G3', b: 'G4', wall: 'right' },
    { id: 'GL4', a: 'G3', b: 'G5', wall: 'left' },
  ],

  initialHazards: {},
};
