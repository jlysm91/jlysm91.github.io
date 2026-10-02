// A general video model can propose a KSL interpretation, but is not a validated
// Korean Sign Language translator. Every returned segment remains a draft.
export const GEMINI_VIDEO_MODEL = 'gemini-flash-latest';
export const MAX_VIDEO_BYTES = 12 * 1024 * 1024;
export const MAX_VIDEO_SECONDS = 60;
export const VIDEO_MIME_TYPES = Object.freeze([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/mov', 'video/mpeg',
]);

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VIDEO_MODEL}:generateContent`;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_SEGMENTS = 30;
const MAX_TOTAL_TEXT = 3000;
const KSL_PROMPT = `이 영상의 한국수어(KSL, Korean Sign Language)를 한국어 글로 해석하는 실험용 초안을 작성하세요.
당신은 검증된 한국수어 전문 번역기가 아닙니다. 미국수어(ASL)나 다른 수어의 의미를 한국수어라고 대체하지 마세요.
손의 모양, 위치, 움직임, 양손 관계 및 수어의 비수지 신호가 실제 영상에서 충분히 확인될 때에만 의미를 제안하세요.
음성, 자막, 화면의 글자(OCR), 입술 읽기, 배경 상황, 일반 제스처 또는 그럴듯한 문장을 근거로 수어의 의미를 추측하지 마세요.
손이나 얼굴이 가려졌거나 프레임이 부족하거나 한국수어인지 판단할 수 없거나 의미를 확신할 근거가 없으면 반드시 해석을 보류하세요.
읽을 수 있는 구간만 segments에 담고 각 구간의 시작과 끝을 영상 시작 기준 초 단위 숫자로 작성하세요. 모든 구간의 uncertain은 true입니다.
읽을 수 있는 구간이 전혀 없으면 segments는 빈 배열, summary는 빈 문자열, unreadableReason은 해석을 보류한 구체적인 한국어 이유입니다.
일부 구간을 읽을 수 없으면 그 구간은 제외하고 unreadableReason에 그 한계를 짧게 적으세요.
summary는 실제로 해석한 구간의 내용만 간결하게 요약하세요. 원문에 없는 인사, 목적, 인물 정보나 연결 문장을 만들지 마세요.
구간은 최대 30개, 구간별 text는 최대 500자, text 전체는 최대 3000자, summary와 unreadableReason은 각각 최대 500자입니다.
지정된 JSON 구조만 반환하세요. 이 결과는 한국수어 사용자의 확인이 필요한 해석 초안입니다.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'NUMBER', description: '영상 시작 기준 구간 시작 시간(초)' },
          end: { type: 'NUMBER', description: '영상 시작 기준 구간 종료 시간(초)' },
          text: { type: 'STRING', description: '영상에서 근거를 확인한 한국어 해석 초안' },
          uncertain: { type: 'BOOLEAN', description: '검증되지 않은 초안이므로 항상 true' },
        },
        required: ['start', 'end', 'text', 'uncertain'],
      },
    },
    summary: { type: 'STRING' },
    unreadableReason: { type: 'STRING' },
  },
  required: ['segments', 'summary', 'unreadableReason'],
};

function fail(message, code) {
  const error = new Error(message);
  error.name = 'GeminiVideoError';
  error.code = code;
  return error;
}

function cancelled() {
  return fail('영상 분석을 취소했어요.', 'ABORTED');
}

export function validateKSLVideo(file, duration) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw fail('내용이 있는 영상 파일을 선택해 주세요.', 'INVALID_FILE');
  }
  if (!VIDEO_MIME_TYPES.includes(file.type?.toLowerCase())) {
    throw fail('MP4, WebM, MOV 또는 MPEG 영상 파일을 선택해 주세요.', 'UNSUPPORTED_FORMAT');
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw fail('영상 크기는 12MB 이하여야 해요. 영상을 줄인 뒤 다시 선택해 주세요.', 'FILE_TOO_LARGE');
  }
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_SECONDS)) {
    throw fail('60초 이하의 영상만 분석할 수 있어요. 영상 길이를 확인해 주세요.', 'INVALID_DURATION');
  }
}

function readBase64(file, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return; }
    const reader = new FileReader();
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      reader.onload = null;
      reader.onerror = null;
      reader.onabort = null;
    };
    const finish = (operation, value) => { cleanup(); operation(value); };
    const abort = () => {
      // Reject before aborting so even a reader that emits no abort event settles.
      finish(reject, cancelled());
      reader.abort();
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      const base64 = comma >= 0 ? result.slice(comma + 1) : '';
      if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        finish(reject, fail('영상 파일을 읽지 못했어요. 파일을 다시 선택해 주세요.', 'READ_FAILED'));
        return;
      }
      finish(resolve, base64);
    };
    reader.onerror = () => finish(reject, fail('영상 파일을 읽지 못했어요. 파일을 다시 선택해 주세요.', 'READ_FAILED'));
    reader.onabort = () => finish(reject, cancelled());
    signal.addEventListener('abort', abort, { once: true });
    try { reader.readAsDataURL(file); }
    catch { finish(reject, fail('영상 파일을 읽지 못했어요. 파일을 다시 선택해 주세요.', 'READ_FAILED')); }
  });
}

function httpError(status) {
  if (status === 401 || status === 403) return fail('API 키 또는 Google AI Studio 접근 권한을 확인해 주세요.', 'API_KEY_REJECTED');
  if (status === 429) return fail('Google API 사용 한도에 도달했어요. 잠시 후 다시 시도하거나 사용량을 확인해 주세요.', 'RATE_LIMITED');
  if (status === 400 || status === 413) return fail('Google에서 이 영상 요청을 처리하지 못했어요. 영상 형식과 길이를 확인해 주세요.', 'REQUEST_REJECTED');
  if (status === 404) return fail('현재 영상 분석 모델을 사용할 수 없어요. 잠시 후 다시 시도해 주세요.', 'MODEL_UNAVAILABLE');
  return fail('Google 영상 분석 서비스가 응답하지 못했어요. 잠시 후 다시 시도해 주세요.', 'SERVICE_ERROR');
}

function parseResult(response, duration) {
  const invalid = () => fail('분석 응답 형식을 확인하지 못했어요. 다시 시도해 주세요.', 'INVALID_RESPONSE');
  if (!response || typeof response !== 'object') throw invalid();
  if (response.promptFeedback?.blockReason) {
    throw fail('Google에서 이 영상의 분석을 제한했어요. 다른 영상을 선택해 주세요.', 'CONTENT_BLOCKED');
  }
  const candidate = response.candidates?.[0];
  if (!candidate) throw fail('Google에서 분석 결과를 보내지 않았어요. 다른 영상으로 다시 시도해 주세요.', 'EMPTY_RESPONSE');
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw fail('분석 응답이 중간에 끝났어요. 영상을 더 짧게 줄여 다시 시도해 주세요.', 'TRUNCATED_RESPONSE');
  }
  if (['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'RECITATION'].includes(candidate.finishReason)) {
    throw fail('Google에서 이 영상의 분석을 제한했어요. 다른 영상을 선택해 주세요.', 'CONTENT_BLOCKED');
  }
  if (candidate.finishReason && candidate.finishReason !== 'STOP') throw invalid();
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) throw invalid();
  const output = parts.filter(part => part && part.thought !== true && typeof part.text === 'string').map(part => part.text).join('');
  let parsed;
  try { parsed = JSON.parse(output); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.segments) || parsed.segments.length > MAX_SEGMENTS) throw invalid();
  if (typeof parsed.summary !== 'string' || parsed.summary.length > 500 || typeof parsed.unreadableReason !== 'string' || parsed.unreadableReason.length > 500) throw invalid();
  const maximum = duration ?? MAX_VIDEO_SECONDS;
  let totalText = 0;
  const segments = parsed.segments.map(segment => {
    if (!segment || typeof segment !== 'object' || !Number.isFinite(segment.start) || !Number.isFinite(segment.end) || segment.start < 0 || segment.end <= segment.start || segment.end > maximum) throw invalid();
    if (typeof segment.text !== 'string' || !segment.text.trim() || segment.text.length > 500 || typeof segment.uncertain !== 'boolean') throw invalid();
    totalText += segment.text.length;
    if (totalText > MAX_TOTAL_TEXT) throw invalid();
    return { start: segment.start, end: segment.end, text: segment.text.trim(), uncertain: true };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const unreadableReason = parsed.unreadableReason.trim();
  if (!segments.length && !unreadableReason) throw invalid();
  return {
    segments,
    // No readable signs means there is no grounded summary to show.
    summary: segments.length ? parsed.summary.trim() : '',
    unreadableReason,
    model: GEMINI_VIDEO_MODEL,
  };
}

/** Send an explicitly consented-to video to Google; no key or result is persisted. */
export async function analyzeKSLVideo({ file, apiKey, signal, onProgress, duration } = {}) {
  validateKSLVideo(file, duration);
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (key.length <= 10 || /[\r\n]/.test(key)) throw fail('Google AI Studio API 키를 입력해 주세요.', 'MISSING_API_KEY');
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  let timedOut = false;
  const externalAbort = () => controller.abort();
  signal?.addEventListener('abort', externalAbort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const progress = (phase, message) => {
    if (typeof onProgress === 'function') onProgress({ phase, message });
  };
  try {
    progress('preparing', '영상을 분석 요청에 맞게 준비하고 있어요.');
    const data = await readBase64(file, controller.signal);
    if (controller.signal.aborted) throw cancelled();
    progress('uploading', 'Google로 영상을 보내 분석 응답을 기다리고 있어요.');
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { inlineData: { mimeType: file.type.toLowerCase() === 'video/quicktime' ? 'video/mov' : file.type.toLowerCase(), data }, videoMetadata: { fps: 8 } },
            { text: KSL_PROMPT },
          ] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, maxOutputTokens: 8192, temperature: 0 },
        }),
      });
    } catch (error) {
      if (controller.signal.aborted) throw cancelled();
      throw fail('Google에 연결하지 못했어요. 인터넷 연결과 API 접근 가능 여부를 확인해 주세요.', 'NETWORK_ERROR');
    }
    if (controller.signal.aborted) throw cancelled();
    if (!response.ok) throw httpError(response.status);
    progress('analyzing', 'Google 응답에서 해석 구간을 확인하고 있어요.');
    let payload;
    try { payload = await response.json(); }
    catch {
      if (controller.signal.aborted) throw cancelled();
      throw fail('Google 분석 응답을 읽지 못했어요. 다시 시도해 주세요.', 'INVALID_RESPONSE');
    }
    if (controller.signal.aborted) throw cancelled();
    const result = parseResult(payload, duration);
    progress('complete', '확인이 필요한 해석 초안을 준비했어요.');
    return result;
  } catch (error) {
    if (timedOut) throw fail('분석 응답 시간이 초과됐어요. 영상을 줄이거나 잠시 후 다시 시도해 주세요.', 'TIMEOUT');
    if (controller.signal.aborted) throw cancelled();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', externalAbort);
  }
}
