/**
 * 도면 판독 — 피난안내도 사진에서 대피 경로 그래프 초안을 뽑는다.
 *
 * ## 이게 왜 필요한가
 *
 * 피난안내도에는 비상구도, 현 위치도, 피난경로 화살표도 **이미 그려져 있다.**
 * 없던 정보를 만드는 게 아니라, 그림으로만 있는 것을 좌표로 **옮겨 적는** 일이다.
 * 지금까지는 그 옮겨 적기를 사람이 클릭으로 했다(도면 하나에 10분쯤).
 *
 * ## 사람 확인을 없애지 말 것
 *
 * 판독은 **초안**이다. 비상구를 하나 잘못 찍으면 시각장애인이 벽으로 걸어간다.
 * 그래서 이 함수는 절대 바로 저장하지 않고, 편집기에 띄워 사람이 고치게 한다.
 * 확인 버튼은 요식이 아니라 **마지막 방어선**이다.
 *
 * ## 축척은 판독하지 않는다
 *
 * "사진 속 1px 이 몇 m 인가"는 사진에 안 적혀 있다. 문 폭(0.9m)이나 복도 폭으로
 * 어림할 수는 있지만 어림은 어림이다. 축척이 두 배 틀리면 "8미터 직진"이
 * 16미터가 되고, 시각장애인은 그 걸음 수를 믿고 걷다가 모퉁이를 지나친다.
 * 이 숫자 하나만은 사람이 직접 넣는다.
 *
 * ## 두 모델이 각자 잘하는 것만 한다
 *
 * 판독에는 성격이 다른 두 모델이 쓰인다.
 *
 *   기호 탐지기 (ml/detector — 피난안내도로 직접 학습시킨 YOLO)
 *       비상구·계단·실·문이 **어디 있는지**를 상자 단위로 집어낸다.
 *       글자는 못 읽고, 통로가 어디로 이어지는지도 모른다.
 *
 *   언어모델 (Gemini · Claude)
 *       도면에 적힌 호실 이름을 읽고, 복도 선과 초록 피난경로 화살표를 따라
 *       **무엇이 무엇과 이어지는지**를 판단한다. 대신 좌표는 눈대중이라 약하다.
 *
 * 그래서 **좌표는 탐지기, 이름과 통로는 언어모델**로 나눈다. 한쪽만 있어도 돌아간다:
 *
 *   둘 다      탐지기가 찍은 지점 위에 언어모델이 이름과 통로를 얹는다 (가장 정확)
 *   탐지기만   지점은 정확하고 통로는 기하학적 추정 + 이름은 번호 (graph.js)
 *   언어모델만 예전 방식 그대로 — 전부 언어모델이 읽는다
 *   둘 다 없음 판독을 시작하지 않고 손으로 그리기로 넘긴다
 */

import { provider, providerLabel, isTransient } from './planReader/providers.js';
import { detectSymbols, detectorHealth } from './planReader/detector.js';
import { nodesFromDetections, inferCorridorEdges } from './planReader/graph.js';

/** 판독 결과로 받아들일 노드 유형 — shared/floor-plan.js 의 NODE_TYPES 와 같아야 한다 */
const NODE_TYPES = ['room', 'junction', 'exit', 'elevator', 'stair'];

const TOOL = {
  name: 'report_plan',
  description: '피난안내도에서 읽어낸 대피 경로 그래프를 보고한다.',
  input_schema: {
    type: 'object',
    properties: {
      isEvacuationPlan: {
        type: 'boolean',
        description: '이 이미지가 실제 피난안내도(층 평면도)인가. 아니면 false.',
      },
      buildingName: { type: 'string', description: '도면에 적힌 건물명. 없으면 빈 문자열.' },
      floorLabel: { type: 'string', description: '층 표기(예: "3층"). 없으면 빈 문자열.' },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: '판독 신뢰도. 조금이라도 흐리거나 가려졌으면 low.',
      },
      notes: {
        type: 'string',
        description: '사람이 꼭 확인해야 할 점을 한국어 한두 문장으로. 예: "왼쪽 아래가 반사광에 가려 통로를 추정했습니다."',
      },
      nodes: {
        type: 'array',
        description: '지점 목록. 좌표는 이미지 좌상단이 (0,0), 우하단이 (1,1).',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '짧은 고유 id (예: N1, X1)' },
            name: { type: 'string', description: '사람이 읽을 이름 (예: "서쪽 계단", "중앙 복도 교차점")' },
            x: { type: 'number', description: '가로 위치 0~1' },
            y: { type: 'number', description: '세로 위치 0~1' },
            type: { type: 'string', enum: NODE_TYPES },
          },
          required: ['id', 'name', 'x', 'y', 'type'],
        },
      },
      edges: {
        type: 'array',
        description: '실제로 걸어서 지나갈 수 있는 통로만. 벽을 가로지르는 연결을 만들지 말 것.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            a: { type: 'string', description: '한쪽 노드 id' },
            b: { type: 'string', description: '다른 쪽 노드 id' },
            wall: {
              type: 'string',
              enum: ['left', 'right'],
              description: 'a→b 로 갈 때 짚고 갈 벽. 모르면 넣지 말 것.',
            },
          },
          required: ['id', 'a', 'b'],
        },
      },
    },
    required: ['isEvacuationPlan', 'confidence', 'nodes', 'edges', 'notes'],
  },
};

const PROMPT = `이 사진은 한국 건물에 게시된 **피난안내도**입니다.
시각장애인 대피 안내 앱에 쓸 **경로 그래프 초안**을 만들어 주세요.

## 도면에 이미 그려져 있는 것들

한국 피난안내도는 규격이 있어 대개 다음이 표시돼 있습니다. 추측하지 말고 **보이는 것만** 옮겨 적으세요.

- **현 위치** — 빨간 점·화살표·"현 위치" 글자
- **비상구·계단** — 초록 바탕에 뛰어가는 사람 픽토그램, "비상구"·"계단" 글자
- **피난경로** — 초록색 화살표나 굵은 선. **이게 있으면 그대로 따르세요.** 통로를 추측할 필요가 없습니다.
- **엘리베이터** — 화재 시 못 쓰지만 위치는 기록해 두세요(경로에서 자동으로 제외됩니다)

## 규칙

1. **좌표**는 이미지 좌상단 (0,0), 우하단 (1,1) 기준의 비율입니다.
2. **간선(edges)은 실제 복도만** 이으세요. 두 점 사이에 벽이 있으면 잇지 마세요.
   눈에 보이는 직선거리가 가깝다는 이유로 이으면, 시각장애인이 벽으로 걸어갑니다.
3. **비상구·피난계단은 반드시 \`exit\`** 으로 하세요. 대피 목표가 되는 건 \`exit\` 뿐이고,
   \`stair\` 로 두면 그 계단은 대피로에서 **빠집니다.** 초록 픽토그램이 붙은 계단은 전부 \`exit\` 입니다.
   (\`stair\` 는 옥상 전용 계단처럼 대피에 쓸 수 없는 것에만 쓰세요.)
4. **이름이 적힌 방은 전부 \`room\` 으로 넣으세요.** 시각장애인이 대피를 시작할 때
   "지금 어디 계신가요"에서 고르는 목록이 이 방 이름입니다. 방이 없으면 **고를 수가 없어**
   안내를 시작하지 못합니다. 각 방은 앞쪽 복도와 통로로 이어주세요.
5. 복도 교차점은 \`junction\` 으로 넣으세요. 꺾이는 지점마다 하나씩 있어야
   "여기서 왼쪽으로 도세요" 안내가 나옵니다.
6. 모든 지점은 복도를 통해 **이어져 있어야** 합니다. 외딴 점을 남기지 마세요.
7. 소화기·소화전·경보기 위치는 **넣지 마세요.** 대피 경로와 무관합니다.

## 확신이 없을 때

**없는 출구를 만들어내지 마세요.** 반사광에 가렸거나 흐려서 안 보이면, 그 부분은
빼고 \`notes\` 에 "왼쪽 아래가 안 보입니다"라고 적으세요. 사람이 그 부분만 채워 넣습니다.

이 결과는 **사람이 검수하는 초안**입니다. 빠뜨린 것은 사람이 채우면 되지만,
잘못 만들어낸 것은 사람이 알아채기 어렵습니다. **적게 말하고 정확하게** 말하세요.

이미지가 피난안내도가 아니면 \`isEvacuationPlan: false\` 로 보고하고 나머지는 비우세요.`;

/**
 * 탐지기가 지점을 이미 찍어 준 경우의 도구·지시문.
 *
 * 좌표를 다시 묻지 않는 것이 핵심이다. 탐지기가 사진에서 상자로 집어낸 위치는
 * 언어모델의 눈대중보다 정확하고, 그걸 다시 말하게 하면 **더 나빠질 뿐**이다.
 * 여기서 묻는 건 언어모델만 할 수 있는 두 가지다 — 적힌 **이름**과 통로 **연결**.
 */
const REFINE_TOOL = {
  name: 'connect_plan',
  description: '이미 찍힌 지점들에 이름을 달고 통로로 잇는다.',
  input_schema: {
    type: 'object',
    properties: {
      isEvacuationPlan: { type: 'boolean', description: '이 이미지가 실제 피난안내도인가.' },
      buildingName: { type: 'string', description: '도면에 적힌 건물명. 없으면 빈 문자열.' },
      floorLabel: { type: 'string', description: '층 표기(예: "3층"). 없으면 빈 문자열.' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      notes: { type: 'string', description: '사람이 꼭 확인해야 할 점을 한국어 한두 문장으로.' },
      renames: {
        type: 'array',
        description: '지점에 도면에 적힌 실제 이름을 달아준다. 글자가 안 보이면 넣지 말 것.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '주어진 지점 id 그대로' },
            name: { type: 'string', description: '도면에 적힌 이름 (예: "301 강의실")' },
            type: {
              type: 'string', enum: NODE_TYPES,
              description: '유형이 명백히 틀렸을 때만. 맞으면 넣지 말 것.',
            },
          },
          required: ['id', 'name'],
        },
      },
      extraNodes: {
        type: 'array',
        description: '탐지기가 놓친 지점만. 특히 복도가 꺾이는 교차점(junction)은 탐지기가 못 찾는다.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '새 id (예: J1)' },
            name: { type: 'string' },
            x: { type: 'number', description: '가로 0~1' },
            y: { type: 'number', description: '세로 0~1' },
            type: { type: 'string', enum: NODE_TYPES },
          },
          required: ['id', 'name', 'x', 'y', 'type'],
        },
      },
      edges: {
        type: 'array',
        description: '실제로 걸어 지나갈 수 있는 통로만. 벽을 가로지르지 말 것.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            a: { type: 'string' },
            b: { type: 'string' },
            wall: { type: 'string', enum: ['left', 'right'], description: 'a→b 로 갈 때 짚고 갈 벽. 모르면 넣지 말 것.' },
          },
          required: ['id', 'a', 'b'],
        },
      },
    },
    required: ['isEvacuationPlan', 'confidence', 'edges', 'notes'],
  },
};

function refinePrompt(nodes) {
  const list = nodes.map(n =>
    `- ${n.id} · ${n.name} · ${n.type} · (${n.x.toFixed(3)}, ${n.y.toFixed(3)})`).join('\n');

  return `이 사진은 한국 건물에 게시된 **피난안내도**입니다.
시각장애인 대피 안내 앱에 쓸 경로 그래프를 만들고 있습니다.

## 지점은 이미 찍혀 있습니다

전용 탐지 모델이 사진에서 기호를 찾아 아래 지점들을 만들었습니다.
좌표는 이미지 좌상단 (0,0), 우하단 (1,1) 기준입니다.

${list}

**좌표를 다시 계산하지 마세요.** 탐지 모델이 상자로 집어낸 위치라 눈대중보다 정확합니다.
당신이 할 일은 탐지 모델이 할 수 없는 두 가지입니다.

## 1. 이름 달기 (renames)

탐지 모델은 **글자를 읽지 못해** 이름을 "실 1", "비상구 2"처럼 번호로만 붙였습니다.
그 자리에 적힌 실제 글자를 읽어 이름을 달아주세요 (예: "301 강의실", "서편 비상계단").

이 이름이 중요한 이유: 시각장애인이 대피를 시작할 때 **"지금 어디 계신가요"에서
고르는 목록**이 이 이름들입니다. "실 1"은 아무 도움이 되지 않습니다.

글자가 흐리거나 가려서 안 읽히면 **그 지점은 \`renames\` 에 넣지 마세요.**
번호 이름("실 3")으로 남으면 사람이 그것만 골라 채우면 되지만, 지어낸 호실 이름은
사람이 검수할 때 알아채기 어렵습니다. 지점 자체를 지우지는 마세요 — 탐지 모델이
사진에서 본 것이라 위치는 맞습니다.

## 2. 통로 잇기 (edges)

도면의 복도 선과 초록 피난경로 화살표를 따라, **실제로 걸어서 지나갈 수 있는**
연결만 만드세요.

- 두 점 사이에 벽이 있으면 **잇지 마세요.** 직선거리가 가깝다는 이유로 이으면
  시각장애인이 벽으로 걸어갑니다.
- 각 실은 앞쪽 복도와 이어주세요.
- **모든 지점이 이어져 있어야** 합니다. 외딴 점을 남기지 마세요.
- 복도가 꺾이는 지점에 지점이 없으면 \`extraNodes\` 에 \`junction\` 으로 추가하세요.
  꺾이는 곳마다 하나 있어야 "여기서 왼쪽으로 도세요" 안내가 나옵니다.

## 유형이 명백히 틀렸을 때만 고치세요

탐지 모델이 소화기를 비상구로 본 것 같다면 \`renames\` 의 \`type\` 으로 고칠 수 있습니다.
다만 **비상구·피난계단은 \`exit\`** 이어야 합니다 — 대피 목표가 되는 건 \`exit\` 뿐이라
\`stair\` 로 바꾸면 그 계단이 대피로에서 빠집니다.

이 결과는 **사람이 검수하는 초안**입니다. 빠뜨린 것은 사람이 채우면 되지만,
잘못 만들어낸 것은 사람이 알아채기 어렵습니다. **적게 말하고 정확하게** 말하세요.

이미지가 피난안내도가 아니면 \`isEvacuationPlan: false\` 로 보고하세요.`;
}

// ---------------------------------------------------------- 공개 함수

export function readerAvailable() {
  return Boolean(provider());
}

export { providerLabel };

/**
 * 편집기가 "AI로 읽기" 버튼을 어떻게 보일지 정하는 데 쓰는 상태.
 *
 * 엔진이 둘이라 "쓸 수 있다/없다" 하나로는 부족하다. 탐지기만 있어도 지점은
 * 찍히고, 언어모델만 있어도 판독은 된다. 둘 중 **하나라도** 있으면 available 이고,
 * 무엇이 빠졌는지는 사람이 고칠 수 있는 정보라 따로 알린다.
 */
export async function readerStatus() {
  const [detector, vision] = await Promise.all([
    detectorHealth(),
    readerAvailable() ? checkVision() : Promise.resolve({ ok: false, reason: '판독 키가 설정되지 않았습니다.' }),
  ]);

  const engine = detector.ok
    ? (vision.ok ? `기호 탐지기 + ${providerLabel()}` : '기호 탐지기 단독')
    : (vision.ok ? `언어모델 단독 (${providerLabel()})` : '연결 없음');

  const reason = detector.ok && vision.ok
    ? `기호는 학습된 탐지기가 찍고, 이름·통로는 ${providerLabel()} 이 읽습니다.`
    : detector.ok
      ? `탐지기가 지점을 찍습니다. 통로는 위치로 추정하고 호실 이름은 번호로 붙으니, 판독 키를 넣으면 정확해집니다. (${vision.reason})`
      : vision.ok
        ? `언어모델이 좌표까지 읽습니다. ml/detector 를 실행하면 지점 위치가 정확해집니다. (${detector.reason})`
        : `${detector.reason} ${vision.reason}`;

  return {
    configured: detector.ok || readerAvailable(),
    available: detector.ok || vision.ok,
    // transient=true 는 "지금 붐빔"이지 "못 쓴다"가 아니다. 편집기가 다시 눌러볼 수 있게 구분한다.
    retryable: Boolean(vision.transient) && !detector.ok,
    engine,
    detector: { ok: detector.ok, reason: detector.reason },
    model: { ok: vision.ok, label: readerAvailable() ? providerLabel() : null, reason: vision.reason },
    reason,
  };
}

// ---------------------------------------------------------- 시야 점검

/**
 * **이 모델이 그림을 실제로 보는지** 확인한다.
 *
 * 왜 필요한가: 게이트웨이(라우터)를 거치면 이미지 블록이 **조용히 버려질 수** 있다.
 * 그러면 모델은 그림을 못 본 채로 "대치동 989-11 신축공사 3층" 같은 그럴듯한
 * 도면을 지어내고, 신뢰도까지 high 로 보고한다. 실제로 monogpt 라우터에서 그랬다.
 *
 * 이건 이 앱에서 **최악의 실패**다. 판독이 안 되는 것보다, 안 된 걸 모른 채
 * 지어낸 대피 경로를 저장하는 쪽이 훨씬 위험하다. 시각장애인이 없는 비상구로 걸어간다.
 *
 * 판별법은 글자 인식이 아니라 **토큰 수 비교**다. 같은 질문을 그림을 붙여서 한 번,
 * 안 붙이고 한 번 보내 input_tokens 를 견준다. 그림이 전달됐다면 반드시 늘어난다.
 * 모델이 그림을 얼마나 잘 읽는지와 무관하게, 전달 여부만 정확히 가린다.
 */
let visionProbe = null;   // { ok, reason } — 프로세스 살아 있는 동안 재사용

/**
 * 256×256 점검용 PNG (흰 바탕 · 파란 사각형 · 노란 원).
 *
 * 단색 이미지를 쓰면 안 된다 — 제미나이가 "Unable to process input image" 로 거절한다.
 * 모양이 있어야 정상적인 사진으로 취급된다.
 */
const PROBE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAEKklEQVR4nO3dwW0TQRSAYYxSAiVQDgeK4UAJHCiGA+VQAj0YISQUFECWvWPPzP9958T7Rnr/7kY5+HQ+n19B1etHDwCPJADSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApD2NvsDpdBp9CfZ2HvkVFp4ApAmANAGQNvxvgOfevP96z8uxru9f3t3nQp4ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBECaAEgTAGkCIE0ApAmANAGQJgDSBEDa06MHaPn28cMlP/b20+fxs/CTAGZZ+n/9ihiGEsBEe///z1HCCAKYd/X/+rEyOJYAFlj9l5eQwVEEsMzqv7ycDG4ngMVW/+WlZXAL/wdYdfunmmFdAthh8+aZZDlegTZZOK9D1/EE2GH7l5htTgLYbcPmn3AqAthwt1aZcwYC2HOr1pr2gQRAmgC2vaGuOPP9CWDnTVp38rsRwOY7tPr8owmANAHsf/vc4xSDCIA0ASRunDud5VgCIE0AlVvmfic6hABIE0DoZrnruW4hANIEQJoAWu8Je5/uCgIgTQCkCYA0AeRekQtnvJwASBMAaQIgTQCkCYA0AZAmANIEQJoASBMAaQIgTQCkCeAPha8cLZzxcgIgTQCkCYA0AbRekfc+3RUEQJoASBNA6D1h13PdQgCkCaBys9zvRIcQAGkCSNwydzrLsQRAmgD2v3HucYpBBECaADa/fa4+/2gC2HmH1p38bgSw7SatOPP9CYA0Aex5Q11r2gcSwIZbtcqcMxDAbrs1/4RTEcBWGzbzbHN6evQAS/q1Z1N92ZbVv44nwA47N88kyxHA8ps3wwzr8gq08OuQ1b+dAJbMwOofRQCLZWD1jyWAZTKw+iMIYJTf+3pjCfZ+KAEM93yDL4zB0t+NAO7KZs/G/wFIEwBpAiBNAKQJgDQBkCYA0gRAmgBIEwBpAiBNAKQJgDQBkCYA0gRAmgBIEwBpAiBNAKQJgDQBkCYA0gRAmgBIEwBpAiBNAKQJgDQBkCYA0gRAmgBIEwBpAiBNAKQJgDQBkCYA0gRAmgBIEwBpAiBNAKQJgDQBkCYA0gRAmgBIEwBpAiBNAKQJgLTT+Xwee4HTaejns73zyBX1BCBNAKQJgLThfwPAzDwBSBMAaQIgTQCkCYA0AZAmANIEQJoASBMAaQIgTQCkCYA0AZAmANIEQJoASBMAaQIgTQCkCYA0AZAmANIEQJoASBMAaQIgTQCkCYA0AfCq7Ac4FbFRfu5foQAAAABJRU5ErkJggg==';

async function inputTokensFor(parts) {
  const { inputTokens } = await provider().send(parts, { maxTokens: 1 });
  return inputTokens;
}

export async function checkVision({ force = false } = {}) {
  if (visionProbe && !force) return visionProbe;
  if (!readerAvailable()) return (visionProbe = { ok: false, reason: '판독 키가 설정되지 않았습니다.' });

  const q = [{ kind: 'text', text: '이 그림의 색은?' }];
  try {
    const [withoutImg, withImg] = await Promise.all([
      inputTokensFor(q),
      inputTokensFor([{ kind: 'image', mediaType: 'image/png', base64: PROBE_PNG }, ...q]),
    ]);

    if (withoutImg === null || withImg === null) {
      return (visionProbe = { ok: true, reason: '토큰 정보를 주지 않아 시야를 확인하지 못했습니다. 판독 결과를 특히 꼼꼼히 확인하세요.' });
    }
    if (withImg <= withoutImg) {
      return (visionProbe = {
        ok: false,
        reason: `연결된 모델(${providerLabel()})이 이미지를 받지 못합니다. `
          + `게이트웨이가 그림을 버리고 있어(토큰 ${withoutImg} → ${withImg}), 판독하면 **도면을 지어냅니다.** `
          + `이미지를 지원하는 키·모델로 바꾸거나, 지금은 손으로 그려주세요.`,
      });
    }
    return (visionProbe = { ok: true, reason: `이미지 전달 확인됨 (토큰 ${withoutImg} → ${withImg})` });
  } catch (err) {
    // 잠깐 붐벼서 난 오류는 **캐시하지 않는다.** 캐시하면 서버를 껐다 켤 때까지
    // 판독이 계속 막힌다 — 실제로 제미나이 503 한 번에 기능이 통째로 죽었다.
    const result = { ok: false, transient: isTransient(err), reason: err.message };
    if (!result.transient) visionProbe = result;
    return result;
  }
}

/**
 * 도면 사진을 읽어 그래프 초안을 만든다.
 *
 * @param dataUri  data:image/...;base64,... (편집기가 축소해서 보낸 것)
 * @param size     { width, height } 이미지 픽셀 크기 — 좌표를 픽셀로 되돌릴 때 쓴다
 * @returns {Promise<{nodes, edges, confidence, notes, buildingName, floorLabel, warnings}>}
 * @throws 키가 없거나 API 가 실패하면 message 에 사람이 읽을 이유가 담긴다
 */
export async function readPlanFromImage(dataUri, size = {}) {
  const parsed = parseDataUri(dataUri);
  if (!parsed) {
    throw Object.assign(new Error('이미지 데이터 URI 형식이 아닙니다.'), { status: 400 });
  }

  // 탐지기를 먼저 돌린다. 좌표가 정확한 쪽이 지점을 잡아야 언어모델이 그 위에
  // 이름과 통로만 얹을 수 있다. 순서가 반대면 언어모델의 눈대중 좌표가 기준이 된다.
  const detected = await detectSymbols(dataUri);
  const hasReader = readerAvailable();

  if (!detected && !hasReader) {
    const health = await detectorHealth();
    throw Object.assign(
      new Error(
        `자동 판독을 쓸 수 없습니다. ${health.reason} `
        + 'AI 판독 키(GOOGLE_API_KEY 또는 ANTHROPIC_API_KEY)를 설정하거나 ml/detector 를 실행하세요. '
        + '손으로 그리기는 그대로 쓸 수 있습니다.',
      ),
      { status: 501 },
    );
  }

  if (!detected) return await readWithModelOnly(parsed, size);
  return await readWithDetector(detected, parsed, size, hasReader);
}

/** 예전 경로 — 탐지기 없이 언어모델이 좌표까지 전부 읽는다 */
async function readWithModelOnly(parsed, size) {
  // 그림이 모델에 닿지 않으면 판독을 **시작하지 않는다.**
  // 못 본 채로 지어낸 도면이 돌아오면 사람이 알아채기 어렵다 — 그럴듯하기 때문이다.
  const vision = await checkVision();
  if (!vision.ok) throw Object.assign(new Error(vision.reason), { status: 503 });

  const { toolInput: draft } = await provider().send(
    [
      { kind: 'image', mediaType: parsed.mediaType, base64: parsed.base64 },
      { kind: 'text', text: PROMPT },
    ],
    { tool: { name: TOOL.name, description: TOOL.description, schema: TOOL.input_schema } },
  );
  if (!draft) {
    throw Object.assign(new Error('판독 결과를 받지 못했습니다.'), { status: 502 });
  }
  assertIsPlan(draft);

  const out = sanitize(draft, size);
  out.engine = `언어모델 단독 (${providerLabel()})`;
  out.warnings.unshift('기호 탐지기가 꺼져 있어 좌표까지 언어모델이 읽었습니다. 지점 위치가 실제와 어긋날 수 있으니 특히 꼼꼼히 확인하세요.');
  return out;
}

/**
 * 탐지기가 찍은 지점 위에 이름·통로를 얹는다.
 *
 * 언어모델이 있으면 그쪽에 맡기고, 없으면 기하학적으로 추정한다(graph.js).
 * 언어모델 호출이 실패해도 **탐지 결과는 버리지 않는다** — 지점만이라도 남으면
 * 사람이 통로만 그리면 되고, 그게 아무것도 없는 것보다 훨씬 빠르다.
 */
async function readWithDetector(detected, parsed, size, hasReader) {
  const { nodes, roomBoxes, warnings } = nodesFromDetections(detected.detections);

  if (!nodes.length) {
    throw Object.assign(
      new Error(
        detected.rawCount
          ? `기호를 ${detected.rawCount}개 찾았지만 확신이 낮아 모두 걸렀습니다. 도면이 화면을 가득 채우도록 정면에서 다시 찍어주세요.`
          : '피난안내도에서 기호를 찾지 못했습니다. 층 평면도가 나온 사진인지, 초점이 맞았는지 확인해주세요.',
      ),
      { status: 422 },
    );
  }

  const detectorNote = `기호 ${nodes.length}곳을 탐지기가 찾았습니다`;

  if (hasReader) {
    const vision = await checkVision();
    if (vision.ok) {
      try {
        const { toolInput: refined } = await provider().send(
          [
            { kind: 'image', mediaType: parsed.mediaType, base64: parsed.base64 },
            { kind: 'text', text: refinePrompt(nodes) },
          ],
          {
            tool: {
              name: REFINE_TOOL.name,
              description: REFINE_TOOL.description,
              schema: REFINE_TOOL.input_schema,
            },
          },
        );
        if (refined) {
          assertIsPlan(refined);
          const merged = applyRefinement(nodes, refined);
          const out = sanitize(merged, size);
          out.engine = `기호 탐지기 + ${providerLabel()}`;
          // 언어모델이 이름을 달았으므로 "번호로만 붙었다" 경고는 뺀다.
          // 남겨두면 사람이 이미 해결된 일을 찾아 헤맨다.
          out.warnings = dedupe([
            ...warnings.filter(w => !w.includes('장소 이름은 번호로만')),
            ...out.warnings,
          ]);
          out.notes = [detectorNote, out.notes].filter(Boolean).join(' · ');
          return out;
        }
      } catch (err) {
        // 언어모델이 실패해도 탐지 결과로 계속 간다. 사람은 통로만 그리면 된다.
        warnings.push(`이름·통로를 언어모델에 맡기려 했으나 실패했습니다 (${err.message}). 탐지된 지점만 담았습니다.`);
      }
    } else {
      warnings.push(`언어모델이 그림을 받지 못해 이름·통로를 맡기지 못했습니다. ${vision.reason}`);
    }
  }

  // 언어모델이 없거나 실패했다 — 통로를 기하학적으로 추정한다
  const inferred = inferCorridorEdges(nodes, roomBoxes);
  const out = sanitize({ nodes: inferred.nodes, edges: inferred.edges }, size);
  out.engine = '기호 탐지기 단독';
  out.confidence = 'low';   // 통로가 추정이라 높게 말할 수 없다
  out.warnings = dedupe([...warnings, ...inferred.warnings, ...out.warnings]);
  out.notes = detectorNote;
  return out;
}

/** 같은 경고를 두 번 읽게 하지 않는다 — 목록이 길어지면 진짜 문제가 묻힌다 */
const dedupe = list => [...new Set(list)];

/** 탐지 지점 + 언어모델이 읽은 이름·추가 지점·통로를 하나로 합친다 */
function applyRefinement(nodes, refined) {
  const byId = new Map(nodes.map(n => [n.id, { ...n }]));

  for (const r of refined.renames || []) {
    const node = byId.get(String(r.id));
    if (!node) continue;                       // 없는 지점을 가리키면 무시
    if (r.name?.trim()) node.name = String(r.name).trim();
    // 유형은 언어모델이 명백한 오탐만 고치도록 했다. 좌표는 절대 덮어쓰지 않는다.
    if (r.type && NODE_TYPES.includes(r.type)) node.type = r.type;
  }

  for (const n of refined.extraNodes || []) {
    if (!n?.id || byId.has(String(n.id))) continue;
    byId.set(String(n.id), n);
  }

  return {
    ...refined,
    nodes: [...byId.values()],
    edges: refined.edges || [],
  };
}

function assertIsPlan(draft) {
  if (draft.isEvacuationPlan === false) {
    throw Object.assign(
      new Error('피난안내도로 보이지 않습니다. 층 평면도가 나온 사진인지 확인해주세요.'),
      { status: 422 },
    );
  }
}

// ---------------------------------------------------------- 정리·검증

/**
 * 판독 결과를 편집기가 그대로 쓸 수 있는 형태로 고친다.
 *
 * 모델이 형식을 지켰더라도 **내용이 어긋날 수 있다** — 없는 노드를 가리키는 간선,
 * 범위를 벗어난 좌표, 겹친 id. 편집기에 그대로 넣으면 화면이 깨지므로 여기서 막고,
 * 무엇을 버렸는지 warnings 로 사람에게 알린다. 조용히 고치면 사람이 검수할 수 없다.
 */
function sanitize(draft, size) {
  const warnings = [];
  const W = Number(size.width) || 1000;
  const H = Number(size.height) || 1000;

  const seen = new Set();
  const nodes = [];
  for (const n of draft.nodes || []) {
    if (!n?.id || seen.has(n.id)) { warnings.push(`중복되거나 id 없는 지점을 버렸습니다.`); continue; }
    const x = Number(n.x), y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { warnings.push(`좌표가 없는 지점 ${n.id} 을 버렸습니다.`); continue; }
    seen.add(n.id);
    nodes.push({
      id: String(n.id),
      name: String(n.name || n.id),
      // 편집기는 이미지 픽셀 좌표를 쓴다 (metersPerUnit 으로 실제 거리를 환산)
      x: Math.round(clamp01(x) * W * 100) / 100,
      y: Math.round(clamp01(y) * H * 100) / 100,
      type: NODE_TYPES.includes(n.type) ? n.type : 'junction',
    });
  }

  const edgeIds = new Set();
  const edges = [];
  for (const e of draft.edges || []) {
    if (!seen.has(e?.a) || !seen.has(e?.b) || e.a === e.b) {
      warnings.push(`양 끝이 맞지 않는 통로를 버렸습니다 (${e?.a} - ${e?.b}).`);
      continue;
    }
    const id = String(e.id || `E${edges.length + 1}`);
    if (edgeIds.has(id)) continue;
    edgeIds.add(id);
    edges.push({
      id, a: String(e.a), b: String(e.b),
      wall: e.wall === 'left' || e.wall === 'right' ? e.wall : null,
    });
  }

  // 대피 목표가 되는 건 exit 뿐이다(shared/floor-plan.js 의 exitNodes).
  // 비상계단을 stair 로 찍어 오는 일이 잦은데, 그대로 두면 저장 검증에서 거부되거나
  // 갈 곳 없는 도면이 된다. 승격시키되 **반드시 알린다** — 옥상 전용 계단처럼
  // 대피에 못 쓰는 것이 섞였을 수 있고, 그건 사람만 판단할 수 있다.
  if (!nodes.some(n => n.type === 'exit')) {
    const stairs = nodes.filter(n => n.type === 'stair');
    if (stairs.length) {
      stairs.forEach(n => { n.type = 'exit'; });
      warnings.push(`계단 ${stairs.length}곳을 출구로 표시했습니다(${stairs.map(n => n.name).join(', ')}). 대피에 쓸 수 없는 계단이면 유형을 바꿔주세요.`);
    } else {
      warnings.push('출구를 하나도 찾지 못했습니다. 비상구·계단을 직접 표시해주세요.');
    }
  }

  if (!nodes.some(n => n.type === 'room')) {
    warnings.push('방을 하나도 찾지 못했습니다. 시각장애인이 대피 시작 위치를 고를 목록이 비게 되니 직접 넣어주세요.');
  }
  if (!edges.length && nodes.length > 1) {
    warnings.push('통로를 잇지 못했습니다. 지점끼리 직접 연결해주세요.');
  }

  return {
    nodes, edges, warnings,
    confidence: draft.confidence || 'low',
    notes: String(draft.notes || ''),
    buildingName: String(draft.buildingName || ''),
    floorLabel: String(draft.floorLabel || ''),
  };
}

const clamp01 = v => Math.min(1, Math.max(0, v));

function parseDataUri(uri) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/i.exec(uri || '');
  if (!m) return null;
  const mediaType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  return { mediaType, base64: m[2] };
}
