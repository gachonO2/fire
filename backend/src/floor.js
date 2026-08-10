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
import { hazardsFromSensors, mergeHazards } from '../../shared/hazard-rules.js';
import { getRepo } from './repositories/index.js';

export async function activeFloorPlan() {
  const repo = await getRepo();
  return new FloorPlan(await repo.getActivePlan());
}

/** @returns {Object} edgeId -> hazard (수동 + 온도 센서 통합) */
export async function currentHazards(floorPlan) {
  const repo = await getRepo();
  const plan = floorPlan || (await activeFloorPlan());
  const manual = await repo.getHazards();
  const sensors = await repo.getSensors();
  return mergeHazards(manual, hazardsFromSensors(sensors, plan));
}
