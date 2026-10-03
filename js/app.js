import { SignStore, normalizeWord, MAX_IMPORT_BYTES } from './storage.js';
import { SignEngine } from './engine.js';
import { VideoSignAnalyzer } from './video-engine.js';
import { createHybridAI } from './hybrid-ai.js';
import { createRecorderUI } from './recorder-ui.js';
import { createVideoChat } from './video-chat.js';
import { PersonalLibrary } from './personal-library.js';
import { createLibraryUI } from './library-ui.js';
import { createVideoDocument, validateVideoDocument, videoDocumentText } from './video-document.js';

const $ = id => document.getElementById(id);
const SETTINGS_KEY = 'signflow.settings.v1';
const HISTORY_KEY = 'signflow.history.v1';
const VIEW_NAMES = { live: 'Live', library: '내 자료', studio: '보조 · 동작 예시 관리', video: '영상 등록', dictionary: '나의 수어 사전', history: '보조 · 동작 비교 기록', settings: '설정' };
let currentView = null, liveOpened = false, liveReady = false;
const DEMO_WORDS = ['안녕하세요', '감사합니다', '반갑습니다'];
const CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const dateFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const store = new SignStore();
const state = {
  signs: [], history: [], sentence: [], confidence: null, tab: 'recognition',
  demo: false, demoIndex: 0, demoSentence: [], cameraState: 'stopped', cameraBusy: false,
  recordIntent: 0, recordPhase: null, recording: null, countdownTimer: null,
  pendingPermission: false, saving: false, deleting: null, videoURL: null, lastFrame: null,
  lastHandCount: -1, historyWarningShown: false, backupURLs: [],
};
const videoState = {
  mode: 'ai', file: null, url: null, duration: null, width: 0, height: 0,
  loading: false, busy: false, canceling: false, loadToken: 0, runToken: 0,
  loadController: null, controller: null, analyzer: null, jobPromise: null,
  cancelPromise: Promise.resolve(), result: null, text: '', notice: '', reviewRange: null, document: null, dirty: false, nextSegment: 1, selectedSegment: null,
};

const personalLibrary = new PersonalLibrary();
const libraryUI = createLibraryUI(personalLibrary, {
  state: () => videoState, validate: validateVideoDocument, controls: renderVideoControls,
  changed: () => { videoState.dirty = true; syncVideoDocument(); },
  saved: () => { videoState.dirty = false; syncVideoDocument(); },
  cancelOpen: () => { if (videoState.loading) run(() => cancelVideoWork('자료 열기를 취소했어요.')); },
  navigate: () => { goTo('video'); $('main').focus({ preventScroll: true }); },
  open: async (record, signal) => {
    if (signal.aborted || !confirmVideoReplace()) return false;
    const file = new File([record.video], record.fileName, { type: record.video.type });
    await selectVideoFile(file, { fromLibrary: true, confirmed: true });
    if (signal.aborted || videoState.file !== file || !videoState.duration || videoState.loading) return false;
    videoState.document = structuredClone(record.document);
    videoState.nextSegment = Math.max(0, ...record.document.segments.map(row => Number(row.id)).filter(Number.isSafeInteger)) + 1;
    videoState.dirty = false;
    $('videoResultLabel').textContent = '개인 영상 자료 · 검토 문서';
    $('videoResultLimitations').textContent = record.document.limitation;
    $('videoResultLimitations').hidden = !record.document.limitation;
    renderVideoEditor(); syncVideoDocument(); return true;
  },
});

const hybridUI = createHybridAI(personalLibrary, {
  state: () => videoState, current: () => libraryUI.current(), selected: () => libraryUI.selected(), libraryBusy: () => libraryUI.busy(),
  controls: renderVideoControls, confirmReplace: confirmVideoReplace,
  note: message => { videoState.notice = message; renderVideoControls(); },
  begin: controller => { stopVideoReview(); videoState.busy = true; videoState.controller = controller; videoState.notice = ''; return ++videoState.runToken; },
  job: job => {
    videoState.jobPromise = job;
    const cleanup = () => { if (videoState.jobPromise === job) videoState.jobPromise = null; };
    job.then(cleanup, cleanup);
  },
  finish: token => {
    if (videoState.runToken === token) { videoState.busy = false; videoState.controller = null; videoState.jobPromise = null; $('videoProgress').hidden = true; }
  },
  progress: (update, token) => updateVideoProgress(update, token, 'ai'),
  result: result => renderVideoResult(result, 'ai'),
  attachAudit: audit => {
    if (!videoState.document) videoState.document = createVideoDocument({}, 'manual', videoState.duration);
    videoState.document.audit = audit; videoState.dirty = true; syncVideoDocument();
  },
  changed: () => { videoState.dirty = true; syncVideoDocument(); },
  download: audit => download(JSON.stringify({ format: 'ksl-gemini-comparison', version: 1, audit, warning: '사용자 평가 기록이며 KSL 정확도 인증이 아닙니다. 영상·키는 포함하지 않습니다.' }, null, 2), 'Gemini-실행-평가.json', 'application/json;charset=utf-8'),
});

const recorderUI = createRecorderUI({
  state: () => videoState, libraryBusy: () => libraryUI.busy(), controls: renderVideoControls,
  confirmReplace: confirmVideoReplace,
  present: dialog => {
    const inline = currentView === 'live';
    dialog.classList.toggle('is-inline', inline);
    if (inline) {
      liveOpened = true;
      $('liveRecorderSlot').append(dialog);
      // Reveal the parent before show() so the first keyboard focus is visible.
      renderWorkspace(); $('liveCaptureLayout').hidden = false;
      dialog.show(); renderWorkspace();
    } else { document.body.append(dialog); dialog.showModal(); }
  },
  closed: () => {
    if (!liveReady) liveOpened = false;
    renderWorkspace();
    if (currentView === 'live') $(liveOpened && liveReady ? 'liveRecordAgain' : 'liveStartBtn').focus({ preventScroll: true });
  },
  notice: message => { videoState.notice = message; renderVideoControls(); },
  beforeOpen: async () => {
    if (state.recordPhase || state.saving) throw new Error('진행 중인 사전 동작 촬영을 마친 뒤 영상 자료를 녹화해 주세요.');
    hybridUI.invalidate(); chatUI.invalidate();
    if (state.demo) endDemo();
    await stopCamera(); stopVideoReview();
  },
  cancelLoad: () => { if (videoState.loading) run(() => cancelVideoWork('녹화 영상 불러오기를 취소했어요.')); },
  accept: async result => {
    await selectVideoFile(result.file, { confirmed: true });
    if (videoState.file !== result.file || !videoState.duration || videoState.loading) return false;
    videoState.document = createVideoDocument({}, 'manual', videoState.duration);
    videoState.document.segments.push({ id: 1, start: 0, end: videoState.duration, text: '', original: '', source: 'manual', reviewed: false });
    videoState.nextSegment = 2; videoState.dirty = true;
    $('videoResultLabel').textContent = '녹화 영상 · 사용자 직접 작성';
    const now = new Date(), localDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    $('personalCaptureDay').value = localDay;
    $('personalTitle').value = `녹화 영상 ${localDay} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    videoState.notice = '녹화한 내용을 확인해 글을 작성하세요. 아직 저장하거나 외부에 전송하지 않았습니다.';
    if (currentView === 'live') liveReady = true;
    renderVideoEditor(); syncVideoDocument(); return true;
  },
  focusEditor: () => $('videoSegments').querySelector('textarea')?.focus(),
});

const chatUI = createVideoChat({
  state: () => videoState, libraryBusy: () => libraryUI.busy(), controls: renderVideoControls,
  notice: message => { videoState.notice = message; renderVideoControls(); },
  record: () => recorderUI.open(),
  settings: () => {
    setVideoMode('ai');
    const panel = document.querySelector('.analysis-settings');
    panel.open = true; $('geminiKey').focus(); panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },
  save: () => { $('personalTitle').focus(); $('personalSaveHeading').scrollIntoView({ block: 'center', behavior: 'smooth' }); },
  begin: controller => {
    stopVideoReview(); videoState.busy = true; videoState.controller = controller; videoState.notice = '';
    const token = ++videoState.runToken; updateVideoProgress({ message: '확인한 글에 대한 Gemini 한국어 답변을 기다리고 있어요…' }, token, 'ai'); return token;
  },
  job: job => { videoState.jobPromise = job; const cleanup = () => { if (videoState.jobPromise === job) videoState.jobPromise = null; }; job.then(cleanup, cleanup); },
  finish: token => { if (videoState.runToken === token) { videoState.busy = false; videoState.controller = null; videoState.jobPromise = null; $('videoProgress').hidden = true; } },
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`); svg.append(use); return svg;
}
function button(text, className, action, iconName) {
  const node = element('button', className); node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.append(document.createTextNode(text));
  if (action) node.addEventListener('click', () => run(action));
  return node;
}
function setButtonLabel(id, text, iconName) {
  const node = $(id); node.replaceChildren();
  if (iconName) node.append(icon(iconName));
  node.append(element('span', '', text));
}
function errorMessage(error) {
  return typeof error?.message === 'string' && /[가-힣]/.test(error.message) ? error.message : '작업을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.';
}
function toast(message, error = false) {
  const node = element('div', `toast${error ? ' toast-error error' : ''}`, message);
  node.prepend(icon(error ? 'info' : 'check'));
  $('toastRegion').append(node);
  while ($('toastRegion').children.length > 3) $('toastRegion').firstElementChild.remove();
  setTimeout(() => node.remove(), 5000);
}
async function run(operation) {
  try { await operation(); } catch (error) { toast(errorMessage(error), true); }
}
function localRead(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function localWrite(key, data) {
  try { localStorage.setItem(key, JSON.stringify(data)); return true; } catch { return false; }
}
function readSettings() {
  const saved = localRead(SETTINGS_KEY) || {};
  return {
    mirror: typeof saved.mirror === 'boolean' ? saved.mirror : true,
    landmarks: typeof saved.landmarks === 'boolean' ? saved.landmarks : true,
    facingMode: saved.facingMode === 'environment' ? 'environment' : 'user',
    threshold: Number.isInteger(saved.threshold) && saved.threshold >= 60 && saved.threshold <= 95 ? saved.threshold : 78,
  };
}
const settings = readSettings();

const engine = new SignEngine({
  video: $('videoElement'),
  onFrame: drawFrame,
  onStatus: ({ state: cameraState, message }) => {
    state.cameraState = cameraState;
    if (cameraState === 'loading') state.cameraBusy = true;
    if (['ready', 'stopped', 'error'].includes(cameraState)) state.cameraBusy = false;
    if (cameraState === 'stopped' && state.recordPhase && !state.saving) cancelRecordingIntent(false);
    setCameraStatus(message, cameraState === 'error', cameraState === 'loading' || cameraState === 'error');
    renderCamera();
  },
  onRecognition: recognition => {
    if (state.demo || state.recordPhase || !engine.recognizing) return;
    let word;
    try { word = normalizeWord(recognition.word); } catch { return; }
    const confidence = Math.max(0, Math.min(1, Number(recognition.confidence) || 0));
    const timestamp = Number.isFinite(recognition.timestamp) ? recognition.timestamp : Date.now();
    state.sentence.push(word); state.sentence = state.sentence.slice(-50);
    state.confidence = confidence;
    state.history.unshift({ word, confidence, timestamp }); state.history = state.history.slice(0, 200);
    if (!localWrite(HISTORY_KEY, state.history) && !state.historyWarningShown) {
      state.historyWarningShown = true;
      toast('연습 기록을 브라우저에 저장할 수 없어요. 필요한 기록을 내려받아 주세요.', true);
    }
    $('liveWord').textContent = word;
    renderSentence(); renderHistory(); renderStats();
  },
  onRecordingProgress: ({ progress, remaining }) => {
    if (state.recordPhase !== 'recording' || !state.recording) return;
    $('recordingProgress').style.width = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    $('recordingTime').textContent = remaining > 0 ? `${Math.ceil(remaining)}초` : '동작 정리 중';
  },
  onRecordingComplete: payload => run(() => saveRecording(payload)),
  onError: error => {
    if (state.recordPhase && !state.saving) cancelRecordingIntent(false);
    setCameraStatus(errorMessage(error), true, true);
    if (!$('addDialog').open) toast(errorMessage(error), true);
    renderCamera();
  },
});

function setCameraStatus(message, error = false, visible = true) {
  $('cameraStatus').textContent = message || '';
  $('cameraStatus').hidden = !visible || !message;
  $('cameraStatus').classList.toggle('status-error', error);
}
function renderCamera() {
  const running = engine.cameraRunning;
  const busy = state.cameraBusy;
  const recording = Boolean(state.recordPhase);
  $('cameraEmpty').hidden = running || state.demo;
  $('videoElement').hidden = !running || state.demo;
  $('canvasOverlay').hidden = !running || state.demo || !settings.landmarks;
  $('demoOverlay').hidden = !state.demo;
  $('liveOverlay').hidden = !running || state.demo || recording;
  $('recordingOverlay').hidden = state.recordPhase !== 'recording' && !state.saving;
  $('cameraBtn').disabled = busy || state.saving;
  setButtonLabel('cameraBtn', busy ? '카메라 연결 중…' : running ? '카메라 끄기' : '카메라 시작', busy ? 'clock' : running ? 'stop' : 'camera');
  document.querySelectorAll('[data-action="camera"]').forEach(node => { node.disabled = busy || state.saving; });
  $('recognizeBtn').hidden = !running || state.demo || state.tab !== 'recognition';
  $('recognizeBtn').disabled = recording || state.cameraState !== 'ready' || engine.samples.length === 0;
  setButtonLabel('recognizeBtn', engine.recognizing ? '인식 일시정지' : '인식 시작', engine.recognizing ? 'stop' : 'play');
  $('trainCameraBtn').hidden = !running || state.demo || state.tab !== 'training';
  $('trainCameraBtn').disabled = recording || busy;
  $('demoBtn').disabled = recording || busy;
  setButtonLabel('demoBtn', state.demo ? '체험 끝내기' : '먼저 체험하기', state.demo ? 'x' : 'play');
  $('cameraFacing').disabled = recording || busy;
  $('cancelRecording').disabled = state.saving;
  $('cameraBadge').replaceChildren(element('span'));
  let badge = '카메라 꺼짐';
  if (state.demo) badge = '화면 체험';
  else if (state.saving) badge = '저장 중';
  else if (state.recordPhase === 'countdown') badge = '촬영 준비';
  else if (state.recordPhase === 'recording') badge = '촬영 중';
  else if (busy) badge = '연결 중';
  else if (running) badge = engine.recognizing ? '인식 중' : '카메라 켜짐';
  else if (state.cameraState === 'error') badge = '연결 확인 필요';
  $('cameraBadge').append(document.createTextNode(badge));
  $('cameraBadge').classList.toggle('is-live', running && !state.demo);
  $('cameraBadge').classList.toggle('is-recording', state.recordPhase === 'recording');
  const result = state.demo ? '화면 체험' : engine.recognizing ? '인식 중' : '대기 중';
  $('resultStatus').replaceChildren(element('span'), document.createTextNode(result));
  $('resultStatus').classList.toggle('is-live', engine.recognizing && !state.demo);
  $('cameraHint').textContent = state.demo ? '예시 단어로 화면의 흐름을 체험하고 있어요 · 카메라 사용 없음' : state.tab === 'training' ? '단어를 등록한 뒤, 준비 시간에 맞춰 손동작을 보여 주세요' : '양손이 화면 안에 보이도록 편안하게 앉아 주세요';
}

function drawFrame(frame) {
  state.lastFrame = frame;
  const canvas = $('canvasOverlay');
  const workspace = $('cameraWorkspace');
  const width = workspace.clientWidth, height = workspace.clientHeight;
  if (!width || !height) return;
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  const count = frame?.handCount || 0;
  if (count !== state.lastHandCount) {
    state.lastHandCount = count;
    $('handStatus').replaceChildren(icon('hand'), element('span', '', state.demo ? '화면 체험 중' : count ? `${count}개 손 감지됨` : engine.cameraRunning ? '손을 보여 주세요' : '손 감지 대기'));
    $('handStatus').classList.toggle('detected', count > 0 && !state.demo);
  }
  if (!settings.landmarks || state.demo || !engine.cameraRunning || !count) return;
  const sourceWidth = $('videoElement').videoWidth || width;
  const sourceHeight = $('videoElement').videoHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const displayWidth = sourceWidth * scale, displayHeight = sourceHeight * scale;
  const left = (width - displayWidth) / 2, top = (height - displayHeight) / 2;
  const point = value => ({ x: left + (settings.mirror ? 1 - value.x : value.x) * displayWidth, y: top + value.y * displayHeight });
  frame.landmarks.forEach((hand, handIndex) => {
    if (!Array.isArray(hand) || hand.length !== 21) return;
    context.strokeStyle = handIndex ? '#9de8c4' : '#cbbcff'; context.lineWidth = 2.2;
    context.beginPath();
    CONNECTIONS.forEach(([a, b]) => {
      if (![hand[a]?.x, hand[a]?.y, hand[b]?.x, hand[b]?.y].every(Number.isFinite)) return;
      const from = point(hand[a]), to = point(hand[b]); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
    });
    context.stroke(); context.fillStyle = '#fff';
    hand.forEach(value => {
      if (![value?.x, value?.y].every(Number.isFinite)) return;
      const position = point(value); context.beginPath(); context.arc(position.x, position.y, 3.2, 0, Math.PI * 2); context.fill();
    });
  });
}

function setTab(tab, focus = false) {
  if (state.recordPhase && tab !== state.tab) { toast('촬영이 끝난 뒤 모드를 변경해 주세요.'); return; }
  state.tab = tab;
  if (tab === 'training') engine.setRecognizing(false);
  for (const [name, id] of [['recognition', 'recognitionTab'], ['training', 'trainingTab']]) {
    const active = name === tab;
    $(id).classList.toggle('active', active); $(id).setAttribute('aria-selected', String(active)); $(id).tabIndex = active ? 0 : -1;
  }
  $('cameraWorkspace').setAttribute('aria-labelledby', tab === 'training' ? 'trainingTab' : 'recognitionTab');
  if (focus) $(tab === 'training' ? 'trainingTab' : 'recognitionTab').focus();
  renderCamera();
}
// One editor DOM and document travel between the Live session and registration.
// Routing never resets the document, storage link, annotations, or conversation.
function renderWorkspace() {
  const live = currentView === 'live' && liveOpened;
  const capturing = live && recorderUI.active();
  $('liveIntro').hidden = live;
  $('liveWorkspace').hidden = !live;
  $('liveCaptureLayout').hidden = !capturing;
  $('liveRecordAgain').hidden = !live || !liveReady || capturing;
  $('liveDraftLink').hidden = !videoState.file;
  const workspace = $('videoWorkspace');
  const host = live && liveReady ? $('liveEditSlot') : $('videoEditorHost');
  if (workspace.parentElement !== host) host.append(workspace);
  workspace.hidden = live && liveReady && capturing;
  workspace.classList.toggle('has-video', Boolean(videoState.file));
  document.querySelector('.video-output-panel').hidden = !videoState.file;
  $('videoChatPanel').hidden = !videoState.document;
}
function endLive() {
  liveOpened = false; liveReady = false;
  recorderUI.close(); hybridUI.invalidate(); chatUI.invalidate();
  stopVideoReview();
  if (videoState.busy || videoState.loading) run(() => cancelVideoWork('Live를 닫아 요청을 취소했어요. 작성한 글은 유지합니다.'));
  renderWorkspace(); $('liveStartBtn').focus({ preventScroll: true });
}
function showView(view, focus = false) {
  if (view === 'main') return;
  if (!VIEW_NAMES[view]) view = 'live';
  const changed = currentView !== null && currentView !== view;
  libraryUI.viewChanged(view);
  currentView = view;
  if (changed) {
    liveOpened = false; liveReady = false;
    hybridUI.invalidate(); chatUI.invalidate();
    if (recorderUI.active()) recorderUI.close('화면을 이동해 카메라를 껐어요. 작성 중인 자료는 유지합니다.');
    stopVideoReview();
    if (videoState.busy || videoState.loading) run(() => cancelVideoWork('화면을 이동해 영상 분석을 취소했어요.'));
    if (engine.cameraRunning || state.cameraBusy || state.recordPhase) run(stopCamera);
    if (state.demo) endDemo();
  }
  document.querySelectorAll('.view').forEach(node => {
    const active = node.id === `view-${view}`; node.hidden = !active; node.classList.toggle('active', active);
  });
  document.querySelectorAll('.nav-item[data-view]').forEach(node => {
    const active = node.dataset.view === view; node.classList.toggle('active', active);
    if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current');
  });
  $('breadcrumbCurrent').textContent = VIEW_NAMES[view];
  document.title = `${VIEW_NAMES[view]} · 한국수어 영상 작업실`;
  renderWorkspace();
  if (view === 'history') renderHistory();
  if (view === 'library' && !libraryUI.busy()) run(() => libraryUI.refresh());
  if (focus) $('main').focus({ preventScroll: true });
  if (view === 'studio' && state.lastFrame) requestAnimationFrame(() => drawFrame(state.lastFrame));
}
function goTo(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  showView(view);
}
function openDialog(id) { if (!$(id).open) $(id).showModal(); }
function closeDialog(id) {
  if (id === 'addDialog') cancelRecordingIntent(true);
  $(id).close();
}
function openAdd(word = '') {
  if (state.recordPhase || state.saving) { toast('현재 촬영을 마치거나 취소한 뒤 새 단어를 등록해 주세요.'); return; }
  if (state.demo) endDemo();
  cancelRecordingIntent(false);
  $('wordInput').value = word;
  $('addTitle').textContent = word ? '같은 단어 동작 예시 추가' : '새 수어 등록하기';
  $('addError').hidden = true; $('startRecordBtn').disabled = false;
  setButtonLabel('startRecordBtn', '촬영 준비하기', 'camera');
  openDialog('addDialog'); $('wordInput').focus();
}
async function startCamera() {
  if (state.demo) endDemo();
  if (engine.cameraRunning && state.cameraState === 'ready') return true;
  state.cameraBusy = true; renderCamera();
  try {
    await engine.startCamera({ facingMode: settings.facingMode });
    return engine.cameraRunning && state.cameraState === 'ready';
  } finally { state.cameraBusy = state.cameraState === 'loading'; renderCamera(); }
}
async function stopCamera() {
  if (state.saving) return;
  cancelRecordingIntent(false);
  await engine.stopCamera();
  $('liveWord').textContent = '';
  renderCamera();
}
function cancelRecordingIntent(stopPending = true) {
  if (state.saving) return;
  const wasPending = state.pendingPermission;
  const hadPhase = state.recordPhase;
  ++state.recordIntent;
  clearTimeout(state.countdownTimer); state.countdownTimer = null;
  state.pendingPermission = false; state.recordPhase = null; state.recording = null;
  engine.cancelRecording(false);
  if (hadPhase && engine.cameraRunning && !state.cameraBusy) state.cameraState = 'ready';
  $('countdownScreen').hidden = true; $('recordingOverlay').hidden = true;
  $('startRecordBtn').disabled = false; setButtonLabel('startRecordBtn', '촬영 준비하기', 'camera');
  if (stopPending && wasPending) run(() => engine.stopCamera());
  if (hadPhase) {
    setCameraStatus('촬영을 취소했어요. 준비되면 다시 등록해 주세요.', false, true);
    $('cameraBtn').focus({ preventScroll: true });
  }
  renderCamera();
}
async function prepareRecording(event) {
  event.preventDefault();
  if (state.recordPhase || state.pendingPermission || state.saving) return;
  let word;
  try { word = normalizeWord($('wordInput').value); }
  catch (error) { $('addError').textContent = errorMessage(error); $('addError').hidden = false; $('wordInput').focus(); return; }
  const duration = [4,6,8].includes(Number($('recordingDuration').value)) ? Number($('recordingDuration').value) : 4;
  const intent = ++state.recordIntent;
  $('addError').hidden = true; $('startRecordBtn').disabled = true;
  setButtonLabel('startRecordBtn', '카메라 준비 중…', 'clock');
  state.pendingPermission = !engine.cameraRunning || state.cameraState !== 'ready';
  try {
    const ready = await startCamera();
    if (intent !== state.recordIntent || !$('addDialog').open) return;
    if (!ready) throw new Error('카메라가 준비되지 않았어요. 카메라 권한을 확인하고 다시 시도해 주세요.');
    state.pendingPermission = false;
    engine.setRecognizing(false);
    goTo('studio'); setTab('training');
    state.recording = { word, duration, intent }; state.recordPhase = 'countdown';
    $('addDialog').dataset.accepted = 'true'; $('addDialog').close();
    $('countdownScreen').hidden = false; $('countdownWord').textContent = `“${word}” · ${duration}초 촬영`;
    $('countdownNumber').textContent = '3'; $('cancelCountdown').focus();
    renderCamera();
    let remaining = 3;
    const tick = async () => {
      if (intent !== state.recordIntent || state.recordPhase !== 'countdown') return;
      remaining -= 1;
      if (remaining > 0) {
        $('countdownNumber').textContent = String(remaining);
        state.countdownTimer = setTimeout(() => run(tick), 1000); return;
      }
      state.countdownTimer = null; $('countdownScreen').hidden = true;
      state.recordPhase = 'recording';
      $('recordingWord').textContent = word; $('recordingTime').textContent = `${duration}초`;
      $('recordingProgress').style.width = '0%'; renderCamera(); $('cancelRecording').focus();
      try { await engine.startRecording({ word, duration }); }
      catch (error) { cancelRecordingIntent(false); throw error; }
    };
    state.countdownTimer = setTimeout(() => run(tick), 1000);
  } catch (error) {
    if (intent !== state.recordIntent) return;
    state.pendingPermission = false;
    $('addError').textContent = errorMessage(error); $('addError').hidden = false;
  } finally {
    if (intent === state.recordIntent) {
      $('startRecordBtn').disabled = false; setButtonLabel('startRecordBtn', '촬영 준비하기', 'camera');
    }
  }
}
async function saveRecording({ word, sample, videoBlob }) {
  const recording = state.recording;
  if (!recording || recording.intent !== state.recordIntent || state.recordPhase !== 'recording' || recording.word !== word) return;
  await Promise.resolve();
  if (recording.intent !== state.recordIntent || !state.recording) return;
  state.saving = true; $('recordingTime').textContent = '이 브라우저에 저장 중'; renderCamera();
  try {
    const sign = await store.saveSample(word, sample, videoBlob);
    await refreshSigns();
    toast(`“${word}” 동작 예시 저장 완료 · ${sign.samples.length}개의 연습 예시${sign.hasVideo ? '' : ' · 영상 없이 동작 데이터 저장'}`);
    setCameraStatus('동작 예시를 저장했어요. 비교 모드에서 등록한 동작을 다시 보여 주세요.', false, true);
  } finally {
    state.saving = false; state.recordPhase = null; state.recording = null;
    $('recordingOverlay').hidden = true; renderCamera(); $('recognitionTab').focus({ preventScroll: true });
  }
}

function renderSentence() {
  const words = state.demo ? state.demoSentence : state.sentence;
  $('sentenceEmpty').hidden = words.length > 0;
  $('sentenceText').hidden = words.length === 0; $('sentenceText').textContent = words.join(' ');
  $('wordChips').replaceChildren();
  if (!words.length) $('wordChips').append(element('span', 'empty-chip', '아직 인식한 단어가 없어요'));
  else words.slice(-5).forEach(word => $('wordChips').append(element('span', 'word-chip', word)));
  const score = state.demo ? null : state.confidence;
  $('matchInfo').hidden = score == null || !words.length;
  $('matchValue').textContent = `${Math.round((score || 0) * 100)}%`; $('matchBar').style.width = `${(score || 0) * 100}%`;
  $('copySentence').disabled = !words.length; $('clearSentence').disabled = !words.length;
  $('speakSentence').disabled = !words.length || !('speechSynthesis' in globalThis);
}
async function startDemo() {
  if (state.recordPhase || state.cameraBusy || state.saving) return;
  cancelRecordingIntent(true);
  await engine.stopCamera();
  state.demo = true; state.demoIndex = 0; state.demoSentence = [DEMO_WORDS[0]];
  $('demoWord').textContent = DEMO_WORDS[0]; state.lastHandCount = -1;
  goTo('studio'); setTab('recognition'); drawFrame({ landmarks: [], handCount: 0 }); renderSentence(); renderCamera();
  setCameraStatus('카메라를 사용하지 않는 화면 체험이에요. 예시 단어는 등록 동작이나 연습 기록에 저장되지 않아요.', false, true);
}
function endDemo() {
  state.demo = false; state.demoSentence = []; state.lastHandCount = -1;
  drawFrame({ landmarks: [], handCount: 0 }); renderSentence(); renderCamera();
  setCameraStatus('', false, false);
}
function sentenceValue() { return (state.demo ? state.demoSentence : state.sentence).join(' '); }
async function copySentence() {
  const text = sentenceValue(); if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch {
    const input = element('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove();
    if (!copied) throw new Error('복사 권한을 사용할 수 없어요. 화면의 문장을 선택해서 복사해 주세요.');
  }
  toast('문장을 복사했어요.');
}
function speakSentence() {
  const text = sentenceValue(); if (!text || !('speechSynthesis' in globalThis)) return;
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'ko-KR'; utterance.rate = 0.9;
  const voice = speechSynthesis.getVoices().find(entry => entry.lang.startsWith('ko'));
  if (voice) utterance.voice = voice;
  utterance.onerror = event => { if (!['canceled','interrupted'].includes(event.error)) toast('음성 읽기를 사용할 수 없어요. 브라우저의 음성 설정을 확인해 주세요.', true); };
  speechSynthesis.cancel(); speechSynthesis.speak(utterance);
}

function emptyState(title, description, action = null) {
  const node = element('div', 'empty-state'); node.append(icon('book'), element('h3', '', title), element('p', '', description));
  if (action) node.append(button('첫 수어 등록하기', 'button button-primary', action, 'plus'));
  return node;
}
function renderStats() {
  const compatible = state.signs.filter(sign => sign.samples.length > 0);
  $('wordCount').textContent = String(compatible.length);
  $('navCount').textContent = String(state.signs.length); $('dictionaryCount').textContent = String(state.signs.length);
  const samples = state.signs.reduce((total, sign) => total + sign.samples.length, 0);
  $('sampleCount').textContent = samples ? `${samples}개의 연습 예시를 배웠어요` : state.signs.length ? '기존 단어는 다시 촬영해 주세요' : '첫 수어를 등록해 보세요';
  const today = dayFormat.format(new Date());
  $('practiceCount').textContent = String(state.history.filter(entry => dayFormat.format(new Date(entry.timestamp)) === today).length);
}
function renderDictionary() {
  const query = $('wordSearch').value.normalize('NFC').trim().toLocaleLowerCase('ko-KR');
  const filtered = state.signs.filter(sign => sign.word.toLocaleLowerCase('ko-KR').includes(query));
  $('dictionaryGrid').replaceChildren();
  if (!filtered.length) {
    $('dictionaryGrid').append(emptyState(query ? '검색한 단어가 없어요' : '등록한 단어가 없습니다', query ? '다른 단어로 검색하거나 새 수어를 등록해 주세요.' : '단어를 입력하고, 카메라로 나의 손동작을 등록해 보세요.', query ? null : () => openAdd()));
  }
  filtered.forEach(sign => {
    const card = element('article', 'sign-card');
    const top = element('div', 'sign-card-top');
    const avatar = element('span', 'sign-avatar', Array.from(sign.word)[0]); avatar.setAttribute('aria-hidden', 'true');
    const content = element('div'); content.append(element('h3', 'sign-word', sign.word));
    content.append(element('p', 'sign-meta', sign.legacy ? '다시 촬영 필요 · 기존 데이터 보존' : `${sign.samples.length}개의 연습 예시 · ${dateFormat.format(new Date(sign.updatedAt))} 등록`));
    top.append(avatar, content); card.append(top);
    const actions = element('div', 'sign-card-actions');
    const play = button('영상 보기', 'button button-outline', () => playVideo(sign), 'play'); play.disabled = !sign.hasVideo;
    if (!sign.hasVideo) play.title = '저장된 영상이 없어요. 다시 촬영하면 영상을 보관할 수 있어요.';
    const repeat = button('예시 추가', 'button button-quiet', () => openAdd(sign.word), 'plus');
    const remove = button('', 'icon-button', () => askDelete(sign), 'trash'); remove.setAttribute('aria-label', `${sign.word} 삭제`);
    actions.append(play, repeat, remove); card.append(actions); $('dictionaryGrid').append(card);
  });
  $('dictionaryPreview').replaceChildren();
  $('dictionaryPreview').classList.toggle('preview-signs', state.signs.length > 0);
  if (!state.signs.length) {
    const empty = element('div', 'dictionary-empty');
    const book = element('span', 'empty-book'); book.append(icon('book'), element('span', '', '+'));
    const content = element('div'); content.append(element('h3', '', '등록한 단어가 없습니다'), element('p', '', '단어를 입력하고, 4초 동안 손동작을 보여 주세요.'), button('나의 첫 수어 등록하기', 'text-button purple', () => openAdd(), 'arrow'));
    empty.append(book, content); $('dictionaryPreview').append(empty);
  } else state.signs.slice(0, 3).forEach(sign => {
    const row = element('div', 'preview-word-row preview-sign');
    const avatar = element('span', 'sign-avatar', Array.from(sign.word)[0]); avatar.setAttribute('aria-hidden', 'true');
    const name = element('div', 'preview-word-name'); name.append(element('strong', '', sign.word), element('small', 'preview-word-meta', sign.legacy ? '다시 촬영 필요' : `${sign.samples.length}개 예시 · ${dateFormat.format(new Date(sign.updatedAt))}`));
    const play = button('', 'icon-button preview-word-play', () => playVideo(sign), 'play'); play.disabled = !sign.hasVideo; play.setAttribute('aria-label', `${sign.word} 영상 보기`);
    row.append(avatar, name, play); $('dictionaryPreview').append(row);
  });
}
async function refreshSigns() {
  state.signs = await store.list(); engine.setSamples(state.signs); renderDictionary(); renderStats(); renderCamera(); renderVideoControls();
}
async function playVideo(sign) {
  const blob = await store.getVideo(sign.id);
  if (!blob) { toast('이 단어에는 저장된 영상이 없어요. 다시 촬영해 주세요.'); return; }
  cleanupVideo(); state.videoURL = URL.createObjectURL(blob);
  $('savedVideo').src = state.videoURL; $('videoTitle').textContent = `“${sign.word}” 등록한 동작`;
  openDialog('videoDialog'); $('savedVideo').play().catch(() => {});
}
function cleanupVideo() {
  $('savedVideo').pause(); $('savedVideo').removeAttribute('src'); $('savedVideo').load();
  if (state.videoURL) URL.revokeObjectURL(state.videoURL); state.videoURL = null;
}
function askDelete(sign) {
  state.deleting = sign;
  $('deleteMessage').textContent = `“${sign.word}”의 모든 연습 예시와 촬영 영상을 삭제해요. 백업 파일이 있다면 동작 데이터를 다시 가져올 수 있어요.`;
  openDialog('deleteDialog');
}
async function confirmDelete() {
  const sign = state.deleting; if (!sign) return;
  $('confirmDelete').disabled = true;
  try { await store.remove(sign.id); await refreshSigns(); $('deleteDialog').close(); toast(`“${sign.word}”을 삭제했어요.`); }
  finally { $('confirmDelete').disabled = false; }
}

function readHistory() {
  const entries = localRead(HISTORY_KEY);
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 200).flatMap(entry => {
    try {
      const word = normalizeWord(entry.word);
      if (!Number.isFinite(entry.timestamp) || entry.timestamp < 0 || entry.timestamp > 8640000000000000 || !Number.isFinite(entry.confidence)) return [];
      return [{ word, timestamp: entry.timestamp, confidence: Math.max(0, Math.min(1, entry.confidence)) }];
    } catch { return []; }
  });
}
function renderHistory() {
  $('historyList').replaceChildren(); $('downloadHistory').disabled = state.history.length === 0;
  if (!state.history.length) {
    $('historyList').append(emptyState('아직 비교 기록이 없습니다', '수어를 등록하고 실제 인식을 시작하면 이곳에 기록이 쌓여요.')); return;
  }
  state.history.forEach(entry => {
    const row = element('div', 'history-row');
    const word = element('strong', 'history-word', entry.word);
    const time = element('time', 'history-time', `${dateFormat.format(new Date(entry.timestamp))} ${timeFormat.format(new Date(entry.timestamp))}`); time.dateTime = new Date(entry.timestamp).toISOString();
    const confidence = element('span', 'history-confidence small-tag', `일치도 ${Math.round(entry.confidence * 100)}%`);
    row.append(word, time, confidence); $('historyList').append(row);
  });
}
function download(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob); const link = element('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function exportData() {
  const parts = await store.exportParts();
  const date = dayFormat.format(new Date());
  if (parts.length === 1) {
    download(parts[0], `수어스튜디오-학습데이터-${date}.json`, 'application/json;charset=utf-8');
    toast('단어와 동작 데이터를 백업했어요. 촬영 영상은 백업 파일에 포함되지 않아요.');
    return;
  }
  cleanupBackups(); $('backupParts').replaceChildren();
  $('backupTitle').textContent = `동작 데이터 백업 · ${parts.length}개 파일`;
  parts.forEach((part, index) => {
    const blob = new Blob([part], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob); state.backupURLs.push(url);
    const link = element('a', 'button button-outline'); link.href = url;
    link.download = `수어스튜디오-학습데이터-${date}-${index + 1}of${parts.length}.json`;
    link.append(icon('download'), document.createTextNode(`백업 ${index + 1} / ${parts.length} · ${(blob.size / 1024 / 1024).toFixed(1)}MB`));
    $('backupParts').append(link);
  });
  openDialog('backupDialog');
}
function cleanupBackups() {
  state.backupURLs.forEach(url => URL.revokeObjectURL(url)); state.backupURLs = [];
}
async function importData(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  if (state.recordPhase || state.saving) throw new Error('현재 촬영이 끝난 뒤 백업을 가져와 주세요.');
  if (file.size > MAX_IMPORT_BYTES) throw new Error('백업 파일은 10MB 이하여야 해요.');
  const result = await store.importData(await file.text()); await refreshSigns();
  toast(`${result.count}개 단어의 동작 데이터를 가져왔어요. 기존 단어는 함께 보관해요.`);
}
function downloadHistory() {
  if (!state.history.length) return;
  const lines = ['수어스튜디오 · 연습 기록 (한국 시간)', '', ...state.history.map(entry => `${dayFormat.format(new Date(entry.timestamp))} ${timeFormat.format(new Date(entry.timestamp))} | ${entry.word} | 동작 일치도 ${Math.round(entry.confidence * 100)}%`)];
  download(lines.join('\n'), `수어스튜디오-연습기록-${dayFormat.format(new Date())}.txt`, 'text/plain;charset=utf-8');
  toast('연습 기록을 내려받았어요.');
}
function renderStorage() {
  const memory = store.mode === 'memory'; const fallback = store.mode === 'localstorage';
  $('storageLabel').textContent = memory ? '현재 세션' : '내 브라우저';
  $('storageSidebar').textContent = memory ? '새로고침 전 백업 필요' : '이 브라우저에 저장';
  $('storageFoot').textContent = memory ? '새로고침하면 사라질 수 있어요' : fallback ? '보조 저장소 · 저장 공간 제한' : '촬영 영상도 기기에 저장돼요';
  $('footerStorage').textContent = memory ? '브라우저 저장이 제한되어 있어요. 새로고침 전에 동작 데이터를 백업해 주세요.' : '영상과 등록 동작은 이 브라우저에 보관합니다.';
  $('storageWarning').textContent = store.warning || (fallback ? '브라우저 보조 저장소를 사용하고 있어요. 저장 공간이 작으므로 단어와 동작 데이터를 주기적으로 백업해 주세요.' : '');
  $('storageWarning').hidden = !$('storageWarning').textContent;
}
function applySettings() {
  $('mirrorToggle').checked = settings.mirror; $('landmarkToggle').checked = settings.landmarks;
  $('cameraFacing').value = settings.facingMode; $('thresholdRange').value = String(settings.threshold); $('thresholdValue').textContent = `${settings.threshold}%`;
  engine.setMirrored(settings.mirror); engine.setThreshold(settings.threshold);
  $('videoElement').style.transform = settings.mirror ? 'scaleX(-1)' : 'none';
  $('canvasOverlay').hidden = !settings.landmarks || !engine.cameraRunning || state.demo;
  if (state.lastFrame) drawFrame(state.lastFrame);
}
function saveSettings() {
  if (!localWrite(SETTINGS_KEY, settings)) toast('설정은 현재 세션에 적용돼요. 브라우저가 설정 저장을 제한하고 있어요.', true);
  applySettings();
}

function formatVideoTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
}
function compatibleVideoSigns() {
  return state.signs.some(sign => sign.samples.some(sample => sample.featureVersion === 2 && sample.frames.length >= 12));
}
function renderVideoControls() {
  if (!$('videoFile')) return;
  const ai = videoState.mode === 'ai';
  const occupied = videoState.busy || videoState.canceling || hybridUI.busy() || chatUI.busy();
  const limit = (ai ? 12 : 50) * 1024 * 1024;
  const validFile = Boolean(videoState.file && videoState.duration && !videoState.loading && videoState.file.size <= limit);
  $('videoLocalMode').classList.toggle('active', !ai); $('videoAIMode').classList.toggle('active', ai);
  $('videoLocalMode').setAttribute('aria-pressed', String(!ai)); $('videoAIMode').setAttribute('aria-pressed', String(ai));
  $('videoLocalMode').disabled = occupied; $('videoAIMode').disabled = occupied;
  if ($('videoLimitLabel')) $('videoLimitLabel').textContent = '최대 50MB · 60초';
  $('aiConnection').hidden = !ai;
  $('geminiKey').disabled = occupied; $('aiUploadConsent').disabled = occupied;
  $('videoAnalyzeBtn').disabled = occupied || !validFile || (!ai && !compatibleVideoSigns());
  $('videoCancelBtn').hidden = !videoState.busy;
  setButtonLabel('videoAnalyzeBtn', videoState.busy ? '분석 중' : ai ? '전송 내용 확인' : '단어 후보 분석');
  const step = videoState.busy ? 1 : videoState.document ? 2 : videoState.file && !videoState.loading ? 1 : 0;
  document.querySelectorAll('.video-steps li').forEach((node, index) => {
    if (index === step) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
  });
  $('videoCopyBtn').disabled = !videoState.text || occupied;
  $('videoDownloadBtn').disabled = !videoState.text || occupied;
  $('videoAddSegment').disabled = occupied || !videoState.duration || videoState.loading;
  $('videoJSONBtn').disabled = !videoState.document || Boolean(validateVideoDocument(videoState.document)) || occupied;
  $('videoEditor').disabled = occupied;
  $('videoReturnToSegment').disabled = occupied;
  $('videoClearBtn').disabled = !videoState.file && !videoState.result && !videoState.loading;
  $('uploadedVideo').controls = !occupied;
  $('videoUploadEmpty').hidden = Boolean(videoState.file);
  $('uploadedVideo').hidden = !videoState.file;
  $('videoFileName').textContent = videoState.file?.name || '영상 선택';
  $('videoFileMeta').textContent = videoState.loading ? '영상 길이와 재생 형식을 확인하고 있어요…' : videoState.file && videoState.duration ? `${videoState.duration.toFixed(1)}초 · ${(videoState.file.size / 1024 / 1024).toFixed(1)}MB · ${videoState.width} × ${videoState.height}` : '최대 60초 · 기기 내 분석 50MB / AI 초안 12MB';
  $('aiConnectionNote').textContent = '키는 현재 페이지에서만 사용합니다. 전송 내용 확인 → 이번 요청 승인 후에만 선택한 자료를 Google로 보냅니다. 자료 선택·저장·검색만으로 전송하지 않습니다.';
  $('videoNotice').replaceChildren();
  const notice = videoState.notice || (!videoState.file ? '' : videoState.file?.size > limit ? `AI 초안은 12MB 이하만 지원합니다. 직접 구간을 작성하거나 용량을 줄여 주세요.` : ai ? '직접 작성하거나 초안 도구를 이용하세요. AI 초안은 KSL 성능 미검증 · 전송은 별도 승인 후.' : compatibleVideoSigns() ? '개인 사전의 단어 후보만 기기 안에서 비교합니다.' : '개인 사전에 등록한 단어가 있어야 후보를 비교할 수 있어요.');
  const noticeText = element('span', '', notice);
  $('videoNotice').append(icon('info'), noticeText);
  $('videoNotice').hidden = !notice;
  libraryUI.update(); hybridUI.update(); recorderUI.update(); chatUI.update();
  renderWorkspace();
  if (!ai && !videoState.notice) {
    const link = element('a', 'text-button purple', ' 나의 수어 사전 보기'); link.href = '#dictionary';
    noticeText.append(link);
  }
}
function stopVideoReview() {
  videoState.reviewRange = null;
  $('uploadedVideo')?.pause();
}
function resetVideoResult() {
  hybridUI.clear(); chatUI.invalidate(); libraryUI.reset();
  stopVideoReview();
  $('videoResultLimitations').textContent = '';
  $('videoResultLimitations').hidden = true;
  videoState.result = null; videoState.text = ''; videoState.document = null; videoState.dirty = false; videoState.nextSegment = 1;
  videoState.selectedSegment = null;
  $('videoReviewNavigation').hidden = true;
  $('videoEditStatus').textContent = '';
  $('videoEditError').textContent = '';
  if (!$('videoTranscript')) return;
  $('videoTranscript').textContent = '영상 분석 후 구간별 초안을 검토하거나, 영상을 보며 직접 내용을 작성할 수 있어요.';
  $('videoTranscript').classList.remove('has-result');
  $('videoSegments').replaceChildren();
  $('videoResultLabel').textContent = '작성 대기';
  $('videoProgress').hidden = true;
}
function updateVideoProgress(payload, token, mode) {
  if (token !== videoState.runToken || !videoState.busy) return;
  $('videoProgress').hidden = false;
  if (mode === 'local' && Number.isFinite(payload.progress)) {
    const progress = Math.max(0, Math.min(1, payload.progress));
    $('videoProgressBar').style.width = `${progress * 100}%`;
    $('videoProgressBar').parentElement?.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
    $('videoProgress').classList.remove('is-indeterminate');
    $('videoProgressBar').parentElement?.classList.remove('indeterminate');
    $('videoProgressText').textContent = payload.message || `영상에서 손동작을 비교하고 있어요 · ${Math.round(progress * 100)}% · ${payload.framesAnalyzed || 0}개 프레임`;
  } else {
    $('videoProgressBar').style.width = '0%';
    $('videoProgressBar').parentElement?.removeAttribute('aria-valuenow');
    $('videoProgress').classList.add('is-indeterminate');
    $('videoProgressBar').parentElement?.classList.add('indeterminate');
    $('videoProgressText').textContent = payload.message || (mode === 'ai' ? 'Google의 영상 분석 응답을 기다리고 있어요…' : '손 인식 모듈을 준비하고 있어요…');
  }
}
async function cancelVideoAnalysis(message = '영상 분석을 취소했어요.') {
  hybridUI.cancel(); chatUI.cancel();
  const token = ++videoState.runToken;
  const analyzer = videoState.analyzer, job = videoState.jobPromise;
  videoState.controller?.abort(); videoState.controller = null;
  videoState.analyzer = null; videoState.jobPromise = null;
  videoState.busy = false;
  const cleanup = [];
  if (analyzer) {
    try { cleanup.push(Promise.resolve(analyzer.cancel())); } catch { /* In-flight callbacks are already invalidated. */ }
  }
  if (job) cleanup.push(Promise.resolve(job));
  cleanup.push(videoState.cancelPromise);
  videoState.canceling = Boolean(analyzer || job || videoState.canceling);
  videoState.cancelPromise = Promise.allSettled(cleanup).then(() => {
    if (token === videoState.runToken) { videoState.canceling = false; renderVideoControls(); }
  });
  if ($('videoProgress')) {
    $('videoProgress').hidden = !message;
    $('videoProgress').classList.remove('is-indeterminate');
    $('videoProgressBar').parentElement?.classList.remove('indeterminate');
    $('videoProgressBar').style.width = '0%'; $('videoProgressText').textContent = message;
  }
  renderVideoControls();
  await videoState.cancelPromise;
}
async function cancelVideoWork(message) {
  stopVideoReview();
  if (videoState.loading) {
    ++videoState.loadToken; videoState.loadController?.abort(); videoState.loadController = null;
    videoState.loading = false; videoState.file = null; videoState.duration = null;
    cleanupUploadedVideo();
    videoState.notice = '영상을 불러오다가 취소했어요. 파일을 다시 선택해 주세요.';
  }
  await cancelVideoAnalysis(message);
}
function cleanupUploadedVideo() {
  stopVideoReview();
  const video = $('uploadedVideo');
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  if (videoState.url) URL.revokeObjectURL(videoState.url);
  videoState.url = null;
}
function loadVideoMetadata(url, signal) {
  const video = $('uploadedVideo');
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', failure); signal.removeEventListener('abort', aborted); };
    const failed = error => { cleanup(); reject(error); };
    const aborted = () => { const error = new Error('영상 불러오기를 취소했어요.'); error.name = 'AbortError'; failed(error); };
    const failure = () => failed(new Error('이 영상을 재생할 수 없어요. 브라우저에서 재생되는 MP4 또는 WebM 영상으로 다시 선택해 주세요.'));
    const ready = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 60) { failed(new Error('영상은 길이가 60초 이하인 파일이어야 해요.')); return; }
      if (!video.videoWidth || !video.videoHeight) { failed(new Error('영상 화면을 찾지 못했어요. 음성 파일이 아닌 수어 영상 파일을 선택해 주세요.')); return; }
      cleanup(); resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    };
    const timer = setTimeout(() => failed(new Error('영상 정보를 읽는 데 시간이 오래 걸려요. 다른 MP4 또는 WebM 파일로 다시 시도해 주세요.')), 15000);
    video.addEventListener('loadedmetadata', ready); video.addEventListener('error', failure);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    video.src = url; video.load();
  });
}
async function selectVideoFile(file, options = {}) {
  if (libraryUI.busy() && !options.fromLibrary) return;
  if (!file || (!options.confirmed && !confirmVideoReplace())) return;
  const token = ++videoState.loadToken;
  videoState.loadController?.abort(); videoState.loadController = null;
  videoState.loading = true; videoState.notice = '';
  $('aiUploadConsent').checked = false;
  resetVideoResult();
  await cancelVideoAnalysis('');
  if (token !== videoState.loadToken) return;
  cleanupUploadedVideo(); videoState.file = null; videoState.duration = null;
  renderVideoControls();
  try {
    const limit = 50 * 1024 * 1024;
    if (!file.size) throw new Error('빈 파일이에요. 수어 영상 파일을 다시 선택해 주세요.');
    if (file.size > limit) throw new Error('영상은 50MB 이하로 선택해 주세요.');
    if ((file.type && !file.type.startsWith('video/')) || (!file.type && !/\.(mp4|webm|mov|m4v|mpeg|mpg|avi|mkv)$/i.test(file.name))) throw new Error('영상 파일을 선택해 주세요. MP4 또는 WebM 형식을 권장해요.');
    videoState.file = file; videoState.url = URL.createObjectURL(file);
    const controller = new AbortController(); videoState.loadController = controller;
    renderVideoControls();
    const metadata = await loadVideoMetadata(videoState.url, controller.signal);
    if (token !== videoState.loadToken) return;
    Object.assign(videoState, metadata); videoState.loadController = null; videoState.loading = false;
  } catch (error) {
    if (token !== videoState.loadToken) return;
    videoState.loading = false; videoState.file = null; videoState.duration = null; videoState.loadController = null;
    cleanupUploadedVideo(); videoState.notice = errorMessage(error);
    if (error.name !== 'AbortError') toast(errorMessage(error), true);
  }
  renderVideoControls();
}
function setVideoMode(mode) {
  if (libraryUI.busy() || videoState.busy || videoState.canceling || !['local', 'ai'].includes(mode)) return;
  videoState.mode = mode; videoState.notice = ''; hybridUI.invalidate();
  renderVideoControls();
}
function confirmVideoReplace() {
  return !videoState.dirty || window.confirm('저장하지 않은 수정 내용이 있어요. 내용을 버리고 계속할까요?');
}
function syncVideoDocument() {
  const doc = videoState.document;
  if (!doc) return;
  if (hybridUI.runState().phase === 'preview') hybridUI.invalidate();
  chatUI.invalidate();
  const error = validateVideoDocument(doc);
  $('videoEditError').textContent = error;
  videoState.text = error ? '' : videoDocumentText(doc);
  const rows = [...doc.segments].sort((a, b) => a.start - b.start);
  $('videoTranscript').textContent = rows.some(row => row.text.trim()) ? rows.map(row => row.text.trim() || '[내용 확인 필요]').join(' ') : '아직 작성된 변환문이 없어요. 구간을 추가하거나 초안을 검토해 주세요.';
  $('videoTranscript').classList.toggle('has-result', rows.some(row => row.text.trim()));
  const selected = doc.segments.find(row => row.id === videoState.selectedSegment);
  if (selected) $('videoReviewStatus').textContent = error ? '구간의 시간 범위를 확인해 주세요.' : `${doc.segments.indexOf(selected) + 1}번 구간 · ${formatVideoTime(selected.start)}–${formatVideoTime(selected.end)}`;
  const pending = rows.filter(row => !row.reviewed || !row.text.trim() || row.uncertainty?.trim()).length;
  $('videoEditStatus').textContent = `${rows.length ? `${rows.length}개 구간 · ${pending}개 검토 필요` : '작성된 구간 없음'}${videoState.dirty ? ' · 저장하지 않은 문서' : ''}`;
  renderVideoControls();
}
function playVideoSegment(row) {
  if (videoState.busy || videoState.canceling || validateVideoDocument({ ...videoState.document, segments: [row] })) return;
  stopVideoReview();
  const video = $('uploadedVideo'), range = { end: row.end };
  video.currentTime = row.start; videoState.reviewRange = range;
  videoState.selectedSegment = row.id;
  const number = videoState.document.segments.indexOf(row) + 1;
  $('videoReviewNavigation').hidden = false;
  $('videoReviewStatus').textContent = `${number}번 구간 · ${formatVideoTime(row.start)}–${formatVideoTime(row.end)}`;
  $('videoSegments').querySelectorAll('.segment-editor').forEach(node => {
    node.classList.toggle('selected', node.dataset.segmentId === String(row.id));
  });
  if (window.matchMedia('(max-width: 760px)').matches) video.scrollIntoView({ block: 'start' });
  video.play().catch(() => { if (videoState.reviewRange === range) videoState.reviewRange = null; });
}
function renderVideoEditor() {
  const doc = videoState.document;
  $('videoSegments').replaceChildren();
  if (!doc) return;
  doc.segments.forEach((row, index) => {
    const node = element('section', 'segment-editor');
    node.dataset.segmentId = String(row.id);
    node.classList.toggle('selected', videoState.selectedSegment === row.id);
    const title = element('div', 'segment-heading');
    const play = button(`${index + 1}번 구간 재생`, 'video-segment', () => playVideoSegment(row), 'play');
    title.append(play, button('삭제', 'text-button', () => {
      doc.segments = doc.segments.filter(item => item !== row); videoState.dirty = true;
      if (videoState.selectedSegment === row.id) { videoState.selectedSegment = null; $('videoReviewNavigation').hidden = true; }
      stopVideoReview(); renderVideoEditor(); syncVideoDocument();
    }));
    node.append(title);
    const times = element('div', 'segment-times');
    for (const [key, label] of [['start', '시작 (초)'], ['end', '끝 (초)']]) {
      const wrapper = element('label', '', label), input = element('input', 'text-input');
      input.type = 'number'; input.min = '0'; input.max = String(doc.duration); input.step = '0.1'; input.value = String(row[key]);
      input.setAttribute('aria-label', `${index + 1}번 구간 ${label}`);
      input.addEventListener('input', () => { row[key] = input.value === '' ? NaN : Number(input.value); row.reviewed = false; checked.checked = false; videoState.dirty = true; stopVideoReview(); syncVideoDocument(); });
      wrapper.append(input); times.append(wrapper);
    }
    node.append(times);
    if (row.original) node.append(element('p', 'segment-original', `${row.source === 'local' ? '참고 단어 후보 · 문장 번역 아님' : '원본 AI 초안 · 성능 미검증'}: ${row.original}`));
    const label = element('label', 'field-label', `${index + 1}번 구간 한국어 글 · 자연스러운 의역`), input = element('textarea', 'text-input');
    input.rows = 3; input.maxLength = 500; input.value = row.text; input.placeholder = '영상을 확인하고 한국어 내용을 작성해 주세요.';
    input.setAttribute('aria-label', `${index + 1}번 구간 한국어 글`);
    input.addEventListener('input', () => { row.text = input.value; row.reviewed = false; checked.checked = false; videoState.dirty = true; syncVideoDocument(); });
    label.append(input); node.append(label);
    const literalLabel = element('label', 'field-label', '직역 · 수어 표현 순서와 의미를 가능한 그대로'), literal = element('textarea', 'text-input');
    literal.rows = 2; literal.maxLength = 1000; literal.value = row.literal || ''; literal.placeholder = '직역은 표준 수어 글로스가 아닙니다. 생략하거나 모호한 부분도 적어 주세요.';
    literal.setAttribute('aria-label', `${index + 1}번 구간 직역`); literalLabel.append(literal); node.insertBefore(literalLabel, label);
    literal.addEventListener('input', () => { row.literal = literal.value; row.reviewed = false; checked.checked = false; videoState.dirty = true; syncVideoDocument(); });
    const details = element('details', 'annotation-details'); details.append(element('summary', '', '상황·지시 대상·불확실성 기록'));
    for (const [key, title, placeholder] of [
      ['context', '상황·문맥', '예: 병원 예약 시간을 변경하는 대화'],
      ['referents', '지시 대상', '예: 화면 왼쪽 공간의 인물은 동료'],
      ['intent', '의도', '예: 시간을 묻는 질문인지, 변경을 요청하는지'],
      ['uncertainty', '불확실한 부분', '예: 1.2–1.8초의 날짜는 내일/다음 주 중 확인 필요'],
    ]) {
      const wrapper = element('label', 'field-label', title), field = element('textarea', 'text-input');
      field.rows = 2; field.maxLength = 1000; field.value = row[key] || ''; field.placeholder = placeholder; field.setAttribute('aria-label', `${index + 1}번 구간 ${title}`);
      field.addEventListener('input', () => { row[key] = field.value; row.reviewed = false; checked.checked = false; videoState.dirty = true; syncVideoDocument(); });
      wrapper.append(field); details.append(wrapper);
    }
    node.append(details);
    const review = element('label', 'consent-label'), checked = element('input'); checked.type = 'checkbox'; checked.checked = row.reviewed;
    checked.addEventListener('change', () => { row.reviewed = checked.checked && Boolean(row.text.trim()); checked.checked = row.reviewed; videoState.dirty = true; syncVideoDocument(); });
    review.append(checked, document.createTextNode('원본 영상과 대조하여 검토함')); node.append(review);
    $('videoSegments').append(node);
  });
}
function addVideoSegment() {
  if (libraryUI.busy()) return;
  if (!videoState.duration || videoState.busy || videoState.canceling || videoState.loading) return;
  if (!videoState.document) {
    videoState.document = createVideoDocument({}, 'manual', videoState.duration);
    $('videoResultLabel').textContent = '사용자 직접 작성';
  }
  const doc = videoState.document;
  if (doc.segments.length >= 100) { toast('구간은 최대 100개까지 작성할 수 있어요.', true); return; }
  const start = Math.max(0, Math.min($('uploadedVideo').currentTime, doc.duration - 0.1));
  doc.segments.push({ id: videoState.nextSegment++, start, end: Math.min(doc.duration, start + 3), text: '', original: '', source: 'manual', reviewed: false });
  videoState.dirty = true; renderVideoEditor(); syncVideoDocument();
  $('videoSegments').lastElementChild.querySelector('textarea').focus();
}
function renderVideoResult(result, mode) {
  videoState.selectedSegment = null; $('videoReviewNavigation').hidden = true;
  videoState.result = { ...result, mode };
  videoState.document = createVideoDocument(result, mode, videoState.duration);
  videoState.nextSegment = videoState.document.segments.length + 1;
  videoState.dirty = true;
  $('videoResultLabel').textContent = mode === 'ai' ? (videoState.document.segments.length ? 'AI 초안 · 검토 필요' : '자동 초안 없음') : '단어 후보 · 문장 번역 아님';
  const limitation = result.unreadableReason || (mode === 'local' ? `${videoState.document.segments.length ? '개인 사전과 비교한 단어 후보입니다.' : '개인 사전의 단어 후보를 찾지 못했습니다.'} 한국어 문장은 원본 영상을 확인한 뒤 직접 작성해 주세요.` : '');
  if (!videoState.document.segments.length && !limitation) videoState.document.limitation = '영상에서 한국수어 내용을 충분히 확인하지 못했어요.';
  else videoState.document.limitation = limitation;
  $('videoResultLimitations').textContent = videoState.document.limitation;
  $('videoResultLimitations').hidden = !videoState.document.limitation;
  renderVideoEditor(); syncVideoDocument();
  $('videoProgress').hidden = false; $('videoProgress').classList.remove('is-indeterminate');
  $('videoProgressBar').parentElement?.classList.remove('indeterminate');
  $('videoProgressBar').style.width = '100%';
  $('videoProgressBar').parentElement?.setAttribute('aria-valuenow', '100');
  $('videoProgressText').textContent = mode === 'ai' ? (videoState.document.segments.length ? '초안을 받았어요. 구간별로 확인하고 한국어 글을 수정해 주세요.' : '분석을 마쳤지만 자동 초안이 없습니다. 영상을 확인하거나 직접 구간을 작성해 주세요.') : `${result.framesAnalyzed || 0}개 프레임 분석 · ${videoState.document.segments.length}개 단어 후보`;
  renderVideoControls();
}
function saveVideoDocument(format) {
  if (!videoState.document || validateVideoDocument(videoState.document) || videoState.busy || videoState.canceling) return;
  const json = format === 'json';
  const content = json ? JSON.stringify({ schemaVersion: 1, ...videoState.document, warning: '사용자 검토 상태이며 검증된 한국수어 번역이 아닙니다.' }, null, 2) : videoState.text;
  download(content, `한국수어-영상-검토문서-${dayFormat.format(new Date())}.${json ? 'json' : 'txt'}`, json ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8');
  toast('글 문서를 내려받았어요. 영상 자료의 변경은 로컬 저장으로 따로 보관해 주세요.');
}
async function analyzeVideo() {
  if (libraryUI.busy() || hybridUI.busy() || videoState.busy || videoState.canceling || videoState.loading) return;
  if (videoState.mode === 'ai') { await hybridUI.prepare(); return; }
  const file = videoState.file, duration = videoState.duration;
  if (!file || !duration) throw new Error('먼저 60초 이하의 수어 영상 파일을 선택해 주세요.');
  if (state.recordPhase || state.saving) throw new Error('현재 촬영을 마치거나 취소한 뒤 영상을 분석해 주세요.');
  if (file.size > 50 * 1024 * 1024) throw new Error('영상은 50MB 이하여야 해요.');
  if (!compatibleVideoSigns()) throw new Error('먼저 수어 사전에 단어와 손동작을 등록해 주세요.');
  if (!confirmVideoReplace()) return;
  const intent = videoState.runToken;
  await videoState.cancelPromise;
  if (intent !== videoState.runToken || videoState.file !== file || videoState.mode !== 'local' || videoState.busy || videoState.loading || videoState.canceling) return;
  const token = ++videoState.runToken;
  const controller = new AbortController(); videoState.controller = controller;
  videoState.busy = true; videoState.notice = ''; stopVideoReview(); renderVideoControls();
  updateVideoProgress({ message: '영상 분석을 준비하고 있어요…' }, token, 'local');
  try {
    if (state.demo) endDemo();
    await stopCamera();
    if (token !== videoState.runToken || controller.signal.aborted) return;
    const onProgress = payload => updateVideoProgress(payload, token, 'local');
    videoState.analyzer = new VideoSignAnalyzer({ onProgress });
    const job = videoState.analyzer.analyze({ file, video: $('uploadedVideo'), signs: state.signs, threshold: settings.threshold / 100, signal: controller.signal });
    videoState.jobPromise = job;
    const result = await job;
    if (token !== videoState.runToken || controller.signal.aborted || videoState.file !== file) return;
    renderVideoResult(result, 'local');
  } catch (error) {
    if (token !== videoState.runToken || controller.signal.aborted || error.name === 'AbortError') return;
    videoState.notice = errorMessage(error); toast(errorMessage(error), true); $('videoProgress').hidden = true;
  } finally {
    if (token === videoState.runToken) { videoState.busy = false; videoState.controller = null; videoState.analyzer = null; videoState.jobPromise = null; renderVideoControls(); }
  }
}

async function clearVideo() {
  if (libraryUI.busy()) return;
  if (!confirmVideoReplace()) return;
  const token = ++videoState.loadToken;
  videoState.loadController?.abort(); videoState.loadController = null;
  await cancelVideoAnalysis('');
  // A newer file selection owns the preview, even while old analysis closes.
  if (token !== videoState.loadToken) return;
  cleanupUploadedVideo(); Object.assign(videoState, { file: null, duration: null, width: 0, height: 0, loading: false, notice: '' });
  $('videoFile').value = ''; $('aiUploadConsent').checked = false; $('geminiKey').value = '';
  resetVideoResult(); renderVideoControls();
}
async function copyVideoResult() {
  if (!videoState.text) return;
  try { await navigator.clipboard.writeText(videoState.text); }
  catch {
    const input = element('textarea'); input.value = videoState.text; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove();
    if (!copied) throw new Error('복사 권한을 사용할 수 없어요. 분석 결과를 선택해서 복사해 주세요.');
  }
  toast('영상 분석 결과를 복사했어요.');
}
function bindVideoEvents() {
  if (!$('videoFile')) return;
  $('videoFile').addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; run(() => selectVideoFile(file)); });
  const video = $('uploadedVideo');
  video.addEventListener('timeupdate', () => {
    if (videoState.reviewRange && video.currentTime >= videoState.reviewRange.end) stopVideoReview();
  });
  video.addEventListener('ended', () => { videoState.reviewRange = null; });
  const dropzone = $('videoDropzone');
  dropzone.tabIndex = 0; dropzone.setAttribute('role', 'button'); dropzone.setAttribute('aria-label', '수어 영상 파일 선택');
  dropzone.addEventListener('keydown', event => { if (['Enter',' '].includes(event.key)) { event.preventDefault(); $('videoFile').click(); } });
  dropzone.addEventListener('dragover', event => { event.preventDefault(); dropzone.classList.add('is-dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
  dropzone.addEventListener('drop', event => { event.preventDefault(); dropzone.classList.remove('is-dragover'); run(() => selectVideoFile(event.dataTransfer?.files?.[0])); });
  $('videoLocalMode').addEventListener('click', () => setVideoMode('local'));
  $('videoAIMode').addEventListener('click', () => setVideoMode('ai'));
  $('geminiKey').addEventListener('input', renderVideoControls); $('aiUploadConsent').addEventListener('change', renderVideoControls);
  $('videoAnalyzeBtn').addEventListener('click', () => run(analyzeVideo));
  $('videoCancelBtn').addEventListener('click', () => run(() => cancelVideoAnalysis()));
  $('videoClearBtn').addEventListener('click', () => run(clearVideo));
  $('videoCopyBtn').addEventListener('click', () => run(copyVideoResult));
  $('videoDownloadBtn').addEventListener('click', () => saveVideoDocument('txt'));
  $('videoJSONBtn').addEventListener('click', () => saveVideoDocument('json'));
  $('videoAddSegment').addEventListener('click', addVideoSegment);
  $('videoReturnToSegment').addEventListener('click', () => {
    const node = [...$('videoSegments').children].find(item => item.dataset.segmentId === String(videoState.selectedSegment));
    node?.querySelector('textarea[aria-label$="구간 한국어 글"]')?.focus();
  });
  resetVideoResult(); renderVideoControls();
}

function bindEvents() {
  libraryUI.bind(); hybridUI.bind(); chatUI.bind(); recorderUI.bind();
  $('liveStartBtn').addEventListener('click', () => run(() => recorderUI.open()));
  $('liveRecordAgain').addEventListener('click', () => run(() => recorderUI.open()));
  $('liveEndBtn').addEventListener('click', endLive);
  bindVideoEvents();
  $('countdownScreen').setAttribute('role', 'dialog');
  $('countdownScreen').setAttribute('aria-modal', 'true');
  $('countdownScreen').setAttribute('aria-label', '촬영 준비 시간');
  document.addEventListener('click', event => {
    const close = event.target.closest('[data-close]');
    if (close) { closeDialog(close.dataset.close); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    run(async () => {
      if (action === 'help') openDialog('helpDialog');
      else if (action === 'add') openAdd();
      else if (action === 'camera') await startCamera();
      else if (action === 'camera-settings') { goTo('settings'); $('mirrorToggle').focus(); }
      else if (action === 'import') $('importFile').click();
      else if (action === 'export') await exportData();
    });
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog(dialog.id); } });
    dialog.addEventListener('cancel', () => { if (dialog.id === 'addDialog') cancelRecordingIntent(true); });
    dialog.addEventListener('close', () => {
      if (dialog.id === 'videoDialog') cleanupVideo();
      if (dialog.id === 'backupDialog') cleanupBackups();
      if (dialog.id === 'deleteDialog') state.deleting = null;
      if (dialog.id === 'addDialog') {
        if (dialog.dataset.accepted === 'true') delete dialog.dataset.accepted;
        else if (state.pendingPermission) cancelRecordingIntent(true);
      }
    });
  });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('recognitionTab').addEventListener('click', () => setTab('recognition'));
  $('trainingTab').addEventListener('click', () => setTab('training'));
  [$('recognitionTab'), $('trainingTab')].forEach(tab => tab.addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'recognition' : event.key === 'End' ? 'training' : state.tab === 'recognition' ? 'training' : 'recognition'; setTab(next, true);
  }));
  $('cameraBtn').addEventListener('click', () => run(() => engine.cameraRunning ? stopCamera() : startCamera()));
  $('recognizeBtn').addEventListener('click', () => {
    if (!engine.samples.length) { toast('먼저 인식할 수어를 등록해 주세요.'); return; }
    engine.setRecognizing(!engine.recognizing); $('liveWord').textContent = ''; renderCamera();
    setCameraStatus(engine.recognizing ? '등록한 동작을 보여 주세요. 같은 단어를 다시 인식하려면 잠시 손을 내려 주세요.' : '인식을 잠시 멈췄어요.', false, true);
  });
  $('demoBtn').addEventListener('click', () => run(() => state.demo ? endDemo() : startDemo()));
  $('demoNext').addEventListener('click', () => {
    if (!state.demo) return;
    state.demoIndex = (state.demoIndex + 1) % DEMO_WORDS.length;
    const word = DEMO_WORDS[state.demoIndex]; state.demoSentence.push(word); state.demoSentence = state.demoSentence.slice(-50);
    $('demoWord').textContent = word; renderSentence();
  });
  $('addForm').addEventListener('submit', event => run(() => prepareRecording(event)));
  $('cancelCountdown').addEventListener('click', () => cancelRecordingIntent());
  $('cancelRecording').addEventListener('click', () => cancelRecordingIntent());
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && recorderUI.active() && $('materialRecorderDialog').classList.contains('is-inline')) {
      event.preventDefault(); recorderUI.close(); return;
    }
    if (event.key === 'Tab' && state.recordPhase === 'countdown') { event.preventDefault(); $('cancelCountdown').focus(); }
    if (event.key === 'Escape' && state.recordPhase && !state.saving) { event.preventDefault(); cancelRecordingIntent(); }
  });
  $('wordSearch').addEventListener('input', renderDictionary);
  $('copySentence').addEventListener('click', () => run(copySentence));
  $('speakSentence').addEventListener('click', () => run(speakSentence));
  $('clearSentence').addEventListener('click', () => {
    if (state.demo) state.demoSentence = []; else { state.sentence = []; state.confidence = null; }
    if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
    $('liveWord').textContent = ''; renderSentence();
  });
  $('confirmDelete').addEventListener('click', () => run(confirmDelete));
  $('importFile').addEventListener('change', event => run(() => importData(event)));
  $('downloadHistory').addEventListener('click', downloadHistory);
  $('mirrorToggle').addEventListener('change', event => { settings.mirror = event.target.checked; saveSettings(); });
  $('landmarkToggle').addEventListener('change', event => { settings.landmarks = event.target.checked; saveSettings(); });
  $('thresholdRange').addEventListener('input', event => { settings.threshold = Math.max(60, Math.min(95, Math.round(Number(event.target.value) || 78))); saveSettings(); });
  $('cameraFacing').addEventListener('change', event => run(async () => {
    if (state.recordPhase || state.saving) { event.target.value = settings.facingMode; return; }
    const wasRunning = engine.cameraRunning;
    settings.facingMode = event.target.value === 'environment' ? 'environment' : 'user'; saveSettings();
    if (wasRunning) { await stopCamera(); await startCamera(); }
  }));
  if ('ResizeObserver' in globalThis) new ResizeObserver(() => { if (state.lastFrame) drawFrame(state.lastFrame); }).observe($('cameraWorkspace'));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && $('uploadedVideo')) {
      $('uploadedVideo').pause();
      if (videoState.busy || videoState.loading) run(() => cancelVideoWork('화면이 보이지 않아 영상 분석을 취소했어요.'));
    }
    if (document.hidden && (engine.cameraRunning || state.cameraBusy || state.recordPhase)) {
      cancelRecordingIntent(true); run(() => engine.stopCamera());
    }
  });
  const cleanup = () => {
    cancelRecordingIntent(false); engine.stopCamera().catch(() => {}); cleanupVideo(); cleanupBackups();
    videoState.loadController?.abort(); cancelVideoAnalysis('').catch(() => {}); cleanupUploadedVideo();
    if ($('geminiKey')) $('geminiKey').value = '';
    if ('speechSynthesis' in globalThis) speechSynthesis.cancel();
  };
  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', event => { if (videoState.dirty || libraryUI.busy() || recorderUI.active()) { event.preventDefault(); event.returnValue = ''; } });
}

async function initialize() {
  bindEvents(); applySettings(); state.history = readHistory();
  renderSentence(); renderHistory(); renderStats(); setTab('recognition'); showView(location.hash.slice(1));
  await store.init(); await refreshSigns(); renderStorage();
  run(() => libraryUI.refresh());
  if (store.mode === 'memory') toast('브라우저 저장이 제한되어 있어요. 새로고침 전에 동작 데이터를 백업해 주세요.', true);
}
initialize().catch(error => {
  setCameraStatus(errorMessage(error), true, true);
  toast(errorMessage(error), true);
});
