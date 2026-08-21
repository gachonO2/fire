import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRepo } from './repositories/index.js';
import { evacuationRoutes } from './routes/evacuation.routes.js';
import { hazardRoutes } from './routes/hazards.routes.js';
import { telemetryRoutes } from './routes/telemetry.routes.js';
import { guardianRoutes } from './routes/guardians.routes.js';
import { planRoutes } from './routes/plans.routes.js';
import { sensorRoutes } from './routes/sensors.routes.js';
import { magneticRoutes } from './routes/magnetic.routes.js';
import { beaconRoutes } from './routes/beacons.routes.js';
import { streamRoutes } from './routes/stream.routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, '../../frontend');

export function createApp() {
  const app = express();

  app.use(cors());
  // 도면 이미지(data URI)가 오가므로 기본 100kb 한도로는 부족하다
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', async (req, res) => {
    const repo = await getRepo();
    res.json({ ok: true, storage: repo.mode, uptime: Math.round(process.uptime()) });
  });

  app.use('/api', evacuationRoutes);
  app.use('/api', hazardRoutes);
  app.use('/api', telemetryRoutes);
  app.use('/api', guardianRoutes);
  app.use('/api', planRoutes);
  app.use('/api', beaconRoutes);
  app.use('/api', magneticRoutes);
  app.use('/api', sensorRoutes);
  app.use('/api', streamRoutes);

  // 개발·시연 편의: 백엔드가 프론트도 함께 서빙한다 (동일 출처라 CORS 불필요).
  // 별도 배포(Firebase Hosting + Cloud Run) 시에는 이 부분이 쓰이지 않는다.
  app.use(express.static(FRONTEND_DIR));

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message });
  });

  return app;
}
