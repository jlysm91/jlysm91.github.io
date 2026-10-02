import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  analyzeKSLVideo, validateKSLVideo, MAX_VIDEO_BYTES, GEMINI_VIDEO_MODEL,
} from '../js/gemini-video.js';

const original = {
  fetch: globalThis.fetch,
  FileReader: globalThis.FileReader,
  setTimeout: globalThis.setTimeout,
};
const apiKey = 'test-key-used-only-in-a-mock';
let calls;
let readers;

class MockFileReader {
  constructor() { this.result = null; this.aborted = false; readers.push(this); }
  readAsDataURL(file) {
    if (file.neverRead) return;
    if (file.readError) { queueMicrotask(() => this.onerror?.()); return; }
    file.arrayBuffer().then(bytes => {
      if (this.aborted) return;
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload?.();
    });
  }
  abort() { this.aborted = true; this.onabort?.(); }
}

function file(type = 'video/mp4') {
  return new File([Uint8Array.from([0, 1, 2, 3, 254, 255])], 'sign.mp4', { type });
}
function result(overrides = {}) {
  return {
    segments: [{ start: 0, end: 1.8, text: '안녕하세요', uncertain: true }],
    summary: '인사하는 수어로 보입니다.', unreadableReason: '', ...overrides,
  };
}
function envelope(value = result(), extras = {}) {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] }, ...extras }] };
}
function mockResponse(value = envelope(), status = 200) {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
function analyze(options = {}) { return analyzeKSLVideo({ file: file(), apiKey, duration: 3, ...options }); }
function rejectCode(code) { return error => error.code === code && /[가-힣]/.test(error.message); }

beforeEach(() => {
  calls = []; readers = [];
  globalThis.FileReader = MockFileReader;
  mockResponse();
});
afterEach(() => {
  globalThis.fetch = original.fetch;
  globalThis.FileReader = original.FileReader;
  globalThis.setTimeout = original.setTimeout;
});

test('validates video type, byte size and optional duration before sending data', async () => {
  for (const video of [file('image/jpeg'), { type: 'video/mp4', size: 0 }, { type: 'video/mp4', size: MAX_VIDEO_BYTES + 1 }]) {
    await assert.rejects(analyze({ file: video }));
  }
  for (const duration of [0, -1, 61, NaN, Infinity, '30']) {
    await assert.rejects(analyze({ duration }), rejectCode('INVALID_DURATION'));
  }
  assert.equal(calls.length, 0);
  assert.equal(readers.length, 0);
  assert.doesNotThrow(() => validateKSLVideo({ type: 'video/mp4', size: MAX_VIDEO_BYTES }, 60));
  assert.doesNotThrow(() => validateKSLVideo(file()));
});

test('requires a key, accepts aliases without assuming a Google key prefix', async () => {
  for (const key of [undefined, '', 'short', 'x'.repeat(10), 'valid-looking\nkey-secret']) {
    await assert.rejects(analyze({ apiKey: key }), rejectCode('MISSING_API_KEY'));
  }
  assert.equal(calls.length, 0);
  await analyze({ apiKey: `  ${apiKey}  ` });
  assert.equal(calls[0].options.headers['x-goog-api-key'], apiKey);
});

test('sends inline video and structured KSL instructions without exposing the key in URL or body', async () => {
  const stages = [];
  const response = await analyze({ onProgress: progress => stages.push(progress) });
  assert.equal(response.model, GEMINI_VIDEO_MODEL);
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers['x-goog-api-key'], apiKey);
  assert.equal(url.includes(apiKey), false);
  assert.equal(options.body.includes(apiKey), false);
  const body = JSON.parse(options.body);
  const parts = body.contents[0].parts;
  assert.deepEqual(parts[0].inlineData, { mimeType: 'video/mp4', data: 'AAECA/7/' });
  assert.equal(parts[0].videoMetadata.fps, 8);
  assert.match(parts[1].text, /한국수어\(KSL/);
  assert.match(parts[1].text, /ASL/);
  assert.match(parts[1].text, /반드시 해석을 보류/);
  assert.match(parts[1].text, /음성, 자막/);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema.required, ['segments', 'summary', 'unreadableReason']);
  assert.deepEqual(stages.map(stage => stage.phase), ['preparing', 'uploading', 'analyzing', 'complete']);
  assert.ok(stages.every(stage => /[가-힣]/.test(stage.message)));
});

test('normalizes the browser MOV MIME type for the video API', async () => {
  await analyze({ file: file('video/quicktime') });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.contents[0].parts[0].inlineData.mimeType, 'video/mov');
});

test('keeps results as uncertain drafts and sorts timestamped segments', async () => {
  mockResponse(envelope(result({ segments: [
    { start: 2, end: 3, text: ' 감사합니다 ', uncertain: false },
    { start: 0, end: 1, text: '안녕하세요', uncertain: true },
  ] })));
  const response = await analyze();
  assert.deepEqual(response.segments, [
    { start: 0, end: 1, text: '안녕하세요', uncertain: true },
    { start: 2, end: 3, text: '감사합니다', uncertain: true },
  ]);
});

test('returns abstention with no misleading summary when no signs are readable', async () => {
  mockResponse(envelope(result({ segments: [], summary: 'Invented summary', unreadableReason: '손이 가려져 있어요.' })));
  const response = await analyze();
  assert.deepEqual(response.segments, []);
  assert.equal(response.summary, '');
  assert.equal(response.unreadableReason, '손이 가려져 있어요.');
  mockResponse(envelope(result({ segments: [], summary: '', unreadableReason: '' })));
  await assert.rejects(analyze(), rejectCode('INVALID_RESPONSE'));
});

test('ignores model thought parts and joins only structured answer text', async () => {
  const json = JSON.stringify(result());
  mockResponse(envelope(result(), { content: { parts: [
    { thought: true, text: 'A private explanation that is not JSON.' },
    { text: json.slice(0, 25) }, { text: json.slice(25) },
  ] } }));
  assert.equal((await analyze()).segments[0].text, '안녕하세요');
});

test('rejects malformed or free-form answers instead of pretending they are translations', async () => {
  for (const output of ['안녕하세요', '```json\n{}\n```', '{}', 'null', '[]']) {
    mockResponse(envelope(result(), { content: { parts: [{ text: output }] } }));
    await assert.rejects(analyze(), rejectCode('INVALID_RESPONSE'));
  }
});

test('rejects impossible timestamps, missing uncertainty and empty segment text', async () => {
  for (const segment of [
    { start: -1, end: 1, text: '인사', uncertain: true },
    { start: 1, end: 1, text: '인사', uncertain: true },
    { start: 2, end: 1, text: '인사', uncertain: true },
    { start: 0, end: 3.01, text: '인사', uncertain: true },
    { start: '0', end: 1, text: '인사', uncertain: true },
    { start: 0, end: null, text: '인사', uncertain: true },
    { start: 0, end: 1, text: '인사' },
    { start: 0, end: 1, text: ' ', uncertain: true },
  ]) {
    mockResponse(envelope(result({ segments: [segment] })));
    await assert.rejects(analyze(), rejectCode('INVALID_RESPONSE'));
  }
  mockResponse(envelope(result({ segments: [{ start: 0, end: 60.1, text: '인사', uncertain: true }] })));
  await assert.rejects(analyze({ duration: undefined }), rejectCode('INVALID_RESPONSE'));
});

test('bounds segment count and text lengths', async () => {
  const segment = { start: 0, end: 1, text: '인사', uncertain: true };
  for (const oversized of [
    result({ segments: Array(31).fill(segment) }),
    result({ segments: [{ ...segment, text: '가'.repeat(501) }] }),
    result({ segments: Array(7).fill({ ...segment, text: '가'.repeat(500) }) }),
    result({ summary: '가'.repeat(501) }),
    result({ unreadableReason: '가'.repeat(501) }),
  ]) {
    mockResponse(envelope(oversized));
    await assert.rejects(analyze(), rejectCode('INVALID_RESPONSE'));
  }
});

test('reports Google safety blocks, absent candidates and truncated responses clearly', async () => {
  for (const [payload, code] of [
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'CONTENT_BLOCKED'],
    [{ candidates: [] }, 'EMPTY_RESPONSE'],
    [envelope(result(), { finishReason: 'SAFETY' }), 'CONTENT_BLOCKED'],
    [envelope(result(), { finishReason: 'MAX_TOKENS' }), 'TRUNCATED_RESPONSE'],
  ]) {
    mockResponse(payload);
    await assert.rejects(analyze(), rejectCode(code));
  }
});

test('maps HTTP errors to Korean messages without echoing provider details or keys', async () => {
  for (const [status, code] of [[401, 'API_KEY_REJECTED'], [403, 'API_KEY_REJECTED'], [429, 'RATE_LIMITED'], [413, 'REQUEST_REJECTED'], [404, 'MODEL_UNAVAILABLE'], [503, 'SERVICE_ERROR']]) {
    mockResponse({ error: { message: `Provider echoed ${apiKey}` } }, status);
    await assert.rejects(analyze(), error => rejectCode(code)(error) && !error.message.includes(apiKey));
  }
});

test('reports a failed connection and malformed transport JSON', async () => {
  globalThis.fetch = async () => { throw new TypeError('Fetch failed'); };
  await assert.rejects(analyze(), rejectCode('NETWORK_ERROR'));
  globalThis.fetch = async () => new Response('not json', { status: 200 });
  await assert.rejects(analyze(), rejectCode('INVALID_RESPONSE'));
});

test('does not read or send an already cancelled video', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(analyze({ signal: controller.signal }), rejectCode('ABORTED'));
  assert.equal(readers.length, 0);
  assert.equal(calls.length, 0);
});

test('cancels FileReader promptly before upload', async () => {
  const controller = new AbortController();
  const video = file(); video.neverRead = true;
  const pending = analyze({ file: video, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, rejectCode('ABORTED'));
  assert.equal(readers[0].aborted, true);
  assert.equal(readers[0].onload, null);
  assert.equal(calls.length, 0);
});

test('passes cancellation to the in-flight request', async () => {
  const controller = new AbortController();
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    controller.abort();
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  };
  await assert.rejects(analyze({ signal: controller.signal }), rejectCode('ABORTED'));
  assert.equal(calls[0].options.signal.aborted, true);
});

test('times out a stalled request and distinguishes timeout from user cancellation', async () => {
  globalThis.setTimeout = (callback, delay, ...args) => original.setTimeout(callback, delay === 90_000 ? 1 : delay, ...args);
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await assert.rejects(analyze(), rejectCode('TIMEOUT'));
});

test('reports file read failures without calling the API', async () => {
  const video = file(); video.readError = true;
  await assert.rejects(analyze({ file: video }), rejectCode('READ_FAILED'));
  assert.equal(calls.length, 0);
});
