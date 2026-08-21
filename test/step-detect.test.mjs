// 걸음 검출: **흔든 것을 걸음으로 세지 않는가.**
//
// 이 시험이 없으면 폰을 흔드는 것만으로 위치가 앞으로 간다. 시각장애인은 걸음
// 수로 남은 거리를 믿으므로, 걷지 않았는데 세어지면 모퉁이를 지나친다.
import { StepDetector } from '../shared/step-detect.js';

let failed = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? '✅' : '❌'} ${name} ${detail}`);
  if (!cond) failed++;
}

const HZ = 50;                 // 앱과 같은 표본 주기 (20ms)
const DT = 1000 / HZ;

/**
 * 가속도 시퀀스를 만든다. 폰은 세워 든 자세(중력이 -y)로 가정한다.
 * @param axis 'v' 수직(걷기) | 'h' 수평(손을 젓는 동작)
 */
function trace({ seconds, hz, amp, axis = 'v', jitter = 0, seed = 1 }) {
  const out = [];
  let rnd = seed;
  const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const n = Math.round(seconds * HZ);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    // 간격을 흔들면 리듬이 깨진다 — 손동작을 흉내낼 때 쓴다
    const f = hz * (1 + (rand() - 0.5) * 2 * jitter);
    phase += (2 * Math.PI * f) / HZ;
    const a = amp * Math.sin(phase);
    out.push({
      t: i * DT,
      x: axis === 'h' ? a : 0,
      y: -1 + (axis === 'v' ? a : 0),   // 중력 1g + 수직 성분
      z: 0,
    });
  }
  return out;
}

function count(samples, opts) {
  const d = new StepDetector(opts);
  let steps = 0;
  for (const s of samples) steps += d.push(s, s.t);
  return steps;
}

// 1) 보통 걷기 — 1.8걸음/초, 수직 0.35g
{
  const s = trace({ seconds: 10, hz: 1.8, amp: 0.35, axis: 'v' });
  const got = count(s);
  const want = 18;
  expect('걷기를 센다', Math.abs(got - want) <= 2, `${got}걸음 (기대 ${want}±2)`);
}

// 2) 손으로 좌우로 흔들기 — 세지만 수직이 아니다
{
  const got = count(trace({ seconds: 10, hz: 3, amp: 0.8, axis: 'h' }));
  expect('좌우로 흔들면 안 센다', got === 0, `${got}걸음`);
}

// 3) 불규칙하게 털기 — 세기도 빠르기도 걷기 범위를 벗어난다
{
  const got = count(trace({ seconds: 10, hz: 5, amp: 1.6, axis: 'v', jitter: 0.5 }));
  expect('세게 터는 동작은 안 센다', got === 0, `${got}걸음`);
}

// 4) 서 있을 때의 미세한 흔들림
{
  const got = count(trace({ seconds: 10, hz: 1.2, amp: 0.08, axis: 'v' }));
  expect('가만히 있으면 안 센다', got === 0, `${got}걸음`);
}

// 5) 위아래로 규칙적으로 흔들기 — 사람이 실제로 하는 그 동작
{
  const got = count(trace({ seconds: 10, hz: 3, amp: 0.6, axis: 'v' }));
  expect('위아래로 흔들어도 안 센다', got === 0, `${got}걸음`);
}

// 6) 걸음을 버리지 않는다 — 리듬 확인에 쓴 것도 결국 세어져야 한다
{
  const s = trace({ seconds: 4, hz: 2, amp: 0.4, axis: 'v' });
  const got = count(s);
  expect('리듬 확인에 쓴 걸음도 세어진다', got >= 7, `8걸음 중 ${got}걸음`);
}

// 7) 멈췄다 다시 걸어도 이어서 센다
{
  const a = trace({ seconds: 5, hz: 1.8, amp: 0.35 });
  const gap = trace({ seconds: 3, hz: 1.8, amp: 0.02 });   // 서 있는 구간
  const b = trace({ seconds: 5, hz: 1.8, amp: 0.35 });
  let t = 0;
  const joined = [...a, ...gap, ...b].map(s => ({ ...s, t: (t += DT) }));
  const got = count(joined);
  expect('멈췄다 다시 걸어도 센다', got >= 15, `${got}걸음 (기대 18±3)`);
}

console.log(failed === 0 ? '\n걸음 검출 통과' : `\n실패 ${failed}건`);
process.exit(failed === 0 ? 0 : 1);
