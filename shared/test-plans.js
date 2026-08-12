/**
 * 화재 대피 테스트 전용 도면 5개.
 * 각 도면은 출발 위치 5곳과 서로 다른 두 출구를 가지며, 불을 놓았을 때
 * 다른 통로로 우회하는 상황을 시험할 수 있도록 순환 경로를 포함한다.
 */

function makePlan({ id, name, prefix, places, coords, edges }) {
  const nodes = places.map((place, index) => ({
    id: `${prefix}P${index + 1}`,
    name: place.name,
    x: coords[index][0],
    y: coords[index][1],
    type: index === 0 ? 'room' : 'junction',
    description: place.description,
    landmark: place.landmark,
  }));

  nodes.push(
    { id: `${prefix}X1`, name: `${name} 서쪽 비상구`, x: 3, y: 3, type: 'exit' },
    { id: `${prefix}X2`, name: `${name} 동쪽 비상구`, x: 37, y: 3, type: 'exit' },
  );

  return {
    id,
    name,
    metersPerUnit: 1,
    stepLength: 0.7,
    image: { width: 40, height: 36 },
    nodes,
    edges: edges.map(([a, b, wall], index) => ({
      id: `${prefix}E${index + 1}`,
      a: `${prefix}${a}`,
      b: `${prefix}${b}`,
      wall: wall || null,
    })),
    initialHazards: {},
  };
}

const OFFICE_PLACES = [
  { name: '안내 데스크 앞', description: '안내 데스크를 등지면 정면으로 복도가 이어집니다.', landmark: '오른쪽 벽에서 안내 방송 스피커 소리가 들립니다.' },
  { name: '중앙 업무공간 입구', description: '복도가 세 방향으로 나뉘는 지점입니다.', landmark: '발밑 점자블록이 십자 모양으로 바뀝니다.' },
  { name: '회의실 복도', description: '회의실 문이 연속해서 있는 짧은 복도입니다.', landmark: '왼쪽 벽을 따라 금속 문손잡이가 이어집니다.' },
  { name: '자료실 앞', description: '서쪽 비상구와 가까운 복도 끝입니다.', landmark: '정면에서 비상구 유도음이 들립니다.' },
  { name: '휴게실 앞', description: '동쪽 비상구로 이어지는 복도입니다.', landmark: '오른쪽에서 환풍기 소리와 찬 공기가 느껴집니다.' },
];

const SCHOOL_PLACES = [
  { name: '1반 교실 앞', description: '교실 뒷문을 등지면 복도가 정면으로 이어집니다.', landmark: '왼쪽 벽에 낮은 사물함이 이어집니다.' },
  { name: '급식실 갈림길', description: '복도가 왼쪽과 정면으로 갈라집니다.', landmark: '급식실 쪽에서 환풍기 소리가 들립니다.' },
  { name: '중앙 계단홀 앞', description: '넓은 계단홀과 복도가 만나는 곳입니다.', landmark: '발소리가 크게 울리고 바닥 재질이 단단해집니다.' },
  { name: '도서실 앞', description: '서쪽 복도 끝과 가까운 곳입니다.', landmark: '오른쪽 벽에 길게 이어진 나무 난간이 있습니다.' },
  { name: '과학실 앞', description: '동쪽 복도 끝과 가까운 곳입니다.', landmark: '왼쪽 벽에 소화전함이 튀어나와 있습니다.' },
];

const HOSPITAL_PLACES = [
  { name: '진료실 앞', description: '진료실 문을 등지면 중앙 복도가 정면으로 이어집니다.', landmark: '오른쪽 벽에 연속 손잡이가 있습니다.' },
  { name: '간호사실 앞', description: '남북 복도가 만나는 중앙 지점입니다.', landmark: '간호사 호출음과 대화 소리가 가까이 들립니다.' },
  { name: '검사실 갈림길', description: '복도가 좌우로 나뉘는 지점입니다.', landmark: '발밑에 경고 점자블록이 길게 놓여 있습니다.' },
  { name: '병실 복도 서편', description: '서쪽 비상구로 이어지는 병실 복도입니다.', landmark: '왼쪽 벽의 손잡이가 비상문까지 이어집니다.' },
  { name: '병실 복도 동편', description: '동쪽 비상구로 이어지는 병실 복도입니다.', landmark: '오른쪽에서 공조기 바람이 느껴집니다.' },
];

const STATION_PLACES = [
  { name: '개찰구 안쪽', description: '개찰구를 등지면 대합실이 정면에 있습니다.', landmark: '뒤쪽에서 개찰구 알림음이 반복해서 들립니다.' },
  { name: '중앙 대합실', description: '승강장과 출구 통로가 갈라지는 넓은 공간입니다.', landmark: '천장이 높아 안내 방송과 발소리가 크게 울립니다.' },
  { name: '환승 통로 입구', description: '긴 환승 통로가 시작되는 지점입니다.', landmark: '바닥의 선형 점자블록이 두 갈래로 나뉩니다.' },
  { name: '서편 매표기 앞', description: '서쪽 비상구와 가까운 대합실 끝입니다.', landmark: '오른쪽에서 매표기 음성 안내가 들립니다.' },
  { name: '동편 고객센터 앞', description: '동쪽 비상구와 가까운 대합실 끝입니다.', landmark: '왼쪽 벽에 낮은 안내 창구 선반이 있습니다.' },
];

const MALL_PLACES = [
  { name: '종합 안내소 앞', description: '안내소를 등지면 중앙 통로가 정면으로 이어집니다.', landmark: '뒤쪽에서 번호표 호출음이 들립니다.' },
  { name: '중앙 광장', description: '여러 매장 통로가 만나는 넓은 공간입니다.', landmark: '바닥 재질이 타일로 바뀌어 발소리가 크게 납니다.' },
  { name: '푸드코트 입구', description: '푸드코트와 비상구 통로가 갈라지는 지점입니다.', landmark: '환풍기 소리와 음식 냄새가 강하게 느껴집니다.' },
  { name: '서편 휴게공간', description: '서쪽 비상구로 이어지는 통로입니다.', landmark: '오른쪽에 낮은 의자가 연속해서 놓여 있습니다.' },
  { name: '동편 화장실 앞', description: '동쪽 비상구로 이어지는 통로입니다.', landmark: '왼쪽 벽에서 물 흐르는 소리가 들립니다.' },
];

export const TEST_PLANS = [
  makePlan({
    id: 'test-office', name: '테스트 1 · 사무실', prefix: 'O', places: OFFICE_PLACES,
    coords: [[20, 31], [20, 23], [30, 23], [10, 12], [30, 12]],
    edges: [['P1', 'P2', 'right'], ['P2', 'P3', 'right'], ['P2', 'P4', 'left'], ['P3', 'P5', 'right'], ['P4', 'P5', 'left'], ['P4', 'X1', 'left'], ['P5', 'X2', 'right']],
  }),
  makePlan({
    id: 'test-school', name: '테스트 2 · 학교', prefix: 'S', places: SCHOOL_PLACES,
    coords: [[8, 31], [8, 20], [20, 20], [12, 9], [29, 10]],
    edges: [['P1', 'P2', 'left'], ['P2', 'P3', 'right'], ['P2', 'P4', 'left'], ['P3', 'P5', 'right'], ['P4', 'P5', 'right'], ['P4', 'X1', 'left'], ['P5', 'X2', 'right']],
  }),
  makePlan({
    id: 'test-hospital', name: '테스트 3 · 병원', prefix: 'H', places: HOSPITAL_PLACES,
    coords: [[20, 32], [20, 24], [20, 16], [8, 10], [32, 10]],
    edges: [['P1', 'P2', 'right'], ['P2', 'P3', 'left'], ['P2', 'P4', 'left'], ['P2', 'P5', 'right'], ['P3', 'P4', 'left'], ['P3', 'P5', 'right'], ['P4', 'X1', 'left'], ['P5', 'X2', 'right']],
  }),
  makePlan({
    id: 'test-station', name: '테스트 4 · 지하철역', prefix: 'T', places: STATION_PLACES,
    coords: [[20, 32], [20, 24], [20, 15], [7, 15], [33, 15]],
    edges: [['P1', 'P2', null], ['P2', 'P3', 'left'], ['P2', 'P4', 'left'], ['P2', 'P5', 'right'], ['P3', 'P4', 'right'], ['P3', 'P5', 'left'], ['P4', 'X1', 'left'], ['P5', 'X2', 'right']],
  }),
  makePlan({
    id: 'test-mall', name: '테스트 5 · 쇼핑몰', prefix: 'M', places: MALL_PLACES,
    coords: [[20, 32], [20, 23], [20, 14], [8, 20], [32, 20]],
    edges: [['P1', 'P2', null], ['P2', 'P3', 'right'], ['P2', 'P4', 'left'], ['P2', 'P5', 'right'], ['P3', 'P4', 'right'], ['P3', 'P5', 'left'], ['P4', 'X1', 'left'], ['P5', 'X2', 'right']],
  }),
];

export const TEST_PLAN_IDS = TEST_PLANS.map(plan => plan.id);
