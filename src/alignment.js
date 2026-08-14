/**
 * 촬영 정렬 판정 — 대피도를 똑바로 찍게 만든다.
 *
 * ## 왜 똑바로 찍어야 하나
 *
 * 비스듬히 찍으면 도면이 사다리꼴로 일그러진다. 그러면 **축척이 위치마다
 * 달라져서** "9걸음"이 어디선 7걸음, 어디선 11걸음이 된다. 시각장애인은
 * 그 걸음 수를 믿고 걷기 때문에 이 왜곡이 곧 오안내가 된다.
 *
 * ## 무엇으로 판정하나
 *
 * 가속도계로 중력 방향을 읽으면 폰의 자세를 알 수 있다. 카메라 영상을
 * 분석하지 않으므로 가볍고, Expo Go 에서 그대로 돌아간다.
 *
 *   벽에 붙은 대피도  → 폰을 **세워서** 벽과 나란히
 *   책상 위 도면      → 폰을 **눕혀서** 바닥과 나란히
 *
 * 둘 중 어느 상황인지는 중력의 z 성분으로 자동 판단한다. 사용자가 모드를
 * 고르게 하면 시각장애인에게 부담이고, 건축 담당자에게도 번거롭다.
 *
 * ## 롤(좌우 기울기)을 가장 엄하게 본다
 *
 * 좌우로 기울면 사진 전체가 회전해 **모든 좌표가 틀어진다.** 위아래 각도는
 * 사다리꼴 왜곡을 만들지만 나중에 보정할 여지가 있는 반면, 회전은 촬영 단계에서
 * 잡는 편이 훨씬 낫다.
 */

const ROLL_TOL = 0.10;      // 중력 x 성분 — 좌우 기울기
const PITCH_TOL = 0.22;     // 벽 촬영 시 앞뒤 기울기
const FLAT_TOL = 0.22;      // 바닥 촬영 시 기울기
const WALL_MODE_Z = 0.6;    // |z| 가 이보다 크면 바닥을 향해 찍는 중

export const MODE = { WALL: 'wall', FLOOR: 'floor' };

/**
 * @param {{x:number,y:number,z:number}} g  가속도계 값 (중력, 단위 g)
 * @returns {{ok:boolean, mode:string, roll:number, pitch:number, hint:string}}
 */
export function evaluate(g) {
  if (!g) return { ok: false, mode: MODE.WALL, roll: 0, pitch: 0, hint: '센서를 준비하는 중입니다' };

  const { x = 0, y = 0, z = 0 } = g;
  const floorMode = Math.abs(z) > WALL_MODE_Z;

  if (floorMode) {
    // 바닥/책상 위 도면: 폰이 수평이어야 한다 → x, y 둘 다 0 에 가깝게
    const roll = Math.abs(x);
    const pitch = Math.abs(y);
    const ok = roll < FLAT_TOL && pitch < FLAT_TOL;
    return {
      ok, mode: MODE.FLOOR, roll, pitch,
      hint: ok ? '좋습니다' : hintFor(x, y, true),
    };
  }

  // 벽에 붙은 도면: 폰을 세우고, 좌우로 기울지 않게
  const roll = Math.abs(x);
  const pitch = Math.abs(z);
  const ok = roll < ROLL_TOL && pitch < PITCH_TOL;
  return {
    ok, mode: MODE.WALL, roll, pitch,
    hint: ok ? '좋습니다' : hintFor(x, z, false),
  };
}

/** 어느 쪽으로 얼마나 틀어졌는지 말로 — 시각장애인도 따라올 수 있게 */
function hintFor(a, b, floorMode) {
  const absA = Math.abs(a), absB = Math.abs(b);
  if (absA >= absB) {
    return a > 0 ? '왼쪽으로 살짝 기울었습니다' : '오른쪽으로 살짝 기울었습니다';
  }
  if (floorMode) return b > 0 ? '위쪽으로 기울었습니다' : '아래쪽으로 기울었습니다';
  return b > 0 ? '폰을 조금 세워주세요' : '폰을 조금 눕혀주세요';
}

/**
 * 정렬 점수 0~1 — 테두리 색을 서서히 바꾸는 데 쓴다.
 * 딱 맞는 순간에만 초록으로 튀면 "거의 다 왔다"는 감각이 없어 찾기 어렵다.
 */
export function score(g) {
  if (!g) return 0;
  const { x = 0, y = 0, z = 0 } = g;
  const floorMode = Math.abs(z) > WALL_MODE_Z;
  const a = Math.abs(x);
  const b = Math.abs(floorMode ? y : z);
  const tolA = floorMode ? FLAT_TOL : ROLL_TOL;
  const tolB = floorMode ? FLAT_TOL : PITCH_TOL;
  const sa = Math.max(0, 1 - a / (tolA * 3));
  const sb = Math.max(0, 1 - b / (tolB * 3));
  return Math.max(0, Math.min(1, sa * sb));
}

/**
 * 갤러리 사진이 도면일 가능성 — 거칠게만 본다.
 *
 * 정확한 판별은 AI 가 필요한데, **그 AI 를 학습시키려고 사진을 모으는 중**이라
 * 순환에 빠진다. 그래서 명백히 아닌 것(셀카·음식 사진 같은)만 걸러내고
 * 애매하면 사용자에게 묻는다.
 *
 * 도면은 대체로 가로세로비가 극단적이지 않고 해상도가 충분하다.
 * 픽셀 분석은 Expo Go 에서 비싸므로 메타데이터만 본다.
 */
export function looksLikePlan({ width, height }) {
  if (!width || !height) return { verdict: 'unsure', reason: '크기를 알 수 없음' };

  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > 3.2) {
    return { verdict: 'reject', reason: '너무 길쭉한 사진입니다 (파노라마?)' };
  }
  if (Math.min(width, height) < 500) {
    return { verdict: 'reject', reason: '해상도가 낮아 도면을 읽을 수 없습니다' };
  }
  return { verdict: 'unsure', reason: '' };
}
