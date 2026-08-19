/**
 * 홈 — **시각장애인이 앱을 열었을 때 처음 만나는 화면.**
 *
 * ## 왜 만들었나
 *
 * 예전에는 앱을 열면 도면 촬영 화면이 떴다(`App.js` 의 기본 PHASE 가 CAPTURE 였다).
 * 카메라가 켜지고, 거기 있는 버튼은 자기장 측정·현장 측정·답사 같은 **측량하는
 * 사람의 도구**였다. 대피 안내는 서버가 화재를 알려야 끼어들었다.
 *
 * 즉 이 앱은 측량 도구가 본체이고 대피가 손님이었다. 라벨을 아무리 달아도
 * 시각장애인은 첫 화면에서 막힌다. 그래서 순서를 뒤집는다 — **대피가 본체이고
 * 측량이 손님이다.**
 *
 * ## 화면에 두 가지만 둔다
 *
 *     대피 시작        화면의 3분의 2. 첫 초점. 여기만 누르면 안내가 시작된다
 *     지금 여기        비콘이 판정한 지점. 확정된 순간에만 읽어 준다
 *
 * 측량 도구는 아래에 접어 둔다. 한 번 누르면 열린다(두 번이 아니다) — 지금은
 * 측량이 주 작업이라 매번 두 단계를 요구하면 만드는 사람이 지친다.
 *
 * ## 위치를 묻지 않는다
 *
 * 목록에서 자기 방 이름을 찾는 일은 눈으로는 1초지만 스크린리더로는 수십 번의
 * 탭이다. 화재 상황에서 그 시간을 쓰게 해서는 안 된다. 비콘이 이미 답을 알고
 * 있으므로 묻지 않고 **말해 준다.** 비콘이 없는 건물을 위한 목록 선택은
 * 폴백으로만 남는다(`StartScreen`, 위치를 못 찾았을 때만 열린다).
 *
 * 확정 전 잠정값은 **알리지 않는다.** 첫 몇 초의 값은 흔들릴 수 있는데 그때마다
 * 음성이 나가면 "여기다 저기다" 하는 꼴이 된다. 서버는 판정이 선 순간에만
 * `fix` 를 내주므로, 들어온 것은 이미 확정된 값이다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo, findNodeHandle, Pressable, ScrollView,
  StyleSheet, Text, View,
} from 'react-native';

import { say } from '../announce';
import { theme } from '../theme';

/** 비콘 판정을 물어보는 주기. 홈에서는 안내 화면만큼 급하지 않다. */
const FIX_MS = 1500;

/** 측량 도구 — 시각장애인 흐름 뒤에 온다 */
const TOOLS = [
  // 맨 앞에 둔다 — 이 값이 없으면 방향 안내가 통째로 꺼진다
  { key: 'north', label: '북쪽 잡기 (5초)', hint: '도면 위쪽이 실제 몇 도인지 서서 잽니다. 이 값이 없으면 방향 안내가 꺼집니다' },
  { key: 'capture', label: '도면 촬영', hint: '피난안내도를 찍어 대피 경로를 만듭니다' },
  { key: 'live', label: '실시간 위치', hint: '전파만으로 위치가 잡히는지 확인합니다' },
  { key: 'field', label: '현장 측정', hint: '보폭·축척·북쪽을 실측합니다' },
  { key: 'magcheck', label: '자기장 확인', hint: '지자기를 측위에 쓸 수 있는지 재봅니다' },
  { key: 'magsurvey', label: '자기장 답사', hint: '통로를 걸으며 자기장 무늬를 남깁니다' },
];

export default function HomeScreen({ api, plan, online, onStartEvac, onTool, onSimulateFire }) {
  const [fix, setFix] = useState(null);
  const [scanner, setScanner] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);

  const startRef = useRef(null);
  const spoken = useRef(null);

  // 스크린리더의 첫 초점을 «대피 시작» 에 놓는다.
  //
  // 이게 없으면 초점이 화면 맨 위(제목)에서 시작해, 시각장애인은 대피 버튼에
  // 닿기까지 몇 번을 더 넘겨야 한다. 화재 상황에서 그 몇 번이 곧 시간이다.
  useEffect(() => {
    const t = setTimeout(() => {
      const tag = findNodeHandle(startRef.current);
      if (tag) AccessibilityInfo.setAccessibilityFocus(tag);
    }, 400);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const got = await api?.getBeaconFix?.().catch(() => null);
      if (!alive || !got) return;
      setScanner(Boolean(got.scanner));
      setFix(got.fix ?? null);

      // 지점이 바뀐 순간에만 말한다. 같은 자리에서 계속 말하면 주변 소리를 덮는데,
      // 시각장애인에게 주변 소리는 시야에 해당한다.
      const nodeId = got.fix?.nodeId;
      if (nodeId && nodeId !== spoken.current) {
        spoken.current = nodeId;
        say(`지금 여기, ${nameOf(plan, nodeId)}`);
      }
    };
    tick();
    const t = setInterval(tick, FIX_MS);
    return () => { alive = false; clearInterval(t); };
  }, [api, plan]);

  const here = fix?.nodeId ? nameOf(plan, fix.nodeId) : null;

  // 「지금 여기」 한 줄 — 안 될 때 **왜** 안 되는지가 바로 읽혀야 한다.
  const where = here
    ? { text: here, sub: `전파로 확정 · ${fix.rssi} dBm`, tone: 'ok' }
    : scanner
      ? { text: '위치를 찾는 중', sub: '답사한 지점 근처로 가 보세요', tone: 'warn' }
      : { text: '위치를 모릅니다', sub: '대피 시작을 누르면 목록에서 고를 수 있습니다', tone: 'warn' };

  const startLabel = here ? `대피 시작. 현재 위치 ${here}` : '대피 시작';

  const openTools = useCallback(() => setToolsOpen(v => !v), []);

  return (
    <View style={styles.root}>
      {/* 화면의 3분의 2. 이 앱에서 제일 큰 것이 제일 중요한 것이어야 한다. */}
      <Pressable
        ref={startRef}
        style={({ pressed }) => [styles.start, pressed && styles.startPressed]}
        onPress={onStartEvac}
        accessibilityRole="button"
        accessibilityLabel={startLabel}
        accessibilityHint="가장 가까운 출구까지 소리와 진동으로 안내합니다">
        <Text style={styles.startTitle}>대피 시작</Text>
        <Text style={styles.startSub}>
          {here ? `${here}에서 출발합니다` : '누르면 위치를 찾습니다'}
        </Text>
      </Pressable>

      {/* 비콘이 말해 주는 현재 위치. 확정된 것만 들어온다. */}
      <View
        style={[styles.here, styles[`tone_${where.tone}`]]}
        accessibilityLiveRegion="polite"
        accessibilityRole="text"
        accessibilityLabel={`지금 여기, ${where.text}. ${where.sub}`}>
        <Text style={styles.hereLabel}>지금 여기</Text>
        <Text style={styles.hereText}>{where.text}</Text>
        <Text style={styles.hereSub}>{where.sub}</Text>
      </View>

      {/* 측량 도구 — 한 번 누르면 열린다. 시각장애인 흐름의 뒤에 온다. */}
      <Pressable
        style={styles.toolsToggle}
        onPress={openTools}
        accessibilityRole="button"
        accessibilityState={{ expanded: toolsOpen }}
        accessibilityLabel="측량 도구"
        accessibilityHint="도면 촬영과 측정 도구를 엽니다. 대피에는 필요하지 않습니다">
        <Text style={styles.toolsToggleText}>
          {toolsOpen ? '▾ 측량 도구' : '▸ 측량 도구'}
        </Text>
        <Text style={styles.status}>{online ? '서버 연결됨' : '서버 없음'}</Text>
      </Pressable>

      {toolsOpen && (
        <ScrollView style={styles.tools} contentContainerStyle={styles.toolsInner}>
          {TOOLS.map(t => (
            <Pressable
              key={t.key}
              style={styles.tool}
              onPress={() => onTool?.(t.key)}
              accessibilityRole="button"
              accessibilityLabel={t.label}
              accessibilityHint={t.hint}>
              <Text style={styles.toolText}>{t.label}</Text>
            </Pressable>
          ))}
          <Pressable
            style={[styles.tool, styles.toolDanger]}
            onPress={onSimulateFire}
            accessibilityRole="button"
            accessibilityLabel="화재 시뮬레이션"
            accessibilityHint="시연용입니다. 실제 화재가 아닙니다">
            <Text style={styles.toolText}>화재 시뮬레이션 (시연용)</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

function nameOf(plan, nodeId) {
  return plan?.nodes?.find(n => n.id === nodeId)?.name || nodeId;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 14, gap: 12 },

  // 화면의 3분의 2. 눈을 감고도 «어딘가는 눌린다» 여야 한다.
  start: {
    flex: 2,
    minHeight: 220,
    backgroundColor: theme.danger,
    borderRadius: theme.radius,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  startPressed: { opacity: 0.85 },
  startTitle: { color: '#fff', fontSize: 44, fontWeight: '900', letterSpacing: 1 },
  startSub: { color: 'rgba(255,255,255,0.9)', fontSize: 16, textAlign: 'center', paddingHorizontal: 16 },

  here: {
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 16,
    borderLeftWidth: 4,
    minHeight: 96,
    justifyContent: 'center',
  },
  tone_ok: { borderLeftColor: theme.ok },
  tone_warn: { borderLeftColor: theme.warn },
  hereLabel: { color: theme.textDim, fontSize: 13 },
  hereText: { color: theme.text, fontSize: 26, fontWeight: '800', marginTop: 2 },
  hereSub: { color: theme.textDim, fontSize: 14, marginTop: 4 },

  toolsToggle: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  toolsToggleText: { color: theme.textDim, fontSize: 16 },
  status: { color: theme.textDim, fontSize: 12 },

  tools: { maxHeight: 260 },
  toolsInner: { gap: 8, paddingBottom: 8 },
  tool: {
    minHeight: 56,
    backgroundColor: theme.surface,
    borderRadius: 12,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  toolDanger: { borderWidth: 1, borderColor: theme.danger },
  toolText: { color: theme.text, fontSize: 16 },
});
