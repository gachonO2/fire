/**
 * 지자기 대조 → 판단 계층 연결.
 *
 * 지자기는 다른 신호와 성격이 다르다. **한 값으로는 아무것도 못 하고, 여러 걸음이
 * 쌓여야 확정이 된다.** 그래서 두 갈래로 들어간다.
 *
 *   걸음마다   observe()   안 맞는 후보를 감점 (참고 단서처럼)
 *   창이 차면  anchorAt()  1등이 확실히 앞서면 확정 (누적 확정)
 *
 * ## 왜 감점만으로는 부족한가
 *
 * `observe()` 는 후보들의 가중치를 갈라줄 뿐 `stepsSinceAnchor` 를 되돌리지 않는다.
 * 즉 지자기가 계속 "맞다"고 해도 확신도는 계속 떨어진다. 그건 사실과 다르다 —
 * 지문이 열 걸음 내리 일치했다면 그건 확인된 것이다. 그래서 조건이 차면 앵커를
 * 놓아 확신도를 되살린다. 이것이 「누적 확정」의 실제 구현이다.
 *
 * ## 대피 중에 특히 잘 맞는다
 *
 * 누적 확정은 걸어야 성립하는데, **대피는 걷는 행위다.** 사용자에게 따로 요구할
 * 것이 없다. 반대로 대피를 시작하는 순간(서 있는 상태)에는 아무것도 못 하므로,
 * 그 첫 1~2초는 비콘·지오펜스가 메워야 한다.
 */

export class MagneticAnchor {
  /**
   * @param {Fusion} fusion
   * @param {MagneticMatcher} matcher
   */
  constructor(fusion, matcher) {
    this.fusion = fusion;
    this.matcher = matcher;
  }

  /**
   * 한 걸음 분의 자기장 값을 넣고, 판단 계층을 갱신한다.
   * **`fusion.step()` 다음에** 부른다 — 후보들이 전진한 뒤라야 지문 색인이 맞는다.
   *
   * @param {number} microTesla |B|
   * @returns {{anchored: boolean, position?: Object, score?: number}}
   */
  update(microTesla) {
    if (!this.matcher.hasFingerprints) return { anchored: false };
    this.matcher.push(microTesla);

    // 1) 걸음마다 감점 — 안 맞는 후보를 조금씩 깎는다
    this.fusion.observe(c => this.matcher.scoreFor(c));

    // 2) 창이 차고 1등이 확실히 앞서면 확정으로 승격
    const v = this.matcher.verdict(this.fusion.snapshot());
    if (!v) return { anchored: false };

    // 매 걸음 다시 놓아도 된다. 노드가 아니라 **지금 그 자리**를 확정하는 것이라
    // 진행도가 되감기지 않기 때문이다. 지문이 걸음마다 계속 일치한다면 확신도가
    // 계속 높은 게 맞다 — 실제로 계속 확인되고 있으니까.
    // 닮음 점수를 그대로 신뢰도로 쓰지 않는다. 합성 신호에서는 1.000 이 나오는데
    // 그러면 다른 후보가 통째로 지워져, 지문이 한 번 잘못 맞았을 때 되돌아올 길이
    // 없어진다 — 지금까지 계속 막아 온 "틀렸는데 자신 있는" 상태다.
    // 점수는 "얼마나 닮았나", 종류별 상한은 "이 센서를 최대 얼마나 믿나"다.
    const ceiling = this.fusion.opts.anchorTrust.magnetic;
    this.fusion.anchorAtPosition(v.position, { kind: 'magnetic', trust: v.score * ceiling });
    return { anchored: true, position: v.position, score: v.score };
  }

  reset() { this.matcher.reset(); }
}
