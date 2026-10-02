/** Browser-only hand tracking and local, example-based sign matching. */
const HANDS_VERSION = '0.4.1646424915';
const HANDS_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${HANDS_VERSION}/`;
const FEATURE_LENGTH = 136;
const HAND_STRIDE = 67;
const MIN_FRAMES = 12;
const SAMPLE_INTERVAL = 65;
const MAX_EXACT_TEMPLATES = 24;
const MAX_CANDIDATE_WORDS = 12;
let handsScriptPromise;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const now = () => globalThis.performance?.now() ?? Date.now();
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
const validFrame = (frame) => Array.isArray(frame) && frame.length === FEATURE_LENGTH && frame.every(Number.isFinite);
const validLandmarks = (points) => Array.isArray(points) && points.length === 21 && points.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.z === undefined || Number.isFinite(p.z)));

/** The fixed two-hand layout keeps MediaPipe result-order changes harmless. */
export function extractHandFeatures(landmarks, handedness = [], { aspectRatio = 1 } = {}) {
  if (!Array.isArray(landmarks) || !landmarks.length) return null;
  const usable = landmarks.slice(0, 2).map((points, index) => ({ points, index }))
    .filter(({ points }) => validLandmarks(points));
  if (!usable.length) return null;
  const slots = [null, null];
  const unresolved = [];
  usable.forEach((hand) => {
    const entry = handedness[hand.index];
    const label = entry?.label || entry?.classification?.[0]?.label;
    const slot = label === 'Left' ? 0 : label === 'Right' ? 1 : -1;
    if (slot >= 0 && !slots[slot]) slots[slot] = hand;
    else unresolved.push(hand);
  });
  unresolved.sort((a, b) => a.points[0].x - b.points[0].x);
  unresolved.forEach((hand) => { slots[slots[0] ? 1 : 0] = hand; });
  const frame = Array(FEATURE_LENGTH).fill(0);
  const scales = [];
  slots.forEach((hand, slot) => {
    if (!hand) return;
    const points = hand.points.map((p) => ({ x: p.x * aspectRatio, y: p.y, z: (p.z || 0) * aspectRatio }));
    const wrist = points[0];
    const scale = Math.max((distance(wrist, points[9]) + distance(points[5], points[17])) / 2, 0.015);
    scales[slot] = scale;
    const offset = slot * HAND_STRIDE;
    frame[offset] = 1;
    points.forEach((point, index) => {
      frame[offset + 1 + index * 3] = clamp((point.x - wrist.x) / scale, -6, 6);
      frame[offset + 2 + index * 3] = clamp((point.y - wrist.y) / scale, -6, 6);
      frame[offset + 3 + index * 3] = clamp((point.z - wrist.z) / scale, -6, 6);
    });
    frame[offset + 64] = wrist.x;
    frame[offset + 65] = wrist.y;
    frame[offset + 66] = scale;
  });
  if (slots[0] && slots[1]) {
    const scale = (scales[0] + scales[1]) / 2;
    frame[134] = (slots[1].points[0].x - slots[0].points[0].x) * aspectRatio / scale;
    frame[135] = (slots[1].points[0].y - slots[0].points[0].y) / scale;
  }
  return frame;
}

/** Preserve the beginning/end while bounding the work done by dynamic time warping. */
export function downsampleSequence(sequence, limit = 32) {
  if (!Array.isArray(sequence)) return [];
  limit = Math.max(2, Math.floor(Number(limit) || 32));
  const valid = sequence.filter(validFrame);
  if (valid.length <= limit) return valid.map((frame) => frame.slice());
  return Array.from({ length: limit }, (_, i) => valid[Math.round(i * (valid.length - 1) / (limit - 1))].slice());
}

function normalizeTrajectory(sequence) {
  const frames = downsampleSequence(sequence);
  if (!frames.length) return frames;
  for (let slot = 0; slot < 2; slot += 1) {
    const offset = slot * HAND_STRIDE;
    const present = frames.filter((frame) => frame[offset] === 1);
    if (!present.length) continue;
    const originX = present[0][offset + 64];
    const originY = present[0][offset + 65];
    const scale = present.reduce((sum, frame) => sum + frame[offset + 66], 0) / present.length;
    frames.forEach((frame) => {
      if (frame[offset] !== 1) return;
      frame[offset + 64] = (frame[offset + 64] - originX) / Math.max(scale, 0.015);
      frame[offset + 65] = (frame[offset + 65] - originY) / Math.max(scale, 0.015);
      frame[offset + 66] = 0;
    });
  }
  return frames;
}

export function frameDistance(a, b) {
  if (!validFrame(a) || !validFrame(b)) return Infinity;
  return preparedFrameDistance(a, b);
}

// Only prepared, validated vectors reach this hot path. Avoid scanning 136 values
// twice for every cell in the DTW grid.
function preparedFrameDistance(a, b) {
  let cost = 0;
  let count = 0;
  for (let slot = 0; slot < 2; slot += 1) {
    const offset = slot * HAND_STRIDE;
    if (a[offset] !== b[offset]) { cost += 1.5; count += 1; continue; }
    if (a[offset] !== 1) continue;
    let shape = 0;
    for (let point = 1; point < 21; point += 1) {
      const start = offset + 1 + point * 3;
      shape += (a[start] - b[start]) ** 2 + (a[start + 1] - b[start + 1]) ** 2 + 0.35 * (a[start + 2] - b[start + 2]) ** 2;
    }
    const motion = Math.hypot(a[offset + 64] - b[offset + 64], a[offset + 65] - b[offset + 65]);
    cost += Math.sqrt(shape / 47) + 0.16 * Math.min(motion, 5);
    count += 1;
  }
  if (!count) return Infinity;
  if (a[0] && a[67] && b[0] && b[67]) cost += 0.12 * Math.min(Math.hypot(a[134] - b[134], a[135] - b[135]), 6);
  return cost / count;
}

/** Bounded DTW distance: timing may change, but the gesture's order must agree. */
export function sequenceDistance(first, second, { bandRatio = 0.3 } = {}) {
  const a = normalizeTrajectory(first);
  const b = normalizeTrajectory(second);
  return preparedSequenceDistance(a, b, bandRatio);
}

function preparedSequenceDistance(a, b, bandRatio = 0.3) {
  if (!a.length || !b.length) return Infinity;
  const width = Math.max(Math.abs(a.length - b.length), Math.ceil(Math.max(a.length, b.length) * bandRatio));
  let previous = new Float64Array(b.length + 1).fill(Infinity);
  let previousLength = new Uint16Array(b.length + 1);
  previous[0] = 0;
  for (let i = 1; i <= a.length; i += 1) {
    const row = new Float64Array(b.length + 1).fill(Infinity);
    const lengths = new Uint16Array(b.length + 1);
    for (let j = Math.max(1, i - width); j <= Math.min(b.length, i + width); j += 1) {
      let bestCost = previous[j - 1];
      let bestLength = previousLength[j - 1];
      const up = previous[j] + 0.025;
      const left = row[j - 1] + 0.025;
      if (up < bestCost) { bestCost = up; bestLength = previousLength[j]; }
      if (left < bestCost) { bestCost = left; bestLength = lengths[j - 1]; }
      row[j] = preparedFrameDistance(a[i - 1], b[j - 1]) + bestCost;
      lengths[j] = bestLength + 1;
    }
    previous = row;
    previousLength = lengths;
  }
  return previous[b.length] / Math.max(previousLength[b.length], 1);
}

// A compact summary is used only to shortlist large libraries. Exact DTW still
// verifies the complete pose and temporal order of every shortlisted template.
function sequenceSummary(sequence) {
  const summary = [];
  const posePoints = [4, 5, 8, 9, 12, 13, 16, 20];
  const tips = [4, 8, 12, 16, 20];
  for (let slot = 0; slot < 2; slot += 1) {
    const offset = slot * HAND_STRIDE;
    const present = sequence.filter((frame) => frame[offset] === 1);
    summary.push(present.length / Math.max(sequence.length, 1) * 3);
    const ending = present.slice(-3);
    const mean = (frames, index) => frames.reduce((sum, frame) => sum + frame[index], 0) / Math.max(frames.length, 1);
    for (const point of posePoints) {
      summary.push(mean(present, offset + 1 + point * 3), mean(present, offset + 2 + point * 3));
    }
    for (const point of tips) {
      summary.push(mean(ending, offset + 1 + point * 3) * 0.45, mean(ending, offset + 2 + point * 3) * 0.45);
    }
    for (const point of tips) summary.push(mean(present, offset + 3 + point * 3) * 0.45);
    for (const index of [offset + 64, offset + 65]) {
      summary.push(mean(ending, index) * 0.3);
      let min = Infinity;
      let max = -Infinity;
      for (const frame of present) { min = Math.min(min, frame[index]); max = Math.max(max, frame[index]); }
      summary.push(present.length ? (max - min) * 0.16 : 0);
    }
  }
  for (const index of [134, 135]) summary.push(sequence.reduce((sum, frame) => sum + frame[index], 0) / Math.max(sequence.length, 1) * 0.25);
  return new Float32Array(summary);
}

function summaryDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) { const difference = a[i] - b[i]; sum += difference * difference; }
  return sum / a.length;
}

export function matchSequence(frames, samples, threshold = 0.78) {
  if (!Array.isArray(frames) || frames.length < MIN_FRAMES) return null;
  const byWord = new Map();
  for (const sample of samples || []) {
    if (!sample.word || !Array.isArray(sample.frames) || sample.frames.length < MIN_FRAMES) continue;
    const distanceValue = sequenceDistance(frames, sample.frames);
    const confidence = Math.exp(-distanceValue * 1.75);
    const previous = byWord.get(sample.word);
    if (!previous || confidence > previous.confidence) byWord.set(sample.word, { word: sample.word, confidence, sampleId: sample.id });
  }
  const ranked = [...byWord.values()].sort((a, b) => b.confidence - a.confidence);
  if (!ranked[0] || ranked[0].confidence < threshold) return null;
  if (ranked[1] && ranked[0].confidence - ranked[1].confidence < 0.035) return null;
  return ranked[0];
}

/** Prepare reusable templates without requesting a camera or loading MediaPipe. */
export function prepareSignTemplates(signs) {
  const entries = Array.isArray(signs) ? signs : Object.entries(signs || {}).map(([word, sign]) => ({ word, ...sign }));
  const samples = entries.flatMap((sign) => (Array.isArray(sign.samples) ? sign.samples : [sign]).map((sample) => ({
    ...sample,
    word: sign.word || sample.word,
    frames: Array.isArray(sample.frames) ? sample.frames.filter(validFrame) : [],
  }))).filter((sample) => typeof sample.word === 'string' && sample.word.trim() && sample.frames.length >= MIN_FRAMES);
  return samples.map((sample) => {
    const sequence = normalizeTrajectory(sample.frames);
    return { sample, sequence, summary: sequenceSummary(sequence), duration: clamp(Number(sample.duration) || sample.frames.length * SAMPLE_INTERVAL / 1000, 0.8, 8) };
  });
}

/** Match timestamped sequences from a live camera or an uploaded video. */
export function matchRecentSequences(recent, preparedSamples, { timestamp, threshold = 0.78 } = {}) {
  const useShortlist = preparedSamples.length > MAX_EXACT_TEMPLATES;
  const windowCache = new Map();
  const windowFor = (duration) => {
    // Limit the number of live summaries even when an imported library has
    // thousands of slightly different recording durations.
    const key = useShortlist ? Math.round(duration / 200) * 200 : duration;
    if (windowCache.has(key)) return windowCache.get(key);
    const entries = recent.filter((entry) => timestamp - entry.timestamp <= key);
    if (entries.length < MIN_FRAMES || timestamp - entries[0].timestamp < key * 0.7) {
      windowCache.set(key, null);
      return null;
    }
    const sequence = normalizeTrajectory(entries.map((entry) => entry.frame));
    const window = { duration: key / 1000, sequence, summary: useShortlist ? sequenceSummary(sequence) : null };
    windowCache.set(key, window);
    return window;
  };
  const candidates = [];
  for (const template of preparedSamples) {
    const windows = [];
    for (const multiplier of [0.7, 1, 1.3]) {
      const window = windowFor(template.duration * multiplier * 1000);
      if (window && !windows.includes(window)) windows.push(window);
    }
    if (!windows.length) continue;
    const coarse = useShortlist ? Math.min(...windows.map((window) => summaryDistance(window.summary, template.summary))) : 0;
    candidates.push({ template, windows, coarse });
  }

  let shortlisted = candidates;
  if (useShortlist) {
    const wordCandidates = new Map();
    for (const candidate of candidates) {
      const group = wordCandidates.get(candidate.template.sample.word) || [];
      group.push(candidate);
      group.sort((a, b) => a.coarse - b.coarse);
      if (group.length > 2) group.pop();
      wordCandidates.set(candidate.template.sample.word, group);
    }
    // Two recordings per word keep varied examples while retaining up to
    // twelve competing words for the ambiguity check.
    shortlisted = [...wordCandidates.values()].sort((a, b) => a[0].coarse - b[0].coarse)
      .slice(0, MAX_CANDIDATE_WORDS).flat().slice(0, MAX_EXACT_TEMPLATES);
  }

  const byWord = new Map();
  let exactComparisons = 0;
  for (const { template, windows } of shortlisted) {
    let confidence = 0;
    let windowDuration = 0;
    for (const window of windows) {
      exactComparisons += 1;
      const candidateConfidence = Math.exp(-preparedSequenceDistance(window.sequence, template.sequence) * 1.75);
      if (candidateConfidence > confidence) { confidence = candidateConfidence; windowDuration = window.duration; }
    }
    const { sample } = template;
    const previous = byWord.get(sample.word);
    if (!previous || confidence > previous.confidence) byWord.set(sample.word, { word: sample.word, confidence, sampleId: sample.id, windowDuration });
  }
  const stats = { samples: preparedSamples.length, templates: shortlisted.length, words: byWord.size, exactComparisons, windows: windowCache.size, validWindows: [...windowCache.values()].filter(Boolean).length };
  const ranked = [...byWord.values()].sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];
  if (!best || best.confidence < threshold || (ranked[1] && best.confidence - ranked[1].confidence < 0.035)) return { match: null, stats };
  return { match: best, stats };
}

function deadline(promise, milliseconds, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timeout));
}

export function loadHands() {
  if (typeof globalThis.Hands === 'function') return Promise.resolve(globalThis.Hands);
  if (handsScriptPromise) return handsScriptPromise;
  handsScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${HANDS_BASE}hands.js`;
    script.async = true;
    script.crossOrigin = 'anonymous';
    const timeout = setTimeout(() => fail(), 20000);
    function fail() {
      clearTimeout(timeout);
      script.remove();
      handsScriptPromise = null;
      reject(new Error('손 인식 모듈을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 카메라를 다시 시작해 주세요.'));
    }
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timeout);
      if (typeof globalThis.Hands !== 'function') { fail(); return; }
      resolve(globalThis.Hands);
    };
    document.head.append(script);
  });
  return handsScriptPromise;
}

function cameraError(error) {
  const messages = {
    NotAllowedError: '카메라 권한이 필요해요. 주소창의 사이트 설정에서 카메라를 허용한 뒤 다시 시작해 주세요.',
    SecurityError: '브라우저가 카메라 접근을 차단했어요. HTTPS 페이지에서 카메라 권한을 허용해 주세요.',
    NotFoundError: '연결된 카메라를 찾지 못했어요. 카메라를 연결한 뒤 다시 시작해 주세요.',
    NotReadableError: '다른 앱에서 카메라를 사용 중이에요. 해당 앱을 종료한 뒤 다시 시작해 주세요.',
    OverconstrainedError: '요청한 카메라를 사용할 수 없어요. 다른 카메라를 선택해 주세요.',
    AbortError: '카메라 연결이 중단됐어요. 잠시 후 다시 시작해 주세요.',
  };
  const original = error?.message || '';
  return new Error(messages[error?.name] || (/[가-힣]/.test(original) ? original : '카메라와 손 인식을 시작하지 못했어요. 인터넷 연결과 카메라 권한을 확인한 뒤 다시 시작해 주세요.'));
}

export class SignEngine {
  constructor({ video, onFrame, onStatus, onRecognition, onRecordingProgress, onRecordingComplete, onError } = {}) {
    this.video = video;
    this.callbacks = { onFrame, onStatus, onRecognition, onRecordingProgress, onRecordingComplete, onError };
    this.stream = null;
    this.hands = null;
    this._ready = false;
    this.threshold = 0.78;
    this.mirrored = true;
    this.recognizing = false;
    this.samples = [];
    this._preparedSamples = [];
    this._recognitionStats = { samples: 0, templates: 0, words: 0, exactComparisons: 0, windows: 0 };
    this._session = 0;
    this._raf = null;
    this._starting = null;
    this._recording = null;
    this._recent = [];
    this._candidate = null;
    this._lastRecognition = null;
    this._lastRecognitionTime = -Infinity;
    this._released = true;
    this._noHandsSince = null;
    this._unknownSince = null;
    this._lastSampleTime = -Infinity;
    this._lastMatchTime = -Infinity;
    this._lastSendTime = -Infinity;
  }

  get cameraRunning() { return Boolean(this.stream && this.stream.getVideoTracks().some((track) => track.readyState === 'live')); }
  get isRecording() { return Boolean(this._recording); }

  _emit(name, payload) {
    try { this.callbacks[name]?.(payload); }
    catch (error) { console.error(`SignEngine ${name}:`, error); }
  }

  _status(state, message) { this._emit('onStatus', { state, message }); }

  async startCamera({ facingMode = 'user' } = {}) {
    if (this.cameraRunning) return this.stream;
    if (this._starting) return this._starting;
    const token = ++this._session;
    const request = this._startCamera(facingMode, token);
    this._starting = request;
    try { return await request; }
    finally { if (this._starting === request) this._starting = null; }
  }

  async _startCamera(facingMode, token) {
    let stream;
    let tracker;
    try {
      if (!this.video) throw new Error('카메라 미리보기 요소를 찾지 못했어요. 페이지를 새로고침해 주세요.');
      if (!globalThis.isSecureContext) throw new Error('카메라는 HTTPS 또는 localhost에서 사용할 수 있어요. HTTPS 주소로 접속해 주세요.');
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저는 카메라를 지원하지 않아요. 최신 Chrome, Edge 또는 Safari를 사용해 주세요.');
      this._status('loading', '손 인식 모듈을 준비하고 있어요…');
      const Hands = await loadHands();
      if (token !== this._session) return null;
      this._status('loading', '카메라 연결을 기다리고 있어요…');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
      if (token !== this._session) { stream.getTracks().forEach((track) => track.stop()); return null; }
      this.stream = stream;
      stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
        if (token === this._session) {
          this.stopCamera();
          this._emit('onError', new Error('카메라 연결이 종료됐어요. 카메라를 다시 시작해 주세요.'));
        }
      }, { once: true }));
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = stream;
      await deadline(this.video.play(), 10000, '카메라 미리보기를 시작하지 못했어요. 카메라를 다시 시작해 주세요.');
      if (token !== this._session) return null;
      tracker = new Hands({ locateFile: (file) => `${HANDS_BASE}${file}` });
      this.hands = tracker;
      tracker.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.65, minTrackingConfidence: 0.65, selfieMode: false });
      tracker.onResults((results) => { if (token === this._session && this.stream) this._onResults(results); });
      this._status('loading', '손 인식 모델을 불러오고 있어요…');
      if (tracker.initialize) await deadline(tracker.initialize(), 35000, '손 인식 모델 로딩이 지연되고 있어요. 인터넷 연결을 확인하고 다시 시작해 주세요.');
      if (token !== this._session) return null;
      if (!this.cameraRunning) throw new Error('카메라 연결이 종료됐어요. 카메라를 다시 시작해 주세요.');
      this._ready = true;
      this._lastSendTime = -Infinity;
      this._resetRecognition();
      this._status('ready', '카메라가 준비됐어요. 두 손이 화면 안에 보이도록 해 주세요.');
      this._scheduleFrame(token);
      return stream;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (token !== this._session) return null;
      await this.stopCamera();
      const actionable = cameraError(error);
      this._status('error', actionable.message);
      this._emit('onError', actionable);
      throw actionable;
    }
  }

  async stopCamera() {
    ++this._session;
    this._starting = null;
    if (this._raf !== null) cancelAnimationFrame(this._raf);
    this._raf = null;
    this._ready = false;
    this.cancelRecording(false);
    this.recognizing = false;
    this._resetRecognition();
    const tracker = this.hands;
    this.hands = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this._emit('onFrame', { landmarks: [], handedness: [], handCount: 0, video: this.video, timestamp: now(), mirrored: this.mirrored });
    this._status('stopped', '카메라가 꺼져 있어요.');
    if (tracker?.close) {
      try { await deadline(Promise.resolve(tracker.close()), 2000, '손 인식 종료'); }
      catch { /* All camera tracks and callbacks are already stopped. */ }
    }
  }

  _scheduleFrame(token) {
    if (token !== this._session || !this.stream || !this.hands) return;
    this._raf = requestAnimationFrame(async (timestamp) => {
      if (token !== this._session || !this.stream || !this.hands) return;
      if (this.video.readyState >= 2 && timestamp - this._lastSendTime >= 45) {
        this._lastSendTime = timestamp;
        try {
          await deadline(this.hands.send({ image: this.video }), 18000, '손 인식이 응답하지 않아요. 카메라를 다시 시작해 주세요.');
        } catch (error) {
          if (token !== this._session) return;
          await this.stopCamera();
          this._emit('onError', cameraError(error));
          this._status('error', cameraError(error).message);
          return;
        }
      }
      this._scheduleFrame(token);
    });
  }

  _onResults(results) {
    const timestamp = now();
    const reportedHands = results.multiHandLandmarks || [];
    const reportedHandedness = results.multiHandedness || [];
    const validIndices = reportedHands.map((points, index) => validLandmarks(points) ? index : -1).filter((index) => index >= 0).slice(0, 2);
    const landmarks = validIndices.map((index) => reportedHands[index]);
    const handedness = validIndices.map((index) => reportedHandedness[index]);
    this._emit('onFrame', { landmarks, handedness, handCount: landmarks.length, video: this.video, timestamp, mirrored: this.mirrored });
    const features = extractHandFeatures(landmarks, handedness, { aspectRatio: this.video.videoWidth / (this.video.videoHeight || this.video.videoWidth || 1) || 1 });
    if (!features) {
      this._recent = [];
      this._candidate = null;
      this._noHandsSince ??= timestamp;
      if (timestamp - this._noHandsSince >= 300) this._released = true;
      return;
    }
    if (this._noHandsSince !== null && timestamp - this._noHandsSince >= 300) this._released = true;
    this._noHandsSince = null;
    if (timestamp - this._lastSampleTime < SAMPLE_INTERVAL) return;
    this._lastSampleTime = timestamp;
    if (this._recording) {
      if (!this._recording.finalizing && !this._recording.canceled) this._recording.frames.push(features);
      return;
    }
    if (!this.recognizing || !this.samples.length) return;
    this._recent.push({ frame: features, timestamp });
    this._recent = this._recent.filter((entry) => timestamp - entry.timestamp < 10000).slice(-150);
    if (timestamp - this._lastMatchTime < 350 || this._recent.length < MIN_FRAMES) return;
    this._lastMatchTime = timestamp;
    this._recognize(timestamp);
  }

  _recognize(timestamp) {
    const { match: best, stats } = matchRecentSequences(this._recent, this._preparedSamples, { timestamp, threshold: this.threshold });
    this._recognitionStats = stats;
    if (!best) {
      this._candidate = null;
      if (!stats.validWindows) { this._unknownSince = null; return; }
      this._unknownSince ??= timestamp;
      if (timestamp - this._unknownSince >= 650) this._released = true;
      return;
    }
    this._unknownSince = null;
    this._candidate = this._candidate?.word === best.word
      ? { word: best.word, hits: this._candidate.hits + 1 }
      : { word: best.word, hits: 1 };
    if (this._candidate.hits < 3) return;
    const repeated = this._lastRecognition === best.word;
    if (timestamp - this._lastRecognitionTime < (repeated ? 1700 : 1000)) return;
    if (repeated && !this._released) return;
    this._lastRecognition = best.word;
    this._lastRecognitionTime = timestamp;
    this._released = false;
    this._emit('onRecognition', { ...best, timestamp: Date.now() });
    this._recent = [];
    this._candidate = null;
  }

  _resetRecognition() {
    this._recent = [];
    this._candidate = null;
    this._lastRecognition = null;
    this._lastRecognitionTime = -Infinity;
    this._lastMatchTime = -Infinity;
    this._lastSampleTime = -Infinity;
    this._released = true;
    this._noHandsSince = null;
    this._unknownSince = null;
  }

  setRecognizing(enabled) {
    this.recognizing = Boolean(enabled);
    this._resetRecognition();
    return this.recognizing;
  }

  setThreshold(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) this.threshold = clamp(numeric > 1 ? numeric / 100 : numeric, 0.5, 0.98);
    return this.threshold;
  }

  setMirrored(enabled) { this.mirrored = Boolean(enabled); }

  setSamples(signs) {
    this._preparedSamples = prepareSignTemplates(signs);
    this.samples = this._preparedSamples.map((template) => template.sample);
    this._resetRecognition();
    return this.samples.length;
  }

  async startRecording({ word, duration = 4 } = {}) {
    const cleanWord = typeof word === 'string' ? word.trim() : '';
    if (!this.cameraRunning || !this._ready) throw new Error('먼저 카메라를 시작하고 손 인식 준비가 끝날 때까지 기다려 주세요.');
    if (!cleanWord) throw new Error('등록할 단어를 입력해 주세요.');
    if (this._recording) throw new Error('이미 녹화 중이에요. 현재 녹화를 끝내거나 취소해 주세요.');
    const seconds = clamp(Number(duration) || 4, 2, 8);
    const recording = { word: cleanWord, duration: seconds, started: now(), frames: [], chunks: [], recorder: null, timer: null, canceled: false, finalizing: false };
    this._recording = recording;
    this._resetRecognition();
    if (typeof MediaRecorder !== 'undefined') {
      try {
        const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported?.(type));
        const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
        recording.recorder = recorder;
        recorder.ondataavailable = (event) => { if (!recording.canceled && event.data?.size) recording.chunks.push(event.data); };
        recorder.onerror = () => { /* Hand features remain usable even if video capture fails. */ };
        recorder.start(250);
      } catch { recording.recorder = null; }
    }
    this._status('recording', `“${cleanWord}” 동작을 ${seconds}초 동안 녹화하고 있어요.`);
    this._emit('onRecordingProgress', { progress: 0, remaining: seconds, elapsed: 0, duration: seconds });
    recording.timer = setInterval(() => {
      if (this._recording !== recording || recording.canceled) return;
      const elapsed = (now() - recording.started) / 1000;
      this._emit('onRecordingProgress', { progress: clamp(elapsed / seconds, 0, 1), remaining: Math.max(0, seconds - elapsed), elapsed: Math.min(seconds, elapsed), duration: seconds });
      if (elapsed >= seconds) this._finishRecording(recording);
    }, 80);
    return { word: cleanWord, duration: seconds };
  }

  async _finishRecording(recording) {
    if (this._recording !== recording || recording.canceled || recording.finalizing) return;
    recording.finalizing = true;
    clearInterval(recording.timer);
    this._status('processing', '녹화한 동작을 정리하고 있어요…');
    const recorder = recording.recorder;
    if (recorder && recorder.state !== 'inactive') {
      try {
        await deadline(new Promise((resolve) => {
          recorder.addEventListener('stop', resolve, { once: true });
          recorder.stop();
        }), 4000, '녹화 종료 대기');
      } catch { /* Any chunks already captured can still be replayed. */ }
    }
    if (recording.canceled || this._recording !== recording || !this.cameraRunning) return;
    this._recording = null;
    this._resetRecognition();
    const trackedSeconds = recording.frames.length * SAMPLE_INTERVAL / 1000;
    if (recording.frames.length < MIN_FRAMES || trackedSeconds < recording.duration * 0.25) {
      const error = new Error('손 동작이 충분히 감지되지 않았어요. 손을 화면 안에 두고 밝은 곳에서 다시 녹화해 주세요.');
      this._emit('onRecordingProgress', { progress: 0, remaining: 0, elapsed: 0, duration: recording.duration });
      this._status('ready', error.message);
      this._emit('onError', error);
      return;
    }
    const videoBlob = recording.chunks.length ? new Blob(recording.chunks, { type: recorder?.mimeType || recording.chunks[0].type || 'video/webm' }) : null;
    const sample = {
      id: globalThis.crypto?.randomUUID?.() || `sample-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: Date.now(),
      frames: recording.frames,
      duration: recording.duration,
      featureVersion: 2,
    };
    this._emit('onRecordingProgress', { progress: 1, remaining: 0, elapsed: recording.duration, duration: recording.duration });
    this._status('ready', `“${recording.word}” 동작을 녹화했어요.`);
    this._emit('onRecordingComplete', { word: recording.word, sample, videoBlob });
  }

  cancelRecording(showStatus = true) {
    const recording = this._recording;
    if (!recording) return;
    recording.canceled = true;
    clearInterval(recording.timer);
    this._recording = null;
    recording.chunks = [];
    if (recording.recorder?.state !== 'inactive') {
      try { recording.recorder?.stop(); } catch { /* Recorder may already have ended. */ }
    }
    this._resetRecognition();
    this._emit('onRecordingProgress', { progress: 0, remaining: 0, elapsed: 0, duration: recording.duration });
    if (showStatus) this._status(this.cameraRunning ? 'ready' : 'stopped', '녹화를 취소했어요.');
  }
}
