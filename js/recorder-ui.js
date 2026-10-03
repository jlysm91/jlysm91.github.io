import { createVideoRecorder } from './video-recorder.js';

// A camera recording remains local until the user explicitly accepts it for editing.
export function createRecorderUI(hooks) {
  const $ = id => document.getElementById(id);
  let recorder, latest = { phase: 'idle', devices: [], elapsed: 0 }, reviewURL = null, reviewedFile = null, accepting = false, intent = 0;
  const active = () => $('materialRecorderDialog').open;
  function releaseReview() {
    if (reviewURL) URL.revokeObjectURL(reviewURL);
    reviewURL = null; reviewedFile = null;
  }
  function render() {
    const phase = latest.phase, review = phase === 'ready' && latest.result;
    const live = ['preview', 'recording'].includes(phase);
    const working = ['requesting', 'stopping'].includes(phase) || accepting;
    $('materialRecorderVideo').classList.toggle('mirror', live && $('materialMirror').checked);
    $('materialFrameGuide').hidden = !live;
    $('materialMirror').disabled = !live;
    $('materialCameraSelect').disabled = phase !== 'preview' || accepting;
    $('materialRecordStart').hidden = phase !== 'preview';
    $('materialRecordStart').disabled = working;
    $('materialRecordStop').hidden = !['recording', 'stopping'].includes(phase);
    $('materialRecordStop').disabled = phase !== 'recording';
    $('materialRecordRetake').hidden = !review && phase !== 'error';
    $('materialRecordRetake').disabled = working;
    $('materialRecordUse').hidden = !review;
    $('materialRecordUse').disabled = working;
    $('materialRecordClose').textContent = accepting ? '불러오기 취소' : '취소 · 카메라 끄기';
    const messages = {
      idle: '카메라가 꺼져 있습니다.', requesting: '카메라 권한과 연결을 기다리고 있어요. 마이크는 요청하지 않습니다.',
      preview: '준비되면 녹화 시작을 누르세요. 아직 녹화하지 않습니다.',
      recording: `녹화 중 · ${Math.floor(latest.elapsed || 0)} / 60초 · 마이크 없음`,
      stopping: '카메라를 끄고 녹화 파일을 확인하고 있어요…',
      ready: `촬영 완료 · ${(latest.result?.duration || 0).toFixed(1)}초 · ${latest.result?.file.type || ''} · 카메라 꺼짐. 원본 방향으로 재생해 확인하세요.`,
      error: latest.error || '녹화를 마치지 못했어요. 다시 시도하거나 영상 파일을 선택해 주세요.',
    };
    $('materialRecorderStatus').textContent = accepting ? '녹화 영상을 편집 화면으로 불러오고 있어요…' : messages[phase];
    $('materialRecorderStatus').classList.toggle('is-error', phase === 'error');
    const select = $('materialCameraSelect');
    const devices = latest.devices || [];
    const deviceStamp = JSON.stringify({ devices, current: latest.deviceId });
    if (select.dataset.devices !== deviceStamp) {
      select.replaceChildren(new Option('기본 전면 카메라', ''));
      devices.forEach((device, index) => select.append(new Option(device.label || `카메라 ${index + 1}`, device.deviceId)));
      if (latest.deviceId && !devices.some(device => device.deviceId === latest.deviceId)) select.append(new Option('현재 사용 중인 카메라', latest.deviceId));
      select.dataset.devices = deviceStamp;
    }
    select.value = latest.deviceId || '';
    update();
  }
  function receive(state) {
    latest = state;
    if (state.phase === 'ready' && state.result && active() && reviewedFile !== state.result.file) {
      releaseReview(); reviewedFile = state.result.file;
      const video = $('materialRecorderVideo'); video.srcObject = null;
      reviewURL = URL.createObjectURL(reviewedFile); video.src = reviewURL;
      video.controls = true; video.autoplay = false; video.muted = true; video.load();
    }
    render(); hooks.controls();
  }
  function update() {
    const state = hooks.state();
    $('materialRecordBtn').disabled = active() || state.busy || state.canceling || state.loading || hooks.libraryBusy();
  }
  async function open() {
    const state = hooks.state();
    if (active() || state.busy || state.canceling || state.loading || hooks.libraryBusy()) return;
    const token = ++intent;
    $('materialRecorderDialog').showModal(); render();
    try {
      await hooks.beforeOpen();
      if (token !== intent || !active()) return;
      const video = $('materialRecorderVideo'); video.controls = false; video.autoplay = true; video.muted = true;
      await recorder.open();
    } catch (error) { if (token === intent && active() && error.name !== 'AbortError') receive({ ...latest, phase: 'error', error: error.message }); }
  }
  function close(message = '') {
    ++intent;
    if (accepting) hooks.cancelLoad();
    accepting = false; recorder?.close();
    const video = $('materialRecorderVideo'); video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
    releaseReview();
    if (active()) $('materialRecorderDialog').close();
    if (message) hooks.notice(message);
    update(); hooks.controls();
  }
  async function reopen(deviceId = '') {
    if (accepting || !active() || ['recording', 'stopping', 'requesting'].includes(latest.phase)) return;
    releaseReview();
    const video = $('materialRecorderVideo'); video.pause(); video.removeAttribute('src'); video.controls = false; video.autoplay = true;
    await recorder.open(deviceId);
  }
  async function use() {
    if (accepting || latest.phase !== 'ready' || !latest.result || !hooks.confirmReplace()) return;
    const result = latest.result, token = intent; accepting = true; render();
    try {
      const accepted = await hooks.accept(result);
      if (token !== intent) return;
      accepting = false;
      if (accepted) { close(); hooks.focusEditor(); }
      else { render(); hooks.notice('촬영한 영상을 열지 못했어요. 다시 촬영하거나 다른 파일을 선택해 주세요.'); }
    } catch (error) { if (token === intent) { accepting = false; render(); hooks.notice(error.message); } }
  }
  function bind() {
    recorder = createVideoRecorder({ video: $('materialRecorderVideo'), onState: receive });
    const run = work => Promise.resolve().then(work).catch(error => { if (active() && error.name !== 'AbortError') receive({ ...latest, phase: 'error', error: error.message }); });
    $('materialRecordBtn').addEventListener('click', () => run(open));
    $('materialRecordStart').addEventListener('click', () => run(() => recorder.start()));
    $('materialRecordStop').addEventListener('click', () => run(() => recorder.stop()));
    $('materialRecordRetake').addEventListener('click', () => run(() => reopen($('materialCameraSelect').value)));
    $('materialCameraSelect').addEventListener('change', event => run(() => reopen(event.target.value)));
    $('materialMirror').addEventListener('change', render);
    $('materialRecordUse').addEventListener('click', () => run(use));
    $('materialRecordClose').addEventListener('click', () => close());
    $('materialRecorderDialog').addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && active()) close('다른 탭으로 이동해 카메라를 끄고 촬영을 취소했어요. 기존 자료는 유지합니다.'); });
    window.addEventListener('pagehide', () => close());
    render();
  }
  return { bind, open, close, update, active, get state() { return latest; } };
}
