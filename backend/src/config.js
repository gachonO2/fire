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

  // 도면 기호 탐지기 (ml/detector — 직접 학습시킨 YOLO 가중치).
  // 안 떠 있으면 판독이 언어모델만으로 돌아간다. 꺼져 있다고 도면 등록이 막히지는 않는다.
  detectorUrl: (process.env.DETECTOR_URL || 'http://127.0.0.1:8001').replace(/\/+$/, ''),
  // 이보다 확신이 낮은 탐지는 버린다. 서비스 쪽 문턱(DETECT_CONF)보다 뒤에 걸리는
  // 2차 문턱이라, 모델을 다시 안 띄우고도 여기서 조일 수 있다.
  detectorMinConfidence: Number(process.env.DETECTOR_MIN_CONFIDENCE) || 0.3,
  // OpenAI 규격 게이트웨이 (monogpt/MonoRouter, OpenRouter, 자체 프록시 등).
  //
  // Anthropic 규격을 흉내 내는 게이트웨이도 있지만, MonoRouter 처럼 **OpenAI
  // 규격만** 여는 곳이 있다. 그쪽으로 Anthropic 형식을 보내면 404 가 난다.
  openaiBaseUrl: (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, ''),
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gemini-3.5-flash',
};

/** 서비스 계정이 준비된 경우에만 Firestore를 쓴다. 아니면 인메모리 데모 모드. */
export const useFirestore = () => Boolean(config.firebaseProjectId);
