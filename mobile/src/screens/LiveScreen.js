/**
 * 실시간 위치 — **대피를 시작하지 않고** 내 위치만 본다.
 *
 * ## 왜 따로 만드나
 *
 * 위치를 보려면 「대피 안내」를 시작해야 했다. 안내를 시작하면 경로가 잡히고
 * 음성이 나가고 도착 판정이 붙는데, 답사가 제대로 됐는지 확인하려고 걷는
 * 사람에게 그건 전부 방해다. 게다가 안내 화면은 걸음 추정·나침반·가상 비콘이
 * 함께 도는 곳이라, **전파만으로 위치가 잡히는지**를 가려낼 수가 없다.
 *
 * 이 화면은 걸음도 나침반도 안 쓴다. 오직 하나만 본다:
 *
 *     맥이 BLE 를 듣는다  →  서버가 «지금 어느 지점» 을 판정한다  →  여기 뜬다
 *
 * 그래서 점이 따라오면 답사가 성공한 것이고, 안 따라오면 그 구간을 다시
 * 태그하면 된다. **그 자리에서 검증되는 것**이 이 화면의 값어치다.
 *
 * ## 걸음을 일부러 안 넣었다
 *
 * 걸음 추정을 같이 돌리면 전파가 못 잡는 구간도 점이 부드럽게 이어져서
 * «되는 것처럼» 보인다. 검증 화면이 검증을 방해하는 셈이다. 전파가 끊기면
 * 점도 멈춰야 어디가 빈 구간인지 보인다.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import PositionMap from './PositionMap';
import { Tracking } from '../tracking';
import { say, stopSpeaking } from '../announce';
import { deviceIdNow } from '../deviceId';
import { theme } from '../theme';

/** 서버에 판정을 물어보는 주기. 맥 스캐너가 초당 여러 번 듣고 있어 이 정도면 즉각적이다. */
const FIX_MS = 800;
/** 답사 진척은 자주 바뀌지 않는다 */
const MAP_MS = 5000;
/**
 * 관제로 위치를 올리는 최소 간격.
 *
 * 지점이 바뀌면 즉시 보내고, 안 바뀌어도 이 주기로 한 번씩 보낸다. 안 보내면
 * 관제 쪽에서 «소식 없음» 으로 흐려지는데, 서 있는 것과 끊긴 것은 다른 일이다.
 */
const REPORT_MS = 2000;

const SOURCE_LABEL = {
  beacon: '비콘 확정',
  pdr: '걸음 추정',
  manual: '수동 지정',
  simulated: '가상 비콘',
};

export default function LiveScreen({ api, plan, onClose }) {
  const [fix, setFix] = useState(null);
  const [scanner, setScanner] = useState(false);
  const [mapped, setMapped] = useState(0);
  const [spots, setSpots] = useState(0);
  const [planImage, setPlanImage] = useState(null);
  const [speak, setSpeak] = useState(true);
  const [, bump] = useState(0);          // 판정이 들어오면 지도를 다시 그린다

  // 걸음도 가상 비콘도 넣지 않는다 — 들어오는 것은 서버 판정뿐이다.
  const tracking = useMemo(() => (plan ? new Tracking(plan) : null), [plan]);
  const lastSpoken = useRef(null);
  // 관제에서 답사자를 대피자와 구분할 수 있게 접두어를 다르게 준다.
  // 기기 이름을 그대로 쓴다 — 새로고침마다 새 이름을 지으면 유령이 쌓인다.
  const userId = useRef(`live-${deviceIdNow().replace(/^app-/, '')}`);
  const lastSentNode = useRef(null);
  const lastSentAt = useRef(0);
  const [reported, setReported] = useState(false);

  useEffect(() => {
    if (!plan?.id) return undefined;
    let alive = true;
    api?.getPlanImage?.(plan.id)
      .then(r => { if (alive && r?.dataUri) setPlanImage(r.dataUri); })
      .catch(() => {});
    return () => { alive = false; };
  }, [api, plan?.id]);

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      const got = await api?.getBeaconFix?.().catch(() => null);
      if (!alive || !got) return;
      setScanner(Boolean(got.scanner));
      setMapped(got.mapped ?? 0);
      setFix(got.fix ?? null);

      const nodeId = got.fix?.nodeId;
      if (!nodeId || !tracking) return;
      // holdCount 1 · trusted — 검증 화면에서는 서버가 말하는 것을 그대로 보여 준다.
      // 안내 화면은 2회 연속을 요구하고 «걸어온 거리로 닿는가» 까지 검사해 튀는
      // 값을 걸러 내지만, 여기서는 그 걸러 내는 동작 자체가 «전파가 얼마나
      // 흔들리나» 를 감춘다. 게다가 이 화면은 걸음을 안 세므로 거리 검사에 쓸
      // 근거가 아예 없다 — 예산이 6걸음에 묶여 모든 이동이 «순간이동» 으로
      // 분류되고, 그래서 걸어도 점이 안 따라왔다.
      tracking.pushRemoteFix(nodeId, { holdCount: 1, trusted: true });
      bump(n => n + 1);

      // 관제로 올린다 — **이 화면도 «지금 걷고 있는 사람»** 이다.
      //
      // 안 올리면 앱에서는 점이 따라오는데 관제 지도는 마지막 안내 때 자리에
      // 붙박여 있다. 답사가 되는지 보려고 걷는 사람이 정작 관제에서는 안 보이는
      // 셈이라, 두 화면을 나란히 놓고 맞춰 볼 수가 없다.
      //
      // phase 를 `survey` 로 둔다. `guiding` 으로 보내면 보호자에게 «대피를
      // 시작했습니다» 알림이 나가고 상단 «대피 중» 숫자가 올라간다 — 답사는
      // 화재가 아니다.
      const pos = tracking.position();
      const now = Date.now();
      if (pos && Number.isFinite(pos.x)
          && (nodeId !== lastSentNode.current || now - lastSentAt.current > REPORT_MS)) {
        lastSentNode.current = nodeId;
        lastSentAt.current = now;
        const here = pos.nodeId ?? nodeId;
        const sent = api?.updatePosition?.(userId.current, {
          nodeId: here,
          nodeName: plan?.nodes?.find(n => n.id === here)?.name || here,
          phase: 'survey',
          x: pos.x, y: pos.y,
          edgeId: pos.edgeId ?? null,
          progress: pos.progress ?? 0,
          confidence: tracking.confidence(),
          source: tracking.source(),
        });
        // api 가 없으면 호출 자체가 undefined 다 — 거기에 .then 을 걸면 화면이 죽는다
        sent?.then?.(r => { if (alive) setReported(Boolean(r)); }).catch?.(() => {});
      }

      if (speak && nodeId !== lastSpoken.current) {
        lastSpoken.current = nodeId;
        const name = plan?.nodes?.find(n => n.id === nodeId)?.name || nodeId;
        say(name);
      }
    };

    const mapTick = async () => {
      const m = await api?.getBeaconMap?.().catch(() => null);
      if (!alive || !m) return;
      setSpots(new Set(Object.values(m.surveyed || {})).size);
    };

    tick(); mapTick();
    const t1 = setInterval(tick, FIX_MS);
    const t2 = setInterval(mapTick, MAP_MS);
    return () => { alive = false; clearInterval(t1); clearInterval(t2); stopSpeaking(); };
  }, [api, plan, tracking, speak]);

  const nodeName = fix?.nodeId
    ? (plan?.nodes?.find(n => n.id === fix.nodeId)?.name || fix.nodeId)
    : null;
  const src = tracking?.source?.() ?? null;
  const conf = Math.round((tracking?.confidence?.() ?? 0) * 100);

  // 상태를 한 줄로 — 안 될 때 **왜** 안 되는지가 바로 읽혀야 한다.
  const status = !scanner
    ? { tone: 'bad', head: '수신기 없음', body: '맥에서 스캐너를 켜세요 (scan-beacons.py serve)' }
    : spots === 0 && mapped === 0
      ? { tone: 'warn', head: '답사 전', body: '지점에 서서 태그해야 전파가 위치를 말할 수 있습니다' }
      : !fix
        ? { tone: 'warn', head: '판정 없음', body: '답사한 지점 근처로 가 보세요' }
        : { tone: 'ok', head: nodeName, body: `${SOURCE_LABEL[src] || src} · ${fix.rssi} dBm` };

  return (
    <View style={styles.root}>
      <View style={styles.top}>
        <Pressable onPress={onClose} style={styles.back} accessibilityRole="button"
                   accessibilityLabel="닫기">
          <Text style={styles.backTx}>‹ 닫기</Text>
        </Pressable>
        <Text style={styles.title}>실시간 위치</Text>
        <Pressable onPress={() => setSpeak(v => !v)} style={styles.back}
                   accessibilityRole="switch" accessibilityState={{ checked: speak }}
                   accessibilityLabel="위치 음성 안내">
          <Text style={[styles.backTx, speak && { color: theme.accent }]}>
            {speak ? '🔊 음성' : '🔇 음성'}
          </Text>
        </Pressable>
      </View>

      {/* 지금 어디인가 — 이 화면에서 제일 큰 글씨여야 한다 */}
      <View style={[styles.card, styles[`tone_${status.tone}`]]} accessibilityLiveRegion="polite">
        <Text style={styles.where} accessibilityRole="header">{status.head}</Text>
        <Text style={styles.sub}>{status.body}</Text>
      </View>

      <View style={styles.stats}>
        <Stat label="답사 지점" value={spots} />
        <Stat label="등록 신호" value={mapped} />
        <Stat label="확신도" value={fix ? `${conf}%` : '—'} />
      </View>

      <View style={styles.mapWrap}>
        <PositionMap plan={plan} tracking={tracking} imageUri={planImage}
                     realBeacons={scanner} mapped={mapped} />
      </View>

      <ScrollView style={styles.note} contentContainerStyle={{ paddingBottom: 14 }}>
        <Text style={styles.noteTx}>
          <Text style={styles.b}>{reported ? '관제 송출 중' : '관제 송출 대기'}</Text>
          {` · ${userId.current} — 관제 지도에 「답사 중」으로 뜹니다.\n`}
          이 화면은 <Text style={styles.b}>전파만</Text> 씁니다. 걸음 추정도 가상 비콘도 끄고
          맥이 들은 신호로만 위치를 잡습니다. 그래서 점이 멈추면 그 구간은 답사가 비어 있다는
          뜻입니다 — 거기 서서 다시 태그하면 됩니다.
        </Text>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statV}>{value}</Text>
      <Text style={styles.statL}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, padding: 14, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: theme.text, fontSize: 17, fontWeight: '700' },
  back: { paddingVertical: 8, paddingHorizontal: 6, minWidth: 74 },
  backTx: { color: theme.textDim, fontSize: 15 },

  card: {
    backgroundColor: theme.surface, borderRadius: theme.radius,
    padding: 16, borderLeftWidth: 4,
  },
  tone_ok: { borderLeftColor: theme.ok },
  tone_warn: { borderLeftColor: theme.warn },
  tone_bad: { borderLeftColor: theme.danger },
  where: { color: theme.text, fontSize: 26, fontWeight: '800' },
  sub: { color: theme.textDim, fontSize: 14, marginTop: 4 },

  stats: { flexDirection: 'row', gap: 8 },
  stat: {
    flex: 1, backgroundColor: theme.surface, borderRadius: 12,
    paddingVertical: 10, alignItems: 'center',
  },
  statV: { color: theme.text, fontSize: 19, fontWeight: '700' },
  statL: { color: theme.textDim, fontSize: 11, marginTop: 2 },

  // 높이를 안 주면 flex 자식이 0 으로 접혀 지도가 사라진다
  mapWrap: {
    flex: 1, minHeight: 240, borderRadius: theme.radius,
    overflow: 'hidden', backgroundColor: theme.surface,
  },

  note: { maxHeight: 96 },
  noteTx: { color: theme.textDim, fontSize: 12.5, lineHeight: 18 },
  b: { color: theme.text, fontWeight: '700' },
});
