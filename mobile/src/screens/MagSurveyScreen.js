/**
 * 지자기 지문 측량 — 통로를 **걸으며** 자기장 무늬를 남긴다.
 *
 * ## 왜 이것이 BLE 를 보완하는가
 *
 * BLE 답사의 앵커는 사람들 폰이었다. 주소가 15분마다 바뀌고, 자리를 뜨고,
 * 광고가 초당 0.3~0.9회밖에 안 온다. **앵커가 움직이는 물건**이라 설정으로
 * 안정시킬 수 없다.
 *
 * 자기장을 휘게 하는 것은 철골·전선·배관이다. 그건 움직이지 않는다.
 * 그래서 이쪽은 «앵커가 떠난다» 는 문제가 없다.
 *
 * ## 대신 성질이 다르다
 *
 *   BLE     서 있기만 해도 1~2초에 «어느 지점»       — 즉시 확정
 *   지자기  8걸음쯤 걸어야 «어디쯤»                  — 누적 확정
 *
 * 그래서 둘을 겹쳐 쓴다. 비콘이 잡히면 그 지점으로 확정(누적오차 리셋)하고,
 * 비콘 사이 구간은 자기장 무늬로 «맞게 가고 있나» 를 걸음마다 확인한다.
 * 판단 계층(`shared/fusion.js`)이 이미 그렇게 받도록 되어 있다 —
 * 비콘은 `anchorAt`, 지자기는 걸음마다 `observe` 하고 확신이 서면 `anchorAtPosition`.
 *
 * ## 한 통로를 한 번에 걷는다
 *
 * 지문은 **순서**가 정보다. "도–미–솔" 이 특정 노래인 것처럼, 오르내림의
 * 순서가 그 통로를 가리킨다. 중간에 멈추거나 되돌아가면 순서가 깨지므로,
 * 시작 지점에서 도착 지점까지 **한 번에 고르게** 걸어야 한다.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Magnetometer } from 'expo-sensors';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { buildFingerprint } from '../magnetic';
import { Odometry } from '../odometry';
import { theme } from '../theme';

/** 자기장 표본 주기. 걸음(약 0.5초)보다 촘촘해야 걸음별로 나눌 수 있다. */
const SAMPLE_MS = 120;
/** 이보다 짧게 걸으면 지문이 안 된다 — 짧은 조각은 어느 통로에나 맞는다 */
const MIN_STEPS = 5;

export default function MagSurveyScreen({ api, plan, onClose }) {
  const [from, setFrom] = useState(null);
  const [run, setRun] = useState(null);        // { from, to, samples, steps }
  const [done, setDone] = useState({});        // edgeId -> 표본 수
  const [note, setNote] = useState(null);
  const latest = useRef(null);
  const odo = useMemo(() => new Odometry(), []);

  // 지금 고른 출발 지점에서 **통로로 이어진** 지점만 도착 후보다.
  // 이어지지 않은 두 지점을 고르면 통로가 없으니 지문을 넣을 자리도 없다.
  const neighbours = useMemo(() => {
    if (!from || !plan) return [];
    return plan.edges
      .filter(e => e.a === from || e.b === from)
      .map(e => ({ edge: e, node: plan.nodes.find(n => n.id === (e.a === from ? e.b : e.a)) }))
      .filter(x => x.node);
  }, [from, plan]);

  useEffect(() => {
    let sub = null;
    Magnetometer.isAvailableAsync().then(ok => {
      if (!ok) { setNote('이 기기에 자력계가 없습니다'); return; }
      Magnetometer.setUpdateInterval(SAMPLE_MS);
      sub = Magnetometer.addListener(({ x, y, z }) => {
        // 크기만 쓴다 — 폰을 어떻게 들어도 같은 값이 나온다
        latest.current = Math.sqrt(x * x + y * y + z * z);
      });
    }).catch(() => setNote('자력계를 켤 수 없습니다'));

    api?.getMagnetic?.().then(d => {
      if (d?.prints) setNote(null);
    }).catch(() => {});
    api?.getMagneticPrints?.().then(d => {
      if (d?.prints) setDone(Object.fromEntries(
        Object.entries(d.prints).map(([k, v]) => [k, v.length])));
    }).catch(() => {});

    return () => { sub?.remove?.(); odo.stop(); };
  }, [api, odo]);

  function start(edge, toNode) {
    setNote(null);
    odo.reset?.();
    odo.start();
    const t = setInterval(() => {
      if (Number.isFinite(latest.current)) {
        setRun(r => (r ? { ...r, samples: [...r.samples, latest.current], steps: odo.steps } : r));
      }
    }, SAMPLE_MS);
    setRun({ edge, toNode, samples: [], steps: 0, timer: t });
  }

  async function finish() {
    if (!run) return;
    clearInterval(run.timer);
    odo.stop();
    const steps = Math.max(run.steps, 0);
    setRun(null);

    if (steps < MIN_STEPS) {
      setNote(`걸음이 ${steps}개뿐입니다 — ${MIN_STEPS}걸음 이상 걸어야 지문이 됩니다`);
      return;
    }
    if (run.samples.length < 3) {
      setNote('자기장 표본이 모자랍니다');
      return;
    }
    // 연속 표본을 **걸음 단위**로 다시 샘플링한다. 판정할 때도 걸음 단위로
    // 비교하므로, 같은 단위로 저장해야 대조가 성립한다.
    const print = buildFingerprint(run.samples, steps);
    const r = await api?.putMagneticPrint?.(run.edge.id, print).catch(() => null);
    if (r?.ok) {
      setDone(d => ({ ...d, [run.edge.id]: print.length }));
      setNote(`${run.edge.id} 저장됨 · ${steps}걸음 · ${print.length}점`);
    } else {
      setNote(r?.error || '서버에 못 올렸습니다');
    }
  }

  const nodes = (plan?.nodes || []).filter(n => n.type !== 'elevator');
  const total = plan?.edges?.length ?? 0;
  const count = Object.keys(done).length;

  return (
    <View style={s.root}>
      <View style={s.top}>
        <Pressable onPress={onClose} style={s.back} accessibilityRole="button"
                   accessibilityLabel="닫기">
          <Text style={s.backTx}>‹ 닫기</Text>
        </Pressable>
        <Text style={s.title}>지자기 지문 측량</Text>
        <Text style={s.count}>{count}/{total}</Text>
      </View>

      {run ? (
        <View style={[s.card, s.live]}>
          <Text style={s.liveWhere}>{run.toNode?.name} 로 걷는 중</Text>
          <Text style={s.liveBig}>{run.steps}<Text style={s.liveUnit}>걸음</Text></Text>
          <Text style={s.sub}>자기장 {Math.round(latest.current ?? 0)} μT · 표본 {run.samples.length}개</Text>
          <Text style={s.hint}>고르게 걸으세요. 멈추거나 되돌아가면 무늬가 깨집니다.</Text>
          <Pressable onPress={finish} style={s.bigBtn} accessibilityRole="button">
            <Text style={s.bigBtnTx}>도착 — 저장</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 20 }}>
          {note && <View style={s.note}><Text style={s.noteTx}>{note}</Text></View>}

          <Text style={s.lbl}>① 출발 지점</Text>
          <View style={s.chips}>
            {nodes.map(n => (
              <Pressable key={n.id} onPress={() => setFrom(n.id)}
                         style={[s.chip, from === n.id && s.chipOn]}
                         accessibilityRole="button">
                <Text style={[s.chipTx, from === n.id && s.chipTxOn]}>{n.name}</Text>
              </Pressable>
            ))}
          </View>

          {from && (
            <>
              <Text style={s.lbl}>② 어디까지 걸을까요</Text>
              <View style={s.chips}>
                {neighbours.map(({ edge, node }) => (
                  <Pressable key={edge.id} onPress={() => start(edge, node)}
                             style={[s.chip, done[edge.id] && s.chipDone]}
                             accessibilityRole="button">
                    <Text style={[s.chipTx, done[edge.id] && s.chipTxDone]}>
                      {node.name}{done[edge.id] ? '  ✓' : ''}
                    </Text>
                  </Pressable>
                ))}
              </View>
              {neighbours.length === 0 && (
                <Text style={s.hint}>이 지점에서 이어진 통로가 없습니다</Text>
              )}
            </>
          )}

          <Text style={s.hint}>
            대피 경로가 지나는 복도부터 재세요. 방 안쪽 통로는 안 걸어도 됩니다 —
            지문은 <Text style={s.b}>사람이 지나는 구간</Text>에만 필요합니다.
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 14, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  count: { color: theme.textDim, fontSize: 14, minWidth: 62, textAlign: 'right' },
  back: { paddingVertical: 8, paddingHorizontal: 6, minWidth: 62 },
  backTx: { color: theme.textDim, fontSize: 15 },

  card: { backgroundColor: theme.surface, borderRadius: theme.radius, padding: 16, gap: 6 },
  live: { borderLeftWidth: 4, borderLeftColor: theme.accent },
  liveWhere: { color: theme.textDim, fontSize: 14 },
  liveBig: { color: theme.text, fontSize: 44, fontWeight: '800' },
  liveUnit: { fontSize: 16, fontWeight: '600', color: theme.textDim },
  sub: { color: theme.textDim, fontSize: 13 },

  bigBtn: {
    marginTop: 10, backgroundColor: theme.accent, borderRadius: 14,
    paddingVertical: 16, alignItems: 'center',
  },
  bigBtnTx: { color: '#fff', fontSize: 17, fontWeight: '800' },

  lbl: { color: theme.text, fontSize: 13, fontWeight: '700', marginTop: 12, marginBottom: 7 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  chip: {
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 11,
    backgroundColor: theme.surface, borderWidth: 1, borderColor: theme.border,
  },
  chipOn: { backgroundColor: theme.accent, borderColor: theme.accent },
  chipDone: { borderColor: theme.ok },
  chipTx: { color: theme.text, fontSize: 13.5 },
  chipTxOn: { color: '#fff', fontWeight: '700' },
  chipTxDone: { color: theme.ok, fontWeight: '600' },

  note: {
    backgroundColor: theme.surface, borderRadius: 12, padding: 12,
    borderLeftWidth: 3, borderLeftColor: theme.warn,
  },
  noteTx: { color: theme.text, fontSize: 13 },
  hint: { color: theme.textDim, fontSize: 12.5, lineHeight: 18, marginTop: 12 },
  b: { color: theme.text, fontWeight: '700' },
});
