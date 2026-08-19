/**
 * 내 위치 지도 — **측위가 실제로 되는지 눈으로 보는 화면.**
 *
 * ## 시각장애인용이 아니다
 *
 * 이 앱의 안내는 소리와 진동으로 나간다. 지도는 **동행하는 사람과 만드는 사람**을
 * 위한 것이다. 화살표 하나로는 "위치가 맞게 잡히고 있나"를 확인할 수 없는데,
 * 그걸 확인하지 못하면 측위가 되는지 안 되는지 영영 모른다.
 *
 * ## 무엇을 보여주는가
 *
 *   회색 선      통로
 *   초록 굵은 선  지금 안내 중인 경로
 *   점           지금 내 위치 — **색이 곧 무엇으로 알아냈는지다**
 *   부채꼴       폰이 향한 방향 (나침반)
 *   흐린 점들     아직 버리지 않은 다른 후보 (판단 계층이 들고 있는 것)
 *
 * 후보를 함께 그리는 이유: 점 하나만 보면 "확신하는 척"으로 보인다. 갈림길에서
 * 후보가 갈렸다가 한쪽으로 모이는 것이 보여야 **왜 확신도가 오르내리는지** 읽힌다.
 */

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Image as SvgImage, Path, Polyline, Text as SvgText } from 'react-native-svg';

import { elbowPoints } from '../orthogonal';
import { theme } from '../theme';

const SOURCE_COLOR = {
  beacon: '#0090ff',     // 비콘이 방금 확정
  barometer: '#a855f7',  // 층 이동으로 확정
  magnetic: '#22c55e',   // 지자기 지문이 확정
  manual: '#f3f4f6',     // 사람이 알려줌
  pdr: '#ff9500',        // 걸음으로 추정 중
};

const SOURCE_LABEL = {
  beacon: '비콘', barometer: '기압계', magnetic: '지자기',
  manual: '직접 지정', pdr: '걸음 추정',
};

export default function PositionMap({ plan, route, tracking, heading, imageUri = null,
                                     walls = null, routePoints = null,
                                     scenario = null, scenarioPosition = null,
                                     realBeacons = false, mapped = 0 }) {
  // 보이는 영역.
  //
  // 도면 사진이 있으면 **사진 전체**를 기준으로 잡는다. 판독기가 낸 좌표가 사진의
  // 픽셀 좌표라서, 사진과 지점이 같은 자리에 겹치려면 좌표계를 사진에 맞춰야 한다.
  // 사진이 없을 때만 지점 범위로 만든다.
  const box = useMemo(() => {
    const img = plan?.image;
    if (img?.width > 0 && img?.height > 0) {
      return { minX: 0, minY: 0, w: img.width, h: img.height,
               s: Math.max(img.width, img.height) / 55 };
    }
    const ns = plan?.nodes || [];
    if (!ns.length) return null;
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
    const pad = Math.max(...xs.map(Math.abs), ...ys.map(Math.abs)) * 0.06 + 4;
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - minX + pad, h = Math.max(...ys) - minY + pad;
    return { minX, minY, w, h, s: Math.max(w, h) / 40 };
  }, [plan]);

  if (!box) {
    // 조용히 사라지면 "지도가 안 그려진다"만 남고 이유를 알 수 없다.
    return (
      <View style={[s.wrap, s.empty]}
            accessibilityRole="image"
            accessibilityLabel={plan ? '지도. 도면에 지점이 없습니다' : '지도. 도면을 아직 받지 못했습니다'}>
        <Text style={s.emptyText}>
          {plan ? '도면에 지점이 없습니다' : '도면을 아직 받지 못했습니다'}
        </Text>
      </View>
    );
  }

  const trackedPos = tracking?.position?.() ?? null;
  const pos = scenario
    ? (scenarioPosition || { x: scenario.current[0], y: scenario.current[1], nodeId: null })
    : trackedPos;
  const conf = tracking?.confidence?.() ?? 0;
  const src = tracking?.source?.() ?? 'pdr';
  const color = scenario ? theme.map.route : (SOURCE_COLOR[src] || SOURCE_COLOR.pdr);

  // 나침반 방위(자북 기준) → 도면 방위(도면 위쪽 기준).
  // northOffset 이 없으면 옮길 수 없으므로 null 로 두고 그리지 않는다.
  const north = Number.isFinite(plan?.northOffset) ? plan.northOffset : null;
  const planHeading = (Number.isFinite(heading) && north !== null)
    ? ((heading - north) % 360 + 360) % 360
    : null;
  const cands = tracking?.fusion?.snapshot?.().slice(0, 8) ?? [];
  const node = id => plan.nodes.find(n => n.id === id);
  const shownRoute = scenario
    ? scenario.route.map(([x, y]) => ({ x, y }))
    : routePoints;
  const scenarioBeacons = scenario
    ? (scenarioPosition?.beacons || [])
    : [];
  const strongestScenarioBeacon = scenarioBeacons
    .filter(b => Number.isFinite(b.rssi))
    .sort((a, b) => b.rssi - a.rssi)[0] || null;

  // 지도를 **읽어 준다.**
  //
  // 스크린리더에게 그림은 존재하지 않는다. 189줄짜리 화면이 통째로 침묵하는 셈이라,
  // 시각장애인은 «지금 어디인지» 를 화면에서 얻을 길이 없었다. 픽셀을 설명할 수는
  // 없으니 **뜻만 한 줄로** 준다 — 어디에 있고, 무엇으로 잡았고, 얼마나 믿을 만한가.
  const hereName = scenario ? 'FR 앞 현재 위치'
    : pos?.nodeId
      ? (plan?.nodes?.find(n => n.id === pos.nodeId)?.name || pos.nodeId)
      : null;
  const mapLabel = hereName
    ? `지도. 현재 위치 ${hereName}. ${SOURCE_LABEL[src] || src}, 확신도 ${Math.round(conf * 100)}퍼센트`
    : '지도. 아직 위치를 잡지 못했습니다';

  return (
    <View style={s.wrap}
          accessibilityRole="image"
          accessibilityLabel={mapLabel}>
      <Svg width="100%" height="100%" viewBox={`${box.minX} ${box.minY} ${box.w} ${box.h}`}
           preserveAspectRatio="xMidYMid meet">
        {/* 도면 사진 — 그 위에 점이 움직인다 */}
        {imageUri && (
          <SvgImage href={{ uri: imageUri }} x={0} y={0}
            width={plan.image.width} height={plan.image.height} preserveAspectRatio="none" />
        )}

        {/* 통로 — 배경이다. 갈 길은 이 위에 따로 그린다. */}
        {!scenario && plan.edges.map(e => {
          const a = node(e.a), b = node(e.b);
          if (!a || !b) return null;
          // 직각으로 꺾어 복도를 따라가게 그린다.
          //
          // 한때 경로만 곧게 그렸다. 직각으로 꺾으면 «그린 방향» 과 «안내 방향» 이
          // 최대 89° 어긋났기 때문이다. 그런데 그건 안내가 곧은 선을 전제로 하고
          // 있었던 탓이지 그림 탓이 아니었다. 지금은 **꺾임점이 경로의 정식 지점**
          // 이라 안내가 «우측으로 가다가 좌측으로 꺾으세요» 로 나온다 — 그림과
          // 안내가 같은 길을 말한다. 기하는 `shared/orthogonal.js` 한 곳이다.
          return (
            <Polyline key={e.id} points={elbowPoints(a, b, { walls })} fill="none"
              stroke={theme.map.corridor}
              strokeOpacity={imageUri ? 0.75 : 0.5}
              strokeWidth={box.s * 0.32}
              strokeLinecap="round" strokeLinejoin="round" />
          );
        })}

        {/* 대피 경로 — **안내 계층이 실제로 안내하는 그 길.**
            두 겹으로 그린다. 번짐을 깔아야 도면 선 위에서 뜬다 — 한 겹만 그리면
            복도 선과 굵기만 다른 선이 되어 «어느 게 갈 길인가» 가 안 갈린다.

            지점을 잇는 통로를 강조하는 방식으로는 이걸 그릴 수 없다. 벽을 피해
            찾은 길은 통로 위를 그대로 가지 않기 때문이다. 그래서 안내하는 쪽
            (`RouteFollower.waypoints`)이 만든 꼭짓점을 **그대로 받아** 그린다.
            같은 값을 그리므로 화면과 말이 갈라질 수 없다 — 예전에 지도만 꺾고
            안내는 곧게 가서 최대 89° 어긋난 적이 있다. */}
        {shownRoute?.length > 1 && (
          <G>
            <Polyline points={shownRoute.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={theme.map.route}
              strokeOpacity={0.28} strokeWidth={box.s * 1.8}
              strokeLinecap="round" strokeLinejoin="round" />
            <Polyline points={shownRoute.map(p => `${p.x},${p.y}`).join(' ')}
              fill="none" stroke={theme.map.route}
              strokeOpacity={1} strokeWidth={box.s * 0.75}
              strokeLinecap="round" strokeLinejoin="round" />
          </G>
        )}

        {/* 서버 답사에 이미 매핑된 기존 비콘 위치. 숫자는 그 위치의 신호원 수다. */}
        {scenario && scenarioBeacons.map(beacon => {
          const count = beacon.count || beacon.beaconIds?.length || 1;
          const value = Number.isFinite(beacon.rssi) ? `${beacon.rssi} dBm` : '';
          return (
            <G key={beacon.id}>
              <Circle cx={beacon.x} cy={beacon.y} r={box.s * 1.5}
                fill={theme.map.beacon} fillOpacity={0.1} />
              <Circle cx={beacon.x} cy={beacon.y} r={box.s * 0.72}
                fill="none" stroke={theme.map.beacon} strokeWidth={box.s * 0.18} />
              <SvgText x={beacon.x} y={beacon.y + box.s * 0.28}
                fontSize={box.s * 0.72} fill={theme.map.beacon} fontWeight="700"
                textAnchor="middle">{count}</SvgText>
              {value ? <SvgText x={beacon.x} y={beacon.y - box.s * 1.05}
                fontSize={box.s * 0.72} fill="#e4bdff" fontWeight="700"
                textAnchor="middle">{value}</SvgText> : null}
            </G>
          );
        })}

        {/* 사진 시나리오의 화재 — 앱도 관제와 같은 빨간 원 하나만 쓴다. */}
        {scenario && (
          <G>
            <Circle cx={scenario.fire[0]} cy={scenario.fire[1]} r={box.s * 3.2}
              fill={theme.map.danger} fillOpacity={0.2}
              stroke={theme.map.danger} strokeWidth={box.s * 0.7} />
            <Circle cx={scenario.fire[0]} cy={scenario.fire[1]} r={box.s * 1.2}
              fill={theme.map.danger} />
          </G>
        )}

        {/* 지점 — 출구만 눈에 띄게 */}
        {plan.nodes.filter(n => !scenario || n.id === scenario.exitNodeId).map(n => (
          <Circle key={n.id} cx={n.x} cy={n.y} r={box.s * (n.type === 'exit' ? 0.75 : 0.45)}
            fill={n.type === 'exit' ? theme.map.exit : theme.map.node}
            fillOpacity={n.type === 'exit' ? 1 : 0.7} />
        ))}

        {/* 아직 버리지 않은 후보들 — 갈림길에서 갈렸다가 모이는 것이 보여야 한다 */}
        {!scenario && cands.map((c, i) => {
          const a = node(c.from), b = node(c.to);
          if (!a || !b || c.weight < 0.02) return null;
          const t = c.steps > 0 ? c.step / c.steps : 1;
          return (
            <Circle key={i} cx={a.x + (b.x - a.x) * t} cy={a.y + (b.y - a.y) * t}
              r={box.s * 0.5} fill={color} fillOpacity={Math.min(0.5, c.weight * 0.5)} />
          );
        })}

        {/* 내 위치 */}
        {pos && (
          <G>
            {/* 확신도가 낮을수록 넓게 — "이 안 어딘가"를 크기로 말한다 */}
            <Circle cx={pos.x} cy={pos.y} r={box.s * (1.4 + (1 - conf) * 3.2)}
              fill={color} fillOpacity={0.16} />
            {/* **나침반 방위를 그대로 그리면 안 된다.**
                heading 은 자북 기준이고 이 그림은 도면 기준이다. 둘을 잇는 값이
                도면의 northOffset 인데, 그걸 빼지 않고 그려서 화면의 부채꼴이
                실제 향한 쪽과 어긋나 있었다. 보정을 모르면 **아예 안 그린다** —
                모르는 방향을 그리면 보는 사람이 그걸 믿는다. */}
            {Number.isFinite(planHeading) && (
              <Fan x={pos.x} y={pos.y} deg={planHeading} r={box.s * 4} color={color} />
            )}
            <Circle cx={pos.x} cy={pos.y} r={box.s * 1.1}
              fill={color} stroke="#fff" strokeWidth={box.s * 0.22} />
          </G>
        )}

        {(pos?.nodeId || scenario) && (
          <SvgText x={pos.x} y={pos.y - box.s * 2} fontSize={box.s * 1.5}
            fill={color} fontWeight="700" textAnchor="middle">
            {scenario ? '현재 위치' : (node(pos.nodeId)?.name ?? pos.nodeId)}
          </SvgText>
        )}
      </Svg>

      <View style={s.bar}>
        <Dot color={color} />
        <Text style={s.src}>{SOURCE_LABEL[src] || src}</Text>
        <Text style={s.conf}>확신도 {(conf * 100).toFixed(0)}%</Text>
        <Text style={s.deg}>
          {!Number.isFinite(heading) ? '방위 없음'
            : north === null ? `${Math.round(heading)}° · 북쪽 보정 없음`
            : `${Math.round(planHeading)}°`}
        </Text>
      </View>
      <View style={s.bar}>
        {/* 비콘 이야기는 비콘 색으로. theme.ok(민트)를 쓰면 출구와 같은 색이라
            «출구 관련 표시인가» 로 읽힌다 — 지도에서 겪은 그 혼동이다. */}
        <Text style={[s.src, { color: scenario || realBeacons ? theme.map.beacon : theme.warn }]}>
          {scenario ? '기존 비콘' : realBeacons ? '실제 전파' : '가상 비콘'}
        </Text>
        <Text style={s.conf}>
          {scenario
            ? `${scenarioBeacons.length}지점${strongestScenarioBeacon ? ` · 최강 ${strongestScenarioBeacon.rssi} dBm` : ''}`
            : realBeacons ? `신호원 ${mapped}개 확정` : '수신기 없음'}
        </Text>
      </View>
    </View>
  );
}

/** 폰이 향한 방향. 도면 위쪽이 자북이라는 전제(northOffset)는 상위가 이미 맞춰 넘긴다. */
/**
 * 폰이 향한 쪽.
 *
 * 넓은 부채로 그린다 — 방위는 실내에서 흔들리는 값이라, 바늘처럼 한 줄로 그으면
 * 실제보다 확실해 보인다. 부채의 폭이 «이 안 어딘가» 를 말한다.
 */
function Fan({ x, y, deg, r, color }) {
  const half = 26;
  const p = a => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${x + r * Math.cos(rad)},${y + r * Math.sin(rad)}`;
  };
  return (
    <Path d={`M ${x},${y} L ${p(deg - half)} L ${p(deg)} L ${p(deg + half)} Z`}
      fill={color} fillOpacity={0.25} />
  );
}

const Dot = ({ color }) => <View style={[s.dot, { backgroundColor: color }]} />;

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#0f1520', borderRadius: theme.radius, overflow: 'hidden' },
  empty: { alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: theme.textDim, fontSize: 14 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  src: { color: theme.text, fontSize: 13.5, fontWeight: '700' },
  conf: { color: theme.textDim, fontSize: 13, marginLeft: 'auto' },
  deg: { color: theme.textDim, fontSize: 13, fontVariant: ['tabular-nums'] },
});
