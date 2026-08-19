// 접근성 계약: **시각장애인이 쓰는 화면이 스크린리더에게 하는 약속을 지키는가.**
//
// ## 왜 이 시험이 있나
//
// 라벨이 빠진 버튼을 VoiceOver 는 "버튼" 이라고만 읽는다. 화재 경보 화면에서
// 그 소리를 들은 시각장애인은 무슨 버튼인지 모른 채 서 있게 된다. 그리고 라벨은
// **화면을 고칠 때마다 조용히 빠진다** — 눈으로 보면 멀쩡해 보이기 때문이다.
// 사람이 매번 확인할 수 없으므로 시험이 대신 지킨다.
//
// ## 왜 앱을 띄우지 않고 소스를 읽나
//
// `mobile/` 에는 테스트 설정이 없다(jest 도 없다). 런타임 테스트를 세우려면
// 설정과 모킹에 하루가 드는데, 시연이 걸린 상태에서 그 위험을 질 이유가 없다.
// 소스를 읽는 검사는 저장소의 기존 시험 무리에 그냥 붙고, **"빠뜨림" 은 100%
// 잡는다.**
//
// ## 문자열을 긁지 않고 문법 나무를 쓴다
//
// 처음에 정규식으로 세어 봤다가 방금 만든 화면이 "라벨 4개 전부 없음" 으로
// 나왔다. 원인은 이것이다:
//
//     style={({ pressed }) => [styles.start, pressed && styles.startPressed]}
//
// 화살표 함수의 `=>` 안에 `>` 가 있어서 정규식이 거기를 태그 끝으로 착각하고
// 잘라 버렸다. 접근성 검사가 거짓말을 하면 안 하느니만 못하므로 파서를 쓴다.
//
// ## 이 시험이 못 잡는 것
//
//   초점 순서        라벨은 다 있는데 순서가 엉켜 대피 버튼이 맨 뒤로 가는 경우
//   런타임 빈 라벨   `accessibilityLabel={name}` 인데 name 이 실제로 빈 문자열
//
// 둘 다 소스에는 안 보인다. 사람이 눈을 감고 써봐야 나온다(`docs/blind-walkthrough.md`).
// **이 시험이 잡는 것은 "빠뜨림" 이고, 사람이 잡는 것은 "이상함" 이다.**

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCREENS = path.join(root, 'mobile', 'src', 'screens');

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

/**
 * 시각장애인이 쓰는 화면과 그 화면에 요구하는 것.
 *
 *   labels   누를 수 있는 것마다 이름과 종류
 *   live     상태가 바뀌면 알린다 (live region 또는 announce 호출)
 *   summary  그림을 요약해 읽어 준다 (지도처럼 볼 수 없는 것)
 */
const BLIND_SCREENS = {
  'HomeScreen.js': { labels: true, live: true },
  'GuideScreen.js': { labels: true, live: true },
  'AlarmScreen.js': { labels: true, live: true },
  'StartScreen.js': { labels: true, live: true },
  'PositionMap.js': { labels: true, live: false, summary: true },
};

/**
 * 측량하는 사람이 쓰는 화면. 시각장애인 대상이 아니므로 계약을 요구하지 않는다.
 *
 * **이 목록은 면제가 아니라 선언이다.** 새 화면이 조용히 빠지지 않도록, 두 목록
 * 어디에도 없는 화면이 있으면 시험이 실패한다.
 */
const TOOL_SCREENS = [
  'CaptureScreen.js', 'ReviewScreen.js', 'SubmitScreen.js',
  'FieldScreen.js', 'LiveScreen.js', 'MagScreen.js', 'MagSurveyScreen.js',
  'NorthScreen.js',
];

/** 누를 수 있는 것으로 보는 태그 */
const TAPPABLE = new Set([
  'Pressable', 'TouchableOpacity', 'TouchableHighlight',
  'TouchableWithoutFeedback', 'Button',
]);

/** 손가락이 닿아야 하는 최소 크기(pt). 애플·구글 권장의 하한. */
const MIN_TOUCH = 44;

function ast(file) {
  return parse(readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['jsx'],
  });
}

/** 문법 나무를 훑으며 조건에 맞는 마디를 모은다 */
function walk(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (typeof node.type === 'string') visit(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach(c => walk(c, visit, seen));
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit, seen);
  }
}

function tagName(el) {
  const n = el.openingElement?.name;
  if (!n) return null;
  if (n.type === 'JSXIdentifier') return n.name;
  // <Animated.View> 같은 것은 뒤쪽 이름을 쓴다
  if (n.type === 'JSXMemberExpression') return n.property?.name ?? null;
  return null;
}

function attrs(el) {
  const out = new Map();
  for (const a of el.openingElement?.attributes ?? []) {
    if (a.type === 'JSXAttribute' && a.name?.type === 'JSXIdentifier') out.set(a.name.name, a);
  }
  return out;
}

/** `StyleSheet.create({...})` 안의 숫자 높이를 모은다 — 손가락 크기 검사용 */
function styleHeights(tree) {
  const heights = new Map();
  walk(tree, node => {
    if (node.type !== 'CallExpression') return;
    const c = node.callee;
    if (c?.type !== 'MemberExpression') return;
    if (c.object?.name !== 'StyleSheet' || c.property?.name !== 'create') return;
    const obj = node.arguments?.[0];
    if (obj?.type !== 'ObjectExpression') return;
    for (const prop of obj.properties) {
      if (prop.type !== 'ObjectProperty' || prop.value?.type !== 'ObjectExpression') continue;
      const key = prop.key?.name ?? prop.key?.value;
      for (const p of prop.value.properties) {
        if (p.type !== 'ObjectProperty') continue;
        const n = p.key?.name ?? p.key?.value;
        if ((n === 'height' || n === 'minHeight') && p.value?.type === 'NumericLiteral') {
          const prev = heights.get(key);
          // minHeight 와 height 가 함께 있으면 큰 쪽이 실제로 닿는 크기다
          heights.set(key, prev === undefined ? p.value.value : Math.max(prev, p.value.value));
        }
      }
    }
  });
  return heights;
}

/** `style={styles.foo}` / `style={[styles.foo, ...]}` 에서 styles 키 이름을 뽑는다 */
function styleKeys(attr) {
  const keys = [];
  if (!attr?.value || attr.value.type !== 'JSXExpressionContainer') return keys;
  walk(attr.value.expression, node => {
    if (node.type === 'MemberExpression'
        && (node.object?.name === 'styles' || node.object?.name === 's')
        && node.property?.name) {
      keys.push(node.property.name);
    }
  });
  return keys;
}

// ── 화면 목록이 빠짐없이 선언돼 있는가 ────────────────────────────────────
//
// 새 화면을 만들고 목록에 안 넣으면 계약을 안 지켜도 시험이 통과해 버린다.
// 그 조용한 통과가 제일 위험하다 — 아무도 모르는 채로 시각장애인이 막힌다.
{
  const files = readdirSync(SCREENS).filter(f => f.endsWith('.js'));
  const declared = new Set([...Object.keys(BLIND_SCREENS), ...TOOL_SCREENS]);
  const undeclared = files.filter(f => !declared.has(f));
  expect('모든 화면이 두 목록 중 하나에 선언돼 있다', undeclared.length === 0,
    undeclared.length ? `선언 안 된 화면: ${undeclared.join(', ')}` : `${files.length}개`);

  const missing = [...declared].filter(f => !files.includes(f));
  expect('목록에만 있고 실제로 없는 화면이 없다', missing.length === 0,
    missing.length ? missing.join(', ') : '');
}

// ── 화면별 계약 ───────────────────────────────────────────────────────────
for (const [file, need] of Object.entries(BLIND_SCREENS)) {
  const full = path.join(SCREENS, file);
  let tree;
  try {
    tree = ast(full);
  } catch (e) {
    expect(`${file} 파싱`, false, e.message);
    continue;
  }

  const heights = styleHeights(tree);
  const unlabeled = [];
  const unroled = [];
  const tooSmall = [];
  let taps = 0;
  let live = false;
  let summary = false;

  walk(tree, node => {
    if (node.type !== 'JSXElement') return;
    const tag = tagName(node);
    if (!tag) return;
    const a = attrs(node);

    if (a.has('accessibilityLiveRegion')) live = true;
    // 지도처럼 볼 수 없는 것은 요약 라벨로 대신한다
    if (a.has('accessibilityLabel') && !TAPPABLE.has(tag)) summary = true;

    if (!TAPPABLE.has(tag)) return;
    taps++;
    const line = node.loc?.start?.line ?? '?';
    if (!a.has('accessibilityLabel')) unlabeled.push(line);
    if (!a.has('accessibilityRole')) unroled.push(line);

    // 손가락이 닿는 크기 — 명시된 높이가 하한보다 작을 때만 잡는다.
    // 높이를 안 준 것은 부모가 정하므로 소스만으로는 알 수 없다.
    for (const k of styleKeys(a.get('style'))) {
      const h = heights.get(k);
      if (h !== undefined && h < MIN_TOUCH) tooSmall.push(`${line}행 styles.${k}=${h}pt`);
    }
  });

  // `say()` / `announce()` 도 상태를 알리는 길이다 — live region 만 세면
  // 음성으로 알리는 화면이 억울하게 실패한다.
  let announces = false;
  walk(tree, node => {
    if (node.type === 'CallExpression'
        && (node.callee?.name === 'say' || node.callee?.name === 'speak')) announces = true;
  });

  if (need.labels) {
    expect(`${file} — 누를 수 있는 것마다 이름`, unlabeled.length === 0,
      unlabeled.length ? `${unlabeled.length}개 누락 (${unlabeled.join(', ')}행)` : `${taps}개 전부`);
    expect(`${file} — 누를 수 있는 것마다 종류`, unroled.length === 0,
      unroled.length ? `${unroled.length}개 누락 (${unroled.join(', ')}행)` : `${taps}개 전부`);
    expect(`${file} — 손가락이 닿는 크기 ${MIN_TOUCH}pt 이상`, tooSmall.length === 0,
      tooSmall.length ? tooSmall.join(' · ') : '');
  }
  if (need.live) {
    expect(`${file} — 상태가 바뀌면 알린다`, live || announces,
      live ? 'live region' : announces ? '음성 안내' : 'live region 도 음성도 없음');
  }
  if (need.summary) {
    expect(`${file} — 볼 수 없는 것을 요약해 읽어 준다`, summary,
      summary ? '' : 'accessibilityLabel 을 가진 요소가 없음');
  }
}

console.log(failed === 0 ? '\n접근성 계약 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
