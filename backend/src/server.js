import { createApp } from './app.js';
import { config } from './config.js';
import { getRepo } from './repositories/index.js';

/**
 * 시연 중에 서버가 죽으면 안 된다.
 * 요청 하나를 처리하다 난 예외 때문에 프로세스 전체가 내려가면, 대피 안내를 받던
 * 사용자와 지켜보던 보호자가 동시에 끊긴다. 로그를 남기고 계속 살아 있게 한다.
 * (그래도 죽는 경우는 scripts/start-all.mjs 가 다시 띄운다)
 */
process.on('uncaughtException', err => {
  console.error('[치명적 오류 — 서버는 계속 실행]', err);
});
process.on('unhandledRejection', err => {
  console.error('[처리되지 않은 거부 — 서버는 계속 실행]', err);
});

const repo = await getRepo(); // 저장소를 먼저 붙여 첫 요청 지연을 없앤다
const app = createApp();

const server = app.listen(config.port);

server.on('listening', () => {
  console.log(`\n대피 안내 백엔드 실행 중`);
  console.log(`   API      http://localhost:${config.port}/api/health`);
  console.log(`   시연 콘솔 http://localhost:${config.port}/demo.html`);
  console.log(`   저장소    ${repo.mode}\n`);
});

server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  // 이미 떠 있는 백엔드를 두 번 띄우려 한 상황 — 죽지 말고 알려만 준다
  console.log(`\n백엔드가 이미 :${config.port} 에서 실행 중입니다. 그대로 사용하세요.`);
  console.log(`   다시 띄우려면 먼저 종료하세요:  npx kill-port ${config.port}\n`);
  process.exit(0);
});

// SSE 연결은 오래 열려 있어야 한다. 기본 타임아웃에 끊기지 않도록 늘린다.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;
server.requestTimeout = 0;
