/**
 * **한 번 걸어서 답사를 만든다.**
 *
 * ## 왜 필요한가
 *
 * 지금 답사는 «지점마다 서서 10초 태그» 다. 기기 광고 주기가 0.3~0.9회/초라
 * 표본 3개에 최소 3.3초가 걸리고, 42지점이면 사람이 건물을 훑는 데 한 시간이
 * 넘는다. 그것도 **기기 하나당** 그렇다 — Web Bluetooth 의 `device.id`,
 * macOS 의 peripheral UUID, iOS 의 identifier 가 전부 (기기, 출처)마다 다른
 * 값이라 맥북으로 만든 답사를 폰이 물려받을 수 없기 때문이다.
 *
 * 그래서 답사를 사람 손에서 떼어내야 한다. 안 그러면 폰을 한 대 늘릴 때마다
 * 건물을 한 바퀴 더 돌아야 한다.
 *
 * ## 방위를 안 쓴다 — 이게 이 파일의 핵심이다
 *
 * 보통 걸음추측항법(PDR)은 «걸음 수 × 보폭» 과 «나침반 방위» 로 위치를
 * 잇는다. 그런데 실내에서 자기나침반은 철골·배전반·엘리베이터 때문에 수십 도
 * 씩 틀어지고, 그 오차가 **누적**되어 60m 복도 끝에서 자리를 통째로 잃는다.
 *
 * 우리는 방위가 필요 없다. **어디서 출발해 어디로 갔는지 사람이 두 번
 * 찍어 주기 때문이다.** 그 두 점 사이의 길은 도면 그래프가 이미 알고 있다.
 * 그러면 남은 미지수는 «그 길 위 어디쯤인가» 하나뿐이고, 그건 걸음 수의
 * 비율로 답이 된다.
 *
 *     사람이 하는 일     출발 탭 → 걷기 → 도착 탭        (2번)
 *     기계가 하는 일     걸음 세기 + 전파 받기 + 붙이기
 *
 * 걸음 수는 가속도만 쓰므로 자기장 왜곡과 무관하다. 보폭이 사람마다 달라도
 * **비율만 쓰기 때문에** 상관없다 — 총 120걸음 중 30걸음째면 경로의 25%
 * 지점이고, 보폭이 0.6m 든 0.8m 든 25%는 25%다.
 *
 * ## 그래도 틀릴 수 있는 것
 *
 * 중간에 멈춰 서 있으면 걸음이 안 늘어 그 자리에 오래 머문 것으로 나오는데,
 * 실제로도 그 자리에 있었으므로 맞다. 반대로 **되돌아 걸으면** 틀린다 —
 * 걸음은 늘어나는데 위치는 되돌아가기 때문이다. 그래서 답사 걷기는
 * «한 방향으로 쭉» 이어야 하고, 이 사실은 화면이 말해 줘야 한다.
 *
 * ## 붙이는 규칙
 *
 * 한 기기가 여러 지점에서 들린다. 그중 **제일 세게 들린 지점**에 붙인다.
 * 가장 센 신호가 곧 제일 가까운 곳이라는, 측위 계층과 같은 전제다.
 * 다만 어디서나 비슷하게 약하게 들리는 기기는 붙이지 않는다 — 그런 기기는
 * 지점을 못 가르므로 매핑에 넣으면 판정만 흐려진다.
 */

/** 최고와 최저의 차이가 이보다 작으면 «어디서나 비슷» 으로 보고 버린다 */
export const MIN_CONTRAST_DB = 6;
/** 이보다 적게 들린 기기는 우연일 수 있다 */
export const MIN_SAMPLES = 3;
/** 이보다 약한 신호는 지점을 가르는 데 못 쓴다 */
export const MIN_RSSI = -95;

/**
 * 경로 위 노드들의 **누적 거리**. 진행률을 지점으로 바꾸는 자다.
 * @param {Array<{id:string,x:number,y:number}>} nodes 지나갈 순서대로
 */
export function routeMetrics(nodes = []) {
  const cum = [0];
  for (let i = 1; i < nodes.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].y - nodes[i - 1].y));
  }
  return { cum, total: cum.at(-1) ?? 0 };
}

/**
 * 진행률(0~1) 에서 **가장 가까운 지점**.
 *
 * 경로 위 한 점을 좌표로 낸 다음 그 점에 제일 가까운 노드를 고른다.
 * 노드 사이를 지나는 동안에는 앞뒤 중 가까운 쪽에 붙으므로, 지점 «구역»
 * 이 저절로 절반씩 나뉜다.
 */
export function nodeAtProgress(nodes, progress) {
  if (!nodes.length) return null;
  if (nodes.length === 1) return nodes[0];
  const { cum, total } = routeMetrics(nodes);
  if (!total) return nodes[0];
  const d = Math.max(0, Math.min(1, progress)) * total;
  let best = nodes[0];
  let bestGap = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const gap = Math.abs(cum[i] - d);
    if (gap < bestGap) { bestGap = gap; best = nodes[i]; }
  }
  return best;
}

/**
 * 걷기 한 번을 답사로 굽는다.
 *
 * @param {Array<{id:string,x:number,y:number}>} routeNodes 출발→도착 순서
 * @param {Array<{steps:number, readings:Array<{beaconId:string,rssi:number}>}>} samples
 *        걸으며 올린 것들. `steps` 는 **출발부터 누적된** 걸음 수다.
 * @returns {{mapping:Object<string,string>, spots:Object<string,number>,
 *            devices:number, kept:number, dropped:Array}}
 */
export function bakeWalk(routeNodes = [], samples = [], opts = {}) {
  const minContrast = opts.minContrastDb ?? MIN_CONTRAST_DB;
  const minSamples = opts.minSamples ?? MIN_SAMPLES;
  const minRssi = opts.minRssi ?? MIN_RSSI;

  const totalSteps = samples.reduce((m, s) => Math.max(m, Number(s?.steps) || 0), 0);
  // 걸음이 하나도 안 세어졌다면 «한 자리에 서 있었다» 는 뜻이다. 그때는
  // 출발 지점 하나짜리 답사가 되고, 그것도 쓸모가 있다(그 자리는 확실하다).
  const denom = totalSteps || 1;

  /** beaconId → nodeId → 그 지점에서 받은 RSSI 들 */
  const byDevice = new Map();
  for (const s of samples) {
    const node = nodeAtProgress(routeNodes, (Number(s?.steps) || 0) / denom);
    if (!node) continue;
    for (const r of s?.readings || []) {
      const rssi = Number(r?.rssi);
      if (!r?.beaconId || !Number.isFinite(rssi)) continue;
      const perNode = byDevice.get(r.beaconId) || new Map();
      const arr = perNode.get(node.id) || [];
      arr.push(rssi);
      perNode.set(node.id, arr);
      byDevice.set(r.beaconId, perNode);
    }
  }

  const mapping = {};
  const spots = {};
  const dropped = [];
  for (const [beaconId, perNode] of byDevice) {
    // 지점마다 중앙값 — 원시 RSSI 는 서 있어도 ±10dBm 튀고 그 튐이 이상치로 온다
    const scored = [...perNode].map(([nodeId, arr]) => [nodeId, median(arr), arr.length]);
    const n = scored.reduce((a, s) => a + s[2], 0);
    if (n < minSamples) { dropped.push({ beaconId, why: 'few-samples', n }); continue; }

    scored.sort((a, b) => b[1] - a[1]);
    const [bestNode, bestRssi] = scored[0];
    const worstRssi = scored.at(-1)[1];

    if (bestRssi < minRssi) { dropped.push({ beaconId, why: 'too-weak', rssi: bestRssi }); continue; }
    // 지점이 하나뿐이면 대비를 잴 수 없다. 그 지점에서만 들렸다는 뜻이므로
    // 오히려 지점을 잘 가르는 기기다 — 통과시킨다.
    if (scored.length > 1 && bestRssi - worstRssi < minContrast) {
      dropped.push({ beaconId, why: 'flat', contrast: +(bestRssi - worstRssi).toFixed(1) });
      continue;
    }
    mapping[beaconId] = bestNode;
    spots[bestNode] = (spots[bestNode] || 0) + 1;
  }

  return {
    mapping,
    spots,
    devices: byDevice.size,
    kept: Object.keys(mapping).length,
    dropped,
    steps: totalSteps,
  };
}

function median(arr) {
  const v = [...arr].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
