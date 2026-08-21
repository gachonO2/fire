/**
 * 백엔드 + 프론트엔드를 한 번에 띄우고 **계속 살려 둔다**.
 *
 * 둘 중 하나가 죽으면 자동으로 다시 띄운다. 시연 도중 서버가 내려가면
 * 대피 안내를 받던 화면과 보호자 화면이 동시에 끊기기 때문이다.
 *
 * 이미 떠 있는 프로세스가 있으면 새로 띄우지 않고 그대로 쓴다 —
 * VS Code F5로 백엔드를 디버깅 중일 때 이 스크립트가 그걸 밀어내면 안 된다.
 *
 * 종료: Ctrl+C (두 프로세스 모두 정리된다)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BACKEND_PORT = Number(process.env.PORT) || 8080;
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT) || 5173;

/** 크래시 루프 방지: 이 시간 안에 죽으면 "빨리 죽었다"고 본다 */
const QUICK_EXIT_MS = 3000;
const MAX_QUICK_RESTARTS = 5;

const services = [
  {
    name: '백엔드',
    color: '\x1b[36m', // 청록
    script: path.join(root, 'backend', 'src', 'server.js'),
    env: { PORT: String(BACKEND_PORT) },
    port: BACKEND_PORT,
    healthPath: '/api/health',
  },
  {
    name: '프론트',
    color: '\x1b[35m', // 자홍
    script: path.join(root, 'scripts', 'dev-server.mjs'),
    env: { FRONTEND_PORT: String(FRONTEND_PORT) },
    port: FRONTEND_PORT,
    healthPath: '/',
  },
];

const RESET = '\x1b[0m';
let shuttingDown = false;

function log(service, line) {
  if (!line.trim()) return;
  console.log(`${service.color}[${service.name}]${RESET} ${line}`);
}

/** 이미 그 포트에서 응답하고 있는지 확인 */
async function alreadyRunning(service) {
  try {
    const res = await fetch(`http://127.0.0.1:${service.port}${service.healthPath}`, {
      signal: AbortSignal.timeout(1200),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

function start(service) {
  service.startedAt = Date.now();

  const child = spawn(process.execPath, [service.script], {
    cwd: root,
    env: { ...process.env, ...service.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.child = child;

  child.stdout.on('data', d => String(d).split('\n').forEach(l => log(service, l)));
  child.stderr.on('data', d => String(d).split('\n').forEach(l => log(service, l)));

  child.on('exit', code => {
    if (shuttingDown) return;

    const lived = Date.now() - service.startedAt;
    service.quickRestarts = lived < QUICK_EXIT_MS ? (service.quickRestarts || 0) + 1 : 0;

    if (service.quickRestarts > MAX_QUICK_RESTARTS) {
      console.error(`\n${service.name}가 반복해서 즉시 종료됩니다. 위 오류를 확인하세요.`);
      console.error(`   고친 뒤 다시 실행하세요: npm run dev:all\n`);
      return;
    }

    log(service, `종료됨 (코드 ${code}) — 2초 뒤 다시 시작합니다.`);
    setTimeout(() => { if (!shuttingDown) start(service); }, 2000);
  });
}

async function main() {
  console.log('\n실내 대피 내비게이션 — 서버를 띄웁니다\n');

  for (const service of services) {
    if (await alreadyRunning(service)) {
      log(service, `이미 :${service.port} 에서 실행 중 — 그대로 사용합니다.`);
      service.skipped = true;
      continue;
    }
    start(service);
  }

  setTimeout(() => {
    console.log(`\n${'─'.repeat(56)}`);
    console.log(`  시연 콘솔   http://localhost:${FRONTEND_PORT}/demo.html`);
    console.log(`  사용자 앱   http://localhost:${FRONTEND_PORT}/index.html`);
    console.log(`  관제        http://localhost:${FRONTEND_PORT}/admin.html`);
    console.log(`  도면·장소   http://localhost:${FRONTEND_PORT}/architect.html`);
    console.log(`${'─'.repeat(56)}`);
    console.log(`  종료하려면 Ctrl+C · 서버가 죽으면 자동으로 다시 뜹니다\n`);
  }, 1500);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n서버를 정리합니다…');
  for (const s of services) s.child?.kill();
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
