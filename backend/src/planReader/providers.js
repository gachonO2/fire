/**
 * 판독 모델 연결부 — Anthropic 규격과 Google 직접 연결 두 갈래.
 *
 * ## 왜 둘인가
 *
 * 게이트웨이(monogpt·OpenRouter 등)는 Anthropic 규격을 흉내 내지만 **이미지 블록을
 * 조용히 버리는 경우가 있다.** 실제로 monogpt 의 claude-code 프로필에서 그랬다 —
 * 그림만 담아 보내면 제미나이가 "contents is not specified"(내용이 비었다)로 답한다.
 * 우리가 보낸 그림이 통역 과정에서 통째로 사라진 것이다.
 *
 * 그래서 Google 키가 있으면 **게이트웨이를 건너뛰고 직접** 부른다. 통역이 없으면
 * 빠뜨릴 것도 없다.
 *
 * ## 두 경로가 똑같이 답한다
 *
 * 어느 쪽을 쓰든 { toolInput, inputTokens } 만 돌려준다. 판독 로직(프롬프트·검증)은
 * 어느 모델을 쓰는지 몰라도 되고, 나중에 다른 제공자를 붙여도 이 파일만 는다.
 */

import { config } from '../config.js';

const ANTHROPIC_VERSION = '2023-06-01';

/**
 * 게이트웨이 앞의 Cloudflare 는 기본 User-Agent 를 막는다(1010).
 * 우회가 아니라 정상적인 클라이언트임을 알리는 최소한의 표시다.
 */
const BROWSERY_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 잠깐 붐벼서 나는 오류. 다시 걸면 되므로 실패로 못박지 않는다. */
export function isTransient(err) {
  return Boolean(err?.transient);
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRIES = 2;
const RETRY_WAIT_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 붐빌 때 잠깐 기다렸다 다시 건다.
 *
 * 판독은 **사람이 버튼을 누르고 기다리는** 작업이라 몇 초 늦는 건 괜찮다.
 * 반면 "잠깐 붐볐다"를 실패로 돌려주면 사용자는 기능이 고장 난 줄 안다.
 */
async function withRetry(fn) {
  let last;
  for (let i = 0; i <= RETRIES; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      if (!RETRY_STATUSES.has(err.httpStatus) || i === RETRIES) break;
      await sleep(RETRY_WAIT_MS * (i + 1));
    }
  }
  throw last;
}

/** 지금 쓸 연결부. Google 키가 있으면 그쪽이 우선이다 — 이미지가 확실히 가므로. */
export function provider() {
  if (config.openaiApiKey && config.openaiBaseUrl) return openaiCompatible;
  if (config.googleApiKey) return google;
  if (config.anthropicApiKey || config.anthropicAuthToken) return anthropic;
  return null;
}

export function providerLabel() {
  const p = provider();
  return p ? `${p.name} · ${p.model()}` : '연결 없음';
}

// ---------------------------------------------------------- Anthropic 규격

const anthropic = {
  name: 'Anthropic 규격',
  model: () => config.planReaderModel,

  headers() {
    const h = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      // 게이트웨이는 대개 Cloudflare 뒤에 있고, 기본 User-Agent 로 부르면
      // 1010(클라이언트 차단)으로 막힌다. 실제로 monogpt 에서 전부 403 이 났다.
      'user-agent': BROWSERY_UA,
    };
    if (config.anthropicAuthToken) h.authorization = `Bearer ${config.anthropicAuthToken}`;
    if (config.anthropicApiKey) h['x-api-key'] = config.anthropicApiKey;
    return h;
  },

  /**
   * @param parts  [{kind:'image', mediaType, base64}] 와 [{kind:'text', text}] 섞인 배열
   * @param tool   null 이면 그냥 대화 (토큰만 재는 용도)
   */
  async send(parts, { tool = null, maxTokens = 8000 } = {}) {
    const content = parts.map(p => (p.kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }
      : { type: 'text', text: p.text }));

    const body = { model: this.model(), max_tokens: maxTokens, messages: [{ role: 'user', content }] };
    if (tool) {
      body.tools = [{ name: tool.name, description: tool.description, input_schema: tool.schema }];
      body.tool_choice = { type: 'tool', name: tool.name };
    }

    const j = await withRetry(async () => {
      const res = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      });
      if (!res.ok) throw await httpError(res);
      return res.json();
    });
    return {
      toolInput: j.content?.find(c => c.type === 'tool_use')?.input ?? null,
      inputTokens: j.usage?.input_tokens ?? null,
    };
  },
};

// ---------------------------------------------------------- Google 직접

const google = {
  name: 'Google AI Studio',
  model: () => config.googleModel,

  async send(parts, { tool = null, maxTokens = 8000 } = {}) {
    const body = {
      contents: [{
        role: 'user',
        parts: parts.map(p => (p.kind === 'image'
          ? { inlineData: { mimeType: p.mediaType, data: p.base64 } }
          : { text: p.text })),
      }],
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (tool) {
      body.tools = [{ functionDeclarations: [{
        name: tool.name, description: tool.description, parameters: toGoogleSchema(tool.schema),
      }] }];
      // ANY = 반드시 함수를 호출하게 한다. 줄글로 답하면 파싱할 수가 없다.
      body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tool.name] } };
    }

    const url = `${GOOGLE_BASE}/models/${encodeURIComponent(this.model())}:generateContent`;
    const j = await withRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.googleApiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await googleError(res);
      return res.json();
    });
    const call = j.candidates?.[0]?.content?.parts?.find(p => p.functionCall)?.functionCall;
    return { toolInput: call?.args ?? null, inputTokens: j.usageMetadata?.promptTokenCount ?? null };
  },

  /** 쓸 수 있는 모델 목록 — 모델 이름이 틀렸을 때 무엇을 쓰면 되는지 알려주려고 */
  async listModels() {
    const res = await fetch(`${GOOGLE_BASE}/models`, { headers: { 'x-goog-api-key': config.googleApiKey } });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => String(m.name).replace(/^models\//, ''));
  },
};

// ---------------------------------------------------------- OpenAI 규격 게이트웨이

/**
 * OpenAI 규격(`/v1/chat/completions`)만 여는 게이트웨이.
 *
 * MonoRouter 가 그렇다 — Claude·Gemini 모델을 **OpenAI 형식으로만** 중계한다.
 * Anthropic 형식을 보내면 `unknown_endpoint` 404 가 난다.
 *
 * ## 브라우저 흉내가 필요하다
 *
 * 이런 게이트웨이는 Cloudflare 뒤에 있는 경우가 많고, 기본 User-Agent 로 부르면
 * **1010(클라이언트 차단)** 으로 막힌다. 실제로 그래서 처음에 전부 403 이 났다.
 * 우회가 아니라, 정상적인 클라이언트임을 알리는 최소한의 표시다.
 */
const openaiCompatible = {
  name: 'OpenAI 규격 게이트웨이',
  model: () => config.openaiModel,

  headers() {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${config.openaiApiKey}`,
      'user-agent': BROWSERY_UA,
    };
  },

  async send(parts, { tool = null, maxTokens = 8000 } = {}) {
    // OpenAI 는 이미지를 data URI 로 받는다 (Anthropic 의 base64 블록과 다르다)
    const content = parts.map(p => (p.kind === 'image'
      ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.base64}` } }
      : { type: 'text', text: p.text }));

    const body = {
      model: this.model(),
      max_completion_tokens: maxTokens,
      messages: [{ role: 'user', content }],
    };
    if (tool) {
      body.tools = [{
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.schema },
      }];
      body.tool_choice = { type: 'function', function: { name: tool.name } };
    }

    const j = await withRetry(async () => {
      const res = await fetch(`${config.openaiBaseUrl}/v1/chat/completions`, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(body),
      });
      if (!res.ok) throw await httpError(res);
      return res.json();
    });

    const call = j.choices?.[0]?.message?.tool_calls?.[0];
    let toolInput = null;
    if (call?.function?.arguments) {
      // 인자는 **문자열로** 온다. 모델이 깨진 JSON 을 낼 수 있으니 던지지 않고 null 로.
      try { toolInput = JSON.parse(call.function.arguments); } catch (_) { toolInput = null; }
    }
    return { toolInput, inputTokens: j.usage?.prompt_tokens ?? null };
  },

  async listModels() {
    try {
      const res = await fetch(`${config.openaiBaseUrl}/v1/models`, { headers: this.headers() });
      if (!res.ok) return [];
      const j = await res.json();
      return (j.data || []).map(m => m.id);
    } catch (_) { return []; }
  },
};

// ---------------------------------------------------------- 도구 스키마 변환

/**
 * JSON Schema → Google Schema.
 *
 * 거의 같지만 Google 은 type 을 대문자로 받고, 모르는 필드가 있으면 요청 전체를
 * 거절한다. 그래서 **아는 필드만 골라 담는다.**
 */
function toGoogleSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) out.type = String(s.type).toUpperCase();
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toGoogleSchema(v)]),
    );
  }
  if (s.items) out.items = toGoogleSchema(s.items);
  if (Array.isArray(s.required) && s.required.length) out.required = s.required;
  return out;
}

// ---------------------------------------------------------- 오류

async function httpError(res) {
  const body = await res.text().catch(() => '');
  return Object.assign(
    new Error(`판독 요청이 실패했습니다 (${res.status}). ${body.slice(0, 300)}`),
    { status: 502, httpStatus: res.status, transient: RETRY_STATUSES.has(res.status) },
  );
}

/** 모델 이름이 틀린 경우가 흔해서, 쓸 수 있는 이름을 같이 알려준다 */
async function googleError(res) {
  const body = await res.text().catch(() => '');
  if (res.status === 404 || /not found|not supported/i.test(body)) {
    const names = await google.listModels().catch(() => []);
    const hint = names.length
      ? `\n쓸 수 있는 모델: ${names.filter(n => /gemini/.test(n)).slice(0, 12).join(', ')}`
      : '';
    return Object.assign(
      new Error(`모델 "${google.model()}" 을 찾을 수 없습니다. backend/.env 의 GOOGLE_MODEL 을 바꿔주세요.${hint}`),
      { status: 400, httpStatus: res.status, transient: false },
    );
  }
  if (res.status === 400 && /API key not valid/i.test(body)) {
    return Object.assign(new Error('Google API 키가 유효하지 않습니다. aistudio.google.com 에서 다시 확인해주세요.'), { status: 401, transient: false });
  }
  return Object.assign(
    new Error(
      RETRY_STATUSES.has(res.status)
        ? `판독 서버가 지금 붐빕니다 (${res.status}). 잠시 뒤 다시 눌러주세요.`
        : `판독 요청이 실패했습니다 (${res.status}). ${body.slice(0, 300)}`,
    ),
    { status: 502, httpStatus: res.status, transient: RETRY_STATUSES.has(res.status) },
  );
}

export const _internal = { toGoogleSchema, google, anthropic };
