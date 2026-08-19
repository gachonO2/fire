/**
 * 지자기 재현성 검사 — **지자기를 쓸지 말지 정하는 화면.**
 *
 * ## 왜 이 화면이 먼저인가
 *
 * 지자기 측위는 전부 한 가정 위에 서 있다: **같은 자리에 다시 오면 같은 값이
 * 나온다.** 이게 아니면 지문이 성립하지 않고, 측량도 대조도 전부 헛일이다.
 *
 * 그런데 그 가정을 아무도 재본 적이 없다. 측량 도구와 매칭 알고리즘을 며칠 걸려
 * 만든 뒤에 "안 되네"를 알게 되면 그 며칠이 통째로 날아간다. 그래서 **먼저 재고
 * 나중에 만든다.** 이 화면은 반나절 안에 답을 내려고 있는 것이다.
 *
 * ## 쓰는 법
 *
 *   1. 복도의 서로 다른 지점을 서너 곳 정한다 (5m쯤 띄워서)
 *   2. 각 지점에서 「재기」를 눌러 3초 기록한다
 *   3. 다른 데 갔다가 **같은 지점으로 돌아와** 다시 잰다
 *   4. 지점마다 두 번 이상 재면 판정이 뜬다
 *
 * 판정 기준은 「지점 간 차이 ÷ 방문 간 차이」다. 앞이 뒤보다 세 배 이상 크면
 * 지문이 성립한다. 1.5배도 안 되면 접는 게 낫다.
 *
 * ## 크기만 쓴다
 *
 * 자력계는 벡터(x,y,z)를 주는데 폰을 돌리면 셋이 다 바뀐다. 크기 |B| 는 안 바뀐다.
 * 그래서 **폰을 어떻게 들고 재든 같은 값**이 나온다 — 이 검사가 성립하는 이유이자,
 * 나중에 지팡이 짚고 걷는 사용자에게도 통하는 이유다.
 *
 * 이 화면은 시각장애인용이 아니라 **측량하는 사람용**이다. 개발/설치 도구다.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Magnetometer } from 'expo-sensors';

import { reproducibilityReport } from '../magnetic';
import { theme } from '../theme';

/** 한 번 잴 때 기록하는 시간 */
const RECORD_MS = 3000;
const SAMPLE_MS = 100;

const VERDICT = {
  good: { color: theme.ok, label: '쓸 수 있습니다' },
  marginal: { color: theme.warn, label: '경계선입니다' },
  unusable: { color: theme.danger, label: '접는 편이 낫습니다' },
  insufficient: { color: theme.textDim, label: '표본이 모자랍니다' },
};

export default function MagScreen({ onClose, api }) {
  // 서버에 남긴 횟수. 걷고 와서 화면을 닫으면 사라지던 값이라, 남았는지가
  // 화면에 보여야 «다시 걸어야 하나» 를 고민하지 않는다.
  const [saved, setSaved] = useState(0);
  const [mag, setMag] = useState(null);          // 지금 |B|
  const [available, setAvailable] = useState(null);
  const [spots, setSpots] = useState([]);        // [{ id, visits: [[번호]] }]
  const [active, setActive] = useState(1);       // 지금 재고 있는 지점 번호
  const [recording, setRecording] = useState(null); // { left, samples }

  const latest = useRef(null);

  useEffect(() => {
    let sub = null;
    let alive = true;
    (async () => {
      const ok = await Magnetometer.isAvailableAsync().catch(() => false);
      if (!alive) return;
      setAvailable(ok);
      if (!ok) return;
      Magnetometer.setUpdateInterval(SAMPLE_MS);
      sub = Magnetometer.addListener(({ x, y, z }) => {
        // 크기만 쓴다 — 폰 자세와 무관해진다
        const b = Math.sqrt(x * x + y * y + z * z);
        latest.current = b;
        setMag(b);
      });
    })();
    return () => { alive = false; sub?.remove?.(); };
  }, []);

  /** 3초 동안 모아서 방문 하나로 저장 */
  function record() {
    if (recording || !available) return;
    const samples = [];
    let left = RECORD_MS;
    setRecording({ left, samples });

    const timer = setInterval(() => {
      if (Number.isFinite(latest.current)) samples.push(latest.current);
      left -= SAMPLE_MS;
      if (left > 0) { setRecording({ left, samples }); return; }

      clearInterval(timer);
      setRecording(null);
      if (samples.length === 0) return;
      setSpots(prev => {
        const next = prev.map(s => ({ ...s, visits: [...s.visits] }));
        const hit = next.find(s => s.id === active);
        if (hit) hit.visits.push(samples);
        else next.push({ id: active, visits: [samples] });
        return next.sort((a, b) => a.id - b.id);
      });

      // **서버에 남긴다.** 건물을 걸어야 나오는 값이라 화면 상태로만 두면
      // 화면을 닫는 순간 사라지고 다시 걸어야 한다.
      api?.postMagneticVisit?.(`지점 ${active}`, samples)
        .then(r => { if (r?.visits) setSaved(r.visits); })
        .catch(() => {});
    }, SAMPLE_MS);
  }

  // 판정은 매 렌더마다 다시 낸다 — 표본이 하나 늘 때마다 결과가 바뀌는 게 보여야 한다
  const visits = spots.flatMap(s => s.visits.map(v => ({ spot: `지점 ${s.id}`, samples: v })));
  const report = reproducibilityReport(visits);
  const v = VERDICT[report.verdict] ?? VERDICT.insufficient;

  const spotIds = [...new Set([...spots.map(s => s.id), active, spots.length + 1])]
    .filter(n => n >= 1 && n <= 8)
    .sort((a, b) => a - b);

  return (
    <View style={s.root}>
      <View style={s.top}>
        <Text style={s.title}>지자기 재현성 검사</Text>
        <Pressable style={s.close} onPress={onClose} accessibilityRole="button">
          <Text style={s.closeText}>닫기</Text>
        </Pressable>
      </View>

      {available === false && (
        <View style={[s.card, { borderColor: theme.danger }]}>
          <Text style={s.cardTitle}>이 기기에는 자력계가 없습니다</Text>
          <Text style={s.dim}>다른 폰으로 시도하세요.</Text>
        </View>
      )}

      {/* 지금 값 */}
      <View style={s.readout}>
        <Text style={s.readoutValue}>
          {mag === null ? '—' : mag.toFixed(1)}
          <Text style={s.unit}>  μT</Text>
        </Text>
        <Text style={s.dim}>
          지구 자기장은 25~65 μT. 실내에서는 철골 때문에 자리마다 다르게 휩니다.
        </Text>
      </View>

      {/* 지점 고르기 */}
      <Text style={s.label}>어느 지점을 재나요</Text>
      <View style={s.chips}>
        {spotIds.map(n => {
          const on = n === active;
          const count = spots.find(x => x.id === n)?.visits.length ?? 0;
          return (
            <Pressable
              key={n}
              style={[s.chip, on && s.chipOn]}
              onPress={() => setActive(n)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
            >
              <Text style={[s.chipText, on && s.chipTextOn]}>지점 {n}</Text>
              <Text style={[s.chipCount, on && s.chipTextOn]}>
                {count === 0 ? '아직' : `${count}회`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Pressable
        style={[s.record, recording && s.recording, !available && s.disabled]}
        onPress={record}
        disabled={!!recording || !available}
        accessibilityRole="button"
      >
        <Text style={s.recordText}>
          {recording
            ? `재는 중… ${(recording.left / 1000).toFixed(1)}초`
            : `지점 ${active} 재기 (3초)`}
        </Text>
      </Pressable>

      <ScrollView style={s.scroll} contentContainerStyle={{ paddingBottom: 32 }}>
        {/* 판정 */}
        <View style={[s.card, { borderColor: v.color }]}>
          <View style={s.cardHead}>
            <Text style={[s.verdict, { color: v.color }]}>{v.label}</Text>
            {report.ratio !== null && (
              <Text style={s.ratio}>
                {report.ratio === Infinity ? '∞' : report.ratio.toFixed(1)}배
              </Text>
            )}
          </View>
          <Text style={s.dim}>{report.message}</Text>

          {report.withinUt !== null && (
            <View style={s.rows}>
              <Row k="같은 자리 재방문 차이" val={`${report.withinUt.toFixed(2)} μT`} />
              <Row k="다른 자리 간 차이" val={`${report.betweenUt.toFixed(2)} μT`} />
              <Row k="판정 기준" val="3배 이상이면 쓸 수 있음" dim />
            </View>
          )}
        </View>

        {/* 지점별 기록 */}
        {spots.map(spot => {
          const means = spot.visits.map(v2 => v2.reduce((a, b) => a + b, 0) / v2.length);
          const spread = means.length >= 2 ? Math.max(...means) - Math.min(...means) : null;
          return (
            <View key={spot.id} style={s.spotRow}>
              <Text style={s.spotName}>지점 {spot.id}</Text>
              <Text style={s.spotVals}>
                {means.map(m => m.toFixed(1)).join('  ·  ')}
              </Text>
              <Text style={[s.spotSpread, spread > 1 && { color: theme.warn }]}>
                {spread === null ? '한 번 더' : `±${spread.toFixed(2)}`}
              </Text>
            </View>
          );
        })}

        {spots.length > 0 && (
          <Pressable style={s.clear} onPress={() => setSpots([])} accessibilityRole="button">
            <Text style={s.clearText}>전부 지우기</Text>
          </Pressable>
        )}

        <Text style={s.help}>
          지점을 서너 곳 정해 5m쯤 띄우고, 각 지점에서 한 번 잰 뒤
          다른 데 갔다가 **돌아와서 다시** 재세요. 지점마다 두 번 이상 재야 판정이 나옵니다.
        </Text>
      </ScrollView>
    </View>
  );
}

function Row({ k, val, dim }) {
  return (
    <View style={s.row}>
      <Text style={s.rowKey}>{k}</Text>
      <Text style={[s.rowVal, dim && { color: theme.textDim, fontWeight: '400' }]}>{val}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 18, paddingTop: 8 },

  top: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  title: { flex: 1, color: theme.text, fontSize: 19, fontWeight: '800' },
  close: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: theme.border,
  },
  closeText: { color: theme.text, fontSize: 14, fontWeight: '600' },

  readout: {
    backgroundColor: theme.surface, borderRadius: theme.radius,
    padding: 18, marginBottom: 18,
  },
  readoutValue: { color: theme.text, fontSize: 46, fontWeight: '800', letterSpacing: -1 },
  unit: { fontSize: 20, fontWeight: '600', color: theme.textDim },

  label: { color: theme.textDim, fontSize: 13, fontWeight: '700', marginBottom: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 12,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: 'transparent',
    alignItems: 'center',
  },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipText: { color: theme.text, fontSize: 15, fontWeight: '700' },
  chipTextOn: { color: '#fff' },
  chipCount: { color: theme.textDim, fontSize: 11, marginTop: 2 },

  record: {
    backgroundColor: theme.accent, borderRadius: theme.radius,
    paddingVertical: 18, alignItems: 'center', marginBottom: 18,
  },
  recording: { backgroundColor: theme.warn },
  disabled: { opacity: 0.4 },
  recordText: { color: '#fff', fontSize: 17, fontWeight: '800' },

  scroll: { flex: 1 },

  card: {
    backgroundColor: theme.surface, borderRadius: theme.radius,
    borderWidth: 1.5, padding: 16, marginBottom: 14,
  },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 6 },
  cardTitle: { color: theme.text, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  verdict: { flex: 1, fontSize: 18, fontWeight: '800' },
  ratio: { color: theme.text, fontSize: 20, fontWeight: '800' },

  rows: { marginTop: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'baseline' },
  rowKey: { flex: 1, color: theme.textDim, fontSize: 13 },
  rowVal: { color: theme.text, fontSize: 14, fontWeight: '700' },

  spotRow: {
    flexDirection: 'row', alignItems: 'baseline', gap: 10,
    paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  spotName: { color: theme.text, fontSize: 14, fontWeight: '700', width: 62 },
  spotVals: { flex: 1, color: theme.textDim, fontSize: 13 },
  spotSpread: { color: theme.ok, fontSize: 13, fontWeight: '700' },

  clear: {
    marginTop: 16, paddingVertical: 12, alignItems: 'center',
    borderRadius: 12, borderWidth: 1, borderColor: theme.border,
  },
  clearText: { color: theme.textDim, fontSize: 14, fontWeight: '600' },

  dim: { color: theme.textDim, fontSize: 13, lineHeight: 19 },
  help: { color: theme.textDim, fontSize: 12.5, lineHeight: 19, marginTop: 18 },
});
