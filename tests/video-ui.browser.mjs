// Run with Playwright and Chromium installed: node tests/video-ui.browser.mjs
// Uses a generated color clip, synthetic hand data and intercepted API responses only.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
execFileSync('python3', [join(root, 'scripts/build-preview.py')]);
const tmp = await mkdtemp(join(tmpdir(), 'sign-video-ui-'));
const fixture = join(tmp, 'sample.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xebe6f5:s=320x240:r=8', '-t', '4', '-c:v', 'libvpx', fixture]);
const hook = `\nglobalThis.testUI = { videoState, state, store, refreshSigns, selectVideoFile, clearVideo, analyzeVideo, cancelVideoAnalysis, renderVideoResult, setVideoMode, showView };`;
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + new URL(req.url, 'http://local').pathname.replace(/\/$/, '/index.html'));
  if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try {
    let body = await readFile(path);
    if (path === join(root, 'js/app.js')) {
      body = Buffer.from(body.toString() + hook);
    }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream');
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  let apiCalls = 0, reply = { segments: [{ start: 0, end: 0.6, text: '검증용 예시', uncertain: true }, { start: 1, end: 1.6, text: '두 번째 예시', uncertain: true }], summary: '', unreadableReason: '2초 이후 구간은 확인이 필요해요.' };
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin) || url.startsWith('blob:')) return route.continue();
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      apiCalls++;
      return route.fulfill({ json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(reply) }] } }] } });
    }
    external.push(url); await route.abort();
  });
  let acceptDialog = true;
  page.on('dialog', dialog => acceptDialog ? dialog.accept() : dialog.dismiss());
  await page.goto(origin + '/#video');
  await page.waitForFunction(() => globalThis.testUI);
  assert.equal(await page.locator('#view-video').isVisible(), true);
  assert.equal(await page.locator('#view-studio').isHidden(), true);
  const capture = async state => {
    await mkdir(join(root, 'dist'), { recursive: true });
    for (const [name, width, height] of [['desktop',1440,1000],['mobile',390,844]]) {
      await page.setViewportSize({width,height});
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0,0); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({path:join(root, `dist/ux-${state}-${name}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:1000});
  };
  await capture('input');
  assert.equal(await page.locator('.analysis-settings').isHidden(), true, 'draft settings stay hidden until a video is selected');
  await page.evaluate(async () => {
    const { extractHandFeatures } = await import('/js/engine.js');
    const hand = Array.from({ length: 21 }, (_, i) => ({ x: .45 + Math.sin(i * .8) * .06, y: .65 - i * .012, z: i * .001 }));
    const frame = extractHandFeatures([hand], [{ label: 'Right' }]);
    await testUI.store.saveSample('테스트', { id: 'fixture', featureVersion: 2, duration: 2, frames: Array.from({ length: 24 }, () => frame) });
    await testUI.refreshSigns();
    globalThis.preservedDictionary = JSON.stringify(await testUI.store.list());
    globalThis.trackerCount = 0;
    globalThis.Hands = class {
      constructor() { globalThis.trackerCount++; }
      setOptions() {}
      onResults(callback) { this.results = callback; }
      async initialize() { if (globalThis.modelFailure) throw new Error('모델 초기화 시험 오류'); if (globalThis.holdModel) await new Promise(resolve => { globalThis.releaseModel = resolve; }); }
      async send() { this.results({ multiHandLandmarks: [] }); }
      async close() {}
    };
  });
  const choose = async () => {
    await page.locator('#videoFile').setInputFiles(fixture);
    await page.waitForFunction(() => testUI.videoState.duration > 0 && !testUI.videoState.loading && !testUI.videoState.canceling);
  };
  await choose();
  await page.locator('.analysis-settings > summary').click();
  await page.locator('#videoLocalMode').click();
  // Delayed cleanup of the old run must not erase the newer file selection.
  assert.equal(await page.evaluate(async () => {
    const file = testUI.videoState.file;
    let release;
    testUI.videoState.jobPromise = new Promise(resolve => { release = resolve; });
    const clear = testUI.clearVideo();
    const select = testUI.selectVideoFile(new File([file], 'new.webm', { type: file.type }));
    release(); await Promise.all([clear, select]);
    return testUI.videoState.file?.name;
  }), 'new.webm');
  // A cancellation arriving before analyze's first await resumes invalidates its intent.
  await page.evaluate(async () => { const pending = testUI.analyzeVideo(); await testUI.cancelVideoAnalysis(); await pending; });
  assert.equal(await page.evaluate(() => globalThis.trackerCount), 0);
  await page.evaluate(async () => { await Promise.all([testUI.analyzeVideo(), testUI.analyzeVideo()]); });
  assert.equal(await page.evaluate(() => globalThis.trackerCount), 1);
  assert.equal(await page.evaluate(() => testUI.videoState.result.words.length), 0);
  assert.match(await page.locator('#videoTranscript').textContent(), /아직 작성된/);
  assert.equal(await page.locator('#videoDownloadBtn').isEnabled(), true);
  // Cancel a pending model initialization, then select/retry. Old completion stays inert.
  await page.evaluate(() => { globalThis.holdModel = true; void testUI.analyzeVideo(); });
  await page.waitForFunction(() => globalThis.releaseModel);
  await capture('processing');
  await page.locator('#videoCancelBtn').click();
  await page.waitForFunction(() => !testUI.videoState.canceling);
  await capture('cancelled');
  await page.evaluate(() => { globalThis.holdModel = false; globalThis.releaseModel(); });
  await choose();
  await page.evaluate(async () => { globalThis.modelFailure = true; await testUI.analyzeVideo(); globalThis.modelFailure = false; });
  assert.match(await page.locator('#videoNotice').innerText(), /초기화 시험 오류/);
  await capture('failed');
  assert.equal(await page.locator('#videoAnalyzeBtn').isEnabled(), true);
  await page.locator('#videoAnalyzeBtn').click();
  await page.waitForFunction(() => testUI.videoState.result && !testUI.videoState.busy);
  // Browser back cancels work; returning does not restart it.
  await page.evaluate(() => { location.hash = 'dictionary'; });
  await page.waitForFunction(() => location.hash === '#dictionary');
  await page.evaluate(() => { location.hash = 'video'; });
  await page.waitForFunction(() => !document.getElementById('view-video').hidden);
  await page.evaluate(() => { globalThis.releaseModel = null; globalThis.holdModel = true; void testUI.analyzeVideo(); });
  await page.waitForFunction(() => globalThis.releaseModel);
  await page.goBack();
  await page.waitForFunction(() => !testUI.videoState.busy && !testUI.videoState.canceling);
  await page.evaluate(() => { globalThis.holdModel = false; globalThis.releaseModel(); });
  await page.goForward();
  assert.equal(await page.evaluate(() => testUI.videoState.busy), false);
  // Validation and recovery use the real browser's media decoder.
  await page.locator('#videoFile').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('not a video') });
  await page.waitForFunction(() => !testUI.videoState.loading);
  assert.equal(await page.locator('#videoAnalyzeBtn').isDisabled(), true);
  await choose();
  await page.locator('#videoAIMode').click();
  await page.locator('#geminiKey').fill('test-placeholder-key-only');
  await page.locator('#aiServiceTier').selectOption('unpaid');
  await page.locator('#aiPrivacyType').selectOption('nonpersonal');
  await page.locator('#aiBillingConfirmed').check();
  const approveAI = async () => {
    await page.locator('#videoAnalyzeBtn').click();
    await page.locator('#aiReviewDialog').waitFor({state:'visible'});
    await page.locator('#aiUploadConsent').check();
    await page.locator('#aiSendBtn').click();
  };
  await approveAI();
  await page.waitForFunction(() => testUI.videoState.document?.source === 'ai' && !testUI.videoState.busy);
  assert.equal(apiCalls, 1);
  assert.match(await page.locator('#videoResultLimitations').innerText(), /2초 이후/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#videoDownloadBtn').click();
  const download = await downloadPromise;
  const exported = await readFile(await download.path(), 'utf8');
  assert.match(exported, /검토 필요/); assert.match(exported, /2초 이후/);
  // Keyboard review starts at the selected segment and pauses near its endpoint.
  await page.locator('.video-segment').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('uploadedVideo').currentTime >= .6 && document.getElementById('uploadedVideo').paused);
  assert.ok(await page.locator('#uploadedVideo').evaluate(video => video.currentTime < 1.1));
  assert.match(await page.locator('#videoReviewStatus').innerText(), /1번 구간/);
  await page.locator('#videoReturnToSegment').click();
  assert.equal(await page.getByRole('textbox',{name:'1번 구간 한국어 글',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.locator('.video-segment').nth(1).click();
  await page.locator('.video-segment').first().click();
  await page.waitForFunction(() => document.getElementById('uploadedVideo').currentTime >= .6 && document.getElementById('uploadedVideo').paused);
  // Editing is independent of original model text; review flags reset on edits.
  await page.getByRole('textbox', {name:'1번 구간 한국어 글', exact:true}).fill('사용자가 확인한 한국어 문장');
  await page.locator('.segment-editor').first().getByRole('checkbox').check();
  assert.match(await page.locator('#videoEditStatus').innerText(), /1개 검토 필요/);
  const jsonDownload = page.waitForEvent('download');
  await page.locator('#videoJSONBtn').click();
  const json = JSON.parse(await readFile(await (await jsonDownload).path(), 'utf8'));
  assert.equal(json.segments[0].original, '검증용 예시');
  assert.equal(json.segments[0].text, '사용자가 확인한 한국어 문장');
  assert.equal(json.segments[0].reviewed, true);
  assert.equal(JSON.stringify(json).includes('test-placeholder-key'), false);
  await page.getByRole('spinbutton', {name:'1번 구간 끝 (초)',exact:true}).fill('0');
  assert.equal(await page.locator('#videoDownloadBtn').isDisabled(), true);
  assert.match(await page.locator('#videoEditError').innerText(), /시작·끝/);
  await page.getByRole('spinbutton', {name:'1번 구간 끝 (초)',exact:true}).fill('0.6');
  assert.equal(await page.locator('.segment-editor').first().getByRole('checkbox').isChecked(), false);
  // Declining a destructive action retains edits, as do navigation and mode changes.
  acceptDialog = false;
  await page.locator('#videoClearBtn').click();
  assert.equal(await page.getByRole('textbox', {name:'1번 구간 한국어 글',exact:true}).inputValue(), '사용자가 확인한 한국어 문장');
  acceptDialog = true;
  await page.locator('#videoLocalMode').click();
  assert.equal(await page.getByRole('textbox', {name:'1번 구간 한국어 글',exact:true}).inputValue(), '사용자가 확인한 한국어 문장');
  await page.locator('#videoAIMode').click();
  await page.waitForFunction(() => document.getElementById('toastRegion').children.length === 0);
  await page.locator('.analysis-settings > summary').click();
  await capture('result');
  await page.screenshot({path:join(root,'dist/video-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(root,'dist/video-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  reply = { segments: [], summary: '', unreadableReason: '확인할 수 있는 수어 구간이 없어요.' };
  await approveAI();
  await page.waitForFunction(() => !testUI.videoState.busy && testUI.videoState.result?.segments?.length === 0);
  assert.match(await page.evaluate(() => testUI.videoState.text), /확인할 수 있는 수어 구간이 없어요/);
  await capture('empty');
  await choose();
  assert.equal(await page.locator('#aiUploadConsent').isChecked(), false);
  assert.equal(await page.locator('#videoResultLimitations').isHidden(), true);
  await page.setViewportSize({width:390,height:844});
  await page.locator('#videoAddSegment').click();
  await page.getByRole('textbox',{name:'1번 구간 한국어 글',exact:true}).fill('직접 작성한 문장');
  assert.equal(await page.locator('#videoDownloadBtn').isEnabled(), true);
  assert.equal(await page.evaluate(()=>testUI.videoState.document.source), 'manual');
  await page.locator('.video-segment').first().click();
  assert.ok(await page.locator('#uploadedVideo').evaluate(node=>node.getBoundingClientRect().top < 100));
  await page.locator('#videoReturnToSegment').click();
  assert.equal(await page.getByRole('textbox',{name:'1번 구간 한국어 글',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.locator('a[href="#settings"]').click();
  await page.locator('#view-settings a[href="#dictionary"]').click();
  assert.equal(await page.evaluate(()=>testUI.state.signs[0].word),'테스트');
  await page.locator('[data-view="video"]').click();
  assert.equal(await page.getByRole('textbox',{name:'1번 구간 한국어 글',exact:true}).inputValue(),'직접 작성한 문장');
  assert.equal(await page.evaluate(async()=>JSON.stringify(await testUI.store.list())===globalThis.preservedDictionary),true);
  assert.deepEqual(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);}),[]);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  assert.equal(await page.locator('body').innerText().then(text => /손끝|장애 극복/.test(text)), false);
  for (const width of [320,768,1280]) {
    await page.setViewportSize({width,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    for (const id of ['videoAnalyzeBtn','videoAddSegment','videoDownloadBtn']) assert.ok((await page.locator('#'+id).boundingBox()).height>=44);
  }
  await page.goto(origin + '/dist/sign-studio-preview.html#video');
  await page.waitForFunction(() => document.title.includes('영상 등록'));
  assert.deepEqual(errors, []);
  console.log('PASS: standalone preview over HTTP; file replacement race, queued cancellation, double start, no-hands abstention, model cancel/retry/error, history back, invalid codec, partial/empty exports, keyboard segment playback, rapid segment selection, mobile overflow, neutral copy, explicit video registration entry, independent original/edited text, review reset, JSON audit export, time validation, discard protection, manual authoring, mobile video/editor navigation, auxiliary data retention. External traffic blocked; Gemini mocked.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true });
}
