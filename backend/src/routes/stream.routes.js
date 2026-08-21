import { Router } from 'express';
import { events, TOPICS } from '../events.js';
import { temperatureHazard, isStale } from '../../../shared/hazard-rules.js';
import { currentHazards } from '../floor.js';
import { getRepo } from '../repositories/index.js';

export const streamRoutes = Router();

/**
 * SSE 실시간 스트림 — 사용자 앱·관제 대시보드·보호자 화면이 함께 구독한다.
 * 접속 즉시 현재 상태를 한 번 내려주고(초기 동기화), 이후 변경분만 push.
 * WebSocket 대신 SSE를 쓴 이유: 서버→클라이언트 단방향이면 충분하고,
 * 프록시·방화벽 환경에서 재연결이 브라우저 기본 동작으로 처리되기 때문.
 *
 * ?code=XXXXXX 를 붙이면 **보호자 스코프**로 동작한다.
 * 코드에 연결된 대상자의 위치·구조요청·알림만 내려가고, 다른 대피자의 정보와
 * 운영 지표(metrics)는 전달하지 않는다 — 보호자는 자신이 돌보는 사람만 봐야 한다.
 */
streamRoutes.get('/stream', async (req, res) => {
  const repo = await getRepo();

  let watchedUserId = null;
  if (req.query.code) {
    const guardian = await repo.getGuardianByCode(req.query.code);
    if (!guardian) return res.status(404).json({ error: '유효하지 않은 보호자 코드입니다.' });
    watchedUserId = guardian.userId;
  }

  const mine = list => (list || []).filter(item => item.userId === watchedUserId);
  const scope = {
    hazards: h => h,   // 지도를 그리려면 위험 상태는 필요하다
    plan: p => p,
    sensors: s => s,
    positions: list => (watchedUserId ? mine(list) : list),
    sos: list => (watchedUserId ? mine(list) : list),
    alerts: list => (watchedUserId ? mine(list) : list),
    metrics: list => (watchedUserId ? [] : list), // 운영 지표는 보호자에게 노출하지 않는다
    beaconMap: list => (watchedUserId ? [] : list), // 답사 결과는 관제만 본다
    beaconFix: f => f,                              // 실제 전파가 잡은 지점 — 폰이 앵커로 쓴다
  };

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (topic, data) => {
    // 여기서 던지면 EventEmitter 가 예외를 그대로 올려 **서버 프로세스가 죽는다.**
    // 실제로 새 주제를 추가하면서 scope 에 넣는 것을 빠뜨렸다가 백엔드가 내려갔다.
    // 화면 하나에 보내는 데 실패한 것이 전체를 멈출 이유는 없다.
    try {
      const shape = scope[topic] || (v => v);
      res.write(`event: ${topic}\n`);
      res.write(`data: ${JSON.stringify(shape(data))}\n\n`);
    } catch (e) {
      console.warn(`[stream] ${topic} 전송 실패:`, e?.message);
    }
  };

  const annotate = sensors => {
    const now = Date.now();
    return sensors.map(s => ({ ...s, hazard: temperatureHazard(s.celsius), stale: isStale(s, now) }));
  };

  /**
   * 위험 상태는 관제 입력과 센서 판독을 합친 값이라, 둘 중 무엇이 바뀌든
   * 다시 계산해서 내보내야 한다. 클라이언트가 두 출처를 직접 합치게 두면
   * 임계값 기준이 프론트와 백엔드로 갈라진다.
   */
  const sendMergedHazards = async () => send('hazards', await currentHazards());

  send('plan', await repo.getActivePlan());
  await sendMergedHazards();
  send('sensors', annotate(await repo.getSensors()));
  send('sos', await repo.getSOS());
  send('positions', await repo.getPositions());
  send('metrics', await repo.getMetrics());
  send('alerts', await repo.getAlerts());

  const handlers = {};
  for (const topic of TOPICS) {
    handlers[topic] =
      topic === 'hazards' ? () => sendMergedHazards()
      : topic === 'sensors' ? data => { send('sensors', annotate(data)); sendMergedHazards(); }
      : data => send(topic, data);
    events.on(topic, handlers[topic]);
  }

  // 유휴 연결이 프록시에 끊기지 않도록 주석 프레임 전송
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    for (const topic of TOPICS) events.off(topic, handlers[topic]);
  });
});
