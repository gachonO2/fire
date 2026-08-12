import { EventEmitter } from 'node:events';

/**
 * 서버 내부 이벤트 허브.
 * 저장소(Firestore onSnapshot 또는 인메모리)에서 변경이 생기면 여기로 흘려보내고,
 * SSE 라우터가 이를 구독해 모든 클라이언트(사용자 앱·관제)로 push 한다.
 */
export const events = new EventEmitter();
events.setMaxListeners(0); // 동시 접속 사용자 수만큼 리스너가 붙는다

export const TOPICS = ['hazards', 'sos', 'positions', 'metrics', 'alerts', 'sensors', 'plan', 'fires'];

export function publish(topic, payload) {
  events.emit(topic, payload);
}
