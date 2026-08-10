import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 루트에서 실행하든 backend/에서 실행하든 같은 .env를 읽도록 경로를 고정한다
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(backendRoot, '.env') });

const resolveFromBackend = p => (p && !path.isAbsolute(p) ? path.join(backendRoot, p) : p);

export const config = {
  port: Number(process.env.PORT) || 8080,
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || '',
  credentialsPath: resolveFromBackend(process.env.GOOGLE_APPLICATION_CREDENTIALS || ''),
  adminToken: process.env.ADMIN_TOKEN || '',
};

/** 서비스 계정이 준비된 경우에만 Firestore를 쓴다. 아니면 인메모리 데모 모드. */
export const useFirestore = () => Boolean(config.firebaseProjectId);
