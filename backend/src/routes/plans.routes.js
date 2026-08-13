import { Router } from 'express';
import { validatePlan, FloorPlan, findUnreachableNodes } from '../../../shared/floor-plan.js';
import { getRepo } from '../repositories/index.js';
import { requireAdmin } from '../middleware/auth.js';
import { readPlanFromImage, readerAvailable, checkVision } from '../planReader.js';

export const planRoutes = Router();

/** 도면 이미지 상한 — Firestore 문서 1MB 제한을 고려한 값 (편집기가 미리 축소해 보낸다) */
const MAX_IMAGE_BYTES = 900_000;

/**
 * 축척을 안 넣었을 때 가정하는 층 가로 폭(m).
 * 층 도면은 대개 20~50m 안에 들어간다. 어디까지나 **추정**이고,
 * 이 값을 쓴 도면은 `scaleEstimated: true` 로 표시된다.
 */
const DEFAULT_PLAN_WIDTH_M = 30;

planRoutes.get('/plans', async (req, res) => {
  const repo = await getRepo();
  res.json(await repo.listPlans());
});

/**
 * 판독을 쓸 수 있는지 — 편집기가 버튼을 보일지 정할 때 쓴다.
 * `/plans/:planId` 보다 **먼저** 선언해야 한다. 뒤에 두면 "reader" 라는
 * 이름의 도면을 찾다가 404 가 난다.
 */
planRoutes.get('/plans/reader', async (req, res) => {
  if (!readerAvailable()) {
    return res.json({ configured: false, available: false, reason: '판독 키가 설정되지 않았습니다.' });
  }
  // 키가 있어도 그림이 모델에 닿는지는 별개다. 닿지 않으면 판독기는 도면을 지어낸다.
  // configured 와 available 을 나눠 두어야 편집기가 "키 없음"과 "키는 있는데 눈이 없음"을
  // 다르게 보여줄 수 있다 — 후자는 사용자가 고칠 수 있는 문제다.
  const vision = await checkVision();
  // transient=true 는 "지금 붐빔"이지 "못 쓴다"가 아니다. 편집기가 버튼을 잠그되
  // 다시 눌러볼 수 있게 구분해서 알린다.
  res.json({
    configured: true, available: vision.ok,
    retryable: Boolean(vision.transient), reason: vision.reason,
  });
});

planRoutes.get('/plans/:planId', async (req, res) => {
  const repo = await getRepo();
  const plan = await repo.getPlan(req.params.planId);
  if (!plan) return res.status(404).json({ error: '도면을 찾을 수 없습니다.' });
  res.json(plan);
});

/**
 * 도면 주입 — 건물의 설계도를 그래프로 등록한다.
 * 도면 편집기에서 그린 결과나, 다른 도구에서 내보낸 JSON을 그대로 받는다.
 *
 * 잘못된 도면은 곧바로 오안내가 되므로 저장 전에 검증한다.
 * 출구에 닿지 못하는 노드는 경고로 알려주되 저장은 허용한다 (편집 중일 수 있으므로).
 */
planRoutes.post('/plans', requireAdmin, async (req, res) => {
  const plan = req.body || {};
  if (!plan.id?.trim()) return res.status(400).json({ error: '도면 id가 필요합니다.' });

  const errors = validatePlan(plan);
  if (errors.length) return res.status(400).json({ error: '도면 검증 실패', details: errors });

  const repo = await getRepo();
  const saved = await repo.savePlan({
    id: plan.id.trim(),
    name: plan.name.trim(),
    metersPerUnit: plan.metersPerUnit ?? 1,
    stepLength: plan.stepLength ?? 0.7,
    // 도면 위쪽이 실제 몇 도인가. 없으면 절대 방향(진동) 안내를 못 한다.
    northOffset: Number.isFinite(plan.northOffset) ? plan.northOffset : null,
    // 축척이 추정값인지. 사람이 편집기에서 가로 폭을 넣으면 그때 벗겨진다.
    scaleEstimated: Boolean(plan.scaleEstimated),
    image: plan.image ?? null,
    nodes: plan.nodes,
    edges: plan.edges,
    initialHazards: plan.initialHazards || {},
  });

  const unreachable = findUnreachableNodes(new FloorPlan(saved));
  res.status(201).json({
    plan: saved,
    warnings: unreachable.length
      ? [`출구까지 이어지지 않는 지점이 있습니다: ${unreachable.join(', ')}`]
      : [],
  });
});

/**
 * 이 도면으로 안내를 시작한다 (활성화).
 *
 * **초안은 활성화할 수 없다.** 사람이 편집기에서 눈으로 확인하고 저장해야
 * `draft` 가 벗겨진다. AI 가 비상구를 하나 잘못 찍으면 시각장애인이 벽으로
 * 걸어가므로, 확인을 건너뛰는 길은 여기서 막는다.
 */
planRoutes.put('/plans/:planId/activate', requireAdmin, async (req, res) => {
  const repo = await getRepo();
  const target = await repo.getPlan(req.params.planId);
  if (!target) return res.status(404).json({ error: '도면을 찾을 수 없습니다.' });
  if (target.draft) {
    return res.status(409).json({
      error: '아직 확인하지 않은 초안입니다. 편집기에서 지점·통로를 확인하고 저장한 뒤 활성화하세요.',
    });
  }

  const plan = await repo.activatePlan(req.params.planId);
  res.json({ ok: true, plan });
});

planRoutes.delete('/plans/:planId', requireAdmin, async (req, res) => {
  const repo = await getRepo();
  const active = await repo.getActivePlan();
  if (active.id === req.params.planId) {
    return res.status(409).json({ error: '사용 중인 도면은 삭제할 수 없습니다.' });
  }
  await repo.deletePlan(req.params.planId);
  res.json({ ok: true });
});

// ------------------------------------------------------------- AI 판독

/**
 * 도면 사진 → 경로 그래프 **초안**.
 *
 * 저장하지 않는다. 편집기에 띄워 사람이 고친 뒤에야 POST /plans 로 들어간다.
 * 비상구를 하나 잘못 찍으면 시각장애인이 벽으로 걸어가므로, 사람 확인을
 * 건너뛰는 경로는 의도적으로 만들지 않았다.
 *
 * body: { dataUri, width, height }
 */
planRoutes.post('/plans/read', requireAdmin, async (req, res, next) => {
  const { dataUri, width, height } = req.body || {};
  if (!dataUri?.startsWith('data:image/')) {
    return res.status(400).json({ error: '이미지 데이터 URI가 필요합니다.' });
  }
  if (dataUri.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error: `이미지가 너무 큽니다 (${Math.round(dataUri.length / 1024)}KB).`,
    });
  }
  try {
    res.json(await readPlanFromImage(dataUri, { width, height }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * 앱에서 찍은 피난안내도 접수 — 촬영부터 초안까지 한 번에.
 *
 * 지금까지는 앱이 찍은 사진이 폰에만 남아, 같은 사진을 편집기에서 **또** 올려야 했다.
 * 여기로 보내면 사진 저장 + AI 판독 + 초안 생성이 한 번에 끝나고, 편집기에서는
 * **확인만** 하면 된다.
 *
 * ## 관제 권한을 요구하지 않는다
 *
 * 도면을 모으는 건 건축 담당자·보호자·일반 사용자 누구나 하는 일이다. 여기서 막으면
 * 데이터가 안 쌓인다. 대신 **초안은 안내에 쓰이지 않는다** — 활성화만 관제 권한이다.
 * "누구나 낼 수 있고, 확인은 담당자가 한다"가 이 API 의 안전 경계다.
 *
 * ## 축척과 방위는 사람이 넣는다
 *
 * 사진에 안 적혀 있어서 판독으로는 알 수 없다. 특히 방위는 **찍는 사람이 그 자리에
 * 서 있을 때만** 잴 수 있으므로 앱이 촬영 직후에 받아 보낸다.
 *
 * body: { name, dataUri, width, height, widthM, northOffset?, id? }
 */
planRoutes.post('/plans/draft', async (req, res, next) => {
  const { name, dataUri, width, height, widthM, northOffset, id } = req.body || {};

  if (!name?.trim()) return res.status(400).json({ error: '건물·층 이름이 필요합니다.' });
  if (!dataUri?.startsWith('data:image/')) {
    return res.status(400).json({ error: '이미지 데이터 URI가 필요합니다.' });
  }
  if (dataUri.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: `이미지가 너무 큽니다 (${Math.round(dataUri.length / 1024)}KB).` });
  }
  const px = Number(width) > 0 ? Number(width) : null;
  if (!px) return res.status(400).json({ error: '이미지 가로 픽셀 수가 필요합니다.' });

  try {
    // 판독이 실패해도 **사진은 반드시 남긴다.**
    // 찍는 사람은 그 건물까지 걸어가 벽 앞에 서서 찍었다. 모델이 잠깐 붐볐다는
    // 이유로 그걸 버리면 다시 가야 한다. 판독은 나중에 편집기에서 다시 돌리면 되고,
    // 정 안 되면 손으로 그리면 된다 — 사진만 있으면 둘 다 가능하다.
    let draft = null;
    let readError = null;
    try {
      draft = await readPlanFromImage(dataUri, { width: px, height });
    } catch (err) {
      readError = err.message;
    }

    const repo = await getRepo();
    const planId = (id?.trim()) || `draft-${slug(name)}-${await nextSuffix(repo, slug(name))}`;
    // 축척을 안 받으면 층 하나를 기본값으로 가정한다.
    // 추정값이라는 **표시를 반드시 남긴다** — 이게 없으면 앱이 "8걸음"을
    // 자신 있게 말하고, 시각장애인은 그 걸음 수를 믿고 걷다가 모퉁이를 지나친다.
    const estimated = !(Number(widthM) > 0);
    const effectiveWidthM = estimated ? DEFAULT_PLAN_WIDTH_M : Number(widthM);

    const plan = {
      id: planId,
      name: name.trim(),
      metersPerUnit: effectiveWidthM / px,
      scaleEstimated: estimated,
      stepLength: 0.7,
      northOffset: Number.isFinite(northOffset) ? ((northOffset % 360) + 360) % 360 : null,
      image: { width: px, height: Number(height) || px },
      nodes: draft?.nodes || [],
      edges: draft?.edges || [],
      initialHazards: {},
      // 확인 전이라는 표시. 이게 붙어 있으면 활성화되지 않는다.
      draft: true,
      readConfidence: draft?.confidence || null,
      readNotes: draft?.notes || '',
      readWarnings: draft?.warnings || [],
      readError,
    };

    // 판독이 출구를 못 찾았어도 저장은 한다 — 사람이 편집기에서 채워 넣으면 되고,
    // 여기서 버리면 애써 찍은 사진이 사라진다. 대신 무엇이 모자란지 알려준다.
    const errors = plan.nodes.length ? validatePlan(plan) : [];
    await repo.savePlan(plan);
    await repo.setPlanImage(planId, dataUri);

    res.status(201).json({
      planId, name: plan.name, draft: true,
      read: Boolean(draft),
      readError,
      nodes: plan.nodes.length,
      edges: plan.edges.length,
      exits: plan.nodes.filter(n => n.type === 'exit').length,
      rooms: plan.nodes.filter(n => n.type === 'room').length,
      confidence: draft?.confidence || null,
      scaleEstimated: estimated,
      notes: draft?.notes || '',
      warnings: [...(draft?.warnings || []), ...errors, ...(readError ? [readError] : [])],
      needsReview: true,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

/**
 * 이름에서 id 를 만든다. **ASCII 만 남긴다.**
 *
 * 한글을 그대로 두면 URL 경로(`/api/plans/:id`)에서 깨진다 — 브라우저는
 * 알아서 인코딩하지만 서버 로그·저장소 키·다른 도구는 그렇지 않다.
 * 보이는 이름(`name`)은 한글 그대로 두고, **id 만** 안전한 글자로 만든다.
 */
function slug(s) {
  return String(s).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'plan';
}

/** 같은 이름으로 여러 번 올려도 덮어쓰지 않게 뒤에 번호를 붙인다 */
async function nextSuffix(repo, base) {
  const list = await repo.listPlans();
  const used = list.filter(p => String(p.id).startsWith(`draft-${base}-`)).length;
  return used + 1;
}

// ------------------------------------------------------------- 도면 이미지
planRoutes.get('/plans/:planId/image', async (req, res) => {
  const repo = await getRepo();
  const dataUri = await repo.getPlanImage(req.params.planId);
  if (!dataUri) return res.status(404).json({ error: '등록된 도면 이미지가 없습니다.' });
  res.json({ dataUri });
});

/** body: { dataUri } — 편집기가 축소·압축해서 보낸 도면 이미지 */
planRoutes.put('/plans/:planId/image', requireAdmin, async (req, res) => {
  const { dataUri } = req.body || {};
  if (!dataUri?.startsWith('data:image/')) {
    return res.status(400).json({ error: '이미지 데이터 URI가 필요합니다.' });
  }
  if (dataUri.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error: `도면 이미지가 너무 큽니다 (${Math.round(dataUri.length / 1024)}KB). ${Math.round(MAX_IMAGE_BYTES / 1024)}KB 이하로 줄여주세요.`,
    });
  }

  const repo = await getRepo();
  if (!(await repo.getPlan(req.params.planId))) {
    return res.status(404).json({ error: '도면을 먼저 저장하세요.' });
  }
  await repo.setPlanImage(req.params.planId, dataUri);
  res.json({ ok: true, bytes: dataUri.length });
});
