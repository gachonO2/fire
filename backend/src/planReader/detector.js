/**
 * 도면 기호 탐지기 연결부 — ml/detector 의 파이썬 서비스를 부른다.
 *
 * ## 언어모델과 무엇이 다른가
 *
 * 언어모델은 도면을 **읽고 설명**한다. 통로가 어디로 이어지는지, 어느 방이 어느
 * 복도에 붙는지 같은 관계는 언어모델이 낫다. 하지만 좌표는 약하다 — 그림을 보고
 * "0.37, 0.62쯤"이라고 눈대중하는 셈이라, 비상구를 몇십 픽셀씩 어긋나게 찍는다.
 *
 * 탐지기는 그 반대다. 관계는 전혀 모르지만 **기호가 어디 있는지는 정확히** 안다.
 * 피난안내도 사진으로 직접 학습시킨 모델이라 초록 픽토그램·계단 기호를 상자 단위로
 * 집어낸다. 대신 "이 방이 어느 복도에 붙는가"는 알 수 없다.
 *
 * 그래서 둘을 합친다. **좌표는 탐지기, 통로는 언어모델.** planReader.js 가 그 이음매다.
 *
 * ## 없으면 없는 대로 간다
 *
 * 파이썬 서비스가 안 떠 있을 수 있다(설치 전, 노트북 재부팅, 배포 환경 차이).
 * 그때 판독 전체를 실패로 돌리면 사진을 찍으러 그 건물까지 걸어간 사람이 헛걸음한다.
 * 여기서는 null 을 돌려주고, 호출하는 쪽이 언어모델만으로 이어간다.
 */

import { config } from '../config.js';

/** 탐지에 쓰는 시간. GPU 없이 CPU 로 두 모델을 돌리면 사진 한 장에 5~15초쯤 걸린다. */
const DETECT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 1500;

/** 학습된 클래스 순서 — ml/detector/hybrid_detector.py 의 CLASS_NAMES 와 같아야 한다 */
export const CLASS_NAMES = [
  'exit', 'stair', 'elevator', 'extinguisher',
  'hydrant', 'you_are_here', 'door', 'room',
];

/** 탐지 결과가 살아 있는 동안만 유효한 상태 캐시 (편집기가 버튼 상태를 자주 묻는다) */
let healthCache = null;
let healthCheckedAt = 0;
const HEALTH_TTL_MS = 10_000;

async function fetchWithTimeout(url, opts = {}, timeoutMs = DETECT_TIMEOUT_MS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 탐지기가 지금 쓸 수 있는가.
 *
 * 결과를 짧게 캐시한다 — 편집기가 화면을 그릴 때마다 물어보는데, 서비스가 꺼져 있으면
 * 매번 연결 실패까지 기다리게 되어 화면이 눈에 띄게 느려진다.
 */
export async function detectorHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && healthCache && now - healthCheckedAt < HEALTH_TTL_MS) return healthCache;

  try {
    const res = await fetchWithTimeout(`${config.detectorUrl}/health`, {}, HEALTH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`상태 확인 실패 (${res.status})`);
    const j = await res.json();
    healthCache = j.ok
      ? { ok: true, device: j.device, reason: `기호 탐지기 준비됨 (${j.device})` }
      : { ok: false, reason: j.reason || '탐지기가 모델을 읽지 못했습니다.' };
  } catch (err) {
    healthCache = {
      ok: false,
      reason: err.name === 'AbortError'
        ? `기호 탐지기가 응답하지 않습니다 (${config.detectorUrl}).`
        : `기호 탐지기에 연결하지 못했습니다 (${config.detectorUrl}). ml/detector 를 실행하면 좌표 정확도가 올라갑니다.`,
    };
  }
  healthCheckedAt = now;
  return healthCache;
}

/**
 * 사진에서 기호를 찾는다.
 *
 * @param dataUri  data:image/...;base64,...
 * @returns {Promise<{detections, counts}|null>}  탐지기를 못 쓰면 **null** (예외 아님).
 *          좌표는 0~1 정규화된 [x1,y1,x2,y2] 이다.
 */
export async function detectSymbols(dataUri) {
  const health = await detectorHealth();
  if (!health.ok) return null;

  try {
    const res = await fetchWithTimeout(`${config.detectorUrl}/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUri }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[detector] 탐지 실패:', res.status, body.slice(0, 200));
      // 상태 캐시를 지운다 — 방금 실패했으니 다음 요청은 다시 확인하게 한다
      healthCache = null;
      return null;
    }
    const j = await res.json();
    const min = config.detectorMinConfidence;
    return {
      detections: (j.detections || []).filter(d => d.confidence >= min),
      // 걸러내기 전 개수도 남긴다. "탐지는 됐는데 확신이 낮아 버렸다"와
      // "아예 못 찾았다"는 사람이 사진을 다시 찍을지 정할 때 다른 정보다.
      rawCount: (j.detections || []).length,
      counts: j.counts || {},
    };
  } catch (err) {
    console.warn('[detector] 탐지 중 오류:', err.message);
    healthCache = null;
    return null;
  }
}
