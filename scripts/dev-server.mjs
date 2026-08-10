/**
 * 프론트엔드 개발 서버 (npm run dev).
 *
 * · frontend/ 를 정적 서빙하고 /shared/* 는 shared/ 원본에서 바로 읽는다
 *   (복사본이 아니라 원본을 보므로 지도·경로탐색을 고치면 새로고침만으로 반영된다)
 * · /api/* 는 백엔드(기본 :8080)로 프록시한다 — 같은 출처가 되어 CORS 없이
 *   SSE(/api/stream)도 그대로 흐른다. 배포 구성과 동작이 같아진다.
 * · 백엔드가 아직 안 떠 있으면 503을 돌려준다. 프론트의 오프라인 폴백이
 *   동작하는 것을 확인할 수 있고, 앱이 죽지 않는다.
 *
 * 백엔드는 VS Code에서 F5로 띄운다 (.vscode/launch.json).
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(root, 'frontend');
const SHARED = path.join(root, 'shared');

const PORT = Number(process.env.FRONTEND_PORT) || 5173;
const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8080';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const backendUrl = new URL(BACKEND);
let backendWasUp = null; // 상태가 바뀔 때만 로그를 찍기 위한 플래그

function proxy(req, res) {
  const proxyReq = http.request(
    {
      hostname: backendUrl.hostname,
      port: backendUrl.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: backendUrl.host },
    },
    proxyRes => {
      if (backendWasUp === false) console.log('✅ 백엔드 연결됨');
      backendWasUp = true;
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res); // SSE도 버퍼링 없이 그대로 흘려보낸다
    }
  );

  proxyReq.on('error', () => {
    if (backendWasUp !== false) {
      console.warn(`⚠️  백엔드(${BACKEND}) 응답 없음 — VS Code에서 F5로 실행하세요.`);
    }
    backendWasUp = false;
    if (res.headersSent) return res.end();
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '백엔드에 연결할 수 없습니다.' }));
  });

  req.pipe(proxyReq);
}

async function serveStatic(req, res, pathname) {
  // /shared/* 는 사본이 아닌 원본 디렉터리에서 읽는다
  const file = pathname.startsWith('/shared/')
    ? path.join(SHARED, pathname.slice('/shared/'.length))
    : path.join(FRONTEND, pathname === '/' ? 'index.html' : pathname);

  // 디렉터리 밖 접근 차단
  if (!file.startsWith(FRONTEND) && !file.startsWith(SHARED)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store', // 개발 중에는 항상 최신 파일을 보게 한다
    });
    createReadStream(file).pipe(res);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer((req, res) => {
  // 이 포트를 누가 쓰고 있는지 스스로 식별하기 위한 표식
  res.setHeader('X-Fire-Evac-Dev', '1');
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.startsWith('/api/')) return proxy(req, res);
  serveStatic(req, res, pathname);
});

// 실제로 바인딩된 포트를 보고한다 (재시도한 경우 요청한 포트와 다를 수 있다)
server.on('listening', () => banner(server.address().port));

function banner(port) {
  console.log(`\n🖥️  프론트엔드 개발 서버`);
  console.log(`   사용자 앱  http://localhost:${port}/index.html`);
  console.log(`   관제       http://localhost:${port}/admin.html`);
  console.log(`   보호자     http://localhost:${port}/guardian.html`);
  console.log(`   /api/*  →  ${BACKEND} (VS Code F5로 백엔드 실행)\n`);
}

/** 해당 포트를 점유한 것이 우리 개발 서버인지 확인 */
function isOurDevServer(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, res => {
      res.resume();
      resolve(res.headers['x-fire-evac-dev'] === '1');
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * 포트가 이미 쓰이고 있어도 그냥 죽지 않는다.
 * · 우리 개발 서버가 이미 떠 있으면 그 사실만 알리고 조용히 끝낸다
 *   (이전 실행이 남아 있는 흔한 상황 — 새로 띄울 필요가 없다)
 * · 다른 프로그램이 쓰고 있으면 다음 포트로 옮겨 뜬다
 */
function listen(port, attempt = 0) {
  server.once('error', async err => {
    if (err.code !== 'EADDRINUSE') throw err;

    if (await isOurDevServer(port)) {
      console.log(`\n✅ 개발 서버가 이미 :${port} 에서 실행 중입니다. 그대로 사용하세요.`);
      banner(port);
      console.log(`   (다시 띄우려면 먼저 해당 프로세스를 종료하세요:`);
      console.log(`    Windows  npx kill-port ${port}`);
      console.log(`    macOS/Linux  lsof -ti:${port} | xargs kill)\n`);
      process.exit(0);
    }

    if (attempt >= 10) {
      console.error(`❌ :${port} 부터 10개 포트가 모두 사용 중입니다. FRONTEND_PORT로 지정하세요.`);
      process.exit(1);
    }

    console.warn(`⚠️  :${port} 는 다른 프로그램이 사용 중 → :${port + 1} 로 시도합니다.`);
    listen(port + 1, attempt + 1);
  });

  server.listen(port);
}

listen(PORT);
