/**
 * 색·간격 토큰.
 *
 * 화재 상황에서 쓰는 앱이라 대비를 높게 잡았다. 저시력자가 큰 글씨와
 * 강한 대비만으로도 상태를 읽을 수 있어야 하고, 연기 속에서 화면이
 * 흐려져도 초록/빨강 구분은 남아야 한다.
 */
export const theme = {
  bg: '#0b0f14',
  surface: '#151b23',
  border: 'rgba(255,255,255,0.35)',

  text: '#f3f4f6',
  textDim: '#9ca3af',

  accent: '#2563eb',
  ok: '#22c55e',
  warn: '#f59e0b',
  danger: '#ef4444',

  radius: 16,
  gap: 12,
};
