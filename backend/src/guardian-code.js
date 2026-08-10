/**
 * 보호자 공유 코드 생성.
 * 혼동하기 쉬운 글자(0/O, 1/I/L)를 뺀 문자 집합을 쓴다 —
 * 재난 상황에서 전화로 불러줘야 할 수도 있기 때문.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export const normalizeCode = code => String(code || '').trim().toUpperCase();
