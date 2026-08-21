/**
 * 건물 — **한 층짜리 시스템이 아니라는 것을 화면이 말해야 한다.**
 *
 * 관제가 6층 하나만 보여 주면 보는 사람에게 이것은 «한 층짜리 시스템» 이다.
 * 실제 건물은 지상 7층에 옥상까지 있고, 불은 한 층에서만 나지 않는다.
 * 그리고 대피는 **층을 내려가는 일**이라 층이 안 보이면 대피가 안 보인다.
 *
 * ## 그래도 없는 것을 있다고 말하지 않는다
 *
 * 일곱 층을 다 그려 놓고 전부 «정상» 이라고 칠하는 것이 제일 쉬운 길이고,
 * 제일 나쁜 길이다. 도면을 안 올린 층은 아무것도 안 보고 있는 것인데
 * 화면은 보고 있다고 말하게 된다 — 관제 화면이 할 수 있는 가장 나쁜
 * 거짓말이고, 이 프로젝트에서 이미 여러 번 피해 온 종류다.
 *
 * 그래서 층 상태를 셋으로 가른다.
 *
 *   감시 중     도면 + 감지기. 화면이 그 층을 실제로 본다
 *   도면만      도면은 있고 감지기가 없다. 경로는 그리되 감지는 못 한다
 *   도면 없음   아무것도 없다. 회색으로 두고 그렇게 적는다
 *
 * 지금은 6층이 «감시 중», 3층이 «도면만», 나머지가 «도면 없음» 이다.
 * 이 그림 자체가 «도면을 올리면 그 층이 켜진다» 를 말해 준다.
 */

import { HEAT_SPOTS } from './heatSensors.js';
import { getRepo } from './repositories/index.js';

/**
 * 이 건물의 생김새.
 *
 * 도면에서 읽어낼 수 있는 값이 아니다 — 도면 한 장은 자기 층만 안다.
 * 건물 전체는 사람이 알려 줘야 하는 값이라 여기 적어 둔다.
 */
export const BUILDING = Object.freeze({
  name: 'AI공학관',
  /**
   * 지상 8개 층 — 1~7층과 옥탑(PH). **지하는 없다.**
   *
   * 옥탑을 별도 칸이 아니라 8층으로 세는 이유: 옥탑에도 도면이 있고
   * 계단이 이어지고 감지기가 붙는다. «층이 아닌 무엇» 으로 빼 두면
   * 그 층만 판정에서 빠져, 옥탑에 불이 나도 화면이 조용하다.
   */
  floors: 8,
  /** 8층의 표시 이름. 「8층」 보다 「옥탑」 이 현장에서 쓰는 말이다. */
  topLabel: '옥탑',
  rooftop: false,
});

/** 도면 이름에서 층을 읽는다. 못 읽으면 null — 추측해서 붙이지 않는다. */
export function floorOfName(name) {
  const m = String(name || '').match(/(\d+)\s*[층충]/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 1 && n <= BUILDING.floors ? n : null;
}

/**
 * 층마다 «무엇이 있나» 를 판정한다.
 *
 * ## 감지기 설치 여부는 **보고 있는 층과 무관하다**
 *
 * 처음에는 활성 도면만 보고 판정했다. 그랬더니 3층을 보는 순간 6층이
 * «도면만» 으로 바뀌었다 — 6층 감지기 스무 대는 그대로 붙어 있는데.
 * 관제 화면이 «보고 있지 않으면 없는 것» 이라고 말한 셈이다.
 *
 * 설치 여부는 그 층의 **도면에 감지기 지점이 있는가**로 판정한다. 그러려면
 * 층마다 도면을 열어 봐야 하지만, 도면은 층당 하나뿐이고 메모리에 있다.
 */
export async function buildingFloors() {
  const repo = await getRepo();
  const plans = await repo.listPlans();
  const activeId = (await repo.getActivePlan())?.id ?? null;

  // 한 층에 도면이 여럿이다 — 촬영할 때마다 초안이 쌓인다. 그중 하나를
  // 그 층의 대표로 골라야 하는데, 순서가 중요하다.
  //
  //   ① 지금 보고 있는 도면
  //   ② 초안이 아닌 것 (사람이 정리해 확정한 도면)
  //   ③ 지점이 많은 것
  //
  // 처음엔 ③만 봤다. 그랬더니 6층에서 **감지기가 없는 옛 초안(50지점)이
  // 정리된 진짜 도면(42지점)을 이겼고**, 3층을 보는 순간 6층이 «도면만» 으로
  // 바뀌었다. 지점 수는 «잘 만든 도면» 의 척도가 아니다 — 판독이 헛짚어
  // 만든 유령 지점도 같이 세기 때문이다. 사람이 확정했는가가 먼저다.
  const rank = p => (p.id === activeId ? 2 : 0) + (p.draft === false ? 1 : 0);
  const best = new Map();
  for (const p of plans) {
    const f = floorOfName(p.name);
    if (f === null) continue;
    const prev = best.get(f);
    const better = !prev || rank(p) > rank(prev)
      || (rank(p) === rank(prev) && (p.nodeCount ?? 0) > (prev.nodeCount ?? 0));
    if (better) best.set(f, p);
  }

  const out = [];
  for (let f = BUILDING.floors; f >= 1; f--) {
    const p = best.get(f) || null;
    let hasDetectors = false;
    if (p) {
      const full = await repo.getPlan(p.id).catch(() => null);
      const ids = new Set((full?.nodes || []).map(n => n.id));
      hasDetectors = HEAT_SPOTS.some(s => ids.has(s.nodeId));
    }
    out.push({
      floor: f,
      planId: p?.id ?? null,
      name: p?.name ?? null,
      nodes: p?.nodeCount ?? 0,
      active: p?.id === activeId,
      detectors: hasDetectors
        ? HEAT_SPOTS.length : 0,
      state: !p ? 'none' : hasDetectors ? 'watched' : 'plan-only',
      label: f === BUILDING.floors && BUILDING.topLabel
        ? BUILDING.topLabel : `${f}층`,
    });
  }
  return { name: BUILDING.name, floors: out, rooftop: BUILDING.rooftop,
    topLabel: BUILDING.topLabel, activeId };
}
