// Run: node tests/personal-library.browser.mjs
// Local synthetic footage only. Every request outside this test server is blocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = resolve(import.meta.dirname, '..');
const tmp = await mkdtemp(join(tmpdir(), 'ksl-personal-library-'));
const fixture = join(tmp, 'synthetic-reference.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xc8d9ee:s=320x240:r=8', '-t', '4', '-c:v', 'libvpx', fixture]);
const fixtureBytes = await readFile(fixture);
const hook = '\nglobalThis.testUI = { videoState, personalLibrary, libraryUI, selectVideoFile, addVideoSegment, store };';
const server = createServer(async (req, res) => {
  if (req.url === '/__storage-test__') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local storage verification</title>'); return; }
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
  const errors = [], external = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') || url.startsWith('blob:')) return route.continue();
    external.push(url); await route.abort();
  });
  let acceptDialog = true;
  const observe = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => acceptDialog ? dialog.accept() : dialog.dismiss());
  };
  const page = await context.newPage(); observe(page);
  await page.goto(origin + '/__storage-test__');
  const storageChecks = await page.evaluate(async bytes => {
    const { PersonalLibrary } = await import('/js/personal-library.js');
    const dbName = 'ksl-personal-transaction-test';
    const library = await new PersonalLibrary({ dbName }).init();
    const input = {
      title: '합성 저장 검증', fileName: 'synthetic.webm', session: 'synthetic-A', role: 'reference',
      video: new Blob([new Uint8Array(bytes)], { type: 'video/webm' }),
      document: { source: 'manual', duration: 4, limitation: '', segments: [{ id: 1, start: 0, end: 2, original: '', text: '합성 주석', source: 'manual', reviewed: false }] },
    };
    const check = (value, message) => { if (!value) throw new Error(message); };
    const expectFailure = async (operation, pattern) => {
      let failure; try { await operation(); } catch (error) { failure = error; }
      check(failure && pattern.test(failure.name + ': ' + failure.message), 'Expected rejection: ' + pattern);
    };
    const aborted = new AbortController(); aborted.abort();
    await expectFailure(() => library.save({ ...input, signal: aborted.signal }), /AbortError/);
    check((await library.list()).length === 0, 'pre-cancelled save must not persist');
    // Abort the real IndexedDB transaction immediately after a put is queued.
    const during = new AbortController();
    const database = await library._database();
    const originalTransaction = database.transaction.bind(database);
    database.transaction = (...args) => {
      const transaction = originalTransaction(...args);
      if (args[1] === 'readwrite') {
        const objectStore = transaction.objectStore.bind(transaction);
        transaction.objectStore = (...storeArgs) => {
          const store = objectStore(...storeArgs), put = store.put.bind(store);
          store.put = (...putArgs) => { const request = put(...putArgs); during.abort(); return request; };
          return store;
        };
      }
      return transaction;
    };
    await expectFailure(() => library.save({ ...input, signal: during.signal }), /AbortError/);
    database.transaction = originalTransaction;
    check((await library.list()).length === 0, 'aborted queued put must be rolled back');
    const first = await library.save(input);
    const concurrent = await Promise.allSettled([
      library.save({ ...input, id: first.id, expectedRevision: 1, title: '첫 번째 동시 수정' }),
      library.save({ ...input, id: first.id, expectedRevision: 1, title: '두 번째 동시 수정' }),
    ]);
    check(concurrent.filter(result => result.status === 'fulfilled').length === 1, 'only one concurrent revision may commit');
    check((await library.get(first.id)).revision === 2, 'concurrent writes must produce revision 2');
    await expectFailure(() => library.remove(first.id, 1), /변경/);
    check((await library.list()).length === 1, 'stale delete must retain updated record');
    await library.remove(first.id, 2);
    for (let index = 0; index < 20; index++) await library.save({ ...input, title: '자료 ' + index });
    await expectFailure(() => library.save(input), /20개/);
    check((await library.list()).length === 20, 'record cap rejection must be atomic');
    await library.close();
    await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(dbName); request.onsuccess = resolve; request.onerror = () => reject(request.error); });
    await expectFailure(() => new PersonalLibrary({ indexedDB: null }).init(), /로컬 저장/);
    return ['pre-cancelled save', 'real transaction rollback after put', 'concurrent revision conflict', 'stale delete rejection', '20-record cap', 'unavailable storage failure'];
  }, [...fixtureBytes]);
  assert.equal(storageChecks.length, 6);
  console.log('PASS: real IndexedDB ' + storageChecks.join(', ') + '.');
  if (!process.argv.includes('--store-only')) {
  const ready = async page => {
    await page.waitForFunction(() => globalThis.testUI?.personalLibrary);
    await page.evaluate(() => testUI.personalLibrary.init());
  };
  const records = () => page.evaluate(async () => (await testUI.personalLibrary.list()).map(({ id, revision, broken }) => ({ id, revision, broken })));
  const waitCount = async count => {
    await page.waitForFunction(() => !testUI.libraryUI.busy());
    assert.equal((await records()).length, count, await page.locator('#libraryStatus').innerText());
  };
  const openLibrary = async () => {
    await page.locator('[data-view="library"]').click();
    await page.locator('#view-library').waitFor({ state: 'visible' });
  };
  const card = id => page.locator(`[data-library-id="${id}"]`);
  const choose = async () => {
    await page.locator('[data-view="video"]').click();
    await page.locator('#videoFile').setInputFiles(fixture);
    await page.waitForFunction(() => testUI.videoState.duration > 0 && !testUI.videoState.loading && !testUI.videoState.canceling);
  };
  const save = async () => {
    await page.locator('#personalSaveBtn').click();
    await page.waitForFunction(() => !testUI.videoState.dirty && !document.getElementById('personalSaveBtn').disabled);
  };
  const segmentField = label => page.getByRole('textbox', { name: `1번 구간 ${label}`, exact: true });
  const takeScreenshots = async name => {
    await mkdir(join(root, 'dist'), { recursive: true });
    if (name === 'editor') {
      // Start and pause the synthetic clip as a user would, so the native player paints a frame.
      await page.locator('#uploadedVideo').evaluate(async video => { await video.play(); video.pause(); });
      await page.waitForFunction(() => document.getElementById('uploadedVideo').readyState >= 2);
    }
    for (const [suffix, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['narrow', 320, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} overflow at ${width}px`);
      await page.screenshot({ path: join(root, `dist/personal-${name}-${suffix}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  };

  await page.goto(origin + '/'); await ready(page);
  // The auxiliary word dictionary is a separate store and must survive this workflow.
  await page.evaluate(async () => {
    await testUI.store.saveSample('보존할 단어', { id: 'personal-library-test', featureVersion: 2, duration: 2, frames: Array.from({ length: 24 }, () => Array(136).fill(.1)) });
  });
  const dictionaryBefore = await page.evaluate(async () => JSON.stringify(await testUI.store.list()));
  await openLibrary();
  assert.equal(await page.locator('[data-library-id]').count(), 0);
  await takeScreenshots('empty');
  await choose(); await page.locator('#videoAddSegment').click();
  await page.locator('#personalTitle').fill('약속 변경 · 합성 검증 자료');
  await page.getByText('촬영 정보 · 나중에 예시 비교하기', { exact: true }).click();
  await page.locator('#personalSession').fill('synthetic-session-A');
  await page.locator('#personalCaptureDay').fill('2026-10-01');
  await page.locator('#personalRole').selectOption('reference');
  await segmentField('직역').fill('내일 약속 시간 바꾸다');
  await segmentField('한국어 글').fill('내일 약속 시간을 바꿀 수 있을까요?');
  await page.getByText('상황·지시 대상·불확실성 기록', { exact: true }).click();
  await segmentField('상황·문맥').fill('만날 시간을 조정하는 상황');
  await segmentField('지시 대상').fill('화자와 대화 상대의 약속');
  await segmentField('의도').fill('시간 변경을 요청함');
  await segmentField('불확실한 부분').fill('손동작 없는 합성 영상이므로 수어 해석 검증 불가');
  await page.locator('.segment-editor').first().getByRole('checkbox').check();
  // Two same-turn clicks must not insert two copies.
  await page.evaluate(() => { const button = document.getElementById('personalSaveBtn'); button.click(); button.click(); });
  await waitCount(1);
  await page.waitForFunction(() => !testUI.videoState.dirty && !document.getElementById('personalSaveBtn').disabled);
  const initial = (await records())[0];
  assert.equal(initial.revision, 1);
  assert.equal(initial.broken, false);
  await takeScreenshots('editor');

  // Reload actually discards memory; opening must reconstruct both video and interpretation.
  await page.reload(); await ready(page); await openLibrary();
  await card(initial.id).getByRole('button', { name: '열기', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  await page.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading);
  assert.equal(await page.locator('#personalTitle').inputValue(), '약속 변경 · 합성 검증 자료');
  assert.equal(await segmentField('직역').inputValue(), '내일 약속 시간 바꾸다');
  assert.equal(await segmentField('한국어 글').inputValue(), '내일 약속 시간을 바꿀 수 있을까요?');
  await page.getByText('상황·지시 대상·불확실성 기록', { exact: true }).click();
  assert.equal(await segmentField('상황·문맥').inputValue(), '만날 시간을 조정하는 상황');
  assert.equal(await segmentField('지시 대상').inputValue(), '화자와 대화 상대의 약속');
  assert.equal(await segmentField('의도').inputValue(), '시간 변경을 요청함');
  assert.match(await segmentField('불확실한 부분').inputValue(), /수어 해석 검증 불가/);
  assert.equal(await page.locator('.segment-editor').first().getByRole('checkbox').isChecked(), true);
  assert.deepEqual(Buffer.from(await page.evaluate(async () => [...new Uint8Array(await testUI.videoState.file.arrayBuffer())])), fixtureBytes);
  await segmentField('한국어 글').fill('내일 약속을 오후로 바꿀 수 있을까요?');
  assert.equal(await page.locator('.segment-editor').first().getByRole('checkbox').isChecked(), false);
  await save();
  assert.equal((await records())[0].revision, 2);
  await openLibrary();
  for (const query of ['오후로', '내일 약속 시간 바꾸다', '만날 시간을 조정', '화자와 대화 상대', '시간 변경을 요청']) {
    await page.locator('#librarySearch').fill(query);
    assert.equal(await page.locator('[data-library-id]').count(), 1, `annotation search: ${query}`);
  }
  await page.locator('#librarySearch').fill('존재하지 않는 문자열');
  assert.equal(await page.locator('[data-library-id]').count(), 0);
  await page.locator('#librarySearch').fill('');
  await card(initial.id).getByRole('checkbox', { name: '약속 변경 · 합성 검증 자료 참고 예시 선택', exact: true }).focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.match(await page.locator('#librarySelectionStatus').innerText(), /1/);
  assert.equal(await card(initial.id).getByRole('checkbox').evaluate(node => node === document.activeElement && node.checked), true);
  await takeScreenshots('library');

  const downloadPromise = page.waitForEvent('download');
  await card(initial.id).getByRole('button', { name: '영상 포함 백업', exact: true }).click();
  const backup = await readFile(await (await downloadPromise).path());
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal(await card(initial.id).getByRole('button', { name: '영상 포함 백업', exact: true }).evaluate(node => node === document.activeElement), true);
  assert.equal(backup.subarray(0, 8).toString(), 'KSLVID1\n');
  const headerLength = backup.readUInt32BE(8);
  const header = JSON.parse(backup.subarray(12, 12 + headerLength).toString());
  assert.equal(header.format, 'ksl-personal-video');
  assert.deepEqual(backup.subarray(12 + headerLength), fixtureBytes, 'backup must include exact video bytes');
  assert.equal(backup.includes(Buffer.from('내일 약속을 오후로 바꿀 수 있을까요?')), true);

  // Declining deletion preserves the record and its selected reference.
  acceptDialog = false;
  await card(initial.id).getByRole('button', { name: '삭제', exact: true }).click();
  assert.equal((await records()).length, 1);
  acceptDialog = true;
  await card(initial.id).getByRole('button', { name: '삭제', exact: true }).click();
  await waitCount(0);
  assert.equal(await page.locator('[data-library-id]').count(), 0);
  const uploadBackup = async (buffer, name = 'synthetic-reference.kslvideo') => {
    await page.locator('#libraryImportFile').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  };
  await uploadBackup(backup); await waitCount(1);
  const restored = (await records())[0];
  assert.notEqual(restored.id, initial.id, 'restore must create a new identity, not overwrite old records');
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading);
  assert.equal(await segmentField('한국어 글').inputValue(), '내일 약속을 오후로 바꿀 수 있을까요?');
  assert.deepEqual(Buffer.from(await page.evaluate(async () => [...new Uint8Array(await testUI.videoState.file.arrayBuffer())])), fixtureBytes);
  await openLibrary();

  // Imports are all-or-nothing; corrupt metadata, bytes and cancellation retain the collection.
  const beforeInvalid = JSON.stringify(await records());
  const waitImportDone = async () => {
    await page.waitForFunction(() => !testUI.libraryUI.busy() && document.getElementById('libraryImportFile').value === '');
  };
  await uploadBackup(Buffer.from('not a backup')); await waitImportDone();
  assert.equal(JSON.stringify(await records()), beforeInvalid);
  const corrupted = Buffer.from(backup); corrupted[corrupted.length - 1] ^= 1;
  await uploadBackup(corrupted); await waitImportDone();
  assert.equal(JSON.stringify(await records()), beforeInvalid);
  const makeBackup = (metadata, video) => {
    const bytes = Buffer.from(JSON.stringify(metadata)), prefix = Buffer.alloc(12);
    prefix.write('KSLVID1\n'); prefix.writeUInt32BE(bytes.length, 8);
    return Buffer.concat([prefix, bytes, video]);
  };
  const invalidVideo = Buffer.from('valid backup hash but no decodable video');
  const invalidVideoHeader = structuredClone(header);
  invalidVideoHeader.video.size = invalidVideo.length;
  invalidVideoHeader.record.sha256 = createHash('sha256').update(invalidVideo).digest('hex');
  await uploadBackup(makeBackup(invalidVideoHeader, invalidVideo)); await waitImportDone();
  assert.equal(JSON.stringify(await records()), beforeInvalid);
  assert.match(await page.locator('#libraryStatus').innerText(), /재생할 수 없/);
  const mismatchedHeader = structuredClone(header); mismatchedHeader.record.document.duration = 5;
  await uploadBackup(makeBackup(mismatchedHeader, fixtureBytes)); await waitImportDone();
  assert.equal(JSON.stringify(await records()), beforeInvalid);
  assert.match(await page.locator('#libraryStatus').innerText(), /영상 길이/);
  await page.locator('#libraryImportFile').setInputFiles([]); await waitImportDone();
  assert.equal(JSON.stringify(await records()), beforeInvalid);
  await takeScreenshots('import-error');

  // Two tabs opening the same revision must not silently overwrite one another.
  const secondPage = await context.newPage(); observe(secondPage);
  await secondPage.goto(origin + '/#library'); await ready(secondPage);
  await secondPage.locator(`[data-library-id="${restored.id}"]`).getByRole('button', { name: '열기', exact: true }).click();
  await secondPage.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading);
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading);
  await segmentField('한국어 글').fill('먼저 저장한 탭의 수정 문장');
  await save();
  await secondPage.getByRole('textbox', { name: '1번 구간 한국어 글', exact: true }).fill('늦게 저장한 탭의 문장');
  await secondPage.locator('#personalSaveBtn').click();
  await secondPage.waitForFunction(() => !document.getElementById('personalSaveBtn').disabled);
  assert.equal((await records())[0].revision, 2, 'stale revision must not be committed');
  assert.equal(await secondPage.evaluate(() => testUI.videoState.dirty), true, 'failed save must preserve unsaved edits');
  await secondPage.close();
  await openLibrary();
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => testUI.videoState.file && !testUI.videoState.loading);
  assert.equal(await segmentField('한국어 글').inputValue(), '먼저 저장한 탭의 수정 문장');
  await segmentField('한국어 글').fill('열기 취소 시 유지할 작성 중 문장');
  await openLibrary(); acceptDialog = false;
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal(await page.evaluate(() => testUI.videoState.document.segments[0].text), '열기 취소 시 유지할 작성 중 문장');
  acceptDialog = true;
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => !testUI.videoState.loading && testUI.videoState.document?.segments[0]?.text === '먼저 저장한 탭의 수정 문장');
  await openLibrary();

  // Cancel while a read is pending, then retry. Old completion cannot reopen a view.
  const documentBeforeCancel = await page.evaluate(() => JSON.stringify(testUI.videoState.document));
  const pauseRead = async () => page.evaluate(() => {
    globalThis.originalLibraryGet = testUI.personalLibrary.get.bind(testUI.personalLibrary);
    globalThis.resumeLibraryRead = null;
    testUI.personalLibrary.get = async (...args) => {
      await new Promise(resolve => { globalThis.resumeLibraryRead = resolve; });
      return originalLibraryGet(...args);
    };
  });
  const resumeRead = async () => page.evaluate(() => {
    testUI.personalLibrary.get = globalThis.originalLibraryGet;
    globalThis.resumeLibraryRead();
  });
  await pauseRead();
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => globalThis.resumeLibraryRead);
  await page.locator('#libraryCancelBtn').click(); await resumeRead();
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal(await page.locator('#view-library').isVisible(), true);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), documentBeforeCancel);
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal(await page.locator('#view-video').isVisible(), true);
  await openLibrary(); await pauseRead();
  await card(restored.id).getByRole('button', { name: '열기', exact: true }).click();
  await page.waitForFunction(() => globalThis.resumeLibraryRead);
  await page.goBack(); await resumeRead();
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal(await page.locator('#view-video').isVisible(), true);
  assert.equal(await page.evaluate(() => JSON.stringify(testUI.videoState.document)), documentBeforeCancel);

  // Cancelling the save's hash read must keep the edit dirty and the stored revision intact.
  await segmentField('한국어 글').fill('저장 취소 후 다시 저장할 문장');
  const revisionBeforeCancel = (await records())[0].revision;
  await page.evaluate(() => {
    const file = testUI.videoState.file;
    globalThis.originalVideoArrayBuffer = file.arrayBuffer.bind(file);
    globalThis.resumeVideoHash = null;
    file.arrayBuffer = async () => {
      await new Promise(resolve => { globalThis.resumeVideoHash = resolve; });
      return originalVideoArrayBuffer();
    };
  });
  await page.locator('#personalSaveBtn').click();
  await page.waitForFunction(() => globalThis.resumeVideoHash);
  await page.locator('#personalCancelBtn').click();
  await page.evaluate(() => { testUI.videoState.file.arrayBuffer = globalThis.originalVideoArrayBuffer; globalThis.resumeVideoHash(); });
  await page.waitForFunction(() => !testUI.libraryUI.busy());
  assert.equal((await records())[0].revision, revisionBeforeCancel);
  assert.equal(await page.evaluate(() => testUI.videoState.dirty), true);
  await save();
  assert.equal((await records())[0].revision, revisionBeforeCancel + 1);
  await openLibrary();

  // Simulate a damaged browser record. It must never masquerade as a saved playable video.
  await page.evaluate(async id => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('ksl-personal-library', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readwrite'); const store = tx.objectStore('videos');
      const get = store.get(id); get.onsuccess = () => { const record = get.result; delete record.video; store.put(record); };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }); db.close();
  }, restored.id);
  await page.reload(); await ready(page); await openLibrary();
  assert.equal((await records())[0].broken, true);
  assert.equal(await card(restored.id).getByRole('button', { name: '열기', exact: true }).isDisabled(), true);
  assert.match(await card(restored.id).innerText(), /영상|손상|복원/);
  await takeScreenshots('broken');
  await card(restored.id).getByRole('button', { name: '삭제', exact: true }).click();
  await waitCount(0);
  await uploadBackup(backup); await waitCount(1);
  assert.equal((await records())[0].broken, false);
  assert.equal(await page.evaluate(async () => JSON.stringify(await testUI.store.list())), dictionaryBefore);
  assert.deepEqual(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(node => node.id); return ids.filter((id, i) => ids.indexOf(id) !== i); }), []);
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log('PASS: synthetic-video local save, double click guard, reload and exact video recovery, literal/natural/context annotations, review reset, revision update, annotation search and empty results, keyboard reference selection/open/backup focus, exact-video backup and new-copy restore, cancelled deletion/open, corrupt import atomicity, stale cross-tab revision protection, pending-read cancel/retry/history back, save cancel/retry, invalid codec and duration rejection, damaged video record and recovery, old dictionary preservation, PC/390px/320px overflow and screenshots. All external traffic blocked; no AI used.');
  }
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rm(tmp, { recursive: true, force: true });
}
