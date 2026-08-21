import { Router } from 'express';

/**
 * 비동기 핸들러가 던진 오류를 에러 미들웨어로 넘기는 Router.
 *
 * Express 4 는 `async` 핸들러가 반환한 Promise 를 보지 않는다. 그래서 핸들러
 * 안에서 예외가 나면 응답이 없는 채로 unhandledRejection 이 되고, Node 15+ 는
 * 그걸 **프로세스 종료**로 처리한다 — 라우터 한 곳의 실수가 백엔드 전체를 죽인다.
 * 실제로 활성 도면이 없을 때 도면을 지우면 서버가 통째로 내려갔다.
 *
 * 대피 안내 서버는 요청 하나가 실패하더라도 계속 떠 있어야 한다. 실패한 요청은
 * 500 으로 돌려주고(app.js 의 에러 미들웨어), 다른 사용자의 안내는 이어간다.
 */
export function asyncRouter() {
  const router = Router();
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    const register = router[method].bind(router);
    router[method] = (path, ...handlers) =>
      register(path, ...handlers.map(wrap));
  }
  return router;
}

// 인자 4개짜리는 에러 미들웨어라 그대로 둔다 (감싸면 Express 가 못 알아본다)
const wrap = handler =>
  handler.length >= 4
    ? handler
    : (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
