import { extractHandFeatures, loadHands, matchRecentSequences, prepareSignTemplates } from './engine.js';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_SECONDS = 60;
const SAMPLE_RATE = 8;
const MODEL_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1646424915/';

function abortError() {
  const error = new Error('영상 분석을 취소했어요.');
  error.name = 'AbortError';
  return error;
}

function checkCanceled(job) { if (job.controller.signal.aborted) throw abortError(); }

function waitForJob(promise, job, milliseconds, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      job.controller.signal.removeEventListener('abort', canceled);
      if (error) reject(error); else resolve(result);
    };
    const canceled = () => finish(abortError());
    job.controller.signal.addEventListener('abort', canceled, { once: true });
    timeout = setTimeout(() => finish(new Error(message)), milliseconds);
    Promise.resolve(promise).then((result) => finish(null, result), (error) => finish(error));
    if (job.controller.signal.aborted) canceled();
  });
}

function waitForVideo(video, predicate, events, job, message) {
  return new Promise((resolve, reject) => {
    let timeout;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      events.forEach((event) => video.removeEventListener(event, ready));
      video.removeEventListener('error', failed);
      job.controller.signal.removeEventListener('abort', canceled);
      if (error) reject(error); else resolve();
    };
    const ready = () => { if (predicate()) finish(); };
    const failed = () => finish(new Error('이 영상 형식이나 코덱을 브라우저에서 읽을 수 없어요. MP4(H.264) 또는 WebM 영상으로 다시 시도해 주세요.'));
    const canceled = () => finish(abortError());
    events.forEach((event) => video.addEventListener(event, ready));
    video.addEventListener('error', failed, { once: true });
    job.controller.signal.addEventListener('abort', canceled, { once: true });
    timeout = setTimeout(() => finish(new Error(message)), 15000);
    if (job.controller.signal.aborted) canceled();
    else if (video.error) failed();
    else ready();
  });
}

async function seekTo(video, timestamp, job) {
  checkCanceled(job);
  const target = Math.max(0, Math.min(timestamp, video.duration - 0.02));
  if (Math.abs(video.currentTime - target) > 0.01) video.currentTime = target;
  await waitForVideo(video, () => !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.06,
    ['seeked', 'loadeddata', 'canplay'], job, '영상의 일부 구간을 읽지 못했어요. 다른 형식으로 변환한 뒤 다시 분석해 주세요.');
}

function actionableError(error) {
  if (error?.name === 'AbortError') return abortError();
  return /[가-힣]/.test(error?.message || '') ? error : new Error('영상을 분석하지 못했어요. 인터넷 연결을 확인하고 MP4(H.264) 또는 WebM 영상으로 다시 시도해 주세요.');
}

/** Offline video matching against the user's own registered sign examples. */
export class VideoSignAnalyzer {
  constructor({ onProgress, onRecognition, onError } = {}) {
    this.callbacks = { onProgress, onRecognition, onError };
    this._active = null;
  }

  _emit(name, payload) {
    try {
      const pending = this.callbacks[name]?.(payload);
      pending?.catch?.((error) => console.error(`VideoSignAnalyzer ${name}:`, error));
    } catch (error) { console.error(`VideoSignAnalyzer ${name}:`, error); }
  }

  cancel() {
    const job = this._active;
    if (!job) return Promise.resolve();
    job.controller.abort();
    job.video?.pause();
    return job.finished;
  }

  async analyze({ file, video, signs, threshold = 0.78, signal } = {}) {
    while (this._active) await this.cancel();
    const job = { controller: new AbortController(), video: null, tracker: null, url: null, previous: null, framesAnalyzed: 0, resolveResults: null };
    job.finished = new Promise((resolve) => { job.finish = resolve; });
    this._active = job;
    const externalCancel = () => job.controller.abort();
    signal?.addEventListener('abort', externalCancel, { once: true });
    if (signal?.aborted) externalCancel();
    try {
      checkCanceled(job);
      if (!file || typeof file.size !== 'number' || file.size <= 0) throw new Error('분석할 영상 파일을 선택해 주세요.');
      if (file.size > MAX_BYTES) throw new Error('영상은 50MB 이하만 분석할 수 있어요. 용량을 줄인 뒤 다시 선택해 주세요.');
      if (file.type && !file.type.startsWith('video/') && file.type !== 'application/octet-stream') throw new Error('동영상 파일을 선택해 주세요. MP4 또는 WebM 형식을 권장해요.');
      const templates = prepareSignTemplates(signs);
      if (!templates.length) throw new Error('먼저 내 사전에 수어 동작을 등록해 주세요. 등록한 단어와 비슷한 손 동작만 영상에서 찾을 수 있어요.');
      const numericThreshold = Number(threshold);
      const matchThreshold = Number.isFinite(numericThreshold) ? Math.max(0.5, Math.min(0.98, numericThreshold > 1 ? numericThreshold / 100 : numericThreshold)) : 0.78;
      const element = video || document.createElement('video');
      if (typeof element.load !== 'function' || typeof element.pause !== 'function') throw new Error('영상 미리보기를 준비하지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
      job.video = element;
      job.previous = { src: element.getAttribute('src'), muted: element.muted, playsInline: element.playsInline, preload: element.preload };
      element.pause();
      element.muted = true;
      element.playsInline = true;
      element.preload = 'auto';
      job.url = URL.createObjectURL(file);
      element.src = job.url;
      element.load();
      this._emit('onProgress', { phase: 'loading', progress: 0, framesAnalyzed: 0, totalFrames: 0, timestamp: 0, duration: 0, message: '영상과 손 인식 모델을 준비하고 있어요…' });
      await waitForVideo(element, () => element.readyState >= 1, ['loadedmetadata'], job, '영상 정보를 읽지 못했어요. MP4(H.264) 또는 WebM 영상으로 다시 시도해 주세요.');
      checkCanceled(job);
      const duration = element.duration;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('영상 길이를 확인하지 못했어요. 저장된 동영상 파일을 다시 선택해 주세요.');
      if (duration > MAX_SECONDS) throw new Error('영상은 60초 이하만 분석할 수 있어요. 필요한 구간을 잘라서 다시 선택해 주세요.');
      if (!element.videoWidth || !element.videoHeight) throw new Error('이 파일에 읽을 수 있는 영상 화면이 없어요. 동영상 파일을 다시 선택해 주세요.');
      const Hands = await waitForJob(loadHands(), job, 22000, '손 인식 모듈을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 다시 분석해 주세요.');
      checkCanceled(job);
      const tracker = new Hands({ locateFile: (filename) => `${MODEL_BASE}${filename}` });
      job.tracker = tracker;
      tracker.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.65, minTrackingConfidence: 0.65, selfieMode: false });
      tracker.onResults((results) => {
        if (!job.controller.signal.aborted && this._active === job) job.resolveResults?.(results);
      });
      if (tracker.initialize) await waitForJob(tracker.initialize(), job, 35000, '손 인식 모델을 불러오는 데 시간이 오래 걸려요. 인터넷 연결을 확인하고 다시 분석해 주세요.');
      checkCanceled(job);

      const words = [];
      const totalFrames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));
      const aspectRatio = element.videoWidth / element.videoHeight;
      let recent = [];
      let candidate = null;
      let lastWord = null;
      let lastWordTime = -Infinity;
      let released = true;
      let noHandsSince = null;
      let unknownSince = null;
      let lastMatchTime = -Infinity;

      for (let index = 0; index < totalFrames; index += 1) {
        checkCanceled(job);
        const timestamp = Math.max(0, Math.min(index / SAMPLE_RATE, duration - 0.02));
        await seekTo(element, timestamp, job);
        const resultsPromise = new Promise((resolve) => { job.resolveResults = resolve; });
        const [, results] = await waitForJob(Promise.all([tracker.send({ image: element }), resultsPromise]), job, 15000, '손 인식이 응답하지 않아요. 페이지를 새로고침한 뒤 다시 분석해 주세요.');
        job.resolveResults = null;
        checkCanceled(job);
        job.framesAnalyzed += 1;
        const features = extractHandFeatures(results.multiHandLandmarks || [], results.multiHandedness || [], { aspectRatio });
        const milliseconds = timestamp * 1000;
        if (!features) {
          recent = [];
          candidate = null;
          noHandsSince ??= milliseconds;
          if (milliseconds - noHandsSince >= 300) released = true;
        } else {
          if (noHandsSince !== null && milliseconds - noHandsSince >= 300) released = true;
          noHandsSince = null;
          recent.push({ frame: features, timestamp: milliseconds });
          recent = recent.filter((entry) => milliseconds - entry.timestamp < 10000).slice(-100);
          if (recent.length >= 12 && milliseconds - lastMatchTime >= 350) {
            lastMatchTime = milliseconds;
            const { match, stats } = matchRecentSequences(recent, templates, { timestamp: milliseconds, threshold: matchThreshold });
            if (!match) {
              candidate = null;
              if (stats.validWindows) {
                unknownSince ??= milliseconds;
                if (milliseconds - unknownSince >= 650) released = true;
              } else unknownSince = null;
            } else {
              unknownSince = null;
              candidate = candidate?.word === match.word ? { word: match.word, hits: candidate.hits + 1 } : { word: match.word, hits: 1 };
              const repeated = lastWord === match.word;
              if (candidate.hits >= 2 && milliseconds - lastWordTime >= (repeated ? 1700 : 1000) && (!repeated || released)) {
                const event = { word: match.word, confidence: match.confidence, start: Math.max(0, timestamp - match.windowDuration), end: timestamp };
                words.push(event);
                lastWord = match.word;
                lastWordTime = milliseconds;
                released = false;
                recent = [];
                candidate = null;
                this._emit('onRecognition', event);
              }
            }
          }
        }
        checkCanceled(job);
        this._emit('onProgress', { phase: 'analyzing', progress: (index + 1) / totalFrames, framesAnalyzed: job.framesAnalyzed, totalFrames, timestamp, duration, message: `${timestamp.toFixed(1)}초 / ${duration.toFixed(1)}초 분석 중` });
      }
      checkCanceled(job);
      return { words, framesAnalyzed: job.framesAnalyzed, duration };
    } catch (error) {
      const actionable = actionableError(error);
      if (actionable.name !== 'AbortError') this._emit('onError', actionable);
      throw actionable;
    } finally {
      signal?.removeEventListener('abort', externalCancel);
      job.resolveResults = null;
      if (job.video && job.previous && job.video.getAttribute('src') === job.url) {
        job.video.pause();
        if (job.previous.src) job.video.src = job.previous.src;
        else job.video.removeAttribute('src');
        job.video.muted = job.previous.muted;
        job.video.playsInline = job.previous.playsInline;
        job.video.preload = job.previous.preload;
        job.video.load();
      }
      if (job.url) URL.revokeObjectURL(job.url);
      if (job.tracker?.close) {
        let timeout;
        try {
          await Promise.race([Promise.resolve(job.tracker.close()), new Promise((resolve) => { timeout = setTimeout(resolve, 3000); })]);
        } catch { /* Video references and all result callbacks have already been released. */ }
        finally { clearTimeout(timeout); }
      }
      if (this._active === job) this._active = null;
      job.finish();
    }
  }
}
