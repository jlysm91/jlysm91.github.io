// Run: node tests/video-chat.browser.mjs
// Synthetic color videos, placeholder credentials and intercepted Gemini replies only.
// All other external traffic is blocked; native camera/microphone access is disabled.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve(import.meta.dirname, '..'), tmp = await mkdtemp(join(tmpdir(), 'ksl-video-chat-'));
const clips = [];
for (const [index, color] of ['0x93b6db', '0xb5d8aa'].entries()) {
  const file = join(tmp, `synthetic-chat-${index}.webm`);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=8`, '-t', '4', '-c:v', 'libvpx', file]);
  clips.push(await readFile(file));
}
const hook = '\nglobalThis.testUI = { videoState, personalLibrary, libraryUI, hybridUI, chatUI, selectVideoFile, addVideoSegment, renderVideoEditor, syncVideoDocument, renderVideoControls, showView, store };';
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
  const page = await context.newPage();
  const errors = [], external = [], requests = [], replies = [], pending = [];
  let answerNumber = 0, acceptDialog = true;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => acceptDialog ? dialog.accept() : dialog.dismiss());
  await context.addInitScript(() => {
    globalThis.syntheticCameraCalls = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      globalThis.syntheticCameraCalls++;
      throw new DOMException('Real camera is prohibited in this test', 'NotAllowedError');
    } });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', { configurable: true, value: async () => [] });
    // A parent application may hold unrelated conversation data. The app must not consume it.
    localStorage.setItem('unrelated-parent-conversation', 'PARENT_CONVERSATION_NEVER_SEND');
    globalThis.parentConversation = 'PARENT_CONVERSATION_NEVER_SEND';
  });
  await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) {
      external.push(url); return route.abort();
    }
    const body = request.postDataJSON(), video = body.contents?.some(content => content.parts?.some(part => part.inlineData));
    requests.push({ url, body, video: Boolean(video) });
    const reply = replies.shift() || 'success';
    if (reply === 'hold') await new Promise(resolve => pending.push(resolve));
    if (reply === 'rate-limit') return route.fulfill({ status: 429, json: { error: { message: 'SYNTHETIC_ERROR_SHOULD_NOT_BE_EXPOSED' } } }).catch(() => {});
    if (reply === 'failure') return route.fulfill({ status: 503, json: { error: { message: 'SYNTHETIC_ERROR_SHOULD_NOT_BE_EXPOSED' } } }).catch(() => {});
    if (reply === 'invalid') return route.fulfill({ json: { candidates: [] } }).catch(() => {});
    const text = video ? JSON.stringify({ segments: [{ start: 0, end: 2, text: 'UNREVIEWED_SYNTHETIC_VIDEO_DRAFT', uncertain: true }], summary: '', unreadableReason: '합성 영상의 모의 응답입니다.' }) : JSON.stringify({ answer: `SYNTHETIC_ASSISTANT_ANSWER_${++answerNumber}` });
    return route.fulfill({ json: { modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 70, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 100 }, candidates: [{ finishReason: reply === 'truncated' ? 'MAX_TOKENS' : 'STOP', content: { role: 'model', parts: [{ text }] } }] } }).catch(() => {});
  });
  const requestCount = () => requests.length;
  const chatRequests = () => requests.filter(request => !request.video);
  const idle = () => page.waitForFunction(() => !testUI.chatUI.busy() && !testUI.hybridUI.busy() && !testUI.videoState.busy && !testUI.videoState.canceling && !testUI.videoState.loading);
  const loadVideo = async index => {
    await page.locator('#videoFile').setInputFiles({ name: `synthetic-chat-${index}.webm`, mimeType: 'video/webm', buffer: clips[index] });
    await idle();
  };
  const policy = async (tier = 'unpaid', privacy = 'nonpersonal') => {
    await page.locator('.analysis-settings').evaluate(node => { node.open = true; });
    await page.locator('#geminiKey').fill('synthetic-chat-placeholder-key');
    await page.locator('#aiServiceTier').selectOption(tier);
    await page.locator('#aiPrivacyType').selectOption(privacy);
    await page.locator('#aiBillingConfirmed').check();
  };
  const setDocument = async (text, { reviewed = true, uncertainty = '' } = {}) => {
    await page.evaluate(({ text, reviewed, uncertainty }) => {
      testUI.videoState.document = {
        source: 'manual', duration: testUI.videoState.duration, limitation: '',
        segments: [{ id: 1, start: 0, end: 2, source: 'manual', original: 'ORIGINAL_DRAFT_NEVER_SEND', text, literal: 'LITERAL_NEVER_SEND', context: 'CONTEXT_NEVER_SEND', referents: 'REFERENTS_NEVER_SEND', intent: 'INTENT_NEVER_SEND', uncertainty, reviewed }],
      };
      testUI.videoState.dirty = true;
      testUI.renderVideoEditor(); testUI.syncVideoDocument();
    }, { text, reviewed, uncertainty });
  };
  const capture = async name => {
    await mkdir(join(root, 'dist'), { recursive: true });
    if (!await page.locator('#chatReviewDialog').isVisible()) await page.locator('.analysis-settings').evaluate(node => { node.open = false; });
    for (const [suffix, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.activeElement?.blur());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} page overflow at ${width}`);
      const dialog = page.locator('#chatReviewDialog');
      const previewOpen = await dialog.isVisible();
      if (previewOpen) {
        await dialog.evaluate(node => { node.scrollTop = 0; });
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true, `${name} dialog overflow at ${width}`);
      } else await page.locator('#videoChatPanel').evaluate(node => node.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: join(root, `dist/chat-${name}-${suffix}.png`), fullPage: !previewOpen });
      if (previewOpen) {
        await page.locator('#chatSendBtn').scrollIntoViewIfNeeded();
        assert.ok((await page.locator('#chatSendBtn').boundingBox()).height >= 44, 'approval button must be at least 44px tall');
        await page.screenshot({ path: join(root, `dist/chat-${name}-approval-${suffix}.png`), fullPage: false });
      } else await page.screenshot({ path: join(root, `dist/chat-${name}-panel-${suffix}.png`), fullPage: false });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  await page.goto(origin + '/#video');
  await page.waitForFunction(() => globalThis.testUI?.chatUI);
  await page.evaluate(() => testUI.personalLibrary.init());
  await loadVideo(0); await policy();
  // The video analysis is a separate approved request; receiving its draft must not start a chat.
  await page.locator('#aiRequestMode').selectOption('baseline');
  await page.locator('#videoAnalyzeBtn').click();
  await page.locator('#aiReviewDialog').waitFor({ state: 'visible' });
  assert.equal(requestCount(), 0);
  await page.locator('#aiUploadConsent').check();
  await page.locator('#aiSendBtn').click(); await idle();
  assert.equal(requestCount(), 1);
  assert.equal(chatRequests().length, 0, 'video draft must not automatically trigger a conversation request');
  assert.equal(requests[0].video, true);
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].reviewed), false);
  await page.evaluate(() => testUI.chatUI.prepare());
  assert.equal(chatRequests().length, 0, 'unreviewed video draft cannot be sent as a confirmed question');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await setDocument('FIRST_CONFIRMED_QUESTION', { uncertainty: '확인하지 못한 내용이 남아 있습니다.' });
  await page.evaluate(() => testUI.chatUI.prepare());
  assert.equal(chatRequests().length, 0, 'uncertain text must be reviewed before conversation');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await setDocument('FIRST_CONFIRMED_QUESTION');
  assert.equal(await page.locator('#chatPrivacyType').inputValue(), 'personal', 'text privacy must default to uncertain/personal independently of video privacy');
  await page.locator('#chatPrepareBtn').click();
  assert.equal(await page.locator('#chatReviewDialog').isVisible(), false);
  assert.match(await page.locator('#chatStatus').innerText(), /무료 서비스/);
  assert.equal(chatRequests().length, 0, 'unpaid personal text must be blocked');
  await page.locator('#chatPrivacyType').selectOption('nonpersonal');
  const history = () => page.evaluate(() => testUI.chatUI.history());
  const preview = async () => {
    const before = requestCount();
    await page.locator('#chatPrepareBtn').click();
    await page.locator('#chatReviewDialog').waitFor({ state: 'visible' });
    assert.equal(requestCount(), before, 'chat preview must not send anything');
    assert.equal(await page.locator('#chatSendConsent').isChecked(), false);
    assert.equal(await page.locator('#chatSendBtn').isDisabled(), true);
    assert.match(await page.locator('#chatReviewManifest').innerText(), /글 답변 요청 1회/);
  };
  const confirm = async () => { await page.locator('#chatSendConsent').check(); await page.locator('#chatSendBtn').click(); };
  const waitHeld = async () => {
    const deadline = Date.now() + 10000;
    while (!pending.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(pending.length, 'mocked request should begin within ten seconds');
  };
  const releaseHeld = () => { const release = pending.shift(); assert.ok(release); release(); };
  const assertTextPayload = request => {
    assert.equal(request.video, false);
    assert.equal(request.body.store, false);
    assert.equal(request.body.generationConfig.maxOutputTokens, 1024);
    assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
    for (const content of request.body.contents) {
      assert.ok(['user', 'model'].includes(content.role));
      assert.equal(content.parts.length, 1);
      assert.deepEqual(Object.keys(content.parts[0]), ['text']);
    }
    for (const hidden of ['ORIGINAL_DRAFT_NEVER_SEND', 'LITERAL_NEVER_SEND', 'CONTEXT_NEVER_SEND', 'REFERENTS_NEVER_SEND', 'INTENT_NEVER_SEND', 'PARENT_CONVERSATION_NEVER_SEND', 'synthetic-chat-placeholder-key']) {
      assert.equal(JSON.stringify(request.body).includes(hidden), false, `must not send ${hidden}`);
    }
    assert.equal(request.url.includes('synthetic-chat-placeholder-key'), false);
  };

  await preview();
  assert.match(await page.locator('#chatReviewManifest').innerText(), /FIRST_CONFIRMED_QUESTION/);
  await capture('preview');
  replies.push('hold');
  await page.locator('#chatSendConsent').check();
  await page.evaluate(() => { document.getElementById('chatSendBtn').click(); document.getElementById('chatSendBtn').click(); });
  await waitHeld(); assert.equal(chatRequests().length, 1, 'repeated confirmation must issue only one call');
  assert.deepEqual(await history(), [], 'pending answer must not become committed conversation history');
  releaseHeld(); await idle();
  assert.deepEqual(await history(), [{ question: 'FIRST_CONFIRMED_QUESTION', answer: 'SYNTHETIC_ASSISTANT_ANSWER_1' }]);
  assertTextPayload(chatRequests()[0]);
  assert.deepEqual(chatRequests()[0].body.contents, [{ role: 'user', parts: [{ text: 'FIRST_CONFIRMED_QUESTION' }] }]);
  assert.equal(requestCount(), 2, 'video interpretation plus separately approved text reply is exactly two calls');

  await loadVideo(1);
  assert.equal((await history()).length, 1, 'changing videos must preserve the current conversation');
  assert.equal(await page.locator('#chatPrepareBtn').isDisabled(), true, 'new video needs new reviewed text');
  await setDocument('SECOND_CONFIRMED_QUESTION');
  await preview();
  const manifest = await page.locator('#chatReviewManifest').innerText();
  assert.match(manifest, /FIRST_CONFIRMED_QUESTION/); assert.match(manifest, /SYNTHETIC_ASSISTANT_ANSWER_1/); assert.match(manifest, /SECOND_CONFIRMED_QUESTION/);
  await confirm(); await idle();
  assertTextPayload(chatRequests()[1]);
  assert.deepEqual(chatRequests()[1].body.contents, [
    { role: 'user', parts: [{ text: 'FIRST_CONFIRMED_QUESTION' }] },
    { role: 'model', parts: [{ text: 'SYNTHETIC_ASSISTANT_ANSWER_1' }] },
    { role: 'user', parts: [{ text: 'SECOND_CONFIRMED_QUESTION' }] },
  ]);
  assert.equal((await history()).length, 2);
  await capture('conversation');
  const preservedHistory = await history(), preservedDocument = await page.evaluate(() => JSON.stringify(testUI.videoState.document));
  const startErrors = requestCount();
  for (const reply of ['rate-limit', 'failure', 'invalid', 'truncated']) {
    replies.push(reply); await preview(); await confirm(); await idle();
    assert.deepEqual(await history(), preservedHistory, `${reply} must preserve completed history`);
    assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), preservedDocument, `${reply} must preserve the review document`);
  }
  assert.equal(requestCount(), startErrors + 4, 'failures must not automatically retry or switch models');
  assert.match(await page.locator('#chatStatus').innerText(), /출력 한도/);
  assert.equal((await page.locator('#chatTurns').innerText()).includes('SYNTHETIC_ERROR_SHOULD_NOT_BE_EXPOSED'), false);
  await capture('failed');

  // Cancellation does not commit an unfinished turn and allows an explicitly approved retry.
  replies.push('hold'); await preview(); await confirm(); await waitHeld();
  await page.locator('#chatCancelBtn').click(); await idle(); releaseHeld();
  assert.deepEqual(await history(), preservedHistory);
  assert.match(await page.locator('#chatStatus').innerText(), /취소/);
  const beforeRetry = requestCount();
  await preview(); await confirm(); await idle();
  assert.equal(requestCount(), beforeRetry + 1);
  assert.equal((await history()).length, 3);
  const afterRetry = await history();
  assert.equal(chatRequests().at(-1).body.contents.length, 5, 'failed/cancelled attempts must not join later conversation context');

  // Preview consent cannot survive a policy, key or confirmed-document change.
  let before = requestCount();
  await preview(); await page.locator('#chatReviewCancelBtn').click();
  await page.evaluate(() => testUI.chatUI.confirm());
  assert.equal(requestCount(), before);
  await preview(); await page.locator('#chatSendConsent').check();
  await page.evaluate(() => { const input = document.getElementById('chatPrivacyType'); input.value = 'personal'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('#chatReviewDialog').isVisible(), false);
  await page.evaluate(() => testUI.chatUI.confirm());
  assert.equal(requestCount(), before);
  await page.locator('#chatPrivacyType').selectOption('nonpersonal');
  await preview(); await page.locator('#chatSendConsent').check();
  await setDocument('CHANGED_CONFIRMED_QUESTION');
  assert.equal(await page.locator('#chatReviewDialog').isVisible(), false);
  await page.evaluate(() => testUI.chatUI.confirm());
  assert.equal(requestCount(), before);
  await preview(); await page.locator('#chatSendConsent').check();
  // No input/change notification: the immutable preview snapshot must still catch the mutation.
  await page.evaluate(() => { testUI.videoState.document.segments[0].text = 'MUTATED_WITHOUT_UI_EVENT'; });
  await page.locator('#chatSendBtn').click();
  assert.equal(await page.locator('#chatReviewDialog').isVisible(), false);
  assert.equal(requestCount(), before);
  await page.evaluate(() => testUI.syncVideoDocument());
  await preview(); await page.locator('#chatSendConsent').check();
  await page.evaluate(() => { const key = document.getElementById('geminiKey'); key.value = 'synthetic-chat-replacement-key'; key.dispatchEvent(new Event('input', { bubbles: true })); });
  assert.equal(await page.locator('#chatReviewDialog').isVisible(), false);
  assert.equal(await page.locator('#aiBillingConfirmed').isChecked(), false);
  await page.evaluate(() => testUI.chatUI.confirm());
  assert.equal(requestCount(), before);
  await policy();

  // Browser Back invalidates an unsent approval, and also cancels an in-flight reply.
  await page.locator('a[href="#settings"]').first().click();
  await page.locator('#view-settings').waitFor({ state: 'visible' });
  await page.locator('a[href="#video"]').first().click();
  await page.locator('#view-video').waitFor({ state: 'visible' });
  assert.deepEqual(await history(), afterRetry, 'ordinary navigation must preserve the tab conversation');
  const historyBeforeBack = await history();
  before = requestCount();
  await preview(); await page.locator('#chatSendConsent').check();
  await page.goBack(); await page.locator('#view-settings').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#chatReviewDialog').isVisible(), false);
  await page.evaluate(() => testUI.chatUI.confirm());
  assert.equal(requestCount(), before);
  assert.deepEqual(await history(), historyBeforeBack);
  await page.goForward(); await page.locator('#view-video').waitFor({ state: 'visible' });
  replies.push('hold'); await preview(); await confirm(); await waitHeld();
  await page.goBack(); await idle(); releaseHeld();
  assert.deepEqual(await history(), historyBeforeBack);
  await page.goForward(); await page.locator('#view-video').waitFor({ state: 'visible' });

  // A response to a changed document must not join history, even if the UI event was missed.
  replies.push('hold'); await preview(); await confirm(); await waitHeld();
  await page.evaluate(() => { testUI.videoState.document.segments[0].text = 'CHANGED_DURING_REQUEST'; });
  releaseHeld(); await idle();
  assert.deepEqual(await history(), historyBeforeBack);
  assert.match(await page.locator('#chatStatus').innerText(), /바뀌어/);

  // Explicit reset keeps video/annotations and removes only the current tab's conversation.
  const documentBeforeClear = await page.evaluate(() => JSON.stringify(testUI.videoState.document));
  acceptDialog = false; await page.locator('#chatClearBtn').click();
  assert.deepEqual(await history(), historyBeforeBack, 'declining reset must preserve conversation');
  acceptDialog = true;
  await page.locator('#chatClearBtn').click();
  assert.deepEqual(await history(), []);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), documentBeforeClear);
  assert.equal(await page.locator('#chatClearBtn').isDisabled(), true);
  await capture('reset');
  for (const request of chatRequests()) assertTextPayload(request);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.equal(await page.evaluate(() => syntheticCameraCalls), 0);
  console.log('PASS: separately approved video-to-draft then text-to-reply calls; unreviewed/uncertain/free-personal blocks; exact confirmed-text-only payload; no original video, annotation or parent conversation leakage; prior confirmed turns, video replacement retention, explicit reset; 429/503/malformed/truncated response retention, cancel/retry/repeated clicks; preview policy/key/document invalidation, browser Back before/during send; PC/390px/320px layout and screenshots. Synthetic clips and mocked replies only; native media and all external traffic blocked.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true });
}
