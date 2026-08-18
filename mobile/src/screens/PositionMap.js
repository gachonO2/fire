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
import Svg, { Circle, G, Image as SvgImage, Line, Path, Text as SvgText } from 'react-native-svg';

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
      <View style={[s.wrap, s.empty]}>
        <Text style={s.emptyText}>
          {plan ? '도면에 지점이 없습니다' : '도면을 아직 받지 못했습니다'}
        </Text>
      </View>
    );
  }

  const pos = tracking?.position?.() ?? null;
  const conf = tracking?.confidence?.() ?? 0;
  const src = tracking?.source?.() ?? 'pdr';
  const color = SOURCE_COLOR[src] || SOURCE_COLOR.pdr;
  const cands = tracking?.fusion?.snapshot?.().slice(0, 8) ?? [];
  const node = id => plan.nodes.find(n => n.id === id);
  const routeEdges = new Set(route?.edges || []);

  return (
    <View style={s.wrap}>
      <Svg width="100%" height="100%" viewBox={`${box.minX} ${box.minY} ${box.w} ${box.h}`}
           preserveAspectRatio="xMidYMid meet">
        {/* 도면 사진 — 그 위에 점이 움직인다 */}
        {imageUri && (
          <SvgImage href={{ uri: imageUri }} x={0} y={0}
            width={plan.image.width} height={plan.image.height} preserveAspectRatio="none" />
        )}

        {/* 통로 */}
        {plan.edges.map(e => {
          const a = node(e.a), b = node(e.b);
          if (!a || !b) return null;
          const on = routeEdges.has(e.id);
          return (
            <Line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={on ? theme.ok : (imageUri ? 'rgba(120,190,255,0.55)' : 'rgba(255,255,255,0.22)')}
              strokeWidth={box.s * (on ? 0.7 : 0.32)} strokeLinecap="round" />
          );
        })}

        {/* 지점 — 출구만 눈에 띄게 */}
        {plan.nodes.map(n => (
          <Circle key={n.id} cx={n.x} cy={n.y} r={box.s * (n.type === 'exit' ? 0.75 : 0.45)}
            fill={n.type === 'exit' ? theme.ok : 'rgba(255,255,255,0.35)'} />
        ))}

        {/* 아직 버리지 않은 후보들 — 갈림길에서 갈렸다가 모이는 것이 보여야 한다 */}
        {cands.map((c, i) => {
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
            {Number.isFinite(heading) && (
              <Fan x={pos.x} y={pos.y} deg={heading} r={box.s * 4} color={color} />
            )}
            <Circle cx={pos.x} cy={pos.y} r={box.s * 1.1}
              fill={color} stroke="#fff" strokeWidth={box.s * 0.22} />
          </G>
        )}

        {pos?.nodeId && (
          <SvgText x={pos.x} y={pos.y - box.s * 2} fontSize={box.s * 1.5}
            fill={color} fontWeight="700" textAnchor="middle">
            {node(pos.nodeId)?.name ?? pos.nodeId}
          </SvgText>
        )}
      </Svg>

      <View style={s.bar}>
        <Dot color={color} />
        <Text style={s.src}>{SOURCE_LABEL[src] || src}</Text>
        <Text style={s.conf}>확신도 {(conf * 100).toFixed(0)}%</Text>
        <Text style={s.deg}>
          {Number.isFinite(heading) ? `${Math.round(heading)}°` : '방위 없음'}
        </Text>
      </View>
      <View style={s.bar}>
        <Text style={[s.src, { color: realBeacons ? theme.ok : theme.warn }]}>
          {realBeacons ? '실제 전파' : '가상 비콘'}
        </Text>
        <Text style={s.conf}>{realBeacons ? `신호원 ${mapped}개 확정` : '수신기 없음'}</Text>
      </View>
    </View>
  );
}

/** 폰이 향한 방향. 도면 위쪽이 자북이라는 전제(northOffset)는 상위가 이미 맞춰 넘긴다. */
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
