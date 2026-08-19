/**
 * 지자기 — **재현성 검사부터.**
 *
 * ## 왜 이 순서인가
 *
 * 지자기 지문은 «같은 자리는 같은 값을 낸다» 에 전부를 걸고 있다. 그것이
 * 참인지 재보지 않고 측량 흐름을 먼저 만들면, 한 층을 다 걷고 나서야 쓸 수
 * 없다는 것을 알게 된다. BLE 답사에서 그 순서를 안 지켜 한 바퀴를 날렸다.
 *
 * 그래서 이 경로는 두 단계로 나뉜다.
 *
 *   1  재현성    같은 자리를 두 번 이상 재서 판정을 받는다  ← 여기서 접을 수도 있다
 *   2  지문      통과했을 때만, 통로를 걸으며 걸음별 |B| 를 기록한다
 *
 * ## 왜 서버에 남기나
 *
 * 검사는 건물을 걸어야 나오는 값이다. 앱 화면 상태로만 들고 있으면 화면을
 * 닫는 순간 사라지고, 다시 걸어야 한다. 답사 결과를 파일로 남긴 것과 같은
 * 이유다 — **사람의 걸음으로 만든 값은 프로세스보다 오래 살아야 한다.**
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';

import { reproducibilityReport } from '../../../shared/magnetic.js';
import { getRepo } from '../repositories/index.js';

export const magneticRoutes = Router();

const FILE = new URL('../../data/magnetic.json', import.meta.url);

/**
 * `{ visits: [{spot, samples}], prints: {edgeId: [μT…]} }`
 *
 * 방문 기록(`visits`)을 원본 그대로 들고 있는다. 판정만 저장하면 문턱을
 * 바꿔 다시 판정할 수 없고, 어느 지점이 흔들렸는지도 못 본다.
 */
let store = { visits: [], prints: {} };

function load() {
  try {
    store = JSON.parse(readFileSync(FILE, 'utf8'));
    const spots = new Set(store.visits.map(v => v.spot)).size;
    if (store.visits.length) {
      console.log(`  지자기 복원: 방문 ${store.visits.length}회 · ${spots}지점`
        + ` · 지문 ${Object.keys(store.prints || {}).length}개 통로`);
    }
  } catch (_) {
    store = { visits: [], prints: {} };
  }
}

function persist() {
  try {
    mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
    writeFileSync(FILE, JSON.stringify(store, null, 1));
  } catch (err) {
    console.warn('  지자기 저장 실패:', err.message);
  }
}

load();

/** 지금까지의 방문 기록과 판정 */
magneticRoutes.get('/magnetic', (req, res) => {
  const report = reproducibilityReport(store.visits);
  res.json({
    visits: store.visits.length,
    spots: [...new Set(store.visits.map(v => v.spot))],
    prints: Object.keys(store.prints || {}).length,
    report,
  });
});

/**
 * 한 지점을 한 번 잰 결과를 더한다.
 *
 * 같은 `spot` 을 두 번 이상 보내야 판정이 나온다 — 그게 «재현성» 의 뜻이다.
 */
magneticRoutes.post('/magnetic/visit', (req, res) => {
  const { spot, samples } = req.body || {};
  if (!spot || !Array.isArray(samples) || samples.length < 3) {
    return res.status(400).json({ error: 'spot 과 samples(3개 이상) 가 필요합니다.' });
  }
  const clean = samples.map(Number).filter(Number.isFinite);
  if (clean.length < 3) return res.status(400).json({ error: '숫자 표본이 3개 이상 필요합니다.' });

  store.visits.push({ spot: String(spot), samples: clean, at: Date.now() });
  persist();

  const report = reproducibilityReport(store.visits);
  res.json({
    ok: true,
    visits: store.visits.length,
    thisSpot: store.visits.filter(v => v.spot === String(spot)).length,
    report,
  });
});

/** 다시 시작 — 잘못 재서 엉킨 것을 버린다 */
magneticRoutes.delete('/magnetic', (req, res) => {
  store = { visits: [], prints: {} };
  persist();
  res.json({ ok: true });
});

/**
 * 통로 지문 — **재현성이 통과했을 때만 의미가 있다.**
 *
 * 그래서 판정이 `unusable` 이면 거부한다. 못 쓰는 지문을 쌓아 두면 나중에
 * 그것을 근거로 위치를 잡게 되고, 왜 틀리는지 알 수 없게 된다.
 */
magneticRoutes.put('/magnetic/print/:edgeId', async (req, res) => {
  const { samples } = req.body || {};
  if (!Array.isArray(samples) || samples.length < 3) {
    return res.status(400).json({ error: 'samples(3개 이상) 가 필요합니다.' });
  }
  const plan = await (await getRepo()).getActivePlan();
  const edgeId = String(req.params.edgeId);
  if (!plan?.edges?.some(e => e.id === edgeId)) {
    return res.status(404).json({ error: `도면에 없는 통로입니다: ${edgeId}` });
  }
  // **통과한 뒤에만 받는다.** `unusable` 만 막고 `insufficient` 를 통과시키면,
  // 검사를 아예 안 한 상태에서 지문이 쌓인다. 나중에 그것을 근거로 위치를
  // 잡게 되고, 틀렸을 때 «지문이 나쁜가 판정이 나쁜가» 를 가릴 수 없다.
  const report = reproducibilityReport(store.visits);
  if (report.verdict === 'unusable') {
    return res.status(409).json({
      error: '재현성 검사 결과가 «쓸 수 없음» 입니다. 같은 자리가 같은 값을 내지 않으므로 지문을 쌓지 않습니다.',
      report,
    });
  }
  if (report.verdict === 'insufficient') {
    return res.status(409).json({
      error: '재현성 검사를 먼저 하세요. 지점 두 곳 이상을 각각 두 번 이상 재야 지문을 받을 수 있습니다.',
      report,
    });
  }
  store.prints[edgeId] = samples.map(Number).filter(Number.isFinite);
  persist();
  res.json({ ok: true, edgeId, count: store.prints[edgeId].length,
    prints: Object.keys(store.prints).length });
});

/** 도면에 얹어 줄 지문 묶음 — 앱의 `MagneticMatcher` 가 이걸 먹는다 */
magneticRoutes.get('/magnetic/prints', (req, res) => {
  res.json({ prints: store.prints || {} });
});
