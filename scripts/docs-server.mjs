/**
 * 발표자료 문서 서버 (npm run docs) — http://localhost:3030
 *
 * docs/ 아래의 정적 문서를 그대로 내준다. 앱 개발 서버(scripts/dev-server.mjs)와
 * 따로 두는 이유는 두 가지다.
 *
 * · 발표 중에 앱을 재시작하거나 백엔드가 죽어도 문서는 계속 떠 있어야 한다.
 *   같은 서버에 얹으면 앱을 만지는 순간 발표 화면이 함께 끊긴다.
 * · 문서는 API 프록시도 라이브리로드도 필요 없다. 정적 파일만 내주면 된다.
 *
 * 포트를 옮기려면 DOCS_PORT 환경변수. 다만 팀원끼리 링크를 주고받으므로
 * 기본값 3030 을 그대로 쓰는 편이 낫다.
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(root, 'docs');

const PORT = Number(process.env.DOCS_PORT) || 3030;

/** 문서를 열었을 때 첫 화면 — 문서가 늘어나면 여기 목록을 늘린다 */
const HOME = '/ai-training/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (pathname === '/') {
    res.writeHead(302, { Location: HOME });
    return res.end();
  }

  // docs/ 밖으로 나가는 경로는 받지 않는다 (../ 로 저장소 전체가 열리는 것을 막는다).
  // 구분자까지 함께 본다 — 접두사만 보면 docs 옆의 docs-private 이 통과한다.
  const target = path.join(DOCS, decodeURIComponent(pathname));
  if (target !== DOCS && !target.startsWith(DOCS + path.sep)) return send404(res);

  let file = target;
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    return send404(res);
  }

  try {
    await stat(file);
  } catch {
    return send404(res);
  }

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
});

function send404(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`문서를 찾지 못했습니다. http://localhost:${PORT}${HOME} 로 시작하세요.\n`);
}

// 포트를 다른 데로 옮기지 않는다 — 팀원에게 알려 준 주소가 3030 이기 때문이다.
server.on('error', err => {
  if (err.code !== 'EADDRINUSE') throw err;
  console.error(`\n:${PORT} 가 이미 사용 중입니다. 먼저 그 프로세스를 종료하세요.`);
  console.error(`   Windows      npx kill-port ${PORT}`);
  console.error(`   macOS/Linux  lsof -ti:${PORT} | xargs kill`);
  console.error(`   다른 포트로 띄우려면  DOCS_PORT=3031 npm run docs\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`\n발표자료 문서 서버`);
  console.log(`   AI 학습·지표  http://localhost:${PORT}${HOME}`);
  console.log(`   같은 망에 있는 팀원에게는 이 PC의 IP 로 주소를 알려주면 됩니다.\n`);
});
