/**
 * 북쪽 잡기 — **서서 5초.**
 *
 * ## 왜 급한 도구인가
 *
 * 도면의 `northOffset`(도면 위쪽이 실제 몇 도인가)이 없으면 방향 안내가 통째로
 * 꺼진다. 진동도, 방향 비프도, "왼쪽으로 도세요" 도, 화면의 큰 화살표도 전부
 * 이 값 하나 뒤에 있다. 값이 없으면 안내 화면은 «방향 확인 중» 에서 멈춘다.
 *
 * 이 건물은 그 값을 **한 번도 잰 적이 없다.** 도면 12개 전부 비어 있었다.
 *
 * ## 걷는 방법이 이미 있는데 왜 또 만드나
 *
 * `FieldScreen` 의 축척 측정이 걸으면서 북쪽도 같이 낸다. 정확하지만 두 지점
 * 사이를 실제로 걸어야 하고, 멀리 떨어진 두 지점을 골라야 해서 몇 분이 든다.
 *
 * 이건 **그 자리에서** 잰다. 복도 하나를 향해 서서 5초. 정확도는 조금 떨어지지만
 * (팔로 겨누는 오차 ±10° 쯤) **없는 것보다 비교가 안 되게 낫다.** 지금은 값이
 * 아예 없어서 방향 안내가 0% 동작하는 상태다.
 *
 * ## 원리는 같다
 *
 *     northOffset = (지금 나침반이 말하는 방위) − (도면 안에서 그 방향의 각도)
 *
 * 계산은 `shared/north.js` 의 `northFromWalk` 를 그대로 쓴다 — 걸으며 모은
 * 표본이든 서서 모은 표본이든 하는 일이 같기 때문이다.
 *
 * ## 흔들리면 안 받는다
 *
 * 표본이 45° 넘게 흩어졌으면 값을 내지 않는다. 폰을 든 채 두리번거렸다는 뜻이고,
 * **틀린 값이 굳는 것이 없는 것보다 위험하다** — 없으면 앱이 방향 안내를 접지만
 * 틀린 값은 자신 있게 반대로 보낸다.
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BearingSensor } from '../bearing';
import { northFromWalk, planBearing } from '../north';
import { say } from '../announce';
import { theme } from '../theme';

/** GuideScreen 의 STABILITY_FLOOR 와 같은 값 — 이 아래 표본은 안 쓴다 */
const STABILITY_FLOOR = 0.25;
/** 몇 초 서 있을 것인가 */
const MEASURE_MS = 5000;
const SAMPLE_MS = 150;

export default function NorthScreen({ api, plan, onClose, onSaved }) {
  const sensor = useRef(new BearingSensor()).current;
  const samples = useRef(null);

  const [heading, setHeading] = useState(null);
  const [stability, setStability] = useState(1);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState(false);
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);

  useEffect(() => {
    let alive = true;
    sensor.start();
    const t = setInterval(() => {
      if (!alive) return;
      setHeading(sensor.heading);
      setStability(sensor.stability);
      if (samples.current && sensor.stability >= STABILITY_FLOOR
          && Number.isFinite(sensor.heading)) {
        samples.current.push(sensor.heading);
      }
    }, SAMPLE_MS);
    return () => { alive = false; clearInterval(t); sensor.stop(); };
  }, []);

  const nodes = (plan?.nodes || []).filter(n => Number.isFinite(n.x));
  // 고른 지점에서 이어진 통로만 보여 준다 — 이어지지 않은 두 점을 고르면
  // 그 방향으로 향할 복도가 없어서 잰 값이 뜻을 잃는다.
  const linked = from
    ? nodes.filter(n => n.id !== from
        && (plan?.edges || []).some(e => (e.a === from && e.b === n.id) || (e.b === from && e.a === n.id)))
    : [];

  function start() {
    if (!from || !to) return;
    setResult(null); setSaved(false);
    samples.current = [];
    setLeft(Math.round(MEASURE_MS / 1000));
    say('움직이지 말고 그대로 계세요', { force: true });

    const tick = setInterval(() => setLeft(v => Math.max(0, v - 1)), 1000);
    setTimeout(() => {
      clearInterval(tick);
      const a = nodes.find(n => n.id === from);
      const b = nodes.find(n => n.id === to);
      const got = northFromWalk(samples.current || [], a, b);
      samples.current = null;
      setResult({ ...got, before: plan?.northOffset ?? null });
      say(got.error ? got.error : `도면 위쪽이 ${Math.round(got.offset)}도입니다`, { force: true });
    }, MEASURE_MS);
  }

  async function save() {
    if (!Number.isFinite(result?.offset) || !plan?.id) return;
    const ok = await api?.setPlanNorth?.(plan.id, result.offset,
      `서서 측정 · ${result.samples}표본 · 흔들림 ${Math.round(result.spread)}°`)
      .catch(() => null);
    setSaved(!!ok);
    // 저장만 하면 앱이 손에 든 도면은 옛날 것 그대로다 — 쓰는 쪽에 알려야 한다
    if (ok) await onSaved?.()?.catch?.(() => {});
    say(ok ? '저장했습니다. 방향 안내가 켜집니다.' : '저장하지 못했습니다', { force: true });
  }

  const measuring = left > 0;
  const planDeg = from && to
    ? planBearing(nodes.find(n => n.id === from), nodes.find(n => n.id === to))
    : null;

  return (
    <View style={s.root}>
      <View style={s.top}>
        <Pressable onPress={onClose} style={s.back}
                   accessibilityRole="button" accessibilityLabel="닫기">
          <Text style={s.backTx}>‹ 닫기</Text>
        </Pressable>
        <Text style={s.title}>북쪽 잡기</Text>
        <View style={s.back} />
      </View>

      <View style={s.card} accessibilityLiveRegion="polite">
        <Text style={s.big}>
          {measuring ? `${left}초` : Number.isFinite(heading) ? `${Math.round(heading)}°` : '—'}
        </Text>
        <Text style={s.sub}>
          {measuring ? '움직이지 마세요'
            : stability < STABILITY_FLOOR ? '나침반이 흔들립니다 — 철제 물건에서 떨어지세요'
            : '지금 폰이 향한 방위'}
        </Text>
      </View>

      <ScrollView style={s.body} contentContainerStyle={{ paddingBottom: 20, gap: 10 }}>
        <Text style={s.hint}>
          복도 하나를 골라 <Text style={s.b}>그 방향으로 폰을 향한 채</Text> 5초 서 있으면 됩니다.
          걷지 않아도 됩니다.
        </Text>

        <Text style={s.label}>1. 지금 서 있는 지점</Text>
        <Picker items={nodes} value={from} onPick={id => { setFrom(id); setTo(null); }} />

        <Text style={s.label}>2. 폰이 향하고 있는 쪽 지점</Text>
        {from
          ? <Picker items={linked} value={to} onPick={setTo} empty="이어진 통로가 없습니다" />
          : <Text style={s.hint}>먼저 서 있는 지점을 고르세요</Text>}

        {planDeg !== null && (
          <Text style={s.hint}>도면 안에서 그 방향은 {Math.round(planDeg)}°입니다.</Text>
        )}

        <Pressable
          style={[s.btn, (!from || !to || measuring) && { opacity: 0.4 }]}
          onPress={start}
          disabled={!from || !to || measuring}
          accessibilityRole="button"
          accessibilityLabel={measuring ? `측정 중 ${left}초 남음` : '5초 측정 시작'}
          accessibilityHint="폰을 고른 방향으로 향한 채 움직이지 마세요">
          <Text style={s.btnTx}>{measuring ? `측정 중 ${left}초` : '5초 측정'}</Text>
        </Pressable>

        {result && (
          <View style={[s.card, result.error && { borderLeftColor: theme.warn }]}
                accessibilityLiveRegion="polite">
            {result.error ? (
              <Text style={s.err}>{result.error}</Text>
            ) : (
              <>
                <Row k="잰 방위" v={`${Math.round(result.bearing)}°`} />
                <Row k="도면 안 각도" v={`${Math.round(result.planDeg)}°`} />
                <Row k="도면 위쪽 = 실제" v={`${Math.round(result.offset)}°`} big />
                <Row k="표본" v={`${result.samples}개 · 흔들림 ${Math.round(result.spread)}°`} />
                <Row k="지금 값" v={result.before === null ? '없음 (방향 안내 꺼짐)'
                  : `${Math.round(result.before)}°`} />
              </>
            )}
          </View>
        )}

        {result && !result.error && (
          <Pressable style={[s.btn, saved && { backgroundColor: theme.ok }]}
                     onPress={save}
                     accessibilityRole="button"
                     accessibilityLabel={saved ? '저장됨' : '이 북쪽으로 저장'}>
            <Text style={s.btnTx}>{saved ? '저장됨 ✓' : '이 북쪽으로 저장'}</Text>
          </Pressable>
        )}

        <Text style={s.note}>
          저장하면 진동·소리 방향 안내와 화면의 큰 화살표가 켜집니다.
          지금은 이 값이 없어서 전부 꺼져 있습니다.
          {'\n\n'}
          더 정확하게 재려면 현장 측정 화면에서 두 지점 사이를 걸으세요.
          걸으며 재면 표본이 많아 팔로 겨누는 오차가 평균으로 지워집니다.
        </Text>
      </ScrollView>
    </View>
  );
}

function Picker({ items, value, onPick, empty = '지점이 없습니다' }) {
  if (!items.length) return <Text style={s.hint}>{empty}</Text>;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8, paddingVertical: 2 }}>
      {items.map(n => (
        <Pressable key={n.id} onPress={() => onPick(n.id)}
                   style={[s.chip, value === n.id && s.chipOn]}
                   accessibilityRole="button"
                   accessibilityLabel={n.name || n.id}
                   accessibilityState={{ selected: value === n.id }}>
          <Text style={[s.chipTx, value === n.id && s.chipTxOn]}>{n.name || n.id}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function Row({ k, v, big }) {
  return (
    <View style={s.row}>
      <Text style={s.rowK}>{k}</Text>
      <Text style={[s.rowV, big && s.rowVBig]}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 14, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  back: { minHeight: 48, justifyContent: 'center', minWidth: 74 },
  backTx: { color: theme.textDim, fontSize: 15 },

  card: {
    backgroundColor: theme.surface, borderRadius: theme.radius, padding: 16,
    borderLeftWidth: 4, borderLeftColor: theme.accent, gap: 4,
  },
  big: { color: theme.text, fontSize: 40, fontWeight: '900' },
  sub: { color: theme.textDim, fontSize: 14 },
  err: { color: theme.warn, fontSize: 15, lineHeight: 21 },

  body: { flex: 1 },
  label: { color: theme.text, fontSize: 15, fontWeight: '700', marginTop: 6 },
  hint: { color: theme.textDim, fontSize: 13.5, lineHeight: 20 },
  b: { color: theme.text, fontWeight: '700' },
  note: { color: theme.textDim, fontSize: 12.5, lineHeight: 19, marginTop: 10 },

  chip: {
    minHeight: 48, justifyContent: 'center', paddingHorizontal: 14,
    backgroundColor: theme.surface, borderRadius: 12,
  },
  chipOn: { backgroundColor: theme.accent },
  chipTx: { color: theme.textDim, fontSize: 15 },
  chipTxOn: { color: '#fff', fontWeight: '700' },

  btn: {
    minHeight: 56, borderRadius: 14, backgroundColor: theme.accent,
    alignItems: 'center', justifyContent: 'center', marginTop: 4,
  },
  btnTx: { color: '#fff', fontSize: 17, fontWeight: '700' },

  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rowK: { color: theme.textDim, fontSize: 13 },
  rowV: { color: theme.text, fontSize: 15, fontWeight: '600' },
  rowVBig: { fontSize: 22, fontWeight: '900' },
});
