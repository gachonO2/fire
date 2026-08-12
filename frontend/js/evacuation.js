/**
 * 대피 상태머신 — 사용자 앱과 시연 콘솔이 **같은 코드**를 쓴다.
 *
 * 흐름: 시작위치 확정 → 경로 요청 → 음성·진동 안내 → 걸음 추적
 *       → 위험 변경 시 재탐색 → 갈 곳이 없거나 위치확신도가 낮으면 안전상태(구조요청)
 *
 * 화면마다 이 로직을 따로 두면 두 갈래로 갈라진다. 안내가 틀리면 사람이 다치는
 * 기능이라 상태머신은 한 벌만 두고, 화면은 이걸 조작·표시하기만 한다.
 */

import { positionOnRoute } from './minimap.js';
import { closestPointOnSegment } from '../shared/geometry.js';

const CONFIDENCE_FLOOR = 0.4;   // 이하로 떨어지면 안전상태 전환
const TURN_THRESHOLD = 30;      // 도 — 이 이상 꺾이면 회전 안내
const DEVIATION_THRESHOLD = 45; // 도 — 진행방향 이탈 판정

export class EvacuationSession {
  /**
   * @param {Api} api
   * @param {Guidance} guidance
   * @param {Odometry|null} odometry 없으면 걸음은 수동(step 호출)으로만 진행
   */
  constructor({ api, guidance, odometry = null, userId }) {
    this.api = api;
    this.guidance = guidance;
    this.odometry = odometry;
    this.userId = userId;

    this.phase = 'idle';   // idle | guiding | arrived | safehold
    this.hazards = {};
    this.startNodeId = null;
    this.route = null;
    this.edgeIndex = 0;
    this.stepsTaken = 0;
    this.positionOverride = null; // 테스트에서 임의 위치로 옮긴 직후의 지도 좌표
    this.recovery = null; // 경로 이탈 시 사람과 가장 가까운 복귀 지점
    this.directionMismatch = false;
    this.deviationStreak = 0;
    this.lastCommand = '';
    this.lastMs = null;
    this._segmentTimer = null;

    /** 화면 갱신 콜백 */
    this.onChange = () => {};
    /** 안내 문장이 나올 때마다 (화면 표시용) */
    this.onAnnounce = () => {};

    this.guidance.onAnnounce = text => {
      this.lastCommand = text;
      this.onAnnounce(text);
      if (this.phase !== 'idle') this._report();
    };

    if (this.odometry) {
      this.odometry.onStep = () => { if (this.phase === 'guiding') this.step(); };
    }
  }

  get plan() { return this.api.floorPlan; }
  get currentEdge() { return this.route?.edges[this.edgeIndex] || null; }
  get exitName() { return this.route?.exit?.name || null; }

  get stepsLeft() {
    const edge = this.currentEdge;
    return edge ? Math.max(0, this.plan.edgeSteps(edge) - this.stepsTaken) : null;
  }

  get currentNodeId() {
    if (!this.route) return this.startNodeId;
    return this.route.nodes[Math.min(this.edgeIndex, this.route.nodes.length - 1)];
  }

  /** 지도에 찍을 현재 좌표 */
  position() {
    if (this.positionOverride) return this.positionOverride;
    if (!this.route) {
      const node = this.plan.getNode(this.startNodeId);
      return node ? { x: node.x, y: node.y } : null;
    }
    const edge = this.currentEdge;
    return positionOnRoute(this.plan, this.route, this.edgeIndex,
      edge ? this.stepsTaken / this.plan.edgeSteps(edge) : 1);
  }

  /** 방향 탐색기가 향해야 할 곳. 이탈 중에는 진행 방향보다 경로 복귀 지점이 우선이다. */
  targetBearing() {
    const pos = this.position();
    if (!pos) return null;
    if (this.recovery) return bearingBetween(pos, this.recovery);
    if (!this.route || this.edgeIndex >= this.route.edges.length) return null;
    const target = this.plan.getNode(this.route.nodes[this.edgeIndex + 1]);
    return target ? bearingBetween(pos, target) : this._bearingAt(this.edgeIndex);
  }

  // ------------------------------------------------------------ 시작 위치
  setStart(nodeId) {
    this.startNodeId = nodeId;
    this.positionOverride = null;
    this.recovery = null;
    this.directionMismatch = false;
    this.onChange(this);
  }

  /**
   * 테스트에서 사람을 임의 좌표로 옮긴다. 경로 계산은 가장 가까운 저장 위치에서
   * 다시 시작하고, 지도 표시는 실제로 놓은 좌표를 유지한다.
   */
  async relocateTo(nodeId, position = null) {
    if (!this.plan.hasNode(nodeId)) return false;

    const wasActive = this.phase !== 'idle';
    this.startNodeId = nodeId;
    this.positionOverride = position && Number.isFinite(position.x) && Number.isFinite(position.y)
      ? { x: position.x, y: position.y }
      : null;
    this.recovery = null;
    this.directionMismatch = false;

    if (!wasActive) {
      this.onChange(this);
      return true;
    }

    this.phase = 'guiding';
    const route = await this._requestRoute(nodeId, 'relocate');
    if (!route) return false;

    const node = this.plan.getNode(nodeId);
    this.guidance.speak(`테스트 인물을 ${node.name} 부근으로 이동했습니다. 새 경로를 안내합니다.`);
    this._scheduleSegment(1200, true);
    this._report();
    this.onChange(this);
    return true;
  }

  /** 대피 전이라 시간 여유가 있으므로 저장된 장소 설명까지 들려준다 */
  announceStartPlace() {
    if (!this.startNodeId) return;
    this.guidance.speak(`${this.plan.describePlace(this.startNodeId)} 맞으면 대피 시작 버튼을 누르세요.`);
  }

  // ------------------------------------------------------------ 대피 시작
  async start() {
    if (!this.startNodeId) return false;

    const route = await this._requestRoute(this.startNodeId, 'initial');
    if (!route) return false; // _requestRoute가 안전상태로 전환함

    this.phase = 'guiding';
    this.guidance.cmdStart(route.exit.name);
    // 시작 안내가 끝날 즈음 첫 이동 명령
    this._scheduleSegment(2200, true);
    this._report();
    this.onChange(this);
    return true;
  }

  /** 백엔드에 경로 요청(실패 시 오프라인 로컬 계산). 없으면 안전상태 전환 후 null */
  async _requestRoute(fromNodeId, kind) {
    const { route, ms, offline, reason } =
      await this.api.computeRoute(fromNodeId, kind, this.userId);

    this.lastMs = ms;
    this.offline = offline;

    if (!route) {
      this.enterSafeHold(reason || '접근 가능한 대피 경로가 없습니다.');
      return null;
    }
    this.route = this.plan.hydrateRoute(route);
    this.edgeIndex = 0;
    this.stepsTaken = 0;
    this.recovery = null;
    this.directionMismatch = false;
    this.onChange(this);
    return this.route;
  }

  // ------------------------------------------------------------ 안내 진행
  _bearingAt(index) {
    if (!this.route || index >= this.route.edges.length) return null;
    return this.plan.bearing(this.route.nodes[index], this.route.nodes[index + 1]);
  }

  _clearScheduledSegment() {
    clearTimeout(this._segmentTimer);
    this._segmentTimer = null;
  }

  _scheduleSegment(delay, atStart = false) {
    this._clearScheduledSegment();
    this._segmentTimer = setTimeout(() => {
      this._segmentTimer = null;
      if (this.phase === 'guiding' && !this.recovery && !this.directionMismatch) {
        this._announceSegment(atStart);
      }
    }, delay);
  }

  /** 현재 구간 안내. atStart=true면 회전 없이 직진 명령부터 */
  _announceSegment(atStart = false) {
    if (!this.route) return;
    if (this.edgeIndex >= this.route.edges.length) { this._arrive(); return; }

    const edge = this.currentEdge;
    const steps = this.plan.edgeSteps(edge);

    if (!atStart && this.edgeIndex > 0) {
      let diff = this._bearingAt(this.edgeIndex) - this._bearingAt(this.edgeIndex - 1);
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      if (Math.abs(diff) >= TURN_THRESHOLD) {
        this.guidance.cmdTurn(diff > 0 ? 'right' : 'left', steps);
        this.onChange(this);
        return;
      }
    }
    this.guidance.cmdStraight(steps, edge.wall);
    this.onChange(this);
  }

  /** 한 걸음 전진 */
  step() {
    const edge = this.currentEdge;
    if (!edge || this.phase !== 'guiding') return;

    this.positionOverride = null;
    this.recovery = null;
    this.directionMismatch = false;
    this.stepsTaken++;
    this._checkDeviation();

    if (this.stepsTaken >= this.plan.edgeSteps(edge)) {
      // 노드 도착 — 확정 지점이므로 확신도 회복
      this.edgeIndex++;
      this.stepsTaken = 0;
      this.deviationStreak = 0;
      this.odometry?.resetAt();
      this._report();
      this._announceSegment();
    }
    this.onChange(this);
  }

  /**
   * 테스트에서 현재 경로와 무관하게 실제 좌표를 한 걸음 이동한다.
   * 경로에서 벗어나거나 반대로 걸으면 직진 안내를 즉시 중단하고 복귀 신호로 전환한다.
   */
  moveFreelyTo(x, y) {
    if (this.phase !== 'guiding' || !this.route || !Number.isFinite(x) || !Number.isFinite(y)) {
      return { status: 'inactive' };
    }

    const previous = this.position();
    const position = { x, y };
    const movementBearing = previous && Math.hypot(x - previous.x, y - previous.y) > 0.001
      ? bearingBetween(previous, position)
      : null;
    const nearest = this._closestPointOnRoute(position);
    if (!nearest) return { status: 'inactive' };

    const wasRecovering = Boolean(this.recovery);
    const previousDistance = this.recovery?.distanceMeters ?? 0;
    const wasDirectionMismatch = this.directionMismatch;
    const distanceMeters = nearest.distance * this.plan.metersPerUnit;
    // 한 걸음만 옆으로 잘못 가도 알아차리되, 지도 좌표의 작은 흔들림은 허용한다.
    const toleranceMeters = Math.max(0.35, this.plan.stepLength * 0.6);

    this.positionOverride = position;
    this.edgeIndex = nearest.edgeIndex;
    this.stepsTaken = Math.min(
      this.plan.edgeSteps(this.currentEdge),
      Math.max(0, Math.round(nearest.t * this.plan.edgeSteps(this.currentEdge))),
    );

    if (distanceMeters > toleranceMeters) {
      this.recovery = {
        x: nearest.x,
        y: nearest.y,
        distanceMeters,
      };
      this.directionMismatch = false;
      this._clearScheduledSegment();

      if (!wasRecovering || distanceMeters > previousDistance + 0.2) {
        this._announceWrongWay('경로에서 벗어났습니다. 방향 신호가 이어지는 쪽으로 이동해 가까운 통로로 돌아가세요.');
      }
      this._report();
      this.onChange(this);
      return { status: 'off-route', distanceMeters, target: this.recovery };
    }

    this.recovery = null;
    const targetNode = this.plan.getNode(this.route.nodes[this.edgeIndex + 1]);
    const desiredBearing = targetNode ? bearingBetween(position, targetNode) : null;
    const headingError = movementBearing == null || desiredBearing == null
      ? 0
      : Math.abs(angleDifference(desiredBearing, movementBearing));

    if (wasRecovering) {
      this.directionMismatch = false;
      this.guidance.speak('경로로 돌아왔습니다. 방향 신호가 이어지는 쪽을 확인한 뒤 이동하세요.');
      this._scheduleSegment(1200, true);
    } else if (headingError > DEVIATION_THRESHOLD) {
      this.directionMismatch = true;
      this._clearScheduledSegment();
      this._announceWrongWay('진행 방향이 잘못되었습니다. 방향 신호가 이어지는 쪽으로 몸을 돌리세요.');
    } else {
      this.directionMismatch = false;
      if (wasDirectionMismatch) {
        this.guidance.speak('올바른 방향을 다시 찾았습니다. 신호가 이어지는 동안 이동하세요.');
      }
    }

    const targetDistance = targetNode
      ? Math.hypot(position.x - targetNode.x, position.y - targetNode.y) * this.plan.metersPerUnit
      : Infinity;
    if (!this.directionMismatch && targetDistance <= this.plan.stepLength * 0.55) {
      this.edgeIndex++;
      this.stepsTaken = 0;
      this.positionOverride = targetNode ? { x: targetNode.x, y: targetNode.y } : position;
      this._report();
      this._announceSegment();
    } else {
      this._report();
      this.onChange(this);
    }
    return { status: this.directionMismatch ? 'wrong-direction' : 'on-route', distanceMeters };
  }

  _closestPointOnRoute(position) {
    let best = null;
    for (let i = 0; i < this.route.edges.length; i++) {
      const a = this.plan.getNode(this.route.nodes[i]);
      const b = this.plan.getNode(this.route.nodes[i + 1]);
      if (!a || !b) continue;
      const point = closestPointOnSegment(position.x, position.y, a.x, a.y, b.x, b.y);
      const distance = Math.hypot(position.x - point.x, position.y - point.y);
      const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const t = Math.max(0, Math.min(1,
        ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length)));
      if (!best || distance < best.distance) {
        best = { ...point, distance, edgeIndex: i, t };
      }
    }
    return best;
  }

  _announceWrongWay(reason) {
    if (typeof this.guidance.cmdWrongWay === 'function') this.guidance.cmdWrongWay(reason);
    else this.guidance.cmdStop(reason);
  }

  /** 방위 센서가 있으면 경로 방위와 비교해 이탈 감지 */
  _checkDeviation() {
    if (!this.odometry) return;
    const expected = this._bearingAt(this.edgeIndex);
    if (expected === null) return;
    const err = this.odometry.headingError(expected);
    if (err === null) return; // 데스크톱: 센서 없음

    if (Math.abs(err) > DEVIATION_THRESHOLD) {
      if (++this.deviationStreak >= 2) {
        this.reportDeviation(err);
        this.deviationStreak = 0;
      }
    } else {
      this.deviationStreak = 0;
      this.odometry.restoreConfidence(0.05);
    }
  }

  /** 경로 이탈 — 멈춰 세우고 확신도를 깎는다 */
  reportDeviation(err) {
    const dirText = err > 0 ? '오른쪽' : '왼쪽';
    const deg = Math.min(90, Math.round(Math.abs(err) / 10) * 10);
    this._announceWrongWay(`${dirText}으로 ${deg}도 돌려 통로를 찾으세요.`);

    const conf = this.odometry ? this.odometry.degradeConfidence(0.25) : 1;
    if (conf < CONFIDENCE_FLOOR) this.enterSafeHold('위치 확신도가 기준보다 낮습니다.');
    this.onChange(this);
  }

  // -------------------------------------------------------------- 재탐색
  /** 위험 상태가 바뀌었을 때 호출. 경로가 달라지면 다시 안내한다. */
  async hazardsChanged(hazards) {
    const changed = signature(this.hazards) !== signature(hazards);
    this.hazards = hazards;
    if (this.phase !== 'guiding' || !changed) { this.onChange(this); return; }

    const old = this.route;
    const oldIds = old.edges.map(e => e.id).join(',');
    const oldBearing = this._bearingAt(this.edgeIndex);
    const lastNode = old.nodes[this.edgeIndex]; // 마지막으로 확정 통과한 지점

    const route = await this._requestRoute(lastNode, 'reroute');
    if (!route) return;

    if (route.edges.map(e => e.id).join(',') === oldIds) { this.onChange(this); return; }

    this.guidance.cmdReroute(this._rerouteReason(old));

    setTimeout(() => {
      // 되돌아가야 하면 멈춤+방향전환부터
      const newBearing = this._bearingAt(this.edgeIndex);
      if (oldBearing !== null && newBearing !== null) {
        let diff = newBearing - oldBearing;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        if (Math.abs(diff) > 150) {
          this.guidance.cmdStop('뒤로 돌아서세요.');
          setTimeout(() => this._announceSegment(true), 2000);
          return;
        }
      }
      this._announceSegment(this.edgeIndex === 0);
    }, 1800);
  }

  /**
   * 재탐색 사유를 사용자가 바로 이해할 말로 바꾼다.
   * "통로 상태가 변경되었습니다"보다 "앞쪽에 화재"가 몸이 먼저 반응하는 문장이다.
   */
  _rerouteReason(oldRoute) {
    const blocked = oldRoute.edges.filter(e => this.hazards[e.id]);
    const has = type => blocked.some(e => this.hazards[e.id].type === type);
    if (has('fire')) return '앞쪽에 화재가 발생했습니다.';
    if (has('heat')) return '앞쪽 통로가 과열되었습니다.';
    if (has('smoke')) return '앞쪽에 연기가 감지되었습니다.';
    if (blocked.length) return '앞쪽 통로를 지날 수 없습니다.';
    return '더 안전한 길이 있습니다.';
  }

  // ------------------------------------------------------------ 종료 상태
  _arrive() {
    this._clearScheduledSegment();
    this.phase = 'arrived';
    this.guidance.cmdArrive(this.route.exit.name);
    this._report();
    this.onChange(this);
  }

  enterSafeHold(reason) {
    this._clearScheduledSegment();
    this.phase = 'safehold';
    this.guidance.cmdDanger(reason);
    setTimeout(() => this.guidance.cmdSOS(), 1800);

    const node = this.plan.getNode(this.currentNodeId);
    this.api.sendSOS({
      userId: this.userId,
      nodeId: node?.id || '?',
      nodeName: node?.name || '알 수 없음',
      reason,
      confidence: this.odometry?.confidence ?? 1,
    });
    this._report();
    this.onChange(this);
  }

  /** "여기가 어디인가요?" — 도면에 저장해 둔 장소 설명을 읽어준다 */
  describeHere() {
    const description = this.plan.describePlace(this.currentNodeId);
    if (!description) {
      this.guidance.speak('현재 위치를 확인할 수 없습니다.');
      return;
    }
    const left = this.stepsLeft;
    this.guidance.speak(description + (left != null ? ` 다음 지점까지 ${left}걸음 남았습니다.` : ''));
  }

  reset() {
    this._clearScheduledSegment();
    this.phase = 'idle';
    this.startNodeId = null;
    this.route = null;
    this.edgeIndex = 0;
    this.stepsTaken = 0;
    this.positionOverride = null;
    this.recovery = null;
    this.directionMismatch = false;
    this.deviationStreak = 0;
    this.lastCommand = '';
    this.onChange(this);
  }

  // ------------------------------------------------------------ 위치 보고
  _report() {
    const node = this.plan.getNode(this.currentNodeId);
    const pos = this.position() || { x: node?.x, y: node?.y };

    this.api.updatePosition(this.userId, {
      nodeId: this.currentNodeId,
      nodeName: node?.name,
      phase: this.phase,
      confidence: this.odometry?.confidence ?? 1,
      x: pos?.x, y: pos?.y,
      // 보호자 화면이 경로와 현재 안내를 그대로 재현할 수 있도록 함께 보낸다
      command: this.lastCommand,
      exitName: this.exitName,
      routeNodes: this.route?.nodes || null,
      routeEdges: this.route?.edges.map(e => e.id) || null,
      stepsLeft: this.stepsLeft,
    });
  }
}

function bearingBetween(a, b) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function angleDifference(target, actual) {
  let diff = target - actual;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}

function signature(hazards) {
  return JSON.stringify(Object.keys(hazards).sort().map(k => [k, hazards[k].type]));
}
