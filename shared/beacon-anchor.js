/**
 * 비콘 판정 → 판단 계층 연결.
 *
 * `BeaconLocator`(shared/positioning.js)는 "지금 어느 노드냐"를 내고,
 * `Fusion`(shared/fusion.js)은 그것을 확정 단서로 받는다. 이 파일은 그 사이에서
 * **언제 앵커를 놓을지**만 정한다. 둘 다 서로를 모른 채로 둘 수 있게 하려는 것이다.
 *
 * ## 매 판정마다 앵커를 놓으면 안 된다
 *
 * 두 가지가 망가진다.
 *
 * **1. 걸음이 지워진다.** 비콘 판정은 "가장 가까운 노드"라서, 그 노드의 영역 안을
 * 걷는 동안 계속 같은 답이 나온다. 그때마다 앵커를 놓으면 믿음이 매번 노드로
 * 다시 모여, 통로 위를 걸어온 진행도가 통째로 사라진다. 화면에서는 사람이 노드에
 * 붙박여 있다가 다음 노드로 순간이동하는 것처럼 보인다.
 *
 * **2. 확신도가 거짓말을 한다.** `estimate()` 는 신호가 전멸해도 마지막 노드를
 * 그대로 돌려준다(안내가 끊기지 않게 하려는 의도된 동작이다). 그 값을 앵커로 넣으면
 * 아무 근거 없이 확신도가 1.0 으로 유지된다 — 이 시스템에서 가장 위험한 상태다.
 *
 * ## 그래서 두 조건을 건다
 *
 *   실제 수신이 있을 것   `beaconId !== null`. 붙잡아 둔 값에는 앵커를 놓지 않는다.
 *   노드가 바뀌었을 것    또는 처음 확정된 순간.
 *
 * 서 있으면 걸음이 안 늘어나므로 확신도도 안 떨어진다. 걸어서 비콘을 벗어나면
 * 다음 비콘을 만날 때까지 서서히 떨어진다. 둘 다 사실 그대로다.
 *
 * ## 확정(locked) 전에는 앵커를 놓지 않는다
 *
 * `BeaconLocator` 는 `locked` 전까지 잠정값을 낸다. 첫 스캔에서 가까운 비콘의
 * 패킷이 유실되면 멀리서 약하게 잡힌 비콘이 1등일 수 있기 때문이다.
 *
 * 처음에는 그 잠정값도 낮은 신뢰도로 넣어봤는데, **로케이터의 히스테리시스와
 * 판단 계층의 거리 검사가 서로 싸웠다.** 잠정으로 R302 를 넣은 직후 더 센 J1 이
 * 들어오면, 판단 계층 입장에서는 "0걸음 걸었는데 12걸음 떨어진 곳에서 신호가 왔다"
 * 라서 정당하게 거부한다. 옳은 판단인데, 애초에 R302 를 믿을 근거가 없었던 게
 * 문제다.
 *
 * 「확실해질 때까지 기다리기」는 로케이터가 이미 하고 있다. 같은 일을 두 겹으로
 * 하면 반드시 어긋나므로, 여기서는 **확정된 뒤에만** 앵커를 놓는다.
 * 그 2초 동안 화면은 "현재 위치를 찾고 있습니다"를 띄운다.
 */

export class BeaconAnchor {
  /**
   * @param {Fusion} fusion
   * @param {BeaconLocator} locator
   */
  constructor(fusion, locator) {
    this.fusion = fusion;
    this.locator = locator;
    this.lastNode = null;
    this.wasLocked = false;
  }

  /**
   * 판정을 한 번 돌리고, 조건이 맞으면 앵커를 놓는다.
   * @param {number} now 스캔 ts 와 같은 시계
   * @returns {{nodeId, anchored: boolean, live: boolean, locked: boolean}|null}
   */
  update(now) {
    const est = this.locator.estimate(now);
    if (!est) return null;

    const locked = this.locator.locked;
    const live = est.beaconId !== null;
    const justLocked = locked && !this.wasLocked;
    const changed = est.nodeId !== this.lastNode;
    this.wasLocked = locked;

    const shouldAnchor = locked && live && (changed || justLocked);
    if (!shouldAnchor) {
      // 앵커를 놓지 않더라도, **실제 수신이 지금 믿는 곳과 맞아떨어지면 확인**을 놓는다.
      //
      // 비콘은 노드 영역 안을 걷는 내내 같은 답을 준다. 노드가 안 바뀌었다고 그
      // 신호를 통째로 버리면, 맞는 답을 계속 받으면서도 확신도가 떨어진다.
      // 실제로 그렇게 짰다가 60걸음 중 5걸음에서 안내가 멈출 뻔했다.
      const confirmed = locked && live && this.fusion.agreesWith(est.nodeId);
      if (confirmed) this.fusion.confirm('beacon');
      return { nodeId: est.nodeId, anchored: false, confirmed, live, locked };
    }

    this.lastNode = est.nodeId;
    this.fusion.anchorAt(est.nodeId, { kind: 'beacon' });
    return { nodeId: est.nodeId, anchored: true, live, locked };
  }

  reset() {
    this.lastNode = null;
    this.wasLocked = false;
  }
}
