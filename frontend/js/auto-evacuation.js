/**
 * 화재 자동 대피 전환 규칙.
 * 현재 실행에서 위치가 확인되지 않았다면 경보만 알리고 경로 계산이나 SOS로 넘어가지 않는다.
 */
export function automaticEvacuationAction({
  armed,
  alarmHandled,
  phase,
  fireActive,
  hasVerifiedPlace,
}) {
  if (!armed || alarmHandled || phase !== 'idle' || !fireActive) return 'ignore';
  return hasVerifiedPlace ? 'start' : 'alert-only';
}

/** 이전 목록에 없던 화재 ID가 추가됐는지 확인한다. */
export function hasNewFire(previousIds, fires) {
  const previous = previousIds instanceof Set ? previousIds : new Set(previousIds || []);
  return (fires || []).some(fire => fire?.id && !previous.has(fire.id));
}

/** 좌표 화재는 fires 이벤트에서 처리하므로, 여기서는 새 수동·센서 경보만 비교한다. */
export function alarmHazardKeys(hazards, initialHazards = {}) {
  return new Set(Object.entries(hazards || {})
    .filter(([edgeId, hazard]) => {
      if (!['fire', 'smoke', 'heat'].includes(hazard?.type)) return false;
      if (hazard.source === 'fire' || hazard.fireId) return false;
      const baseline = initialHazards[edgeId];
      return baseline?.type !== hazard.type || Boolean(hazard.sensorId);
    })
    .map(([edgeId, hazard]) => `${edgeId}:${hazard.type}:${hazard.sensorId || ''}`));
}

export function hasNewSetValue(previous, current) {
  for (const value of current) if (!previous.has(value)) return true;
  return false;
}
