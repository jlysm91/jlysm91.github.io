// Run: node tests/video-recorder.browser.mjs
// getUserMedia/enumerateDevices are replaced before application code runs. No real device is accessed.
// Native MediaRecorder encodes an animated canvas; the resulting file uses the real media decoder and IndexedDB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve(import.meta.dirname, '..');
const hook = '\nglobalThis.testUI = { videoState, personalLibrary, libraryUI, recorderUI, store };';
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html'));
  if (!path.startsWith(root + '/')) return res.writeHead(403).end();
  try {
    let body = await readFile(path);
    if (path === join(root, 'js/app.js')) body = Buffer.from(body.toString() + hook);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(path)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  const external = [], errors = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    external.push(url); await route.abort();
  });
  const installSyntheticCamera = () => {
    const mock = globalThis.syntheticCamera = { mode: 'ready', calls: [], streams: [], pending: [], stopCalls: 0, frames: 0, enumerations: 0 };
    const makeStream = constraints => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); let frame = 0;
      const paint = () => {
        const rear = constraints.video?.deviceId?.exact === 'synthetic-rear';
        ctx.fillStyle = rear ? '#c9d7a7' : '#a8c6e3'; ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#223456'; ctx.font = '26px sans-serif';
        ctx.fillText('SYNTHETIC CAMERA · NO KSL', 55, 70);
        ctx.fillRect(40 + frame++ % 180, 180, 110, 100);
        mock.frames++;
        if (!stream || stream.getVideoTracks().some(track => track.readyState === 'live')) requestAnimationFrame(paint);
      };
      let stream; paint(); stream = canvas.captureStream(24);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track), settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: constraints.video?.deviceId?.exact || 'synthetic-front' });
        track.stop = () => { mock.stopCalls++; stop(); };
      }
      mock.streams.push(stream); return stream;
    };
    // Never call or retain native getUserMedia/enumerateDevices.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      mock.calls.push(structuredClone(constraints));
      if (mock.mode === 'denied') throw new DOMException('Synthetic permission denial', 'NotAllowedError');
      if (mock.mode === 'unavailable') throw new DOMException('Synthetic missing camera', 'NotFoundError');
      if (mock.mode === 'pending') return new Promise(resolve => mock.pending.push(() => resolve(makeStream(constraints))));
      return makeStream(constraints);
    } });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => {
      mock.enumerations++;
      return [
        { kind: 'videoinput', deviceId: 'synthetic-front', groupId: 'synthetic', label: '합성 카메라 앞' },
        { kind: 'videoinput', deviceId: 'synthetic-rear', groupId: 'synthetic', label: '합성 카메라 뒤' },
      ];
    } });
    if (location.search.includes('unsupported-recorder')) {
      globalThis.MediaRecorder.isTypeSupported = () => false;
    } else if (location.search.includes('webm-recorder')) {
      const supported = globalThis.MediaRecorder.isTypeSupported.bind(globalThis.MediaRecorder);
      globalThis.MediaRecorder.isTypeSupported = type => type.startsWith('video/webm') && supported(type);
    }
  };
  await context.addInitScript(installSyntheticCamera);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let acceptDialog = true;
  page.on('dialog', dialog => acceptDialog ? dialog.accept() : dialog.dismiss());
  await page.goto(origin + '/');
  await page.waitForFunction(() => globalThis.testUI);
  const phase = async value => {
    await page.waitForFunction(value => [value, 'error'].includes(testUI.recorderUI.state.phase), value);
    assert.equal(await page.evaluate(() => testUI.recorderUI.state.phase), value, await page.locator('#materialRecorderStatus').innerText());
  };
  const noLiveTracks = async () => {
    await page.waitForFunction(() => syntheticCamera.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
  };
  const open = async () => { await page.locator('#materialRecordBtn').click(); await phase('preview'); };
  const close = async () => {
    await page.locator('#materialRecordClose').click();
    await page.locator('#materialRecorderDialog').waitFor({ state: 'hidden' }); await noLiveTracks();
  };
  const record = async () => {
    await page.locator('#materialRecordStart').click(); await phase('recording');
    // Real wall-clock recording time gives the native encoder enough frames to finalize a playable file.
    await page.waitForTimeout(1100);
    await page.locator('#materialRecordStop').click(); await phase('ready');
    await noLiveTracks();
    await page.waitForFunction(() => {
      const video = document.getElementById('materialRecorderVideo');
      return Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth > 0;
    });
  };
  const capture = async name => {
    await mkdir(join(root, 'dist'), { recursive: true });
    if (name === 'annotation') await page.locator('#uploadedVideo').evaluate(async video => { await video.play(); video.pause(); });
    for (const [suffix, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow at ${width}px`);
      const dialogOpen = await page.locator('#materialRecorderDialog').evaluate(dialog => dialog.open);
      if (dialogOpen) {
        await page.locator('#materialRecorderDialog').evaluate(dialog => { dialog.scrollTop = 0; });
        assert.equal(await page.locator('#materialRecorderDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
        for (const button of await page.locator('#materialRecorderDialog > .personal-actions button').all()) {
          if (!await button.isVisible()) continue;
          const box = await button.boundingBox();
          assert.ok(box.height >= 44 && box.y >= 0 && box.y + box.height <= height, `${name} camera action must stay visible at ${width}px`);
        }
      }
      await page.screenshot({ path: join(root, `dist/recorder-${name}-${suffix}.png`), fullPage: !dialogOpen });
      if (dialogOpen && ['camera', 'recorded'].includes(name)) {
        await page.locator('#materialRecordClose').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, `dist/recorder-${name}-actions-${suffix}.png`), fullPage: false });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  await page.evaluate(async () => {
    await testUI.store.saveSample('기존 사전 유지', { id: 'recorder-regression', featureVersion: 2, duration: 2, frames: Array.from({ length: 24 }, () => Array(136).fill(.2)) });
  });
  const dictionaryBefore = await page.evaluate(async () => JSON.stringify(await testUI.store.list()));
  assert.equal(await page.evaluate(() => syntheticCamera.calls.length), 0, 'initialization must not request camera access');

  await page.evaluate(() => { syntheticCamera.mode = 'denied'; });
  await page.locator('#materialRecordBtn').click(); await phase('error');
  assert.match(await page.locator('#materialRecorderStatus').innerText(), /권한|허용/);
  await capture('permission-error'); await close();
  await page.evaluate(() => { syntheticCamera.mode = 'unavailable'; });
  await page.locator('#materialRecordBtn').click(); await phase('error');
  assert.match(await page.locator('#materialRecorderStatus').innerText(), /카메라/);
  await close();

  // A late permission grant after cancellation must stop its tracks and leave the dialog closed.
  await page.evaluate(() => { syntheticCamera.mode = 'pending'; });
  const beforeDouble = await page.evaluate(() => syntheticCamera.calls.length);
  await page.evaluate(() => { const button = document.getElementById('materialRecordBtn'); button.click(); button.click(); });
  await phase('requesting');
  await page.waitForFunction(() => syntheticCamera.pending.length === 1);
  assert.equal(await page.evaluate(() => syntheticCamera.calls.length), beforeDouble + 1);
  await page.locator('#materialRecordClose').click();
  await page.evaluate(() => { syntheticCamera.pending.shift()(); syntheticCamera.mode = 'ready'; });
  await noLiveTracks();
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  assert.equal(await page.evaluate(() => testUI.videoState.file), null);

  await open();
  assert.equal(await page.locator('#materialRecordStart').isVisible(), true);
  assert.equal(await page.evaluate(() => syntheticCamera.streams.at(-1).getAudioTracks().length), 0);
  await page.locator('#materialMirror').check();
  assert.equal(await page.locator('#materialRecorderVideo').evaluate(video => video.classList.contains('mirror')), true);
  await capture('camera');
  const countBeforeSwitch = await page.evaluate(() => syntheticCamera.calls.length);
  await page.locator('#materialCameraSelect').selectOption('synthetic-rear'); await phase('preview');
  await page.waitForFunction(count => syntheticCamera.calls.length === count + 1, countBeforeSwitch);
  assert.equal(await page.evaluate(() => syntheticCamera.calls.at(-1).video.deviceId.exact), 'synthetic-rear');
  assert.equal(await page.evaluate(() => syntheticCamera.streams.slice(0, -1).every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
  await page.evaluate(() => { const button = document.getElementById('materialRecordStart'); button.click(); button.click(); });
  await phase('recording');
  assert.equal(await page.locator('#materialCameraSelect').isDisabled(), true);
  await page.waitForTimeout(1100);
  await page.evaluate(() => { const button = document.getElementById('materialRecordStop'); button.click(); button.click(); });
  await phase('ready'); await noLiveTracks();
  await page.waitForFunction(() => Number.isFinite(document.getElementById('materialRecorderVideo').duration) && document.getElementById('materialRecorderVideo').duration > 0);
  assert.equal(await page.locator('#materialRecorderVideo').evaluate(video => video.classList.contains('mirror')), false, 'saved preview must use original orientation');
  assert.equal(await page.evaluate(() => testUI.recorderUI.state.result.mirrored), false);
  const firstFile = await page.evaluate(() => ({ name: testUI.recorderUI.state.result.file.name, size: testUI.recorderUI.state.result.file.size, duration: testUI.recorderUI.state.result.duration }));
  assert.ok(firstFile.size > 0); assert.ok(firstFile.duration > 0 && firstFile.duration <= 60);
  await page.locator('#materialRecorderVideo').evaluate(async video => { await video.play(); video.pause(); });
  await capture('recorded');
  await page.locator('#materialRecordRetake').click(); await phase('preview');
  assert.equal(await page.locator('#materialRecordUse').isHidden(), true);
  await record();
  await page.locator('#materialRecordUse').click();
  await page.locator('#materialRecorderDialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading && testUI.videoState.document?.segments.length === 1);
  await noLiveTracks();
  assert.equal(await page.evaluate(() => testUI.videoState.document.source), 'manual');
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 직역', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).inputValue(), '');
  assert.equal(await page.locator('#geminiKey').inputValue(), '');
  assert.ok(await page.locator('#personalTitle').inputValue());
  const nativeVideo = await page.evaluate(async () => ({
    bytes: [...new Uint8Array(await testUI.videoState.file.arrayBuffer())],
    duration: testUI.videoState.duration, type: testUI.videoState.file.type,
  }));
  assert.ok(Number.isFinite(nativeVideo.duration) && nativeVideo.duration > 0 && nativeVideo.duration <= 60);
  assert.match(nativeVideo.type, /^video\/(webm|mp4)/);
  const existingRecord = await page.evaluate(async () => {
    const doc = structuredClone(testUI.videoState.document);
    Object.assign(doc.segments[0], { text: '이전 자료 보존 확인', literal: '이전 자료', reviewed: true });
    const saved = await testUI.personalLibrary.save({ title: '보존할 기존 영상 자료', role: 'reference', captureDay: '2026-10-01', session: 'previous-session', fileName: testUI.videoState.file.name, video: testUI.videoState.file, document: doc });
    return { id: saved.id, sha256: saved.sha256, document: saved.document };
  });
  await page.getByRole('textbox', { name: '1번 구간 직역', exact: true }).fill('합성 녹화 자료 직역 검증');
  await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('카메라 녹화본에 직접 작성한 검증용 문장입니다.');
  await page.getByText('상황·지시 대상·불확실성 기록', { exact: true }).click();
  await page.getByRole('textbox', { name: '1번 구간 상황·문맥', exact: true }).fill('실제 수어가 없는 합성 카메라 테스트');
  await page.getByRole('textbox', { name: '1번 구간 불확실한 부분', exact: true }).fill('한국수어 성능은 검증하지 않음');
  await page.locator('#personalTitle').fill('직접 녹화 · 합성 검증 자료');
  await capture('annotation');
  await page.locator('#personalSaveBtn').click();
  await page.waitForFunction(() => !testUI.libraryUI.busy() && !testUI.videoState.dirty);
  const records = await page.evaluate(() => testUI.personalLibrary.list());
  assert.equal(records.length, 2);
  const recordedId = records.find(record => record.title === '직접 녹화 · 합성 검증 자료').id;
  assert.equal(await page.evaluate(() => syntheticCamera.calls.every(call => call.audio === false)), true);
  await page.reload(); await page.waitForFunction(() => globalThis.testUI);
  await page.evaluate(id => testUI.libraryUI.openRecord(id), recordedId);
  await page.waitForFunction(() => !testUI.libraryUI.busy() && testUI.videoState.file && !testUI.videoState.loading);
  assert.deepEqual(await page.evaluate(async () => [...new Uint8Array(await testUI.videoState.file.arrayBuffer())]), nativeVideo.bytes, 'reopened recording must preserve its exact bytes');
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 직역', exact: true }).inputValue(), '합성 녹화 자료 직역 검증');
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).inputValue(), '카메라 녹화본에 직접 작성한 검증용 문장입니다.');
  assert.ok(await page.locator('#uploadedVideo').evaluate(video => Number.isFinite(video.duration) && video.duration > 0));
  assert.equal(await page.evaluate(async () => JSON.stringify(await testUI.store.list())), dictionaryBefore);
  const oldRecord = await page.evaluate(id => testUI.personalLibrary.get(id), existingRecord.id);
  assert.equal(oldRecord.sha256, existingRecord.sha256); assert.deepEqual(oldRecord.document, existingRecord.document);

  // Opening/cancelling/retaking never discards edits. Only Use asks to replace them.
  await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('새 녹화를 취소해도 보존할 작성 중 문장');
  const draft = await page.evaluate(() => JSON.stringify(testUI.videoState.document));
  await open(); await close();
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), draft);
  await open(); await record();
  acceptDialog = false;
  await page.locator('#materialRecordUse').click();
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), true);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), draft);
  acceptDialog = true;
  await page.locator('#materialRecordRetake').click(); await phase('preview');
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), draft);
  await close();

  // Camera loss and background/navigation close every track, without adopting a partial recording.
  await open();
  await page.evaluate(() => { const track = syntheticCamera.streams.at(-1).getVideoTracks()[0]; track.stop(); track.dispatchEvent(new Event('ended')); });
  await noLiveTracks();
  await close();
  await open(); await page.locator('#materialRecordStart').click(); await phase('recording');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
  });
  await page.locator('#materialRecorderDialog').waitFor({ state: 'hidden' }); await noLiveTracks();
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), draft);
  await page.locator('[data-view="library"]').click();
  await page.locator('[data-view="video"]').click();
  await open(); await page.goBack();
  await page.locator('#materialRecorderDialog').waitFor({ state: 'hidden' }); await noLiveTracks();
  assert.equal(await page.locator('#view-library').isVisible(), true);
  await page.locator('[data-view="video"]').click();
  await open();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await noLiveTracks();
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  assert.equal(await page.evaluate(() => syntheticCamera.calls.every(call => call.audio === false)), true);

  // Exercise the real WebM encoder and durable Duration repair separately from preferred MP4.
  const webmContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await webmContext.addInitScript(installSyntheticCamera);
  await webmContext.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    external.push(url); await route.abort();
  });
  const webm = await webmContext.newPage();
  webm.on('pageerror', error => errors.push(error.message));
  webm.on('dialog', dialog => dialog.accept());
  await webm.goto(origin + '/?webm-recorder'); await webm.waitForFunction(() => globalThis.testUI);
  await webm.locator('#materialRecordBtn').click();
  await webm.waitForFunction(() => testUI.recorderUI.state.phase === 'preview');
  await webm.locator('#materialRecordStart').click();
  await webm.waitForFunction(() => testUI.recorderUI.state.phase === 'recording');
  await webm.waitForTimeout(1100);
  await webm.locator('#materialRecordStop').click();
  await webm.waitForFunction(() => ['ready', 'error'].includes(testUI.recorderUI.state.phase));
  assert.equal(await webm.evaluate(() => testUI.recorderUI.state.phase), 'ready', await webm.locator('#materialRecorderStatus').innerText());
  assert.equal(await webm.evaluate(() => testUI.recorderUI.state.result.file.type), 'video/webm');
  await webm.waitForFunction(() => Number.isFinite(document.getElementById('materialRecorderVideo').duration) && document.getElementById('materialRecorderVideo').duration > 0);
  assert.equal(await webm.evaluate(() => syntheticCamera.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
  await webm.locator('#materialRecordUse').click();
  await webm.locator('#materialRecorderDialog').waitFor({ state: 'hidden' });
  await webm.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading && testUI.videoState.document?.segments.length === 1);
  const webmBytes = await webm.evaluate(async () => [...new Uint8Array(await testUI.videoState.file.arrayBuffer())]);
  await webm.getByRole('textbox', { name: '1번 구간 직역', exact: true }).fill('WebM 합성 녹화 검증');
  await webm.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('WebM 녹화 파일의 재접속 보관을 확인합니다.');
  await webm.locator('#personalTitle').fill('WebM 재생·저장 검증');
  await webm.locator('#personalSaveBtn').click();
  await webm.waitForFunction(() => !testUI.libraryUI.busy() && !testUI.videoState.dirty);
  const webmId = await webm.evaluate(async () => (await testUI.personalLibrary.list())[0].id);
  assert.equal(await webm.evaluate(() => syntheticCamera.calls.every(call => call.audio === false)), true);
  await webm.reload(); await webm.waitForFunction(() => globalThis.testUI);
  await webm.evaluate(id => testUI.libraryUI.openRecord(id), webmId);
  await webm.waitForFunction(() => !testUI.libraryUI.busy() && testUI.videoState.file && !testUI.videoState.loading);
  assert.equal(await webm.evaluate(() => testUI.videoState.file.type), 'video/webm');
  assert.deepEqual(await webm.evaluate(async () => [...new Uint8Array(await testUI.videoState.file.arrayBuffer())]), webmBytes);
  assert.ok(await webm.locator('#uploadedVideo').evaluate(video => Number.isFinite(video.duration) && video.duration > 0));
  await webm.locator('#uploadedVideo').evaluate(async video => { await video.play(); video.pause(); });
  await webmContext.close();

  const unsupported = await context.newPage();
  unsupported.on('pageerror', error => errors.push(error.message));
  await unsupported.goto(origin + '/?unsupported-recorder');
  await unsupported.waitForFunction(() => globalThis.testUI);
  await unsupported.locator('#materialRecordBtn').click();
  await unsupported.waitForFunction(() => testUI.recorderUI.state.phase === 'error');
  assert.match(await unsupported.locator('#materialRecorderStatus').innerText(), /지원|녹화|형식/);
  assert.equal(await unsupported.evaluate(() => syntheticCamera.calls.length), 0, 'unsupported recording must not request a camera');
  await unsupported.close();

  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(`PASS: synthetic-only camera permission denial/unavailability, pending cancellation and late-track cleanup, repeated open/start/stop, device switch, preview-only mirror, native preferred ${nativeVideo.type} and forced video/webm finite playback and exact-video IndexedDB save/reload, retake/use, literal/natural/context authoring, old library/dictionary retention, discard rejection, track-ended/background/back/pagehide cleanup, unsupported codec without permission request, audio:false, PC/390px/320px screenshots. No real devices or external AI used.`);
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
