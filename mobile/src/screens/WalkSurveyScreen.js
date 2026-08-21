/**
 * 걷기 답사 — **폰이 자기 답사를 자기가 만든다.**
 *
 * ## 왜 이게 앱 안에 있어야 하나
 *
 * 처음에는 웹 페이지(`frontend/survey.html`)로 만들었다. 안드로이드 크롬에
 * 플래그 두 개를 켜면 오늘 당장 돌아가니까. 그런데 그건 임시방편이다 —
 * **답사한 폰과 안내받는 폰이 같아야** 하기 때문이다.
 *
 * BLE 식별자는 (기기, 출처)마다 다른 값이다. 크롬이 만든 `device.id` 와
 * 이 앱이 보는 값이 다르므로, 크롬으로 답사해 놓고 앱으로 안내받으면
 * 매핑이 하나도 안 맞는다. 답사와 안내가 같은 앱 안에 있어야 그 값이
 * 이어진다.
 *
 * 그리고 시각장애인이 쓰는 것은 앱이지 크롬 탭이 아니다.
 *
 * ## Expo Go 로는 안 된다
 *
 * `react-native-ble-plx` 는 네이티브 모듈이라 Expo Go 에 안 들어 있다.
 * 개발 빌드(`expo-dev-client`)가 필요하고, 둘 다 이미 `package.json` 에
 * 있다. 안 되는 환경에서는 «왜 안 되는지» 를 화면에 적는다 — 「지원 안 함」
 * 한 줄로 뭉개면 현장에서 못 고친다.
 *
 * ## 방위를 안 쓴다
 *
 * 출발과 도착을 사람이 찍어 주므로 그 사이의 길은 도면 그래프가 안다.
 * 남은 미지수는 «길 위 어디쯤» 하나뿐이고 걸음 수의 비율이 그 답이다.
 * 실내 나침반은 철골·배전반에 수십 도씩 틀어지므로 안 믿을 값을 섞지 않는다.
 * 굽는 규칙은 `shared/walk-survey.js` 에 있고 테스트가 지킨다.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';

import { available as bleAvailable, startScan, unavailableReason } from '../ble';
import { Odometry } from '../odometry';

/** 모아서 한 번에 올린다. 광고마다 요청을 던지면 초당 수십 번이 된다. */
const FLUSH_MS = 1500;
/** 이보다 오래된 관측은 버린다 — 지나간 신호로 지금 자리를 말하면 안 된다 */
const KEEP_MS = 4000;

export default function WalkSurveyScreen({ api, plan, onClose }) {
  useKeepAwake();   // 걸으며 쓰는 화면이다. 잠기면 스캔도 걸음도 멈춘다.

  const [phase, setPhase] = useState('setup');   // setup | walking | done
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [steps, setSteps] = useState(0);
  const [devices, setDevices] = useState(0);
  const [uploads, setUploads] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const stopScan = useRef(null);
  const odo = useRef(null);
  const seen = useRef(new Map());     // beaconId → [{rssi, at}]
  const stepsRef = useRef(0);
  const flushTimer = useRef(null);

  const spots = useMemo(
    () => (plan?.nodes || []).filter(n => n.type !== 'elevator'),
    [plan]);

  useEffect(() => () => teardown(), []);

  function teardown() {
    try { stopScan.current?.(); } catch (_) { /* 이미 멈춤 */ }
    stopScan.current = null;
    odo.current?.stop();
    odo.current = null;
    clearInterval(flushTimer.current);
    flushTimer.current = null;
    seen.current.clear();
  }

  /**
   * 창 안의 관측을 기기마다 **중앙값**으로 눌러 올린다.
   *
   * 평균이 아니라 중앙값인 이유: 원시 RSSI 는 서 있어도 ±10dBm 튀고 그 튐이
   * 한쪽으로 크게 빠지는 이상치로 온다. 평균은 끌려가고 중앙값은 안 끌려간다.
   */
  async function flush() {
    const cut = Date.now() - KEEP_MS;
    const readings = [];
    for (const [beaconId, list] of seen.current) {
      const fresh = list.filter(s => s.at >= cut);
      if (!fresh.length) { seen.current.delete(beaconId); continue; }
      seen.current.set(beaconId, fresh);
      const v = fresh.map(s => s.rssi).sort((a, b) => a - b);
      const m = v.length >> 1;
      readings.push({
        beaconId,
        rssi: Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2),
        samples: fresh.length,
      });
    }
    if (!readings.length) return;
    try {
      await api.sampleWalkSurvey(stepsRef.current, readings);
      setUploads(u => u + 1);
      setDevices(seen.current.size);
    } catch (e) {
      setError(`올리기 실패: ${e.message}`);
    }
  }

  async function start() {
    if (!from) return;
    setBusy(true); setError(null);
    try {
      await api.startWalkSurvey(from);
    } catch (e) {
      setError(`시작 실패: ${e.message}`); setBusy(false); return;
    }

    if (!bleAvailable()) {
      // 스캔이 안 되면 답사는 무의미하다. 세션을 켜 두면 화면은 «걷고 있다»
      // 고 말하는데 아무것도 안 쌓인다.
      await api.cancelWalkSurvey().catch(() => {});
      setError(unavailableReason());
      setBusy(false);
      return;
    }

    stepsRef.current = 0;
    setSteps(0); setDevices(0); setUploads(0);
    seen.current.clear();

    odo.current = new Odometry();
    odo.current.onStep = n => { stepsRef.current = n; setSteps(n); };
    odo.current.start();

    stopScan.current = startScan(
      r => {
        if (!r?.beaconId || !Number.isFinite(r.rssi)) return;
        const list = seen.current.get(r.beaconId) || [];
        list.push({ rssi: r.rssi, at: Date.now() });
        seen.current.set(r.beaconId, list);
      },
      e => setError(`스캔 오류: ${e.message}`));

    flushTimer.current = setInterval(flush, FLUSH_MS);
    setPhase('walking');
    setBusy(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }

  async function finish() {
    if (!to) return;
    setBusy(true);
    // 마지막 묶음을 흘리지 않는다 — 도착 지점 신호가 통째로 빠지면 정작
    // 제일 중요한 «출구 앞» 이 답사에서 빈다.
    await flush();
    try {
      const d = await api.finishWalkSurvey(to);
      teardown();
      setResult(d);
      setPhase('done');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setError(`마무리 실패: ${e.message}`);
    }
    setBusy(false);
  }

  async function cancel() {
    teardown();
    await api.cancelWalkSurvey().catch(() => {});
    setPhase('setup'); setResult(null); setError(null);
  }

  const nameOf = id => spots.find(n => n.id === id)?.name || id;

  return (
    <ScrollView style={s.wrap} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={s.head}>
        <Text style={s.h1}>걷기 답사</Text>
        <Pressable onPress={onClose} accessibilityLabel="닫기" style={s.x}>
          <Text style={s.xt}>✕</Text>
        </Pressable>
      </View>
      <Text style={s.sub}>
        출발을 찍고 <Text style={s.b}>한 방향으로 쭉</Text> 걸어 도착을 찍습니다.
        되돌아 걸으면 어긋납니다.
      </Text>

      {phase !== 'done' && (
        <View style={s.card}>
          <Text style={s.cap}>수신 상태</Text>
          <View style={s.live}>
            <Stat n={phase === 'walking' ? devices : '—'} label="잡힌 기기" on={devices > 0} />
            <Stat n={steps} label="걸음" on={steps > 0} />
            <Stat n={uploads} label="올린 묶음" on={uploads > 0} />
          </View>
          {!bleAvailable() && (
            <Text style={s.warn}>{unavailableReason()}</Text>
          )}
        </View>
      )}

      {error ? <Text style={s.err}>{error}</Text> : null}

      {phase === 'setup' && (
        <View style={s.card}>
          <Text style={s.cap}>① 지금 서 있는 곳</Text>
          <Picker spots={spots} value={from} onPick={setFrom} />
          <Pressable
            style={[s.btn, s.go, (!from || busy) && s.off]}
            disabled={!from || busy}
            onPress={start}
            accessibilityRole="button">
            <Text style={s.btnGo}>{busy ? '시작하는 중…' : '답사 시작 — 여기서부터 걷습니다'}</Text>
          </Pressable>
        </View>
      )}

      {phase === 'walking' && (
        <View style={s.card}>
          <Text style={s.cap}>② 지금 도착한 곳</Text>
          <Text style={s.note}>{nameOf(from)} 에서 출발했습니다</Text>
          <Picker spots={spots} value={to} onPick={setTo} />
          <Pressable
            style={[s.btn, s.go, (!to || busy) && s.off]}
            disabled={!to || busy}
            onPress={finish}
            accessibilityRole="button">
            <Text style={s.btnGo}>{busy ? '굽는 중…' : '답사 끝 — 여기까지 걸었습니다'}</Text>
          </Pressable>
          <Pressable style={[s.btn, s.ghost]} onPress={cancel} accessibilityRole="button">
            <Text style={s.btnGhost}>버리기</Text>
          </Pressable>
        </View>
      )}

      {phase === 'done' && result && (
        <View style={s.card}>
          <Text style={s.cap}>답사 완료</Text>
          <Text style={s.big}>{result.kept}<Text style={s.unit}> 개 기기 채택</Text></Text>
          <Text style={s.note}>
            {nameOf(result.from)} → {nameOf(result.to)} · {result.steps}걸음 ·
            경로 {result.route?.length}지점{'\n'}
            훑은 기기 {result.devices}개 중 새로 저장 {result.added}개 ·
            전체 답사 {result.surveyed}신호
          </Text>
          {Object.keys(result.spots || {}).length > 0 && (
            <Text style={s.spots}>
              {Object.entries(result.spots)
                .map(([k, v]) => `${nameOf(k)} ${v}개`).join('\n')}
            </Text>
          )}
          <Pressable style={[s.btn, s.go]} onPress={() => { setPhase('setup'); setResult(null); }}>
            <Text style={s.btnGo}>한 번 더 걷기</Text>
          </Pressable>
          <Pressable style={[s.btn, s.ghost]} onPress={onClose}>
            <Text style={s.btnGhost}>닫기</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

function Stat({ n, label, on }) {
  return (
    <View style={s.stat}>
      <Text style={[s.statN, on && s.statOn]}>{n}</Text>
      <Text style={s.statL}>{label}</Text>
    </View>
  );
}

/**
 * 지점 고르기 — 목록을 그대로 편다.
 *
 * 드롭다운을 안 쓴다. 스크린리더로 드롭다운을 여닫는 것은 탭이 두 배로
 * 들고, 무엇보다 **걸으면서** 고르는 화면이라 손가락이 닿는 큰 칸이라야 한다.
 */
function Picker({ spots, value, onPick }) {
  return (
    <View style={s.picker}>
      {spots.map(n => (
        <Pressable
          key={n.id}
          onPress={() => onPick(n.id)}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === n.id }}
          style={[s.opt, value === n.id && s.optOn]}>
          <Text style={[s.optT, value === n.id && s.optTOn]} numberOfLines={1}>
            {n.name || n.id}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0d1117', padding: 16 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h1: { color: '#e6edf3', fontSize: 22, fontWeight: '700' },
  x: { padding: 8 },
  xt: { color: '#8b949e', fontSize: 20 },
  sub: { color: '#8b949e', fontSize: 13, marginTop: 4, marginBottom: 14, lineHeight: 20 },
  b: { color: '#e6edf3', fontWeight: '700' },

  card: {
    backgroundColor: '#161b22', borderColor: '#262d36', borderWidth: 1,
    borderRadius: 14, padding: 16, marginBottom: 12,
  },
  cap: { color: '#8b949e', fontSize: 12, fontWeight: '600', marginBottom: 10, letterSpacing: 0.4 },

  live: { flexDirection: 'row' },
  stat: { flex: 1, alignItems: 'center' },
  statN: { color: '#e6edf3', fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statOn: { color: '#2fd6a6' },
  statL: { color: '#8b949e', fontSize: 12, marginTop: 2 },

  picker: { marginBottom: 10 },
  opt: {
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 10,
    borderWidth: 1, borderColor: '#262d36', backgroundColor: '#1c232c', marginBottom: 6,
  },
  optOn: { borderColor: '#4d9fff', backgroundColor: 'rgba(77,159,255,.14)' },
  optT: { color: '#c9d2dc', fontSize: 15 },
  optTOn: { color: '#e6edf3', fontWeight: '700' },

  btn: { paddingVertical: 16, borderRadius: 11, alignItems: 'center', marginTop: 8 },
  go: { backgroundColor: '#4d9fff' },
  ghost: { borderWidth: 1, borderColor: '#262d36' },
  off: { opacity: 0.4 },
  btnGo: { color: '#04121f', fontSize: 16, fontWeight: '700' },
  btnGhost: { color: '#8b949e', fontSize: 15, fontWeight: '600' },

  note: { color: '#8b949e', fontSize: 13, lineHeight: 20, marginBottom: 10 },
  spots: { color: '#c9d2dc', fontSize: 13, lineHeight: 20, marginBottom: 10 },
  big: { color: '#2fd6a6', fontSize: 36, fontWeight: '700' },
  unit: { color: '#8b949e', fontSize: 15, fontWeight: '600' },
  warn: {
    color: '#e79a3c', fontSize: 13, lineHeight: 20, marginTop: 12,
    backgroundColor: 'rgba(231,154,60,.1)', borderRadius: 10, padding: 12,
  },
  err: {
    color: '#ff4438', fontSize: 13, lineHeight: 20, marginBottom: 12,
    backgroundColor: 'rgba(255,68,56,.1)', borderRadius: 10, padding: 12,
  },
});
