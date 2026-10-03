/** Camera recording stays local. Importing/constructing this module never requests permission. */
export const MAX_RECORDING_SECONDS = 60;
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
const MIME_CANDIDATES = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
const abortError = () => new DOMException('촬영을 취소했습니다.', 'AbortError');
function fail(message) { throw new Error(message); }
function checkSignal(signal) { if (signal?.aborted) throw abortError(); }
function stopTracks(stream) { for (const track of stream?.getTracks?.() || []) { try { track.stop(); } catch { /* Release every remaining track. */ } } }
function cameraError(error) {
  const messages = {
    NotAllowedError: '카메라 사용이 허용되지 않았습니다. 브라우저의 카메라 권한을 확인한 뒤 다시 열어 주세요.',
    SecurityError: '이 환경에서는 카메라를 열 수 없습니다. HTTPS 주소 또는 localhost에서 열어 주세요.',
    NotFoundError: '사용할 수 있는 카메라가 없습니다. 카메라 연결을 확인해 주세요.',
    NotReadableError: '카메라를 사용할 수 없습니다. 다른 앱의 카메라 사용을 종료한 뒤 다시 시도해 주세요.',
    OverconstrainedError: '선택한 카메라를 열 수 없습니다. 다른 카메라를 선택해 주세요.',
  };
  return new Error(messages[error?.name] || '카메라를 열지 못했습니다. 연결과 권한을 확인한 뒤 다시 시도해 주세요.');
}

// EBML sizes retain their marker only for IDs. No compressed media bytes are decoded or changed.
function element(bytes, offset, limit = bytes.length) {
  const start = offset;
  function vint(isId) {
    if (offset >= limit || bytes[offset] === 0) fail('녹화 영상의 WebM 구조를 읽지 못했습니다.');
    let length = 1, marker = 0x80;
    while (!(bytes[offset] & marker)) { marker >>= 1; length++; }
    if (length > (isId ? 4 : 8) || offset + length > limit) fail('녹화 영상의 WebM 길이 정보가 올바르지 않습니다.');
    let value = BigInt(isId ? bytes[offset] : bytes[offset] & (marker - 1));
    for (let index = 1; index < length; index++) value = value * 256n + BigInt(bytes[offset + index]);
    offset += length;
    if (!isId && value === (1n << BigInt(7 * length)) - 1n) return null;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('녹화 영상의 WebM 요소가 너무 큽니다.');
    return Number(value);
  }
  const id = vint(true), sizeOffset = offset, size = vint(false), body = offset;
  const end = size === null ? limit : body + size;
  if (end > limit) fail('녹화 영상의 WebM 데이터가 중간에 끊겼습니다.');
  return { id, start, sizeOffset, body, end, size };
}
function sizeBytes(value) {
  let length = 1;
  while (BigInt(value) >= (1n << BigInt(length * 7)) - 1n) length++;
  let encoded = BigInt(value) | (1n << BigInt(length * 7));
  const bytes = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) { bytes[index] = Number(encoded & 255n); encoded >>= 8n; }
  return bytes;
}
function unsigned(bytes, start, end) {
  if (end <= start || end - start > 6) fail('녹화 영상의 시간 단위를 읽지 못했습니다.');
  let result = 0;
  for (let index = start; index < end; index++) result = result * 256 + bytes[index];
  return result;
}

/** Write finite Duration into this recorder's unindexed streaming WebM, without transcoding.
 * EBML/RFC8794 and Matroska Info/Duration: timestamp ticks use TimestampScale nanoseconds.
 * Indexed containers are left untouched when Duration already exists; unsupported structures fail closed.
 */
export async function finalizeWebMDuration(blob, seconds, signal) {
  checkSignal(signal);
  if (!(blob instanceof Blob) || !blob.size || blob.size > MAX_RECORDING_BYTES || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RECORDING_SECONDS) fail('녹화 영상의 길이 또는 용량을 확인할 수 없습니다. 다시 촬영해 주세요.');
  const bytes = new Uint8Array(await blob.arrayBuffer()); checkSignal(signal);
  const header = element(bytes, 0);
  if (header.id !== 0x1a45dfa3 || header.size === null) fail('지원하는 WebM 녹화 파일이 아닙니다.');
  const segment = element(bytes, header.end);
  if (segment.id !== 0x18538067 || segment.end !== bytes.length) fail('지원하는 WebM 녹화 구조가 아닙니다.');
  let info, indexed = false;
  for (let offset = segment.body; offset < segment.end;) {
    const child = element(bytes, offset, segment.end);
    if (child.id === 0x1549a966) { if (info) fail('WebM 영상 정보가 중복되어 있습니다.'); info = child; }
    if ([0x114d9b74, 0x1c53bb6b, 0xbf].includes(child.id)) indexed = true;
    let end = child.end;
    if (child.id === 0x1f43b675) {
      // Walk element boundaries (never search compressed bytes) to find streaming Cluster ends.
      // Position is an optional absolute Segment offset and cannot survive inserted metadata.
      const topLevel = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469]);
      for (let cursor = child.body; cursor < child.end;) {
        const entry = element(bytes, cursor, child.end);
        if (topLevel.has(entry.id)) {
          if (child.size !== null) fail('WebM 영상의 클러스터 구조가 올바르지 않습니다.');
          end = cursor; break;
        }
        if (entry.size === null) fail('지원하는 WebM 프레임 구조가 아닙니다.');
        if (entry.id === 0xa7) indexed = true;
        cursor = entry.end;
      }
    } else if (child.size === null) fail('지원하는 WebM 녹화 구조가 아닙니다.');
    offset = end;
  }
  if (!info || info.size === null) fail('WebM 영상의 시간 정보를 찾지 못했습니다.');
  let scale = 1000000, durationElement;
  const children = [];
  for (let offset = info.body; offset < info.end;) {
    const child = element(bytes, offset, info.end);
    if (child.size === null) fail('WebM 영상의 시간 정보가 올바르지 않습니다.');
    if (child.id === 0x2ad7b1) scale = unsigned(bytes, child.body, child.end);
    if (child.id === 0x4489) durationElement = child;
    children.push(child); offset = child.end;
  }
  if (!Number.isFinite(scale) || scale <= 0) fail('WebM 영상의 시간 단위가 올바르지 않습니다.');
  if (durationElement && [4, 8].includes(durationElement.size)) {
    const view = new DataView(bytes.buffer, durationElement.body, durationElement.size);
    const existing = durationElement.size === 8 ? view.getFloat64(0, false) : view.getFloat32(0, false);
    if (Number.isFinite(existing) && existing > 0) return blob;
  }
  if (indexed) fail('이 WebM 녹화 파일의 재생 시간을 안전하게 완성하지 못했습니다. 다른 브라우저에서 다시 촬영해 주세요.');
  const time = new Uint8Array(8); new DataView(time.buffer).setFloat64(0, seconds * 1e9 / scale, false);
  const newDuration = new Uint8Array([0x44, 0x89, 0x88, ...time]);
  // Info CRC-32 would become stale after editing metadata; it is optional and omitted.
  const infoParts = children.filter(child => child.id !== 0x4489 && child.id !== 0xbf).map(child => bytes.subarray(child.start, child.end));
  const infoBodySize = infoParts.reduce((sum, part) => sum + part.length, 0) + newDuration.length;
  const newInfo = new Blob([bytes.subarray(info.start, info.sizeOffset), sizeBytes(infoBodySize), ...infoParts, newDuration]);
  const newSegmentBody = new Blob([bytes.subarray(segment.body, info.start), newInfo, bytes.subarray(info.end, segment.end)]);
  // Rewrite the Segment's own size, so finite and streaming Segment headers both remain valid.
  const output = new Blob([bytes.subarray(0, segment.sizeOffset), sizeBytes(newSegmentBody.size), newSegmentBody], { type: blob.type });
  if (output.size > MAX_RECORDING_BYTES) fail('녹화 영상이 50MiB를 초과했습니다. 더 짧게 촬영해 주세요.');
  return output;
}

/** The returned bytes must reload with finite metadata; elapsed time alone is never accepted. */
export async function finalizeRecordedVideo(blob, elapsed, { signal, document: documentRef = globalThis.document, URL: urlAPI = globalThis.URL, setTimeout: delay = globalThis.setTimeout, clearTimeout: clear = globalThis.clearTimeout } = {}) {
  checkSignal(signal);
  const mime = blob.type.split(';')[0].trim().toLowerCase();
  if (!['video/mp4', 'video/webm'].includes(mime)) fail('이 브라우저의 녹화 형식을 지원하지 않습니다. MP4 또는 WebM을 지원하는 브라우저에서 다시 촬영해 주세요.');
  if (!blob.size || blob.size > MAX_RECORDING_BYTES) fail('녹화 영상이 비어 있거나 50MiB를 초과했습니다. 다시 촬영해 주세요.');
  if (mime === 'video/webm') blob = await finalizeWebMDuration(blob, elapsed, signal);
  checkSignal(signal);
  if (!documentRef?.createElement || !urlAPI?.createObjectURL) fail('녹화 영상의 재생 가능 여부를 확인할 수 없습니다.');
  const player = documentRef.createElement('video');
  const url = urlAPI.createObjectURL(blob);
  const metadata = await new Promise((resolve, reject) => {
    let timer, finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clear(timer); player.onloadeddata = player.onloadedmetadata = player.onerror = null;
      signal?.removeEventListener('abort', abort);
      const result = { duration: player.duration, width: player.videoWidth, height: player.videoHeight };
      player.removeAttribute('src'); player.load(); urlAPI.revokeObjectURL(url);
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(abortError());
    const ready = () => {
      if (player.readyState < 2) return;
      if (!Number.isFinite(player.duration) || player.duration <= 0 || player.duration > MAX_RECORDING_SECONDS || !player.videoWidth || !player.videoHeight) return finish(new Error('녹화 영상의 재생 시간을 확인할 수 없습니다. 60초 이내로 다시 촬영해 주세요.'));
      finish();
    };
    player.onloadedmetadata = ready; player.onloadeddata = ready;
    player.onerror = () => finish(new Error('녹화 영상을 다시 재생할 수 없습니다. 다른 브라우저에서 다시 촬영해 주세요.'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = delay(() => finish(new Error('녹화 영상의 재생 확인 시간이 초과되었습니다. 다시 촬영해 주세요.')), 10000);
    player.muted = true; player.playsInline = true; player.preload = 'auto'; player.src = url; player.load();
    if (signal?.aborted) abort();
  });
  checkSignal(signal);
  const filename = `한국수어-촬영-${new Date().toISOString().replace(/[:.]/g, '-')}.${mime === 'video/mp4' ? 'mp4' : 'webm'}`;
  return { file: new File([blob], filename, { type: mime }), ...metadata, mirrored: false };
}

export function createVideoRecorder({ video, onState = () => {}, deps = {} } = {}) {
  const media = deps.mediaDevices ?? globalThis.navigator?.mediaDevices;
  const Recorder = deps.MediaRecorder ?? globalThis.MediaRecorder;
  const documentRef = deps.document ?? globalThis.document;
  const windowRef = deps.window ?? globalThis.window;
  const now = deps.now ?? (() => performance.now());
  const delay = deps.setTimeout ?? globalThis.setTimeout, clear = deps.clearTimeout ?? globalThis.clearTimeout;
  const interval = deps.setInterval ?? globalThis.setInterval, clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval;
  const finalize = deps.finalize ?? finalizeRecordedVideo;
  const maxSeconds = Math.min(MAX_RECORDING_SECONDS, deps.maxSeconds ?? MAX_RECORDING_SECONDS);
  const maxBytes = Math.min(MAX_RECORDING_BYTES, deps.maxBytes ?? MAX_RECORDING_BYTES);
  if (!video || !Number.isFinite(maxSeconds) || maxSeconds <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) fail('촬영 환경 설정이 올바르지 않습니다.');
  let state = { phase: 'idle', elapsed: 0, bytes: 0, devices: [], deviceId: '', error: '', result: null };
  let generation = 0, stream, recorder, opening, completion, finalController, startedAt = 0, clock, deadline, stopTimer, chunks = [], removers = [], destroyed = false;
  const snapshot = () => ({ ...state, devices: state.devices.map(device => ({ ...device })) });
  const emit = patch => { state = { ...state, ...patch }; onState(snapshot()); };
  function clearTimers() { clearIntervalFn(clock); clear(deadline); clear(stopTimer); clock = deadline = stopTimer = undefined; }
  function releaseCamera() {
    for (const remove of removers) remove(); removers = [];
    stopTracks(stream); stream = null;
    try { video.pause(); } catch { /* A pending player still needs its source detached. */ }
    video.srcObject = null;
  }
  function discard(error) {
    generation++;
    clearTimers(); finalController?.abort(); finalController = null;
    const active = recorder; recorder = null;
    if (active) {
      active.ondataavailable = active.onstop = active.onerror = null;
      try { if (active.state !== 'inactive') active.stop(); } catch { /* Cancellation still releases every track. */ }
    }
    releaseCamera(); chunks = [];
    opening?.reject(error); opening = null;
    completion?.reject(error); completion = null;
  }
  function cancel(message = '') { discard(abortError()); emit({ phase: 'idle', elapsed: 0, bytes: 0, error: message, result: null }); }
  function rejectRecording(error) { discard(error); emit({ phase: 'error', error: error.message, result: null }); }
  async function listDevices() {
    if (!media?.enumerateDevices) return [];
    const token = generation;
    try {
      const all = await media.enumerateDevices();
      const devices = all.filter(device => device.kind === 'videoinput').map((device, index) => ({ deviceId: device.deviceId, label: device.label || `카메라 ${index + 1}` }));
      if (token === generation && !destroyed) emit({ devices });
      return devices;
    } catch { return state.devices.slice(); }
  }
  function open(deviceId = '') {
    if (destroyed) return Promise.reject(new Error('촬영 창이 닫혔습니다. 다시 열어 주세요.'));
    if (['recording', 'stopping'].includes(state.phase)) return Promise.reject(new Error('촬영을 종료하거나 취소한 뒤 카메라를 변경해 주세요.'));
    if (opening && state.deviceId === deviceId) return opening.promise;
    if (state.phase === 'preview' && state.deviceId === deviceId) return Promise.resolve(snapshot());
    discard(abortError());
    const token = generation;
    emit({ phase: 'requesting', deviceId, elapsed: 0, bytes: 0, error: '', result: null });
    const supported = Recorder?.isTypeSupported && MIME_CANDIDATES.some(type => { try { return Recorder.isTypeSupported(type); } catch { return false; } });
    if (!media?.getUserMedia || !supported) {
      const error = new Error('이 브라우저에서는 직접 촬영을 지원하지 않습니다. 기기의 카메라 앱으로 촬영한 MP4 또는 WebM 파일을 선택해 주세요.');
      emit({ phase: 'error', error: error.message }); return Promise.reject(error);
    }
    let resolve, reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    promise.catch(() => {}); opening = { promise, resolve, reject };
    const constraints = { audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) } };
    Promise.resolve().then(() => {
      if (token !== generation || destroyed) throw abortError();
      return media.getUserMedia(constraints);
    }).then(async acquired => {
      if (token !== generation || destroyed) { stopTracks(acquired); return; }
      stream = acquired;
      if (!(stream.getVideoTracks?.() || []).length || (stream.getAudioTracks?.() || []).length) fail('소리 없이 녹화할 카메라 영상을 얻지 못했습니다.');
      for (const track of stream.getVideoTracks()) {
        const ended = () => rejectRecording(new Error('카메라 연결이 끊겨 촬영을 취소했습니다. 연결을 확인하고 다시 촬영해 주세요.'));
        track.addEventListener('ended', ended); removers.push(() => track.removeEventListener('ended', ended));
      }
      video.muted = true; video.playsInline = true; video.srcObject = stream;
      await video.play();
      if (token !== generation || destroyed) return;
      const actualId = stream.getVideoTracks()[0].getSettings?.().deviceId || deviceId;
      const pending = opening; opening = null;
      emit({ phase: 'preview', deviceId: actualId }); pending?.resolve(snapshot());
      void listDevices();
    }).catch(error => {
      if (token !== generation || destroyed) return;
      const translated = cameraError(error); discard(translated); emit({ phase: 'error', error: translated.message, result: null });
    });
    return promise;
  }
  function start() {
    if (state.phase === 'recording') return;
    if (state.phase !== 'preview' || !stream) fail('먼저 카메라를 열어 화면을 확인해 주세요.');
    let selected;
    for (const mimeType of MIME_CANDIDATES) {
      try {
        if (Recorder.isTypeSupported(mimeType)) { selected = new Recorder(stream, { mimeType, videoBitsPerSecond: 2500000 }); break; }
      } catch { /* A reported codec can still be unavailable; try another supported container. */ }
    }
    if (!selected) { const error = new Error('이 브라우저에서 MP4·WebM 녹화를 시작할 수 없습니다. 카메라 앱으로 촬영한 파일을 선택해 주세요.'); rejectRecording(error); throw error; }
    recorder = selected; chunks = [];
    const token = generation;
    let resolve, reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    promise.catch(() => {}); completion = { promise, resolve, reject };
    const current = () => token === generation && recorder === selected;
    selected.ondataavailable = event => {
      if (!current() || !(event.data instanceof Blob) || !event.data.size) return;
      if (state.bytes + event.data.size > maxBytes) return rejectRecording(new Error('녹화 영상이 50MiB를 초과하여 완료하지 못했습니다. 더 짧게 촬영해 주세요.'));
      chunks.push(event.data); emit({ bytes: state.bytes + event.data.size });
      if (state.phase === 'recording' && state.bytes >= maxBytes * 0.97) void stop().catch(() => {});
    };
    selected.onerror = () => { if (current()) rejectRecording(new Error('녹화 중 오류가 발생했습니다. 영상을 완성하지 못했으므로 다시 촬영해 주세요.')); };
    selected.onstop = async () => {
      if (!current()) return;
      if (state.phase === 'recording') { rejectRecording(new Error('카메라 녹화가 예기치 않게 중단되었습니다. 다시 촬영해 주세요.')); return; }
      clearTimers(); releaseCamera();
      finalController = new AbortController();
      try {
        if (state.elapsed < 0.1) fail('영상이 너무 짧습니다. 잠시 촬영한 뒤 종료해 주세요.');
        if (state.elapsed > maxSeconds) fail('녹화 시간이 60초를 초과했습니다. 더 짧게 다시 촬영해 주세요.');
        const blob = new Blob(chunks, { type: selected.mimeType || chunks[0]?.type }); chunks = [];
        const result = await finalize(blob, state.elapsed, { signal: finalController.signal });
        if (!current()) return;
        if (!(result?.file instanceof Blob) || !result.file.size || result.file.size > maxBytes || !Number.isFinite(result.duration) || result.duration <= 0 || result.duration > maxSeconds) fail('녹화 영상의 길이 또는 용량을 확인할 수 없습니다.');
        recorder = null; selected.ondataavailable = selected.onstop = selected.onerror = null; finalController = null;
        const pending = completion; completion = null;
        emit({ phase: 'ready', result, elapsed: result.duration, bytes: result.file.size, error: '' }); pending?.resolve(result);
      } catch (error) { if (current()) rejectRecording(error?.name === 'AbortError' ? error : new Error(error?.message || '녹화 영상을 완성하지 못했습니다. 다시 촬영해 주세요.')); }
    };
    startedAt = now(); emit({ phase: 'recording', elapsed: 0, bytes: 0, error: '', result: null });
    try { selected.start(250); }
    catch { const error = new Error('녹화를 시작하지 못했습니다. 카메라를 다시 열어 주세요.'); rejectRecording(error); throw error; }
    clock = interval(() => { if (current() && state.phase === 'recording') emit({ elapsed: Math.max(0, (now() - startedAt) / 1000) }); }, 100);
    // Leave one frame/timer margin below the existing strict 60-second import ceiling.
    deadline = delay(() => { if (current()) void stop().catch(() => {}); }, Math.max(1, maxSeconds * 1000 - 100));
  }
  function stop() {
    if (state.phase === 'stopping') return completion?.promise || Promise.resolve(null);
    if (state.phase === 'ready') return Promise.resolve(state.result);
    if (state.phase !== 'recording' || !recorder) return Promise.resolve(null);
    const pending = completion.promise;
    clearTimers(); emit({ phase: 'stopping', elapsed: Math.max(0, (now() - startedAt) / 1000) });
    stopTimer = delay(() => rejectRecording(new Error('녹화 종료 응답이 없어 촬영을 취소했습니다. 다시 촬영해 주세요.')), 5000);
    try { recorder.stop(); } catch { rejectRecording(new Error('녹화를 종료하지 못했습니다. 다시 촬영해 주세요.')); }
    return pending;
  }
  const hidden = () => { if (documentRef?.hidden && ['requesting', 'preview', 'recording', 'stopping'].includes(state.phase)) cancel('화면을 벗어나 촬영을 취소했습니다. 다시 카메라를 열어 주세요.'); };
  const pagehide = () => { if (state.phase !== 'idle') cancel('페이지를 벗어나 촬영을 취소했습니다.'); };
  const devicechange = () => { if (['preview', 'recording'].includes(state.phase)) void listDevices(); };
  documentRef?.addEventListener?.('visibilitychange', hidden);
  windowRef?.addEventListener?.('pagehide', pagehide);
  media?.addEventListener?.('devicechange', devicechange);
  return {
    open, start, stop, cancel, listDevices, close: () => cancel(),
    destroy() { destroyed = true; cancel(); documentRef?.removeEventListener?.('visibilitychange', hidden); windowRef?.removeEventListener?.('pagehide', pagehide); media?.removeEventListener?.('devicechange', devicechange); },
    get state() { return snapshot(); },
  };
}
