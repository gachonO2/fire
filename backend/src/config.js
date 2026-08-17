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

  // 도면 사진 판독용. 없으면 판독 기능만 꺼지고 손으로 그리기는 그대로 된다.
  //
  // 게이트웨이(monogpt 같은 라우터)를 거칠 수도 있어 주소와 인증 방식을 둘 다 연다.
  //   ANTHROPIC_API_KEY    → x-api-key 헤더 (Anthropic 직접 연결)
  //   ANTHROPIC_AUTH_TOKEN → Authorization: Bearer (게이트웨이 대부분)
  anthropicBaseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
  planReaderModel: process.env.PLAN_READER_MODEL || 'claude-opus-5',

  // Google AI Studio 직접 연결. 게이트웨이를 거치지 않으므로 이미지가 확실히 전달된다.
  // 모델 이름을 따로 둔 이유: 게이트웨이용 PLAN_READER_MODEL 이 남아 있어도 섞이지 않게.
  googleApiKey: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '',
  googleModel: process.env.GOOGLE_MODEL || 'gemini-3.5-flash',
};

/** 서비스 계정이 준비된 경우에만 Firestore를 쓴다. 아니면 인메모리 데모 모드. */
export const useFirestore = () => Boolean(config.firebaseProjectId);
