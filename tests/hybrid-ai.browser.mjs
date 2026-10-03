// Run: node tests/hybrid-ai.browser.mjs
// Synthetic color videos and intercepted Gemini responses only; no external requests leave Chromium.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = resolve(import.meta.dirname, '..'), tmp = await mkdtemp(join(tmpdir(), 'ksl-hybrid-ai-'));
const clips = [];
for (const [index, color] of ['0x93b6db', '0xb5d8aa', '0xe4bf93', '0xc2afe0'].entries()) {
  const path = join(tmp, `synthetic-${index}.webm`);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240:r=8`, '-t', '4', '-c:v', 'libvpx', path]);
  clips.push(await readFile(path));
}
const hook = '\nglobalThis.testUI = { videoState, personalLibrary, libraryUI, hybridUI, selectVideoFile, addVideoSegment, store, renderVideoControls };';
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
  const errors = [], external = [], requests = [], replies = [];
  let releaseResponse;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await context.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      const body = request.postDataJSON(); requests.push({ url, body });
      const reply = replies.shift() || 'success';
      if (reply === 'hold') await new Promise(resolve => { releaseResponse = resolve; });
      if (reply === 'rate-limit') return route.fulfill({ status: 429, json: { error: { message: 'synthetic rate limit' } } }).catch(() => {});
      if (reply === 'invalid') return route.fulfill({ json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'invalid result' }] } }] } }).catch(() => {});
      const assisted = body.contents[0].parts.filter(part => part.inlineData).length > 1;
      const result = { segments: [{ start: 0, end: 1.5, text: assisted ? 'ASSISTED_SYNTHETIC_DRAFT' : 'BASELINE_SYNTHETIC_DRAFT', uncertain: true }], summary: '', unreadableReason: '합성 영상 응답이며 한국수어 정확도 검증이 아닙니다.' };
      return route.fulfill({ json: { modelVersion: 'gemini-3.8-flash', usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }, candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }] } }).catch(() => {});
    }
    external.push(url); await route.abort();
  });
  const ready = async () => { await page.waitForFunction(() => globalThis.testUI?.hybridUI); await page.evaluate(() => testUI.personalLibrary.init()); };
  const idle = () => page.waitForFunction(() => !testUI.hybridUI.busy() && !testUI.videoState.busy && !testUI.videoState.loading);
  const settings = async () => {
    const panel = page.locator('.analysis-settings');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').first().click();
  };
  const openRecord = async id => {
    await page.evaluate(id => testUI.libraryUI.openRecord(id), id); await idle(); await settings();
  };
  const findReferences = async () => {
    await settings();
    const panel = page.locator('.ai-reference-settings');
    if (!await panel.evaluate(node => node.open)) await panel.locator('summary').click();
    await page.locator('#aiReferenceSearch').fill('USER_TOPIC');
    await page.locator('#aiFindReferences').click();
    // A repeated search must settle to the latest list; await its public controller promise.
    await page.evaluate(() => testUI.hybridUI.findReferences());
  };
  const policy = async (tier = 'unpaid', privacy = 'nonpersonal') => {
    await settings();
    await page.locator('#geminiKey').fill('synthetic-placeholder-key-only');
    await page.locator('#aiServiceTier').selectOption(tier);
    await page.locator('#aiPrivacyType').selectOption(privacy);
    await page.locator('#aiBillingConfirmed').check();
  };
  const preview = async mode => {
    await settings(); await page.locator('#aiRequestMode').selectOption(mode);
    const before = requests.length;
    await page.locator('#videoAnalyzeBtn').click();
    await page.locator('#aiReviewDialog').waitFor({ state: 'visible' });
    assert.equal(requests.length, before, 'preview must not send video');
    assert.equal(await page.locator('#aiUploadConsent').isChecked(), false, 'approval is per request');
    assert.equal(await page.locator('#aiSendBtn').isDisabled(), true);
  };
  const confirm = async () => {
    await page.locator('#aiUploadConsent').check();
    await page.locator('#aiSendBtn').click();
  };
  const capture = async name => {
    await mkdir(join(root, 'dist'), { recursive: true });
    if (name !== 'preview' && await page.locator('.analysis-settings').evaluate(node => node.open)) await page.locator('.analysis-settings > summary').click();
    for (const [suffix, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow at ${width}`);
      if (name === 'preview') {
        await page.locator('#aiReviewDialog').evaluate(dialog => { dialog.scrollTop = 0; });
        assert.equal(await page.locator('#aiReviewDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true, 'dialog must not scroll horizontally');
      }
      await page.screenshot({ path: join(root, `dist/hybrid-${name}-${suffix}.png`), fullPage: name !== 'preview' });
      if (name === 'preview') {
        await page.locator('#aiSendBtn').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(root, `dist/hybrid-preview-approval-${suffix}.png`), fullPage: false });
        assert.ok((await page.locator('#aiSendBtn').boundingBox()).height >= 44);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };
  await page.goto(origin + '/#video'); await ready();
  const ids = await page.evaluate(async clips => {
    const make = (index, role, title, day, session) => ({
      title, role, captureDay: day, session, fileName: `synthetic-${index}.webm`, video: new Blob([new Uint8Array(clips[index])], { type: 'video/webm' }),
      document: { source: 'manual', duration: 4, limitation: '', segments: [{ id: 1, start: 0, end: 2, source: 'manual', original: '', reviewed: true,
        text: index ? `REFERENCE_NATURAL_${index}` : 'TARGET_NATURAL_NEVER_SEND', literal: index ? `REFERENCE_LITERAL_${index}` : 'TARGET_LITERAL_NEVER_SEND',
        context: index ? `USER_TOPIC REFERENCE_CONTEXT_${index}` : 'TARGET_CONTEXT_NEVER_SEND',
        referents: index ? `REFERENCE_REFERENTS_${index}` : 'TARGET_REFERENTS_NEVER_SEND', intent: index ? `REFERENCE_INTENT_${index}` : 'TARGET_INTENT_NEVER_SEND', uncertainty: '' }] },
    });
    const rows = await Promise.all([
      testUI.personalLibrary.save(make(0, 'test', '독립 평가용 합성 영상', '2026-10-03', 'target-session')),
      testUI.personalLibrary.save(make(1, 'reference', '참고 합성 영상 하나', '2026-10-01', 'reference-session-1')),
      testUI.personalLibrary.save(make(2, 'reference', '참고 합성 영상 둘', '2026-10-02', 'reference-session-2')),
      testUI.personalLibrary.save(make(3, 'reference', '참고 합성 영상 셋', '2026-09-30', 'reference-session-3')),
    ]);
    for (const kind of ['review', 'literal', 'uncertainty']) {
      const invalid = make(3, 'reference', '부적격 참고 ' + kind, '2026-09-29', 'invalid-' + kind);
      if (kind === 'review') invalid.document.segments[0].reviewed = false;
      if (kind === 'literal') invalid.document.segments[0].literal = '';
      if (kind === 'uncertainty') invalid.document.segments[0].uncertainty = '확인하지 못함';
      await testUI.personalLibrary.save(invalid);
    }
    await testUI.libraryUI.refresh();
    return rows.map(row => row.id);
  }, clips.map(bytes => [...bytes]));
  const rejectPreparation = async mode => {
    await page.locator('#aiRequestMode').selectOption(mode);
    const before = requests.length;
    await page.locator('#videoAnalyzeBtn').click(); await idle();
    assert.equal(await page.locator('#aiReviewDialog').isVisible(), false);
    assert.equal(requests.length, before, 'invalid preparation must not send');
  };
  const chooseTwoReferences = async () => {
    await findReferences();
    for (const checkbox of await page.locator('#aiReferenceCandidates').getByRole('checkbox').all()) {
      if (await checkbox.isChecked()) await checkbox.uncheck();
    }
    await page.getByRole('checkbox', { name: '참고 합성 영상 하나 Gemini 참고 예시', exact: true }).check();
    await page.getByRole('checkbox', { name: '참고 합성 영상 둘 Gemini 참고 예시', exact: true }).check();
  };
  await openRecord(ids[0]);
  await policy('unpaid', 'personal');
  await page.locator('#videoAnalyzeBtn').click(); await idle();
  assert.equal(requests.length, 0, 'unpaid identifiable materials must be blocked');
  assert.equal(await page.locator('#aiReviewDialog').isVisible(), false);
  await page.locator('#geminiKey').fill('different-synthetic-placeholder-key');
  assert.equal(await page.locator('#aiBillingConfirmed').isChecked(), false, 'changing a key must clear project confirmation');
  await policy('paid', 'personal');
  await page.locator('#aiBillingConfirmed').uncheck();
  await rejectPreparation('baseline');
  await page.locator('#aiBillingConfirmed').check();
  await preview('baseline');
  assert.match(await page.locator('#aiReviewManifest').innerText(), /유료 프로젝트/);
  await page.locator('#aiReviewCancelBtn').click();
  await policy();
  assert.equal(await page.locator('#aiReferenceSearch').inputValue(), '', 'target annotation must never become a retrieval query');
  await findReferences();
  const candidates = page.locator('#aiReferenceCandidates').getByRole('checkbox');
  await candidates.first().waitFor();
  assert.equal(await candidates.count(), 3);
  for (const candidate of await candidates.all()) assert.equal(await candidate.isChecked(), false, 'suggestions require explicit selection');
  await page.getByRole('checkbox', { name: '참고 합성 영상 하나 Gemini 참고 예시', exact: true }).check();
  await page.getByRole('checkbox', { name: '참고 합성 영상 둘 Gemini 참고 예시', exact: true }).check();
  const thirdReference = page.getByRole('checkbox', { name: '참고 합성 영상 셋 Gemini 참고 예시', exact: true });
  await thirdReference.click();
  assert.equal(await thirdReference.isChecked(), false, 'a third reference must not be selected');
  // Unfinished annotations remain saveable, but cannot serve as comparison ground truth.
  await page.evaluate(async id => { globalThis.originalHybridTarget = await testUI.personalLibrary.get(id); }, ids[0]);
  for (const kind of ['review', 'text', 'literal', 'uncertainty', 'empty']) {
    await page.evaluate(async ({ id, kind }) => {
      const record = await testUI.personalLibrary.get(id);
      const document = structuredClone(globalThis.originalHybridTarget.document);
      if (kind === 'review') document.segments[0].reviewed = false;
      if (kind === 'text') document.segments[0].text = '   ';
      if (kind === 'literal') document.segments[0].literal = '   ';
      if (kind === 'uncertainty') document.segments[0].uncertainty = '아직 확인하지 못한 대상 의미';
      if (kind === 'empty') document.segments = [];
      const saved = await testUI.personalLibrary.save({ ...record, expectedRevision: record.revision, document });
      if (JSON.stringify(saved.document) !== JSON.stringify(document)) throw new Error('Unfinished target annotations must stay saveable without alteration');
    }, { id: ids[0], kind });
    await openRecord(ids[0]); await rejectPreparation('comparison');
    assert.match(await page.locator('#videoNotice').innerText(), /비교 대상의 모든 구간/);
    assert.equal(requests.length, 0, `${kind} target must not send any request`);
  }
  await page.evaluate(async id => {
    const record = await testUI.personalLibrary.get(id);
    await testUI.personalLibrary.save({ ...record, expectedRevision: record.revision, document: globalThis.originalHybridTarget.document });
  }, ids[0]);
  await openRecord(ids[0]); await preview('comparison');
  // A review changed after preview also invalidates the approval before sending.
  await page.evaluate(() => { testUI.videoState.document.segments[0].reviewed = false; });
  await confirm(); await idle();
  assert.equal(requests.length, 0, 'a changed target review must invalidate approval');
  assert.match(await page.locator('#videoNotice').innerText(), /변경/);
  await openRecord(ids[0]);
  // Changing a stored reference after preview invalidates that approval before any network call.
  await preview('comparison');
  await page.evaluate(async id => {
    const record = await testUI.personalLibrary.get(id);
    globalThis.originalHybridReference = record;
    await testUI.personalLibrary.save({ ...record, expectedRevision: record.revision });
  }, ids[1]);
  await confirm(); await idle();
  assert.equal(requests.length, 0);
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].text), 'TARGET_NATURAL_NEVER_SEND');
  await chooseTwoReferences();
  for (const kind of ['day', 'session', 'hash']) {
    await page.evaluate(async ({ id, targetId, kind }) => {
      const record = await testUI.personalLibrary.get(id), target = await testUI.personalLibrary.get(targetId);
      const changed = { ...record, expectedRevision: record.revision };
      if (kind === 'day') changed.captureDay = target.captureDay;
      if (kind === 'session') changed.session = target.session;
      if (kind === 'hash') { changed.video = target.video; delete changed.sha256; }
      await testUI.personalLibrary.save(changed);
    }, { id: ids[1], targetId: ids[0], kind });
    await chooseTwoReferences(); await rejectPreparation('comparison');
    assert.match(await page.locator('#videoNotice').innerText(), kind === 'hash' ? /같은 영상|중복 참고/ : /다른 촬영 날짜·묶음/);
    await page.evaluate(async id => {
      const current = await testUI.personalLibrary.get(id);
      await testUI.personalLibrary.save({ ...globalThis.originalHybridReference, id, expectedRevision: current.revision });
    }, ids[1]);
    await chooseTwoReferences();
  }
  await preview('comparison');
  await page.evaluate(async id => {
    const record = await testUI.personalLibrary.get(id);
    await testUI.personalLibrary.remove(id, record.revision);
  }, ids[1]);
  await confirm(); await idle();
  assert.equal(requests.length, 0, 'a missing reference must invalidate approval');
  await findReferences();
  assert.equal(await page.getByRole('checkbox', { name: '참고 합성 영상 하나 Gemini 참고 예시', exact: true }).count(), 0);
  ids[1] = await page.evaluate(async () => {
    const { id, revision, createdAt, updatedAt, ...input } = globalThis.originalHybridReference;
    return (await testUI.personalLibrary.save(input)).id;
  });
  await chooseTwoReferences();
  await preview('comparison');
  await page.evaluate(async id => {
    const target = await testUI.personalLibrary.get(id);
    await testUI.personalLibrary.save({ ...target, expectedRevision: target.revision });
  }, ids[0]);
  await confirm(); await idle();
  assert.equal(requests.length, 0, 'a changed saved target must invalidate comparison approval');
  await openRecord(ids[0]); await policy(); await chooseTwoReferences();
  await preview('comparison');
  await page.locator('#aiReviewManifest details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
  const manifest = await page.locator('#aiReviewManifest').innerText();
  assert.match(manifest, /synthetic-0|독립 평가용/);
  assert.match(manifest, /참고 합성 영상 하나/); assert.match(manifest, /참고 합성 영상 둘/);
  assert.match(manifest, /REFERENCE_LITERAL_1/); assert.match(manifest, /REFERENCE_NATURAL_2/);
  assert.match(await page.locator('#aiReviewManifest').innerText(), /요청 2회/);
  assert.match(await page.locator('#aiCostEstimate').innerText(), /토큰/);
  await capture('preview');
  // Baseline must complete before the assisted call begins; repeat clicks cannot duplicate either.
  replies.push('hold', 'success');
  await page.locator('#aiUploadConsent').check();
  await page.evaluate(() => { document.getElementById('aiSendBtn').click(); document.getElementById('aiSendBtn').click(); });
  await page.waitForFunction(() => testUI.hybridUI.busy());
  for (let i = 0; !releaseResponse && i < 3000; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseResponse, 'intercepted request must begin within 30 seconds');
  assert.equal(requests.length, 1);
  releaseResponse(); releaseResponse = null;
  await idle();
  assert.equal(requests.length, 2);
  const [baseline, assisted] = requests;
  assert.match(baseline.url, /gemini-3\.8-flash:generateContent/);
  const baselineVideos = baseline.body.contents[0].parts.filter(part => part.inlineData);
  const assistedVideos = assisted.body.contents[0].parts.filter(part => part.inlineData);
  assert.equal(baselineVideos.length, 1); assert.equal(assistedVideos.length, 3);
  assert.equal(baselineVideos[0].inlineData.data, clips[0].toString('base64'));
  assert.equal(assistedVideos.at(-1).inlineData.data, clips[0].toString('base64'));
  assert.equal(assistedVideos[0].inlineData.data, clips[1].toString('base64'));
  assert.equal(assistedVideos[1].inlineData.data, clips[2].toString('base64'));
  for (const { body } of requests) {
    assert.equal(JSON.stringify(body).includes('TARGET_'), false, 'ground-truth target annotations must not leave the browser');
    assert.equal(JSON.stringify(body).includes('USER_TOPIC'), body === assisted.body, 'user query must not enter baseline prompt');
    for (const part of body.contents[0].parts.filter(part => part.inlineData)) assert.equal(part.videoMetadata.fps, 8);
  }
  assert.equal(JSON.stringify(baseline.body).includes('REFERENCE_'), false);
  assert.equal(JSON.stringify(assisted.body).includes('REFERENCE_LITERAL_1'), true);
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].text), 'TARGET_NATURAL_NEVER_SEND', 'comparison must retain editable ground truth');
  assert.match(await page.locator('#aiComparisonResults').innerText(), /BASELINE_SYNTHETIC_DRAFT/);
  assert.match(await page.locator('#aiComparisonResults').innerText(), /ASSISTED_SYNTHETIC_DRAFT/);
  await page.locator('#aiEvaluationPreference').selectOption('assisted');
  await page.locator('#aiEvaluationNote').fill('합성 응답 UI 검증만 수행함');
  await capture('comparison');
  await page.locator('#personalSaveBtn').click();
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  const persisted = await page.evaluate(id => testUI.personalLibrary.get(id), ids[0]);
  assert.equal(persisted.document.audit.mode, 'comparison');
  assert.equal(persisted.document.audit.evaluation.meaning, 'assisted');
  assert.equal(persisted.document.audit.runs.length, 2);
  assert.equal(persisted.document.segments[0].text, 'TARGET_NATURAL_NEVER_SEND');
  assert.equal(JSON.stringify(persisted.document.audit).includes('synthetic-placeholder-key-only'), false);
  const backupBytes = await page.evaluate(async id => {
    const { encodePersonalBackup } = await import('/js/personal-library.js');
    return [...new Uint8Array(await (await encodePersonalBackup(await testUI.personalLibrary.get(id))).arrayBuffer())];
  }, ids[0]);
  const backup = Buffer.from(backupBytes), headerLength = backup.readUInt32BE(8);
  const backupRecord = JSON.parse(backup.subarray(12, 12 + headerLength).toString()).record;
  assert.equal(backupRecord.document.audit.evaluation.note, '합성 응답 UI 검증만 수행함');
  await page.reload(); await ready(); await openRecord(ids[0]); await policy();
  assert.equal(await page.evaluate(() => testUI.videoState.document.audit.runs.length), 2);
  assert.equal(await page.evaluate(() => testUI.videoState.document.audit.evaluation.meaning), 'assisted');
  assert.equal(requests.length, 2, 'reload and audit review must not send anything');

  // Each single mode has one fresh approval and only its authorized payload.
  await findReferences();
  await page.getByRole('checkbox', { name: '참고 합성 영상 하나 Gemini 참고 예시', exact: true }).check();
  await preview('baseline'); await confirm(); await idle();
  assert.equal(requests.length, 3);
  assert.equal(requests.at(-1).body.contents[0].parts.filter(part => part.inlineData).length, 1);
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].text), 'BASELINE_SYNTHETIC_DRAFT');
  await openRecord(ids[0]); await policy();
  await preview('assisted'); await confirm(); await idle();
  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1).body.contents[0].parts.filter(part => part.inlineData).length, 2);
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].text), 'ASSISTED_SYNTHETIC_DRAFT');

  // Error and cancellation retain the user's current document and do not run fallbacks.
  await openRecord(ids[0]); await policy();
  const preservedDocument = await page.evaluate(() => JSON.stringify(testUI.videoState.document.segments));
  await preview('comparison'); replies.push('rate-limit'); await confirm(); await idle();
  assert.equal(requests.length, 5, '429 must stop comparison before request two');
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document.segments)), preservedDocument);
  await capture('rate-limit');
  await preview('baseline'); replies.push('invalid'); await confirm(); await idle();
  assert.equal(requests.length, 6);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document.segments)), preservedDocument);
  await preview('baseline'); replies.push('hold'); await confirm();
  for (let i = 0; !releaseResponse && i < 3000; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseResponse, 'intercepted request must begin within 30 seconds');
  await page.locator('#videoCancelBtn').click();
  await idle(); releaseResponse(); releaseResponse = null;
  assert.equal(requests.length, 7);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document.segments)), preservedDocument);
  await preview('baseline'); await confirm(); await idle();
  assert.equal(requests.length, 8, 'explicit retry may issue one new request');
  await preview('baseline'); await page.locator('#aiReviewCancelBtn').click();
  assert.equal(requests.length, 8, 'cancelling preview must send nothing');

  await page.locator('[data-view="library"]').click();
  await page.locator('#view-library').waitFor({ state: 'visible' });
  await openRecord(ids[0]); await policy();
  await preview('baseline');
  await page.goBack();
  await page.locator('#aiReviewDialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#view-library').isVisible(), true);
  assert.equal(requests.length, 8, 'browser back must invalidate unsubmitted approval');

  await openRecord(ids[0]); await policy(); await chooseTwoReferences();
  const almostLimit = Buffer.concat([clips[0], Buffer.alloc(12 * 1024 * 1024 - clips[0].length - 1)]);
  await page.locator('#videoFile').setInputFiles({ name: 'padded-synthetic.webm', mimeType: 'video/webm', buffer: almostLimit });
  await page.waitForFunction(() => testUI.videoState.file?.name === 'padded-synthetic.webm' && !testUI.videoState.loading);
  await rejectPreparation('assisted');
  assert.match(await page.locator('#videoNotice').innerText(), /합계.*12MB/);
  assert.equal(requests.length, 8);

  // A reference revision changed during baseline must prevent the assisted request.
  await openRecord(ids[0]); await policy(); await chooseTwoReferences();
  await preview('comparison'); replies.push('hold'); await confirm();
  for (let i = 0; !releaseResponse && i < 3000; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseResponse);
  await page.evaluate(async id => {
    const reference = await testUI.personalLibrary.get(id);
    await testUI.personalLibrary.save({ ...reference, expectedRevision: reference.revision });
  }, ids[1]);
  releaseResponse(); releaseResponse = null; await idle();
  assert.equal(requests.length, 9, 'stale assisted input must not issue request two');
  const partial = await page.evaluate(() => testUI.videoState.document.audit);
  assert.equal(partial.runs.length, 2);
  assert.equal(partial.runs[0].status, 'complete');
  assert.equal(partial.runs[1].status, 'failed');
  assert.equal(partial.runs[1].variant, 'assisted');
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].text), 'TARGET_NATURAL_NEVER_SEND');

  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('PASS: explicit per-request preview approval, unpaid personal-data/paid billing guards, reviewed-only opt-in annotation search, unfinished target save preservation with unreviewed/blank-text/blank-literal/uncertain/empty comparison rejection and corrected-target retry, post-preview target review rejection, baseline/assisted/comparison request counts, sequential identical-target comparison, target annotation exclusion, full reference video+annotations, fixed model/fps, max-two and aggregate-12MB limits, stale/deleted reference and changed target approval rejection, date/session/hash separation, audit save/reload/backup, single-mode adoption, 429 stop/no fallback, invalid response retention, cancel/retry/repeated click, preview cancellation/history back, mid-comparison revision stop and partial audit, PC/390px/320px overflow and screenshots. Synthetic data only; all external traffic intercepted or blocked.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true });
}
