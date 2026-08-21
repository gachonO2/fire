/**
 * 현장 측정 — **가정값을 실측으로 바꾸는 화면.**
 *
 * ## 왜 필요한가
 *
 * 지금 측위 코드에는 재보지 않은 숫자가 여럿 박혀 있다.
 *
 *   보폭      0.7 m    `demoPlan.js` 의 stepLength
 *   층고      3.5 m    `altitude.js` 의 floorHeight
 *   안정도 문턱 0.25     `GuideScreen` 의 STABILITY_FLOOR
 *
 * 이 값들이 틀리면 안내가 통째로 어긋난다. 보폭이 0.7 이 아니라 0.6 이면
 * "10미터 앞"이 실제로는 8.6미터고, 시각장애인은 그 걸음 수를 믿고 걷다가
 * 모퉁이를 지나친다.
 *
 * 그런데 앱 화면에는 걸음 수도 안정도도 안 나온다. 건물을 한 바퀴 돌고 와도
 * "보폭은 못 쟀네"가 된다. 이 화면은 그 원시값을 그대로 보여주고, 재는 절차를
 * 버튼 두 개로 만든다.
 *
 * ## 앱이 실제로 쓰는 센서를 그대로 쓴다
 *
 * `Odometry` 와 `BearingSensor` 는 안내 화면이 쓰는 바로 그 클래스다. 여기서 잰
 * 값이 곧 실제 동작이다 — 따로 만든 측정 코드로 재면 그 값이 앱에서도 나온다는
 * 보장이 없다.
 *
 * 측량하는 사람용 도구다. 시각장애인 사용자에게 보이는 화면이 아니다.
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Barometer, Magnetometer } from 'expo-sensors';

import { Odometry } from '../odometry';
import { BearingSensor } from '../bearing';
import { northFromWalk } from '../north';
import { theme } from '../theme';

/** GuideScreen 의 STABILITY_FLOOR 와 같은 값 — 이 아래면 방향 안내가 꺼진다 */
const STABILITY_FLOOR = 0.25;
/** 1 hPa ≈ 8.33 m (해수면 근처) */
const M_PER_HPA = 8.33;

export default function FieldScreen({ onClose, api = null, plan = null, onSaved = null }) {
  const odo = useRef(new Odometry()).current;
  const sensor = useRef(new BearingSensor()).current;

  const [steps, setSteps] = useState(0);
  const [heading, setHeading] = useState(null);
  const [stability, setStability] = useState(1);
  const [mag, setMag] = useState(null);
  const [alt, setAlt] = useState(null);

  // 진행 중인 측정
  const [stride, setStride] = useState(null);     // { from, meters } 또는 결과
  const [floor, setFloor] = useState(null);
  const [strideResult, setStrideResult] = useState(null);
  const [floorResult, setFloorResult] = useState(null);

  // 안정도 이력 — 방향 안내가 얼마나 자주 꺼지는지
  const stabHits = useRef({ n: 0, low: 0, min: 1 });
  const [stabPct, setStabPct] = useState(null);
  const magRange = useRef({ lo: Infinity, hi: -Infinity });

  // 축척 재기 — 도면의 두 지점 사이를 걸어 픽셀↔미터 환산을 구한다
  const [scaleFrom, setScaleFrom] = useState(null);
  const [scaleTo, setScaleTo] = useState(null);
  const [scaleRun, setScaleRun] = useState(null);
  const [scaleResult, setScaleResult] = useState(null);
  // 같은 걷기에서 북쪽 보정도 같이 나온다 — 따로 걸을 이유가 없다
  const headings = useRef(null);   // 측정 중일 때만 배열 — 평소엔 모으지 않는다
  const [northResult, setNorthResult] = useState(null);
  const [northSaved, setNorthSaved] = useState(false);
  const [saved, setSaved] = useState(false);

  const refHpa = useRef(null);
  const distance = useRef(20);   // 보폭 측정에 쓸 알려진 거리(m)

  useEffect(() => {
    let alive = true;
    let baro = null, magSub = null;

    odo.onStep = () => alive && setSteps(odo.steps);
    odo.start();
    sensor.start();

    const tick = setInterval(() => {
      if (!alive) return;
      setHeading(sensor.heading);
      setStability(sensor.stability);
      // 축척을 재는 동안의 방위를 모은다. 흔들리는 표본은 여기서 버린다 —
      // 나중에 평균 내면 이미 섞여 버려서 걸러낼 수 없다.
      if (headings.current && sensor.stability >= STABILITY_FLOOR
          && Number.isFinite(sensor.heading)) {
        headings.current.push(sensor.heading);
      }

      const h = stabHits.current;
      h.n++;
      if (sensor.stability < STABILITY_FLOOR) h.low++;
      h.min = Math.min(h.min, sensor.stability);
      setStabPct(Math.round((1 - h.low / h.n) * 100));
    }, 300);

    Barometer.isAvailableAsync().then(ok => {
      if (!ok || !alive) return;
      Barometer.setUpdateInterval(500);
      baro = Barometer.addListener(({ pressure }) => {
        if (refHpa.current === null) refHpa.current = pressure;
        setAlt(-(pressure - refHpa.current) * M_PER_HPA);
      });
    }).catch(() => {});

    Magnetometer.isAvailableAsync().then(ok => {
      if (!ok || !alive) return;
      Magnetometer.setUpdateInterval(200);
      magSub = Magnetometer.addListener(({ x, y, z }) => {
        const b = Math.sqrt(x * x + y * y + z * z);
        const r = magRange.current;
        r.lo = Math.min(r.lo, b); r.hi = Math.max(r.hi, b);
        setMag(b);
      });
    }).catch(() => {});

    return () => {
      alive = false;
      clearInterval(tick);
      baro?.remove?.();
      magSub?.remove?.();
      odo.stop();
      sensor.stop();
    };
  }, []);

  // ── 축척: 두 지점 사이를 걸어 «도면 1픽셀 = 몇 미터» 를 낸다
  //
  // 보폭은 방금 잰 값이 있으면 그걸, 없으면 도면 값을 쓴다.
  const strideM = strideResult?.stride ?? plan?.stepLength ?? 0.7;

  function scaleStart() {
    setScaleResult(null); setSaved(false);
    setNorthResult(null); setNorthSaved(false);
    headings.current = [];
    setScaleRun({ from: odo.steps });
  }
  async function scaleEnd() {
    if (!scaleRun || !scaleFrom || !scaleTo || !plan) return;
    const walked = odo.steps - scaleRun.from;
    setScaleRun(null);
    if (walked < 5) { setScaleResult({ error: '걸음이 너무 적습니다' }); return; }

    const a = plan.nodes.find(n => n.id === scaleFrom);
    const b = plan.nodes.find(n => n.id === scaleTo);
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(px > 0)) { setScaleResult({ error: '같은 지점입니다' }); return; }

    const meters = walked * strideM;
    const mpu = meters / px;
    setScaleResult({
      walked, meters, px, mpu, strideM,
      widthM: (plan.image?.width || 0) * mpu,
      before: plan.metersPerUnit,
    });

    // **같은 걷기에서 북쪽도 나온다.** A→B 를 걸었다는 사실이 이미 선언돼 있으니
    // 걷는 동안의 나침반 평균과 도면 안 각도의 차이가 곧 보정값이다.
    // 안내 화면처럼 «곧게 네 걸음이면 그 방향일 것» 이라고 추측하지 않는다 —
    // 반대로 걸어서 180° 틀어진 값이 박히는 일이 여기서는 생기지 않는다.
    const got = northFromWalk(headings.current, a, b);
    headings.current = null;
    setNorthResult({ ...got, before: plan.northOffset });
  }
  async function scaleSave() {
    if (!scaleResult?.mpu || !plan?.id) return;
    const ok = await api?.setPlanScale?.(plan.id, scaleResult.mpu,
      `걸음 ${scaleResult.walked} × 보폭 ${strideM.toFixed(3)}m`).catch(() => null);
    setSaved(!!ok);
    if (ok) await onSaved?.()?.catch?.(() => {});
  }

  async function northSave() {
    if (!Number.isFinite(northResult?.offset) || !plan?.id) return;
    const ok = await api?.setPlanNorth?.(plan.id, northResult.offset,
      `${northResult.samples}표본 · 흔들림 ${Math.round(northResult.spread)}°`).catch(() => null);
    setNorthSaved(!!ok);
    if (ok) await onSaved?.()?.catch?.(() => {});
  }

  // ── 보폭: 알려진 거리를 걷고 걸음 수로 나눈다
  function strideStart() {
    setStrideResult(null);
    setStride({ from: odo.steps, meters: distance.current });
  }
  function strideEnd() {
    if (!stride) return;
    const walked = (odo.steps) - stride.from;
    setStride(null);
    if (walked < 3) { setStrideResult({ error: '걸음이 너무 적습니다' }); return; }
    setStrideResult({ steps: walked, meters: stride.meters, stride: stride.meters / walked });
  }

  // ── 층고: 한 층 오르내리기 전후의 고도 차
  function floorStart() {
    setFloorResult(null);
    setFloor({ from: alt ?? 0, steps: odo.steps });
  }
  function floorEnd() {
    if (!floor || alt === null) return;
    const d = alt - floor.from;
    const walked = (odo.steps) - floor.steps;
    setFloor(null);
    setFloorResult({ meters: Math.abs(d), up: d > 0, steps: walked });
  }

  const r = magRange.current;
  const hasRange = Number.isFinite(r.lo) && Number.isFinite(r.hi);

  return (
    <View style={s.root}>
      <View style={s.top}>
        <Text style={s.title}>현장 측정</Text>
        <Pressable style={s.close} onPress={onClose} accessibilityRole="button">
          <Text style={s.closeText}>닫기</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        {/* 지금 값 */}
        <View style={s.grid}>
          <Cell k="걸음" v={String(steps)} />
          <Cell k="방위" v={heading === null ? '—' : `${Math.round(heading)}°`} />
          <Cell
            k="나침반 안정도"
            v={`${(stability * 100).toFixed(0)}%`}
            bad={stability < STABILITY_FLOOR}
            sub={stability < STABILITY_FLOOR ? '안내 꺼짐' : null}
          />
          <Cell k="고도(시작 대비)" v={alt === null ? '—' : `${alt >= 0 ? '+' : ''}${alt.toFixed(2)} m`} />
          <Cell k="자기장" v={mag === null ? '—' : `${mag.toFixed(1)} μT`} />
          <Cell
            k="자기장 범위"
            v={hasRange ? `${r.lo.toFixed(0)}~${r.hi.toFixed(0)}` : '—'}
            sub={hasRange && r.hi - r.lo > 8 ? '지문 여지 있음' : hasRange ? '변화 작음' : null}
          />
        </View>

        {/* ① 보폭 */}
        <Section
          title="① 보폭"
          why="지금 0.7 m 로 박혀 있다. 이게 틀리면 '10미터 앞'이 실제로 8미터가 된다."
        >
          <View style={s.chips}>
            {[10, 20, 30].map(m => (
              <Pressable key={m}
                style={[s.chip, distance.current === m && s.chipOn]}
                onPress={() => { distance.current = m; setStrideResult(x => x); }}
                accessibilityRole="button">
                <Text style={[s.chipText, distance.current === m && s.chipTextOn]}>{m} m</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.hint}>
            줄자로 잰 직선 구간의 시작에 서서 「시작」, 끝에 도착해 「도착」.
          </Text>
          <Pressable
            style={[s.btn, stride && s.btnRunning]}
            onPress={stride ? strideEnd : strideStart}
            accessibilityRole="button">
            <Text style={s.btnText}>
              {stride
                ? `도착 — ${(odo.steps) - stride.from}걸음째`
                : `${distance.current}m 걷기 시작`}
            </Text>
          </Pressable>
          {strideResult && (
            <Result
              error={strideResult.error}
              lines={strideResult.error ? [] : [
                [`${strideResult.meters} m ÷ ${strideResult.steps}걸음`, ''],
                ['보폭', `${strideResult.stride.toFixed(3)} m`],
                ['지금 값', '0.700 m'],
                ['차이', `${((strideResult.stride / 0.7 - 1) * 100).toFixed(1)} %`],
              ]}
              note="도면의 stepLength 에 이 값을 넣으세요."
            />
          )}
        </Section>

        {/* ② 층고 */}
        <Section
          title="② 층고"
          why="지금 3.5 m 로 박혀 있다. 층 이동 판정(엘리베이터·계단)이 이 값을 쓴다."
        >
          <Text style={s.hint}>
            한 층 아래(또는 위)에서 「시작」, 한 층 오르내린 뒤 「도착」.
            계단·엘리베이터 둘 다 재보면 좋습니다.
          </Text>
          <Pressable
            style={[s.btn, floor && s.btnRunning]}
            onPress={floor ? floorEnd : floorStart}
            disabled={alt === null}
            accessibilityRole="button">
            <Text style={s.btnText}>
              {floor
                ? `도착 — ${(alt - floor.from >= 0 ? '+' : '')}${(alt - floor.from).toFixed(2)} m`
                : alt === null ? '기압계 없음' : '층 이동 시작'}
            </Text>
          </Pressable>
          {floorResult && (
            <Result
              lines={[
                ['측정된 층고', `${floorResult.meters.toFixed(2)} m`],
                ['방향', floorResult.up ? '올라감' : '내려감'],
                ['이동 중 걸음', `${floorResult.steps}걸음`],
                ['판정', floorResult.steps <= 6 ? '엘리베이터' : '계단'],
              ]}
              note="altitude.js 의 floorHeight 에 이 값을 넣으세요."
            />
          )}
        </Section>

        {/* ③ 축척 */}
        <Section
          title="③ 축척 + 북쪽 (한 번 걸어 둘 다)"
          why="1픽셀이 몇 미터인지, 그리고 도면 위쪽이 실제 몇 도인지. 북쪽을 모르면 「폰을 이쪽으로 돌리세요」가 통째로 꺼진다 — 어느 쪽을 보고 서 있든 「직진」만 나온다."
        >
          {!plan ? (
            <Text style={s.hint}>도면을 아직 받지 못했습니다.</Text>
          ) : (
            <>
              <Text style={s.hint}>
                멀리 떨어진 두 지점을 고르고 그 사이를 걸으세요. 멀수록 정확합니다.
                보폭은 {strideResult ? '방금 잰 값' : '도면 값'} {strideM.toFixed(3)}m 를 씁니다.
              </Text>
              <NodePick label="시작" plan={plan} value={scaleFrom} onPick={setScaleFrom} />
              <NodePick label="도착" plan={plan} value={scaleTo} onPick={setScaleTo} />
              <Pressable
                style={[s.btn, scaleRun && s.btnRunning,
                        (!scaleFrom || !scaleTo) && { opacity: 0.4 }]}
                onPress={scaleRun ? scaleEnd : scaleStart}
                disabled={!scaleFrom || !scaleTo}
                accessibilityRole="button">
                <Text style={s.btnText}>
                  {scaleRun ? `도착 — ${odo.steps - scaleRun.from}걸음째` : '걷기 시작'}
                </Text>
              </Pressable>
              {scaleResult && (
                <>
                  <Result
                    error={scaleResult.error}
                    lines={scaleResult.error ? [] : [
                      ['걸은 거리', `${scaleResult.walked}걸음 × ${scaleResult.strideM.toFixed(3)}m = ${scaleResult.meters.toFixed(1)}m`],
                      ['도면 위 거리', `${scaleResult.px.toFixed(0)} px`],
                      ['축척', `${scaleResult.mpu.toFixed(5)} m/px`],
                      ['지금 값', `${(scaleResult.before ?? 0).toFixed(5)} m/px`],
                      ['건물 폭 환산', `${scaleResult.widthM.toFixed(1)} m`],
                    ]}
                    note="저장하면 모든 거리 안내가 이 값으로 다시 계산됩니다."
                  />
                  {!scaleResult.error && (
                    <Pressable style={[s.btn, saved && { backgroundColor: theme.ok }]}
                      onPress={scaleSave} accessibilityRole="button">
                      <Text style={s.btnText}>{saved ? '저장됨 ✓' : '이 축척으로 저장'}</Text>
                    </Pressable>
                  )}
                </>
              )}

              {/* 같은 걷기에서 북쪽도 나온다 — 방향 안내 전체가 이 값 하나에 걸려 있다 */}
              {northResult && (
                <>
                  <Result
                    error={northResult.error}
                    lines={northResult.error ? [] : [
                      ['걸으며 잰 방위', `${northResult.bearing.toFixed(0)}°`],
                      ['도면 안 각도', `${northResult.planDeg.toFixed(0)}°`],
                      ['도면 위쪽 = 실제', `${northResult.offset.toFixed(0)}°`],
                      ['지금 값', northResult.before === null || northResult.before === undefined
                        ? '없음 (방향 안내 꺼짐)' : `${Number(northResult.before).toFixed(0)}°`],
                      ['표본', `${northResult.samples}개 · 흔들림 ${Math.round(northResult.spread)}°`],
                    ]}
                    note="저장하면 진동·소리 방향 안내가 켜집니다. 지금은 이 값이 없어 꺼져 있습니다."
                  />
                  {!northResult.error && (
                    <Pressable style={[s.btn, northSaved && { backgroundColor: theme.ok }]}
                      onPress={northSave} accessibilityRole="button">
                      <Text style={s.btnText}>
                        {northSaved ? '저장됨 ✓' : '이 북쪽으로 저장'}
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
            </>
          )}
        </Section>

        {/* ④ 나침반 안정도 */}
        <Section
          title="④ 나침반 안정도"
          why="실내 철골이 자기장을 휘게 한다. 문턱 아래로 자주 떨어지면 방향 안내가 대부분 꺼진다."
        >
          <View style={s.rows}>
            <Row k="안정 비율" v={stabPct === null ? '—' : `${stabPct} %`}
                 bad={stabPct !== null && stabPct < 70} />
            <Row k="최저 안정도" v={`${(stabHits.current.min * 100).toFixed(0)} %`} />
            <Row k="표본" v={`${stabHits.current.n}`} dim />
            <Row k="안내가 꺼지는 기준" v={`${STABILITY_FLOOR * 100} % 미만`} dim />
          </View>
          <Text style={s.hint}>
            복도를 천천히 걸으며 이 화면을 켜두면 비율이 쌓입니다.
            70% 아래면 실내에서 방향 안내를 믿기 어렵다는 뜻입니다.
          </Text>
          <Pressable style={s.reset}
            onPress={() => { stabHits.current = { n: 0, low: 0, min: 1 }; setStabPct(null); }}
            accessibilityRole="button">
            <Text style={s.resetText}>기록 초기화</Text>
          </Pressable>
        </Section>

        <Text style={s.footer}>
          네 값 모두 지금은 추측입니다. 실측으로 바꿔야 「비콘 몇 개 필요한가」
          같은 계산을 믿을 수 있습니다.
        </Text>
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────── 조각

/** 지점 고르기 — 45개가 넘으므로 가로 스크롤 칩으로 둔다 */
const NodePick = ({ label, plan, value, onPick }) => (
  <View style={{ marginBottom: 10 }}>
    <Text style={s.pickLabel}>{label}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {plan.nodes.map(n => (
        <Pressable key={n.id}
          style={[s.pick, value === n.id && s.pickOn]}
          onPress={() => onPick(n.id)}
          accessibilityRole="button"
          accessibilityState={{ selected: value === n.id }}>
          <Text style={[s.pickText, value === n.id && { color: '#fff' }]}>
            {(n.name || n.id).slice(0, 14)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  </View>
);

const Cell = ({ k, v, sub, bad }) => (
  <View style={s.cell}>
    <Text style={s.cellK}>{k}</Text>
    <Text style={[s.cellV, bad && { color: theme.danger }]}>{v}</Text>
    {sub ? <Text style={[s.cellSub, bad && { color: theme.danger }]}>{sub}</Text> : null}
  </View>
);

const Section = ({ title, why, children }) => (
  <View style={s.section}>
    <Text style={s.sectionTitle}>{title}</Text>
    <Text style={s.sectionWhy}>{why}</Text>
    {children}
  </View>
);

const Row = ({ k, v, dim, bad }) => (
  <View style={s.row}>
    <Text style={s.rowK}>{k}</Text>
    <Text style={[s.rowV, dim && { color: theme.textDim, fontWeight: '400' },
                  bad && { color: theme.danger }]}>{v}</Text>
  </View>
);

const Result = ({ lines, note, error }) => (
  <View style={[s.result, error && { borderColor: theme.danger }]}>
    {error ? <Text style={{ color: theme.danger }}>{error}</Text> : null}
    {lines.map(([k, v], i) => (
      <View key={i} style={s.row}>
        <Text style={s.rowK}>{k}</Text>
        <Text style={s.rowV}>{v}</Text>
      </View>
    ))}
    {!error && note ? <Text style={s.resultNote}>{note}</Text> : null}
  </View>
);

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingHorizontal: 18, paddingTop: 8 },

  top: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  title: { flex: 1, color: theme.text, fontSize: 19, fontWeight: '800' },
  close: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
           borderWidth: 1, borderColor: theme.border },
  closeText: { color: theme.text, fontSize: 14, fontWeight: '600' },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 },
  cell: { flexGrow: 1, flexBasis: '30%', backgroundColor: theme.surface,
          borderRadius: 12, padding: 12 },
  cellK: { color: theme.textDim, fontSize: 11.5, marginBottom: 3 },
  cellV: { color: theme.text, fontSize: 21, fontWeight: '800' },
  cellSub: { color: theme.textDim, fontSize: 11, marginTop: 2 },

  section: { backgroundColor: theme.surface, borderRadius: theme.radius,
             padding: 16, marginBottom: 14 },
  sectionTitle: { color: theme.text, fontSize: 17, fontWeight: '800', marginBottom: 4 },
  sectionWhy: { color: theme.textDim, fontSize: 12.5, lineHeight: 18, marginBottom: 12 },

  chips: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  chip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10,
          backgroundColor: theme.bg },
  chipOn: { backgroundColor: theme.accent },
  chipText: { color: theme.text, fontSize: 14, fontWeight: '700' },
  chipTextOn: { color: '#fff' },

  btn: { backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 15,
         alignItems: 'center', marginTop: 4 },
  btnRunning: { backgroundColor: theme.warn },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  result: { marginTop: 12, borderRadius: 12, borderWidth: 1,
            borderColor: theme.ok, padding: 13 },
  resultNote: { color: theme.textDim, fontSize: 12, marginTop: 8, lineHeight: 17 },

  rows: { gap: 6, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'baseline', paddingVertical: 2 },
  rowK: { flex: 1, color: theme.textDim, fontSize: 13 },
  rowV: { color: theme.text, fontSize: 14.5, fontWeight: '700' },

  reset: { marginTop: 6, paddingVertical: 10, alignItems: 'center',
           borderRadius: 10, borderWidth: 1, borderColor: theme.border },
  resetText: { color: theme.textDim, fontSize: 13, fontWeight: '600' },

  pickLabel: { color: theme.textDim, fontSize: 12, marginBottom: 5 },
  pick: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9,
          backgroundColor: theme.bg, marginRight: 6 },
  pickOn: { backgroundColor: theme.accent },
  pickText: { color: theme.text, fontSize: 13, fontWeight: '600' },

  hint: { color: theme.textDim, fontSize: 12.5, lineHeight: 18, marginBottom: 10 },
  footer: { color: theme.textDim, fontSize: 12.5, lineHeight: 19, marginTop: 8 },
});
