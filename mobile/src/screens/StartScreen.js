/**
 * 시작 위치 — **위치를 못 찾았을 때만** 나오는 화면.
 *
 * 평소에는 이 화면이 안 나온다. `src/locator.js` 가 비콘으로 위치를 알아내
 * 곧바로 안내가 시작된다. 불난 상황에 시각장애인에게 목록을 훑게 하는 건 말이 안 된다.
 *
 * 그래도 지우지는 않는다. 비콘이 안 잡히는 자리가 반드시 생기고(구석·지하·고장),
 * 그때 아무 지점이나 찍어서 출발하면 엉뚱한 경로가 나온다. **모르면 묻는 게**
 * 모르는 채로 안내하는 것보다 낫다.
 *
 * ## 목록을 소리로 훑는다
 *
 * 시각장애인은 화면의 버튼을 눈으로 찾을 수 없다. 그래서 **한 번에 하나씩 읽어주고**,
 * 화면 위쪽 절반을 누르면 다음 후보로, 아래쪽 절반을 누르면 확정한다.
 * VoiceOver 를 켠 사람은 평소처럼 쓸어넘겨도 되도록 버튼 목록도 그대로 둔다.
 *
 * 큰 목록을 훑는 건 느리므로 **최근에 고른 곳을 맨 앞에** 놓는다. 같은 건물을
 * 매일 쓰는 사람이 대부분이라, 대개 첫 후보에서 끝난다.
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { say, stopSpeaking } from '../announce';
import { chimeGood, chimeLocked } from '../sound';
import { cueLocked } from '../haptics';
import { theme } from '../theme';

export default function StartScreen({ plan, recentId, onPick, onCancel }) {
  // 출구·엘리베이터는 출발점이 될 수 없다. 방이 먼저, 그다음 교차점.
  const places = orderPlaces(plan, recentId);
  const [cursor, setCursor] = useState(0);
  const spoken = useRef(-1);

  useEffect(() => {
    say('위치를 자동으로 찾지 못했습니다. 지금 계신 곳을 골라주세요. '
      + '화면 위쪽을 누르면 다음 장소, 아래쪽을 누르면 선택입니다.',
        { force: true });
    return () => stopSpeaking();
  }, []);

  // 후보가 바뀔 때마다 이름을 읽어준다 — 이게 이 화면의 본체다
  useEffect(() => {
    if (!places.length || spoken.current === cursor) return;
    spoken.current = cursor;
    const p = places[cursor];
    chimeLocked();
    say(`${p.name}. ${cursor + 1} / ${places.length}`, { force: true });
  }, [cursor, places.length]);

  function next() { setCursor(c => (c + 1) % places.length); }
  function confirm() {
    const p = places[cursor];
    if (!p) return;
    chimeGood();
    cueLocked();
    say(`${p.name}에서 대피를 시작합니다.`, { force: true });
    onPick?.(p);
  }

  if (!places.length) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>등록된 장소가 없습니다</Text>
        <Text style={styles.body}>
          도면에 방이 표시돼 있어야 시작 위치를 고를 수 있습니다.
          관리자에게 도면 등록을 요청하세요.
        </Text>
        <Pressable style={styles.cancel} onPress={onCancel}
                   accessibilityRole="button" accessibilityLabel="돌아가기">
          <Text style={styles.cancelText}>돌아가기</Text>
        </Pressable>
      </View>
    );
  }

  const here = places[cursor];

  return (
    <View style={styles.root}>
      {/* 화면을 위·아래로 갈라 큰 표적 두 개로 쓴다. 버튼을 더듬어 찾을 수 없기 때문. */}
      <Pressable
        style={styles.half}
        onPress={next}
        accessibilityRole="button"
        accessibilityLabel="다음 장소 듣기"
      >
        <Text style={styles.eyebrow}>위치를 못 찾았습니다 · 지금 계신 곳은?</Text>
        <Text style={styles.place} numberOfLines={3}>{here.name}</Text>
        <Text style={styles.counter}>{cursor + 1} / {places.length}</Text>
        <Text style={styles.hint}>여기를 누르면 다음 장소</Text>
      </Pressable>

      <Pressable
        style={[styles.half, styles.confirmHalf]}
        onPress={confirm}
        accessibilityRole="button"
        accessibilityLabel={`${here.name}에서 대피 시작`}
        accessibilityHint="이 장소에서 대피 경로를 계산합니다"
      >
        <Text style={styles.confirmText}>여기서 시작</Text>
        <Text style={styles.confirmSub}>{here.name}</Text>
      </Pressable>

      {/* VoiceOver 사용자와 눈이 보이는 동행자를 위한 평범한 목록.
          위 두 표적을 지우면 안 된다 — 반대도 마찬가지다. 이중화를 유지할 것. */}
      <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
        {places.map((p, i) => (
          <Pressable
            key={p.id}
            style={[styles.chip, i === cursor && styles.chipOn]}
            onPress={() => (i === cursor ? confirm() : setCursor(i))}
            accessibilityRole="button"
            accessibilityLabel={p.name}
            accessibilityState={{ selected: i === cursor }}
          >
            <Text style={[styles.chipText, i === cursor && styles.chipTextOn]}>{p.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * 고를 수 있는 장소를 쓸모 순으로 늘어놓는다.
 * 최근에 고른 곳 → 방 → 교차점. 출구·엘리베이터는 출발점이 아니므로 뺀다.
 */
function orderPlaces(plan, recentId) {
  const all = (plan?.nodes || []).filter(
    n => n.type !== 'exit' && n.type !== 'elevator',
  );
  const rank = n => (n.id === recentId ? 0 : n.type === 'room' ? 1 : 2);
  return [...all].sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'ko'));
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  half: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8,
  },
  confirmHalf: {
    backgroundColor: theme.ok,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
  },
  eyebrow: { color: theme.textDim, fontSize: 16, letterSpacing: 1 },
  place: { color: '#fff', fontSize: 40, fontWeight: '800', textAlign: 'center' },
  counter: { color: theme.textDim, fontSize: 15 },
  hint: { color: 'rgba(255,255,255,0.45)', fontSize: 14, marginTop: 6 },
  confirmText: { color: '#052e16', fontSize: 32, fontWeight: '900' },
  confirmSub: { color: '#065f46', fontSize: 17, fontWeight: '600' },
  list: { maxHeight: 92, backgroundColor: theme.surface },
  listInner: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'center' },
  chip: {
    paddingVertical: 12, paddingHorizontal: 16, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  chipOn: { backgroundColor: theme.accent },
  chipText: { color: theme.text, fontSize: 15 },
  chipTextOn: { color: '#fff', fontWeight: '700' },
  title: { color: theme.text, fontSize: 24, fontWeight: '800', textAlign: 'center', marginTop: 80, paddingHorizontal: 24 },
  body: { color: theme.textDim, fontSize: 16, lineHeight: 24, textAlign: 'center', padding: 24 },
  cancel: { alignSelf: 'center', padding: 16 },
  cancelText: { color: theme.textDim, fontSize: 16, textDecorationLine: 'underline' },
});
