import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PersonalLibrary, normalizePersonalInput, encodePersonalBackup, decodePersonalBackup,
  searchPersonalRecords, MAX_PERSONAL_VIDEO_BYTES, MAX_PERSONAL_HEADER_BYTES,
} from '../js/personal-library.js';

const bytes = new Uint8Array([0, 1, 2, 3, 128, 255, 17, 19]);
const video = new Blob([bytes], { type: 'video/webm' }); // Synthetic bytes; media decoding belongs to browser tests.
const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
function fixture(overrides = {}) {
  return {
    id: 'personal_fixture', revision: 3, createdAt: 1728000000000, updatedAt: 1728000001000,
    title: '도서관에서 만나는 약속', captureDay: '2026-10-02', session: '촬영 A', role: 'reference',
    fileName: 'synthetic.webm', video, sha256,
    document: { source: 'ai', duration: 4, limitation: '질문 여부 확인 필요', segments: [{
      id: 1, start: 0.5, end: 3.5, original: 'AI의 원본 후보', text: '내일 도서관에서 만나요.',
      source: 'ai', reviewed: false, literal: '내일 도서관 만나다', context: '약속 장소를 정하는 중',
      referents: '상대방', intent: '만남 제안', uncertainty: '시각은 영상에서 확인되지 않음',
    }] }, ...overrides,
  };
}
function fromInput(input) { return { ...fixture(), ...input }; }
async function rewriteHeader(backup, change) {
  const all = new Uint8Array(await backup.arrayBuffer());
  const length = new DataView(all.buffer).getUint32(8, false);
  const header = JSON.parse(new TextDecoder().decode(all.slice(12, 12 + length)));
  change(header);
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const size = new Uint8Array(4); new DataView(size.buffer).setUint32(0, encoded.length, false);
  return new Blob([all.slice(0, 8), size, encoded, all.slice(12 + length)]);
}

test('full backup preserves original video bytes, original candidate and distinct annotations', async () => {
  const source = fixture();
  source.secret = 'must-never-enter-backup';
  source.document.apiKey = 'never-document-key';
  source.document.segments[0].unknown = 'never-segment-key';
  const normalized = normalizePersonalInput(source);
  assert.equal(normalized.secret, undefined);
  assert.equal(normalized.document.apiKey, undefined);
  assert.equal(normalized.document.segments[0].unknown, undefined);
  const backup = await encodePersonalBackup(source);
  const restored = await decodePersonalBackup(backup);
  assert.deepEqual(new Uint8Array(await restored.video.arrayBuffer()), bytes);
  assert.deepEqual(restored.document, normalized.document);
  assert.equal(restored.document.segments[0].original, 'AI의 원본 후보');
  assert.equal(restored.document.segments[0].text, '내일 도서관에서 만나요.');
  assert.equal(restored.document.segments[0].reviewed, false);
  assert.equal(restored.sha256, sha256);
  assert.equal(restored.id, undefined, 'restore is a new record and must not target an existing ID');
  assert.equal(restored.revision, undefined);
  assert.equal(restored.createdAt, undefined);
  assert.ok(!(await backup.text()).includes('must-never-enter-backup'));
  assert.equal(source.secret, 'must-never-enter-backup', 'validation must not mutate source');
});

test('video-free, wrong-type and oversized inputs cannot be labelled durable videos', () => {
  for (const replacement of [null, new Blob([]), new Blob(['text'], { type: 'text/html' })]) {
    assert.throws(() => normalizePersonalInput(fixture({ video: replacement })));
  }
  assert.throws(() => normalizePersonalInput(fixture({ video: new Blob([new Uint8Array(MAX_PERSONAL_VIDEO_BYTES + 1)], { type: 'video/webm' }) })), /50MiB/);
  const untyped = new Blob([bytes]);
  assert.equal(normalizePersonalInput(fixture({ video: untyped })).video, untyped);
  assert.throws(() => normalizePersonalInput(fixture({ video: untyped, fileName: 'payload.txt' })), /형식/);
});

test('annotation validation rejects cross-field times, unsupported roles, dates and duplicate IDs', () => {
  const bad = [
    row => { row.title = '   '; },
    row => { row.role = 'trained'; },
    row => { row.captureDay = '2026-02-30'; },
    row => { row.document.duration = 61; },
    row => { row.document.duration = NaN; },
    row => { row.document.segments[0].end = 5; },
    row => { row.document.segments[0].start = -1; },
    row => { row.document.segments[0].end = row.document.segments[0].start; },
    row => { row.document.segments[0].reviewed = 'true'; },
    row => { row.document.segments[0].source = 'certified'; },
    row => { row.document.segments[0].text = 'x'.repeat(501); },
    row => { row.document.segments[0].literal = 'x'.repeat(1001); },
    row => { row.document.segments.push({ ...row.document.segments[0], id: '1' }); },
    row => { row.document.segments = Array(101).fill(row.document.segments[0]); },
    row => { row.session = '\u0000'; },
  ];
  for (const change of bad) { const input = fixture(); change(input); assert.throws(() => normalizePersonalInput(input)); }
  assert.equal(normalizePersonalInput(fixture({ captureDay: '2024-02-29' })).captureDay, '2024-02-29');
  assert.deepEqual(normalizePersonalInput(fixture({ document: { source: 'manual', duration: 4, segments: [] } })).document.segments, []);
});

test('save validation enforces the backup metadata budget before persistence', () => {
  const input = fixture();
  input.document.segments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, start: 0, end: 1, original: '원'.repeat(1000), text: '글'.repeat(500), source: 'manual', reviewed: false,
    ...Object.fromEntries(['literal', 'context', 'intent', 'referents', 'uncertainty'].map(field => [field, '문'.repeat(1000)])),
  }));
  assert.throws(() => normalizePersonalInput(input), /주석 용량/);
});

test('backup rejects wrong magic, oversized header, truncated payload and unsupported version', async () => {
  const backup = await encodePersonalBackup(fixture());
  await assert.rejects(decodePersonalBackup(new Blob(['{}'])), /지원하는/);
  await assert.rejects(decodePersonalBackup(new Blob(['plain text is not a video backup'])), /TXT·JSON/);
  await assert.rejects(decodePersonalBackup(backup.slice(0, backup.size - 1)), /크기/);
  const prefix = new Uint8Array(await backup.slice(0, 12).arrayBuffer());
  new DataView(prefix.buffer).setUint32(8, MAX_PERSONAL_HEADER_BYTES + 1, false);
  await assert.rejects(decodePersonalBackup(new Blob([prefix, 'remaining data'])), /주석 길이/);
  await assert.rejects(decodePersonalBackup(await rewriteHeader(backup, header => { header.version = 2; })), /버전/);
});

test('backup import validates hash, video type, annotation bounds and invalid UTF-8', async () => {
  const backup = await encodePersonalBackup(fixture());
  const corrupted = new Uint8Array(await backup.arrayBuffer()); corrupted[corrupted.length - 1] ^= 1;
  await assert.rejects(decodePersonalBackup(new Blob([corrupted])), /확인값/);
  await assert.rejects(encodePersonalBackup(fixture({ video: new Blob(['changed'], { type: 'video/webm' }) })), /확인값/);
  for (const change of [
    header => { header.video.type = 'text/html'; },
    header => { header.video.size += 1; },
    header => { header.record.document.segments[0].end = 61; },
    header => { header.record.sha256 = 'invalid'; },
    header => { header.record.revision = 0; },
  ]) await assert.rejects(decodePersonalBackup(await rewriteHeader(backup, change)));
  const badUTF8 = new Uint8Array(await backup.arrayBuffer()); badUTF8[12] = 255;
  await assert.rejects(decodePersonalBackup(new Blob([badUTF8])), /주석을 읽을 수/);
});

test('annotation search is plain text across context, literal, intent and session', () => {
  const first = fixture();
  const second = fixture({ id: 'personal_second', title: '식당', session: 'B', document: { source: 'manual', duration: 4, segments: [] } });
  assert.deepEqual(searchPersonalRecords([first, second], ' 도서관  약속 '), [first]);
  assert.deepEqual(searchPersonalRecords([first, second], '만나다 시각'), [first]);
  assert.deepEqual(searchPersonalRecords([first, second], '촬영 a'), [first]);
  assert.deepEqual(searchPersonalRecords([first, second], '식당'), [second]);
  assert.deepEqual(searchPersonalRecords([first, second], '없는 문장'), []);
  const all = [first, second]; assert.notEqual(searchPersonalRecords(all, ''), all);
  assert.deepEqual(searchPersonalRecords([{ id: 'broken', title: '손상 자료', broken: true, document: null }], '손상').map(row => row.id), ['broken']);
});

test('unavailable IndexedDB never falls back to a memory success', async () => {
  const library = new PersonalLibrary({ indexedDB: null });
  await assert.rejects(library.init(), /로컬 저장을 사용할 수/);
  await assert.rejects(library.save(fixture({ id: undefined })), /로컬 저장을 사용할 수/);
  await assert.rejects(library.list(), /로컬 저장을 사용할 수/);
});

test('an already-cancelled save does not access storage or hash the video', async () => {
  let opened = false;
  const library = new PersonalLibrary({ indexedDB: { open() { opened = true; throw new Error('must not open'); } } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(library.save({ ...fixture(), signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(library.remove('personal_fixture', 3, controller.signal), { name: 'AbortError' });
  assert.equal(opened, false);
});

// A controlled commit boundary checks the failure contract, not IndexedDB behavior.
// Real browser persistence, cross-tab races and reload are covered by browser tests.
function controlledLibrary({ rows = [], putError = null } = {}) {
  let tx, written, readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const library = new PersonalLibrary({ indexedDB: null });
  library._database = async () => ({ transaction() {
    tx = {
      error: null,
      abort() { queueMicrotask(() => tx.onabort?.()); },
      objectStore() { return {
        getAll() { const request = {}; queueMicrotask(() => { request.result = rows; request.onsuccess(); readyResolve(); }); return request; },
        put(record) { if (putError) throw putError; written = record; },
        delete() { written = 'delete'; },
      }; },
    };
    return tx;
  } });
  return { library, ready, transaction: () => tx, written: () => written };
}

test('save resolves only after a completed transaction, not a successful put', async () => {
  const controlled = controlledLibrary();
  let finished = false;
  const pending = controlled.library.save(fixture({ id: undefined })).then(result => { finished = true; return result; });
  await controlled.ready;
  assert.equal(finished, false);
  assert.equal(controlled.written().video, video);
  controlled.transaction().oncomplete();
  const result = await pending;
  assert.equal(result.revision, 1);
  assert.equal(result.sha256, sha256);
  assert.equal(result.broken, false);
});

test('quota failure and cancellation before commit never return a saved record', async () => {
  const controlled = controlledLibrary({ putError: new DOMException('synthetic quota', 'QuotaExceededError') });
  await assert.rejects(controlled.library.save(fixture({ id: undefined })), /저장 공간이 부족/);
  assert.equal(controlled.written(), undefined);
  const cancellable = controlledLibrary();
  const controller = new AbortController();
  const pending = cancellable.library.save(fixture({ id: undefined, signal: controller.signal }));
  await cancellable.ready; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('stale revisions and capacity failures do not issue writes', async () => {
  const current = fixture();
  const changed = controlledLibrary({ rows: [current] });
  await assert.rejects(changed.library.save(fixture({ expectedRevision: 2 })), /다른 탭/);
  assert.equal(changed.written(), undefined);
  const full = controlledLibrary({ rows: Array.from({ length: 20 }, (_, i) => fixture({ id: `personal_${i}` })) });
  await assert.rejects(full.library.save(fixture({ id: undefined })), /최대 20개/);
  assert.equal(full.written(), undefined);
  const largeVideo = new Blob([new Uint8Array(MAX_PERSONAL_VIDEO_BYTES)], { type: 'video/webm' });
  const tooLarge = controlledLibrary({ rows: Array.from({ length: 4 }, (_, i) => fixture({ id: `personal_${i}`, video: largeVideo })) });
  await assert.rejects(tooLarge.library.save(fixture({ id: undefined })), /200MiB/);
  assert.equal(tooLarge.written(), undefined);
});
