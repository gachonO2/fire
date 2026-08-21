/**
 * 걷기 답사 화면 — 폰이 **자기 답사를 자기가 만든다.**
 *
 * ## 이 화면이 하는 일은 셋뿐이다
 *
 *   전파 받기   `WebBleScanner`      → 무엇이 얼마나 세게 들리나
 *   걸음 세기   `StepDetector`       → 출발부터 몇 걸음
 *   올리기      `/api/survey/walk/*` → 서버가 경로 위에 되짚어 붙인다
 *
 * 위치를 계산하지 않는다. 여기서 지점을 정하려 들면 «전파가 나쁜 건지 판정이
 * 나쁜 건지» 를 영영 못 가린다.
 *
 * ## 왜 걸음을 폰이 세는가
 *
 * 서버는 폰이 얼마나 걸었는지 알 수 없고, 가속도는 폰에만 있다. 반대로
 * 「어느 지점이었나」 는 도면을 든 서버라야 안다. 그래서 폰은 **걸음 수만**
 * 올리고, 그것을 지점으로 바꾸는 일은 서버가 한다.
 *
 * 방위는 안 보낸다. 실내 나침반은 철골·배전반에 수십 도씩 틀어지는데,
 * 출발과 도착을 사람이 찍어 주면 경로 모양은 도면 그래프가 이미 안다 —
 * 안 믿을 값을 굳이 섞을 이유가 없다.
 *
 * ## 안 되는 이유를 숨기지 않는다
 *
 * Web Bluetooth 는 조건이 많다(플래그·보안 컨텍스트·권한·제스처). 「지원하지
 * 않습니다」 한 줄로 뭉개면 현장에서 못 고친다. 무엇이 막았는지와 **그걸
 * 어떻게 푸는지**를 화면에 그대로 적는다.
 */

import { WebBleScanner, bleBlockedMessage, bleScanSupport } from './ble-scan.js';
import { StepDetector } from '../shared/step-detect.js';

const $ = id => document.getElementById(id);
const api = p => `/api${p}`;

let scanner = null;
let steps = 0;
let uploads = 0;
let motionOn = false;
const detector = new StepDetector();

function log(msg, cls = '') {
  const el = $('log');
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  el.innerHTML = `<span class="${cls}">${t}  ${msg}</span>\n` + el.innerHTML;
}

async function post(path, body) {
  const r = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

// ─────────────────────────────────────────────── 도면 지점 목록

async function loadNodes() {
  // 활성 도면은 `/api/map` 이다. `/api/plans/:id` 는 id 를 알아야 하고,
  // 답사하는 사람은 «지금 서버가 쓰는 도면» 을 쓰면 된다.
  const plan = await (await fetch(api('/map'))).json();
  const nodes = (plan?.nodes || []).filter(n => n.type !== 'elevator');
  if (!nodes.length) { log('활성 도면에 지점이 없습니다.', 'bad'); return; }
  // 이름으로 정렬하지 않는다 — 도면에 적힌 순서가 곧 건물을 도는 순서라,
  // 걸으면서 고를 때 가나다순보다 그쪽이 훨씬 빨리 찾힌다.
  const opts = nodes.map(n =>
    `<option value="${n.id}">${n.name || n.id}</option>`).join('');
  $('from').innerHTML = opts;
  $('to').innerHTML = opts;
  log(`도면 «${plan.name}» · 지점 ${nodes.length}곳`);
}

// ─────────────────────────────────────────────── 걸음

/**
 * iOS 는 동작 센서에 명시적 허가가 필요하다. 안드로이드는 그냥 열린다.
 * 허가를 못 받아도 **답사는 계속 간다** — 걸음이 0이면 출발 지점 한 곳짜리
 * 답사가 되고, 그것도 없는 것보다는 낫다.
 */
async function startSteps() {
  try {
    const need = window.DeviceMotionEvent?.requestPermission;
    if (typeof need === 'function') {
      const ok = await window.DeviceMotionEvent.requestPermission();
      if (ok !== 'granted') { log('동작 센서 거부 — 걸음을 못 셉니다.', 'bad'); return; }
    }
  } catch (_) { /* 허가를 못 물어보는 브라우저 */ }

  window.addEventListener('devicemotion', onMotion);
  motionOn = true;
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a) return;
  // 센서는 m/s², 검출기는 g 단위를 먹는다
  const n = detector.push(
    { x: (a.x ?? 0) / 9.81, y: (a.y ?? 0) / 9.81, z: (a.z ?? 0) / 9.81 },
    e.timeStamp || Date.now());
  if (n) { steps += n; $('n-step').textContent = steps; }
}

// ─────────────────────────────────────────────── 수신 상태

function paintSupport() {
  const s = bleScanSupport();
  const box = $('why');
  if (s.ok) { box.hidden = true; return true; }
  box.hidden = false;
  box.innerHTML = bleBlockedMessage(s)
    .replace(/(chrome:\/\/\S+)/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s]+)/g, '<code>$1</code>');
  return false;
}

// ─────────────────────────────────────────────── 답사

$('btn-start').addEventListener('click', async () => {
  const from = $('from').value;
  $('btn-start').disabled = true;
  try {
    await post('/survey/walk/start', { fromNodeId: from });

    scanner = new WebBleScanner(async readings => {
      try {
        await post('/survey/walk/sample', { steps, readings });
        uploads++;
        $('n-up').textContent = uploads;
        $('n-dev').textContent = scanner.deviceCount;
        $('s-scan').classList.add('on');
      } catch (err) {
        log(`올리기 실패: ${err.message}`, 'bad');
      }
    });

    const r = await scanner.start();
    if (!r.ok) {
      // 스캔이 안 되면 답사는 무의미하다 — 시작한 세션을 접는다.
      // 켜 두면 «걷고 있다» 고 화면이 말하는데 아무것도 안 쌓인다.
      await fetch(api('/survey/walk'), { method: 'DELETE' });
      paintSupport();
      log(bleBlockedMessage(r), 'bad');
      $('btn-start').disabled = false;
      return;
    }

    await startSteps();
    $('setup').hidden = true;
    $('walking').hidden = false;
    // 도착 기본값을 출발과 다르게 둔다 — 같은 값으로 끝내면 경로가 한 점이다
    const sel = $('to');
    if (sel.value === from && sel.options.length > 1) sel.selectedIndex = sel.options.length - 1;
    log(`답사 시작 — ${$('from').selectedOptions[0].text} 에서 출발`
      + (motionOn ? '' : ' (걸음 못 셈)'), 'ok');
  } catch (err) {
    log(`시작 실패: ${err.message}`, 'bad');
    $('btn-start').disabled = false;
  }
});

$('btn-finish').addEventListener('click', async () => {
  $('btn-finish').disabled = true;
  try {
    // 마지막 묶음을 흘리지 않는다 — 도착 지점 신호가 통째로 빠지면
    // 정작 제일 중요한 «출구 앞» 이 답사에서 비어 버린다.
    scanner?._flush?.();
    await new Promise(r => setTimeout(r, 400));
    const d = await post('/survey/walk/finish', { toNodeId: $('to').value });
    stopAll();
    const spots = Object.entries(d.spots || {})
      .map(([k, v]) => `${k} ${v}개`).join(' · ') || '없음';
    log(`답사 완료 — ${d.steps}걸음 · 경로 ${d.route.length}지점\n`
      + `  기기 ${d.devices}개 중 ${d.kept}개 채택, 새로 ${d.added}개 저장\n`
      + `  ${spots}\n  전체 답사 ${d.surveyed}신호`, 'ok');
    if (d.dropped?.length) {
      const why = d.dropped.reduce((m, x) => (m[x.why] = (m[x.why] || 0) + 1, m), {});
      log(`  버린 기기: ${Object.entries(why).map(([k, v]) => `${k} ${v}개`).join(' · ')}`);
    }
  } catch (err) {
    log(`마무리 실패: ${err.message}`, 'bad');
    $('btn-finish').disabled = false;
  }
});

$('btn-cancel').addEventListener('click', async () => {
  await fetch(api('/survey/walk'), { method: 'DELETE' });
  stopAll();
  log('버렸습니다. 다시 시작할 수 있습니다.');
});

function stopAll() {
  scanner?.stop();
  scanner = null;
  window.removeEventListener('devicemotion', onMotion);
  motionOn = false;
  detector.reset();
  steps = 0; uploads = 0;
  $('n-step').textContent = '0';
  $('n-up').textContent = '0';
  $('n-dev').textContent = '—';
  $('s-scan').classList.remove('on');
  $('setup').hidden = false;
  $('walking').hidden = true;
  $('btn-start').disabled = false;
  $('btn-finish').disabled = false;
}

// 화면을 켜 둔 채 걸어야 한다 — 잠기면 스캔도 걸음도 멈춘다
navigator.wakeLock?.request?.('screen').catch(() => {});

paintSupport();
loadNodes().catch(err => log(`도면 실패: ${err.message}`, 'bad'));
