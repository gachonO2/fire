/** 구조 요청 다중 입력의 진행 상태. UI와 무관하게 테스트할 수 있도록 분리한다. */
export function advanceSosPress(current, required = 3) {
  const count = Math.min(required, Math.max(0, current) + 1);
  return {
    count,
    remaining: Math.max(0, required - count),
    complete: count >= required,
  };
}

/** 데스크톱 키보드나 네이티브 WebView가 전달한 볼륨 올리기 입력인지 판별한다. */
export function isVolumeUpInput(event) {
  const key = event?.key || event?.code;
  return key === 'AudioVolumeUp'
    || key === 'VolumeUp'
    || event?.keyCode === 175
    || event?.keyCode === 183
    || event?.keyCode === 24;
}
