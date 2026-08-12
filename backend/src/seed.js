/**
 * 샘플 도면 등록 — 서버가 뜰 때 저장소에 없으면 넣어 둔다.
 *
 * 도면 이미지는 저장소에 data URI로 들어가야 하는데(브라우저가 CSP 없이 바로 그리도록),
 * 원본 SVG는 파일로 두고 여기서 읽어 변환한다. 그래야 도면을 고칠 때
 * 거대한 문자열이 아니라 그림 파일을 편집할 수 있다.
 *
 * 이미 있는 도면은 건드리지 않는다 — 사용자가 편집한 내용을 서버 재시작이 되돌리면 안 된다.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GACHON_3F_PLAN } from '../../shared/gachon-plan.js';
import { TEST_PLANS } from '../../shared/test-plans.js';

const sharedDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared');

const SAMPLES = [
  { plan: GACHON_3F_PLAN, image: 'plans/gachon-3f.svg' },
  ...TEST_PLANS.map((plan, index) => ({
    plan,
    image: `plans/test-${index + 1}.svg`,
    test: true,
  })),
];

/**
 * 등록만 하고 활성화는 하지 않는다. 어느 도면으로 안내할지는 사람이 고르는 일이고
 * (시연 콘솔의 건물 선택, 또는 도면 편집기), 서버 재시작이 그 선택을 바꿔서는 안 된다.
 */
export async function seedSamplePlans(repo) {
  for (const { plan, image, test } of SAMPLES) {
    const existing = await repo.getPlan(plan.id);
    // test-* 는 앱이 제공하는 고정 테스트 fixture라 구조 개선 사항을 갱신한다.
    // 사용자가 만든 일반 도면은 기존 원칙대로 절대 덮어쓰지 않는다.
    if (!existing || test) await repo.savePlan(plan);
    try {
      if (!(await repo.getPlanImage(plan.id))) {
        const svg = await readFile(path.join(sharedDir, image), 'utf8');
        const dataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
        await repo.setPlanImage(plan.id, dataUri);
      }
    } catch (err) {
      console.warn(`[seed] ${plan.id} 도면 이미지를 읽지 못했습니다:`, err.message);
    }
    if (!existing) {
      console.log(test
        ? `[seed] 테스트 도면 등록: ${plan.name} (테스트 위치 5곳)`
        : `[seed] 샘플 도면 등록: ${plan.name} (장소 ${plan.nodes.length}곳)`);
    }
  }
}
