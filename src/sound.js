/**
 * 소리 — 방향 신호, 안심/경고 효과음, 화재 사이렌.
 *
 * ## 왜 소리가 진동만큼 중요한가
 *
 * 폰은 진동 모터가 하나뿐이라 **방향 자체를 촉각으로 줄 수 없다.** 왼쪽만 떨게 할
 * 방법이 없기 때문이다. 반면 소리는 스테레오라 좌우가 실제로 갈린다. 그래서
 * 방향은 소리가, 세기는 진동이 맡는 역할 분담이 자연스럽다.
 *
 * 골전도 이어폰을 쓰면 귀를 막지 않아 화재경보·사람 목소리·지팡이 소리를 그대로
 * 들으면서 방향 신호를 받는다. 시각장애인 보행에서 주변 소리는 시야에 해당하므로
 * 그걸 덮지 않는 것이 중요하다.
 *
 * ## data URI 로는 소리가 안 났다
 *
 * 처음에는 WAV 를 만들어 `data:audio/wav;base64,...` 로 바로 재생했다. **iOS 의
 * AVPlayer 는 data URI 를 못 읽는다.** 그래서 진동은 나는데 소리만 안 나는
 * 상태였다. 지금은 캐시 폴더에 **파일로 쓰고** `file://` 로 재생한다.
 *
 * ## 미리 만들어 둔다
 *
 * 방향 신호는 정확도·좌우에 따라 음이 달라지는데, 그때그때 만들어 파일로 쓰면
 * 소리가 늦는다. 그래서 앱을 켤 때 **격자로 미리 만들어 두고** 재생할 때는
 * 가장 가까운 칸을 고른다. 25개 남짓이라 용량도 시간도 부담이 없다.
 */

import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';

const SR = 22050;              // 표본율 — 신호음에는 충분하고 생성이 빠르다
const DIR_NAME = 'fireapp-sfx';

/** 방향 신호 격자 — 정확도 5단계 × 좌우 5단계 */
const ALIGN_STEPS = [0, 0.25, 0.5, 0.75, 1];
const PAN_STEPS = [-1, -0.5, 0, 0.5, 1];

let ready = false;
let readyPromise = null;
const players = new Map();     // key -> AudioPlayer

// ------------------------------------------------------------- WAV 합성

function toBase64(bytes) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]; const b = bytes[i + 1]; const c = bytes[i + 2];
    out += CHARS[a >> 2];
    out += CHARS[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : CHARS[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : CHARS[c & 63];
  }
  return out;
}

/**
 * 스테레오 WAV 바이트.
 * @param {(t:number)=>[number,number]} sample 시각 t(초) → [좌, 우] (-1~1)
 */
function makeWav(durationSec, sample) {
  const n = Math.floor(SR * durationSec);
  const dataBytes = n * 4;                 // 16bit × 2ch
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);

  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, SR, true); view.setUint32(28, SR * 4, true);
  view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, dataBytes, true);

  for (let i = 0; i < n; i++) {
    const [l, r] = sample(i / SR);
    view.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l)) * 32767, true);
    view.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r)) * 32767, true);
  }
  return buf;
}

/** 딸깍거리지 않게 앞뒤를 부드럽게 깎는다 */
function envelope(t, dur, attack = 0.008, release = 0.03) {
  if (t < attack) return t / attack;
  if (t > dur - release) return Math.max(0, (dur - t) / release);
  return 1;
}

// ------------------------------------------------------------- 소리 정의

function toneWav(freq, pan, dur = 0.09) {
  // 등출력 패닝: 한쪽으로 몰아도 전체 음량이 유지된다
  const ang = ((pan + 1) / 2) * (Math.PI / 2);
  const gl = Math.cos(ang); const gr = Math.sin(ang);
  return makeWav(dur, t => {
    const v = Math.sin(2 * Math.PI * freq * t) * envelope(t, dur) * 0.55;
    return [v * gl, v * gr];
  });
}

function melodyWav(notes, dur) {
  return makeWav(dur, t => {
    let v = 0;
    for (const [start, len, freq, amp] of notes) {
      if (t >= start && t < start + len) {
        const local = t - start;
        v += Math.sin(2 * Math.PI * freq * local) * envelope(local, len, 0.006, 0.06) * amp;
      }
    }
    return [v, v];
  });
}

/** 삐뽀삐뽀 — 두 음이 번갈아 울리는 한 마디. 이어 붙여 반복한다. */
function sirenWav() {
  const dur = 1.0;
  return makeWav(dur, t => {
    const half = t % 0.5 < 0.25;
    const freq = half ? 880 : 660;
    const local = t % 0.25;
    const v = Math.sin(2 * Math.PI * freq * local) * envelope(local, 0.25, 0.01, 0.04) * 0.5;
    return [v, v];
  });
}

/** 앱을 켤 때 만들어 둘 소리 목록 */
function buildAll() {
  const out = [];
  for (const a of ALIGN_STEPS) {
    for (const p of PAN_STEPS) {
      out.push([toneKey(a, p), toneWav(430 + 500 * a, p)]);
    }
  }
  out.push(['good', melodyWav([[0.00, 0.12, 784, 0.42], [0.10, 0.20, 1175, 0.38]], 0.32)]);
  out.push(['wrong', melodyWav([[0.00, 0.13, 466, 0.42], [0.12, 0.22, 311, 0.42]], 0.36)]);
  out.push(['locked', melodyWav([[0.00, 0.10, 988, 0.40], [0.08, 0.16, 1319, 0.34]], 0.26)]);
  out.push(['reject', melodyWav([[0.00, 0.16, 220, 0.45]], 0.20)]);
  out.push(['siren', sirenWav()]);
  return out;
}

const toneKey = (a, p) => `t${a}_${p}`;

// ------------------------------------------------------------- 준비

/**
 * 오디오 세션을 열고 소리 파일을 만들어 둔다.
 *
 * 무음 스위치를 켜도 들려야 한다 — 화재 안내가 스위치 하나 때문에 안 들리면 안 된다.
 */
export function initAudio() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    try {
      await setAudioModeAsync({
        playsInSilentMode: true,
        shouldRouteThroughEarpiece: false,
        interruptionMode: 'duckOthers',
      });
    } catch (_) { /* 설정 실패해도 재생은 시도한다 */ }

    try {
      const dir = new Directory(Paths.cache, DIR_NAME);
      try { dir.create({ intermediates: true, idempotent: true }); } catch (_) {}

      for (const [key, bytes] of buildAll()) {
        const file = new File(dir, `${key}.wav`);
        try {
          // 이미 있으면 다시 쓰지 않는다 — 앱을 다시 켤 때 시작이 빨라진다
          if (!file.exists) file.write(toBase64(bytes), { encoding: 'base64' });
        } catch (_) {
          try { file.write(toBase64(bytes), { encoding: 'base64' }); } catch (__) { continue; }
        }
        try { players.set(key, createAudioPlayer({ uri: file.uri })); } catch (_) {}
      }
      ready = players.size > 0;
    } catch (_) { ready = false; }
    return ready;
  })();
  return readyPromise;
}

// ------------------------------------------------------------- 재생

/**
 * 짧은 소리를 처음부터 다시 재생한다.
 *
 * `seekTo` 는 비동기다. 되감기 전에 play 하면 **끝난 지점에서 재생**돼 아무 소리도
 * 안 난다. 그래서 되감은 뒤에 튼다.
 */
function play(key, { volume = 1, loop = false } = {}) {
  const p = players.get(key);
  if (!p) {
    // 아직 준비 중이면 준비된 뒤에 한 번 울린다.
    // 화재 경보가 "0.5초 늦게 켜졌다"는 이유로 통째로 사라지면 안 된다.
    if (readyPromise) readyPromise.then(() => { if (players.has(key)) play(key, { volume, loop }); });
    return null;
  }
  try {
    p.loop = loop;
    p.volume = volume;
    const go = () => { try { p.play(); } catch (_) {} };
    const r = p.seekTo(0);
    if (r && typeof r.then === 'function') r.then(go, go);
    else go();
  } catch (_) { /* 소리가 안 나도 진동·음성은 계속돼야 한다 */ }
  return p;
}

const nearest = (steps, v) =>
  steps.reduce((best, s) => (Math.abs(s - v) < Math.abs(best - v) ? s : best), steps[0]);

// ------------------------------------------------------------- 공개 API

/**
 * 방향 탐색 신호. 폰을 훑는 동안 반복 재생된다.
 * @param align 0~1 정확도 (정면일수록 높은 음), @param errorDeg 부호로 좌우 결정
 */
export function beepDirection(align, errorDeg, strength = 1) {
  const a = nearest(ALIGN_STEPS, Math.max(0, Math.min(1, align)));
  const p = nearest(PAN_STEPS, Math.max(-1, Math.min(1, (errorDeg || 0) / 70)));
  // 틀린 방향에서도 들려야 한다. 세기는 음량으로만 표현하고 바닥을 남긴다.
  play(toneKey(a, p), { volume: 0.4 + 0.5 * Math.max(0, Math.min(1, strength)) });
}

/** 올바른 방향으로 들어섰을 때 — 심신을 안정시키는 상행 2음 */
export function chimeGood() { play('good', { volume: 0.9 }); }

/** 엉뚱한 방향으로 갈 때 — 하행 2음. 놀래키지 않되 분명하게. */
export function chimeWrong() { play('wrong', { volume: 0.9 }); }

/** 무언가 맞아떨어졌을 때 (촬영 정렬, 구간 통과) */
export function chimeLocked() { play('locked', { volume: 0.8 }); }

/** 받아들일 수 없을 때 (잘못된 사진, 보정 실패) */
export function chimeReject() { play('reject', { volume: 0.8 }); }

// ------------------------------------------------------------- 사이렌

let siren = null;

/** 화재 경보. 자고 있어도 깨야 하므로 크게, 그리고 계속. */
export function startSiren() {
  siren = play('siren', { volume: 1, loop: true });
}

export function stopSiren() {
  try { siren?.pause?.(); } catch (_) {}
  siren = null;
}

/** 소리가 준비됐는지 — 디버깅용 */
export function audioReady() { return ready; }
