// Run: node tests/live-workspace.browser.mjs
// Canvas-only getUserMedia and synthetic local video. Native camera/device discovery and external requests are never used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve(import.meta.dirname, '..'), tmp = await mkdtemp(join(tmpdir(), 'ksl-live-workspace-'));
const fixture = join(tmp, 'synthetic-local-video.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xacc8df:s=320x240:r=8', '-t', '4', '-c:v', 'libvpx', fixture]);
const fixtureBytes = await readFile(fixture);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], external = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    external.push(url); await route.abort();
  });
  await context.addInitScript(() => {
    const mock = globalThis.liveCameraMock = { mode: 'ready', calls: [], streams: [], pending: [], frames: 0 };
    const streamFor = constraints => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d'); let stream, frame = 0;
      const paint = () => {
        ctx.fillStyle = '#aacbe2'; ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#253754'; ctx.font = '26px sans-serif';
        ctx.fillText('SYNTHETIC LIVE CAMERA', 60, 80);
        ctx.fillRect(50 + frame++ % 200, 210, 90, 90); mock.frames++;
        if (!stream || stream.getVideoTracks().some(track => track.readyState === 'live')) requestAnimationFrame(paint);
      };
      paint(); stream = canvas.captureStream(24);
      for (const track of stream.getTracks()) {
        const settings = track.getSettings.bind(track);
        track.getSettings = () => ({ ...settings(), deviceId: constraints.video?.deviceId?.exact || 'synthetic-live-camera' });
      }
      mock.streams.push(stream); return stream;
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async constraints => {
      mock.calls.push(structuredClone(constraints));
      if (mock.mode === 'denied') throw new DOMException('Synthetic permission denial', 'NotAllowedError');
      if (mock.mode === 'pending') return new Promise(resolve => mock.pending.push(() => resolve(streamFor(constraints))));
      return streamFor(constraints);
    } });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [
      { kind: 'videoinput', deviceId: 'synthetic-live-camera', groupId: 'synthetic', label: '합성 Live 카메라' },
    ] });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin + '/');
  await page.waitForFunction(() => globalThis.testUI);
  const calls = () => page.evaluate(() => liveCameraMock.calls.length);
  const stopped = () => page.waitForFunction(() => liveCameraMock.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
  const cameraPhase = async value => {
    await page.waitForFunction(value => [value, 'error'].includes(testUI.recorderUI.state.phase), value);
    assert.equal(await page.evaluate(() => testUI.recorderUI.state.phase), value, await page.locator('#materialRecorderStatus').innerText());
  };
  const navigate = async view => {
    await page.locator(`.nav-item[data-view="${view}"]`).click();
    await page.locator(`#view-${view}`).waitFor({ state: 'visible' });
  };
  const end = async () => {
    await page.locator('#liveEndBtn').click(); await stopped();
    await page.locator('#liveIntro').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  };
  const start = async () => { await page.locator('#liveStartBtn').click(); await cameraPhase('preview'); };
  const capture = async name => {
    await mkdir(join(root, 'dist'), { recursive: true });
    for (const [suffix, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow at ${width}px`);
      for (const item of await page.locator('.nav-item[data-view]').all()) assert.ok((await item.boundingBox()).height >= 44);
      await page.screenshot({ path: join(root, `dist/live-${name}-${suffix}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  assert.equal(await page.locator('#view-live').isVisible(), true);
  assert.equal(await page.locator('#liveIntro').isVisible(), true);
  assert.equal(await page.locator('#liveWorkspace').isHidden(), true);
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  assert.equal(await calls(), 0);
  assert.deepEqual(await page.locator('.nav-item[data-view]').evaluateAll(nodes => nodes.map(node => node.dataset.view)), ['live', 'video', 'library']);
  await capture('home');
  assert.equal(await calls(), 0, 'viewports and rendering must not start a camera');

  // Default, explicit Live, unknown hashes and older deep links are all permission-free.
  for (const [hash, expected] of [['live', 'live'], ['unknown-view', 'live'], ['video', 'video'], ['library', 'library']]) {
    const fresh = await context.newPage();
    fresh.on('pageerror', error => errors.push(error.message));
    await fresh.goto(origin + '/#' + hash);
    await fresh.waitForFunction(() => globalThis.testUI);
    assert.equal(await fresh.locator('#view-' + expected).isVisible(), true, `deep link #${hash}`);
    assert.equal(await fresh.evaluate(() => liveCameraMock.calls.length), 0);
    await fresh.close();
  }
  await page.bringToFront();
  await page.evaluate(async () => {
    await testUI.store.saveSample('Live 개편 이전 사전', { id: 'live-ui-preservation', featureVersion: 2, duration: 2, frames: Array.from({ length: 24 }, () => Array(136).fill(.2)) });
  });
  const dictionaryBefore = await page.evaluate(async () => JSON.stringify(await testUI.store.list()));
  await navigate('video'); await navigate('library'); await navigate('live');
  assert.equal(await calls(), 0, 'tab navigation alone must not request media');

  await page.evaluate(() => { liveCameraMock.mode = 'denied'; });
  await page.locator('#liveStartBtn').click(); await cameraPhase('error');
  assert.match(await page.locator('#materialRecorderStatus').innerText(), /권한|허용/);
  assert.equal(await calls(), 1);
  await capture('permission-error');
  await page.locator('#materialRecorderDialog summary').focus();
  await page.keyboard.press('Escape'); await stopped();
  await page.locator('#liveIntro').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'liveStartBtn', 'Escape after permission denial must focus the visible start button');
  await page.evaluate(() => { liveCameraMock.mode = 'ready'; });
  const beforeDouble = await calls();
  await page.evaluate(() => { const button = document.getElementById('liveStartBtn'); button.click(); button.click(); });
  await cameraPhase('preview');
  assert.equal(await calls(), beforeDouble + 1, 'double start must open one stream');
  assert.equal(await page.locator('#liveIntro').isHidden(), true);
  assert.equal(await page.locator('#liveWorkspace').isVisible(), true);
  assert.equal(await page.locator('#materialRecorderDialog').evaluate(dialog => dialog.open && dialog.classList.contains('is-inline') && !dialog.matches(':modal')), true);
  assert.equal(await page.locator('#videoWorkspace').isHidden(), true);
  await capture('camera');
  await navigate('video'); await stopped();
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  assert.equal(await page.locator('#videoEditorHost > #videoWorkspace').count(), 1);
  const afterTab = await calls(); await navigate('live');
  assert.equal(await page.locator('#liveIntro').isVisible(), true);
  assert.equal(await calls(), afterTab, 'returning to Live must not resume camera automatically');

  // Permission may complete after Cancel or after leaving the tab. Stop that late stream immediately.
  for (const leave of ['cancel', 'tab']) {
    await page.evaluate(() => { liveCameraMock.mode = 'pending'; });
    await page.locator('#liveStartBtn').click(); await cameraPhase('requesting');
    await page.waitForFunction(() => liveCameraMock.pending.length === 1);
    if (leave === 'cancel') await end();
    else await navigate('library');
    await page.evaluate(() => { liveCameraMock.pending.shift()(); liveCameraMock.mode = 'ready'; });
    await stopped();
    assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
    const count = await calls();
    if (leave === 'tab') await navigate('live');
    assert.equal(await page.locator('#liveIntro').isVisible(), true);
    assert.equal(await calls(), count);
  }
  await navigate('video'); await navigate('live'); await start();
  const beforeHistory = await calls();
  await page.goBack(); await page.locator('#view-video').waitFor({ state: 'visible' }); await stopped();
  await page.goForward(); await page.locator('#view-live').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#liveIntro').isVisible(), true);
  assert.equal(await calls(), beforeHistory, 'history forward must not restart a previously active camera');

  // An accepted Live recording opens the editor; cancelling a retake keeps that same work.
  await start();
  await page.locator('#materialRecordStart').click(); await cameraPhase('recording');
  await page.waitForTimeout(1100);
  await page.locator('#materialRecordStop').click(); await cameraPhase('ready'); await stopped();
  await page.locator('#materialRecordUse').click();
  await page.locator('#liveEditSlot > #videoWorkspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  await page.getByRole('textbox', { name: '1번 구간 직역', exact: true }).fill('Live 합성 녹화 주석');
  await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('재촬영을 취소해도 유지할 문장');
  await page.evaluate(() => { globalThis.liveAcceptedNode = document.getElementById('videoWorkspace'); });
  const acceptedDraft = await page.evaluate(() => JSON.stringify(testUI.videoState.document));
  assert.equal(await page.locator('#videoDropzone').isVisible(), false, 'Live uses its existing next-recording action');
  assert.equal(await page.locator('#materialRecordBtn').isVisible(), false);
  assert.equal(await page.locator('#videoAnalyzeBtn').innerText(), '전송 내용 확인');

  // The chat settings shortcut must reveal the AI key even after selecting local analysis.
  await page.locator('.analysis-settings > summary').click();
  await page.locator('#videoLocalMode').click();
  assert.equal(await page.locator('#aiConnection').isVisible(), false);
  await page.locator('#chatSettingsBtn').click();
  assert.equal(await page.locator('#aiConnection').isVisible(), true);
  assert.equal(await page.locator('.analysis-settings').evaluate(node => node.open), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'geminiKey');
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), acceptedDraft);
  assert.deepEqual(external, [], 'opening AI settings must not send any request');
  await page.locator('.analysis-settings > summary').click();
  await page.locator('#uploadedVideo').evaluate(async video => { await video.play(); video.pause(); });
  await capture('accepted-editor');
  await page.locator('#liveRecordAgain').click(); await cameraPhase('preview');
  await page.locator('#materialRecordClose').click(); await stopped();
  await page.locator('#liveEditSlot > #videoWorkspace').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), acceptedDraft);
  assert.equal(await page.evaluate(() => document.getElementById('videoWorkspace') === globalThis.liveAcceptedNode), true);
  await page.locator('#liveRecordAgain').click(); await cameraPhase('preview');
  await page.locator('#materialRecorderDialog summary').focus();
  await page.keyboard.press('Escape'); await stopped();
  await page.locator('#liveEditSlot > #videoWorkspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#materialRecorderDialog').isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'liveRecordAgain', 'Escape after retaking must focus the visible next-recording button');
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), acceptedDraft);
  assert.equal(await page.evaluate(() => document.getElementById('videoWorkspace') === globalThis.liveAcceptedNode), true);
  await end();

  // The editing workspace is moved, not copied; saved and unsaved annotations survive all three tabs.
  await navigate('video');
  await page.locator('#videoFile').setInputFiles(fixture);
  await page.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading && testUI.videoState.duration > 0);
  await page.locator('#videoAddSegment').click();
  await page.getByRole('textbox', { name: '1번 구간 직역', exact: true }).fill('보존할 합성 직역');
  await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('자료실에 저장한 검증용 문장');
  await page.getByText('상황·지시 대상·불확실성 기록', { exact: true }).click();
  await page.getByRole('textbox', { name: '1번 구간 상황·문맥', exact: true }).fill('탭 개편 데이터 보존 검사');
  await page.locator('#personalTitle').fill('세 탭 개편 보존 자료');
  await page.locator('#personalSaveBtn').click();
  await page.waitForFunction(() => !testUI.libraryUI.busy() && !testUI.videoState.dirty);
  const savedId = await page.evaluate(async () => (await testUI.personalLibrary.list())[0].id);
  const stored = await page.evaluate(id => testUI.personalLibrary.get(id), savedId);
  await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('탭을 옮겨도 남아야 하는 작성 중 문장');
  await page.evaluate(() => { globalThis.originalEditorNode = document.getElementById('videoWorkspace'); });
  const draft = await page.evaluate(() => JSON.stringify(testUI.videoState.document));
  await navigate('live');
  assert.equal(await page.locator('#liveDraftLink').isVisible(), true);
  assert.equal(await page.locator('#liveWorkspace').isHidden(), true);
  const beforeDraftLink = await calls();
  await page.locator('#liveDraftLink').click();
  await page.locator('#view-video').waitFor({ state: 'visible' });
  assert.equal(await calls(), beforeDraftLink, 'continuing an existing draft must only navigate to Video');
  assert.equal(await page.locator('#videoEditorHost > #videoWorkspace').count(), 1);
  assert.equal(await page.evaluate(() => document.getElementById('videoWorkspace') === globalThis.originalEditorNode), true);
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).inputValue(), '탭을 옮겨도 남아야 하는 작성 중 문장');
  await navigate('live'); await start();
  await page.locator('#materialRecordClose').click(); await stopped();
  await page.locator('#liveIntro').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#liveWorkspace').isHidden(), true, 'existing draft must not open Live editor without accepting a Live recording');
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), draft);
  await navigate('library');
  await page.locator(`[data-library-id="${savedId}"]`).waitFor({ state: 'visible' });
  assert.equal(await page.locator(`[data-library-id="${savedId}"]`).count(), 1);
  await capture('library');
  await navigate('video');
  assert.equal(await page.locator('#videoEditorHost > #videoWorkspace').count(), 1);
  assert.equal(await page.evaluate(() => document.getElementById('videoWorkspace') === globalThis.originalEditorNode), true);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), draft);
  assert.deepEqual(Buffer.from(await page.evaluate(async () => [...new Uint8Array(await testUI.videoState.file.arrayBuffer())])), fixtureBytes);
  const unchanged = await page.evaluate(id => testUI.personalLibrary.get(id), savedId);
  assert.equal(unchanged.sha256, stored.sha256); assert.deepEqual(unchanged.document, stored.document);
  assert.equal(await page.evaluate(async () => JSON.stringify(await testUI.store.list())), dictionaryBefore);
  assert.equal(await page.evaluate(() => liveCameraMock.calls.every(call => call.audio === false)), true);
  await stopped();

  await page.goto(origin + '/#library'); await page.reload();
  await page.waitForFunction(() => globalThis.testUI);
  await page.locator(`[data-library-id="${savedId}"]`).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => !testUI.libraryUI.busy() && testUI.videoState.file && !testUI.videoState.loading);
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).inputValue(), '자료실에 저장한 검증용 문장');
  assert.equal(await page.getByRole('textbox', { name: '1번 구간 직역', exact: true }).inputValue(), '보존할 합성 직역');
  assert.equal(await calls(), 0, 'opening an old library record after reload must not request camera access');
  assert.equal(await page.evaluate(async () => JSON.stringify(await testUI.store.list())), dictionaryBefore);
  assert.deepEqual(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(node => node.id); return ids.filter((id, i) => ids.indexOf(id) !== i); }), []);

  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('PASS: no-hash/Live default and old deep links without camera access, exactly three tabs, CTA-only camera request, double-click guard, denial and late-permission cancellation, Escape returns focus to the visible start/next-recording button, tab/back/forward track cleanup with no automatic restart, accepted Live recording and cancelled-retake editor retention, local-mode chat settings reveals and focuses AI key without modifying the document or sending requests, camera-free draft link, same editor node and draft preservation, saved library/dictionary persistence and exact video bytes, audio:false, PC/390px/320px overflow and screenshots. Synthetic streams only; external requests blocked.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true });
}
