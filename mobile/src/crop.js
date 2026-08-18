/**
 * 틀 안만 잘라내기 — 화면에 그린 사각형과 저장되는 사진을 일치시킨다.
 *
 * ## 왜 필요한가
 *
 * 틀은 **화면에만** 그려져 있었고, 저장은 카메라가 본 전체가 그대로 됐다.
 * 천장·책상·주변 종이까지 전부 들어간 사진이 서버로 갔다. 사용자는 틀에
 * 맞췄다고 믿었는데 실제로는 아무 효과가 없었던 것이다.
 *
 * 판독 정확도에도 직접 영향을 준다 — 도면이 사진의 3분의 1만 차지하면
 * 글자와 픽토그램이 그만큼 작게 잡히고, 주변 잡동사니가 오판을 부른다.
 *
 * ## 좌표를 어떻게 옮기는가
 *
 * 카메라 미리보기는 화면을 **꽉 채운다**(aspect-fill). 센서가 본 그림의 가장자리는
 * 화면 밖으로 잘려 나가 있고, 그 잘린 양을 되돌려야 화면 위의 사각형이 사진의
 * 어느 부분인지 알 수 있다.
 *
 *   배율   = max(미리보기폭 / 사진폭, 미리보기높이 / 사진높이)
 *   잘린양 = (사진크기 × 배율 − 미리보기크기) / 2
 *   사진좌표 = (화면좌표 + 잘린양) / 배율
 *
 * 미리보기와 사진의 가로세로 비가 같으면 잘린양이 0 이 되어 단순 비례가 된다.
 * 다를 때도 같은 식으로 맞는다.
 */

/**
 * 화면 위 사각형 → 사진 픽셀 사각형.
 *
 * @param preview {width, height}  카메라 미리보기가 실제로 차지한 크기 (onLayout)
 * @param photo   {width, height}  찍힌 사진의 픽셀 크기
 * @param rect    {x, y, width, height} 미리보기 안에서의 틀 위치
 * @returns {originX, originY, width, height} 사진 픽셀 기준. 못 구하면 null
 */
export function mapRectToPhoto(preview, photo, rect) {
  const pw = Number(preview?.width);
  const ph = Number(preview?.height);
  const iw = Number(photo?.width);
  const ih = Number(photo?.height);
  if (!(pw > 0 && ph > 0 && iw > 0 && ih > 0)) return null;

  const scale = Math.max(pw / iw, ph / ih);
  const offX = (iw * scale - pw) / 2;
  const offY = (ih * scale - ph) / 2;

  let x = (rect.x + offX) / scale;
  let y = (rect.y + offY) / scale;
  let w = rect.width / scale;
  let h = rect.height / scale;

  // 사진 밖으로 나가지 않게 가둔다. 밖을 자르려 하면 네이티브에서 실패한다.
  x = Math.max(0, Math.min(x, iw - 1));
  y = Math.max(0, Math.min(y, ih - 1));
  w = Math.max(1, Math.min(w, iw - x));
  h = Math.max(1, Math.min(h, ih - y));

  return {
    originX: Math.round(x),
    originY: Math.round(y),
    width: Math.round(w),
    height: Math.round(h),
  };
}

/**
 * 미리보기 안에서 틀이 놓인 자리.
 *
 * 화면에 그리는 값과 **같은 식**을 써야 한다. 한쪽만 바꾸면 보이는 틀과 잘리는
 * 영역이 어긋나고, 그건 사용자가 알아챌 수 없는 종류의 어긋남이다.
 *
 * @param preview {width, height}
 * @param widthRatio 틀의 가로가 미리보기 가로에서 차지하는 비율
 * @param aspect     틀의 가로/세로 비
 */
export function guideRect(preview, widthRatio = 0.86, aspect = 4 / 3) {
  const pw = Number(preview?.width) || 0;
  const ph = Number(preview?.height) || 0;
  let w = pw * widthRatio;
  let h = w / aspect;
  // 세로로 넘치면 세로에 맞춘다 (가로 화면이나 긴 틀에서)
  if (h > ph * 0.9) { h = ph * 0.9; w = h * aspect; }
  return { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h };
}
