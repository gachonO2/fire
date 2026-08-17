/**
 * 현재 활성 도면과 "지금 이 순간의 위험 상태"를 만드는 곳.
 *
 * 위험은 두 출처를 합친 결과다:
 *   1) 관제·화재수신기가 직접 지정한 위험 (hazards)
 *   2) 온도 센서 판독값을 임계값으로 변환한 위험 (sensors)
 * 경로탐색은 반드시 이 합쳐진 결과를 써야 한다. 한쪽만 보면
 * 센서가 정상이라는 이유로 관제가 막아둔 통로를 안내하게 된다.
 */
import { FloorPlan } from '../../shared/floor-plan.js';
import { hazardsFromSensors, hazardsFromFires, mergeHazards } from '../../shared/hazard-rules.js';
import { getRepo } from './repositories/index.js';

/**
 * 활성 도면. **없으면 null.**
 *
 * 예전에는 도면이 없으면 시연용 "병원 3층"으로 채웠다. 그래서 실제 건물을 넣기
 * 전까지 앱이 있지도 않은 병원 복도를 자신 있게 안내했다. 없는 건 없다고 해야 한다.
 */
export async function activeFloorPlan() {
  const repo = await getRepo();
  const plan = await repo.getActivePlan();
  return plan ? new FloorPlan(plan) : null;
}

/** @returns {Object} edgeId -> hazard (수동 + 온도 센서 + 화재 발생지 통합) */
export async function currentHazards(floorPlan) {
  const repo = await getRepo();
  const plan = floorPlan || (await activeFloorPlan());
  const manual = await repo.getHazards();
  if (!plan) return manual;   // 도면이 없으면 센서를 통로에 대응시킬 수 없다
  const sensors = await repo.getSensors();
  const fires = await repo.getFires();
  return mergeHazards(
    manual,
    hazardsFromSensors(sensors, plan),
    hazardsFromFires(fires, plan),
  );
}
