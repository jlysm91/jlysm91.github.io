import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeAIAudit, aiAuditText } from '../js/ai-audit.js';
import { createVideoDocument, validateVideoDocument, videoDocumentText } from '../js/video-document.js';
import { PersonalLibrary, normalizePersonalInput, encodePersonalBackup, decodePersonalBackup } from '../js/personal-library.js';

const video = new Blob([new Uint8Array([0, 1, 2, 3, 127, 128, 255])], { type: 'video/webm' });
const videoHash = Buffer.from(await crypto.subtle.digest('SHA-256', await video.arrayBuffer())).toString('hex');
const referenceHash = 'b'.repeat(64);
const annotation = (text = '내일 만나는지 묻는 말입니다.') => ({
  id: 1, start: 0.25, end: 3.5, original: '', text, source: 'manual', reviewed: true,
  literal: '내일 만나다 질문', context: '약속 시간을 정하는 중', referents: '상대방', intent: '질문', uncertainty: '',
});
const response = text => ({
  segments: [{ start: 0.25, end: 3.5, text, uncertain: true }], summary: text,
  unreadableReason: '', model: 'gemini-test-model', modelVersion: 'test-model-version',
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 35 },
});
function auditFixture() {
  return {
    version: 1, runId: 'comparison_fixture_1', createdAt: 1790985600000,
    model: 'gemini-test-model', promptVersion: 'ksl-compare-v1', mode: 'comparison',
    target: { sha256: videoHash, id: 'personal_target', revision: 2, session: '다른 날 촬영', captureDay: '2026-10-03', annotations: [annotation('사용자가 따로 기록한 대상 정답')] },
    references: [{ id: 'personal_reference', revision: 4, sha256: referenceHash, title: '약속의 질문 예시', session: '참고 촬영', captureDay: '2026-10-02', duration: 4, annotations: [annotation()] }],
    runs: [{ variant: 'baseline', status: 'complete', result: response('기본 AI 원본') }, { variant: 'assisted', status: 'complete', result: response('참고 포함 AI 원본') }],
    evaluation: { meaning: 'unrated', note: '' },
  };
}
function personalFixture(audit = auditFixture()) {
  return {
    id: 'personal_target', revision: 3, createdAt: 1790985600000, updatedAt: 1790985600000,
    title: '비교용 합성 자료', session: '다른 날 촬영', captureDay: '2026-10-03', role: 'test',
    fileName: 'synthetic.webm', video, sha256: videoHash,
    document: { source: 'manual', duration: 4, limitation: '', segments: [annotation('대상의 편집 가능한 정답')], ...(audit === undefined ? {} : { audit }) },
  };
}
async function rewriteBackup(backup, transform) {
  const bytes = new Uint8Array(await backup.arrayBuffer());
  const length = new DataView(bytes.buffer).getUint32(8, false);
  const header = JSON.parse(new TextDecoder().decode(bytes.slice(12, 12 + length)));
  transform(header);
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const prefix = bytes.slice(0, 12); new DataView(prefix.buffer).setUint32(8, encoded.length, false);
  return new Blob([prefix, encoded, bytes.slice(12 + length)]);
}

test('audit snapshots originals and ground truth separately, with immutable provenance and editable evaluation', () => {
  const raw = auditFixture();
  const audit = normalizeAIAudit(raw, 4);
  raw.runs[0].result.segments[0].text = 'caller changed response';
  raw.target.annotations[0].text = 'caller changed ground truth';
  raw.references[0].annotations[0].literal = 'caller changed reference';
  assert.equal(audit.runs[0].result.segments[0].text, '기본 AI 원본');
  assert.equal(audit.target.annotations[0].text, '사용자가 따로 기록한 대상 정답');
  assert.equal(audit.references[0].annotations[0].literal, '내일 만나다 질문');
  assert.throws(() => { audit.runs[0].result.segments[0].text = 'mutated'; }, TypeError);
  assert.throws(() => { audit.references.push({}); }, TypeError);
  assert.throws(() => { audit.target = {}; }, TypeError);
  audit.evaluation.meaning = 'assisted'; audit.evaluation.note = '질문의 의도가 더 잘 보존됨';
  assert.equal(audit.evaluation.meaning, 'assisted');
  audit.evaluation = { meaning: 'equal', note: '동일한 의미' };
  assert.equal(audit.evaluation.meaning, 'equal');
  assert.equal(Object.isFrozen(raw.target), false, 'caller working data must remain editable');
});

test('normalization drops unknown credentials and transport payloads at every persisted depth', () => {
  const raw = auditFixture();
  raw.apiKey = 'excluded-key'; raw.headers = { authorization: 'excluded-key' };
  raw.target.inlineData = { data: 'excluded-target-base64' };
  raw.references[0].video = video; raw.references[0].apiKey = 'excluded-key';
  raw.references[0].annotations[0].secret = 'excluded-secret';
  raw.runs[0].request = { apiKey: 'excluded-key' };
  raw.runs[0].result.rawResponse = 'excluded-raw';
  raw.runs[0].result.usageMetadata.apiKey = 'excluded-key';
  raw.evaluation.secret = 'excluded-secret';
  const output = JSON.stringify(normalizeAIAudit(raw, 4));
  for (const forbidden of ['excluded-', 'apiKey', 'authorization', 'inlineData', 'rawResponse']) assert.equal(output.includes(forbidden), false);
  assert.match(output, /"totalTokenCount":35/);
  assert.match(output, /test-model-version/);
  assert.match(output, /사용자가 따로 기록한 대상 정답/);
});

test('adopting an AI result cannot rewrite the local target ground truth or either original response', () => {
  const audit = auditFixture();
  const doc = createVideoDocument({ ...audit.runs[1].result, audit }, 'ai', 4);
  doc.segments[0].text = '사용자의 최종 수정'; doc.segments[0].reviewed = true;
  assert.equal(doc.segments[0].original, '참고 포함 AI 원본');
  assert.equal(doc.audit.runs[1].result.segments[0].text, '참고 포함 AI 원본');
  assert.equal(doc.audit.runs[0].result.segments[0].text, '기본 AI 원본');
  assert.equal(doc.audit.target.annotations[0].text, '사용자가 따로 기록한 대상 정답');
  assert.equal(validateVideoDocument(doc), '');
});

test('personal normalization, JSON and full-video backup preserve responses, reference revisions and evaluation', async () => {
  const input = personalFixture();
  input.document.audit.evaluation = { meaning: 'assisted', note: '지시 대상은 여전히 확인 필요' };
  const normalized = normalizePersonalInput(input);
  const json = JSON.parse(JSON.stringify(normalized.document));
  assert.deepEqual(json.audit, input.document.audit);
  const backup = await encodePersonalBackup(input);
  const restored = await decodePersonalBackup(backup);
  assert.deepEqual(restored.document.audit, normalized.document.audit);
  assert.equal(restored.document.audit.references[0].revision, 4);
  assert.equal(restored.document.audit.evaluation.note, '지시 대상은 여전히 확인 필요');
  assert.equal(restored.document.audit.target.id, 'personal_target', 'restored record ID changes separately from original analysis provenance');
  assert.equal(restored.id, undefined);
  assert.deepEqual(new Uint8Array(await restored.video.arrayBuffer()), new Uint8Array(await video.arrayBuffer()));
});

test('older documents and backups without audit remain compatible', async () => {
  const input = personalFixture(); delete input.document.audit;
  const normalized = normalizePersonalInput(input);
  assert.equal(Object.hasOwn(normalized.document, 'audit'), false);
  const restored = await decodePersonalBackup(await encodePersonalBackup(input));
  assert.equal(Object.hasOwn(restored.document, 'audit'), false);
  assert.equal(validateVideoDocument(restored.document), '');
  assert.equal(Object.hasOwn(createVideoDocument(response('초안'), 'ai', 4), 'audit'), false);
});

test('malformed envelope, reference versions/hashes, dates, timestamps and field bounds are rejected', () => {
  const edits = [
    row => { row.version = 2; }, row => { row.runId = ''; }, row => { row.createdAt = 'today'; },
    row => { row.model = ' '; }, row => { row.promptVersion = 'x'.repeat(101); },
    row => { row.target.id = undefined; }, row => { row.target.revision = 0; }, row => { row.target.sha256 = 'x'; },
    row => { row.references[0].revision = -1; }, row => { row.references[0].sha256 = 'b'.repeat(63); },
    row => { row.references[0].captureDay = '2026-02-30'; }, row => { row.references[0].duration = 61; },
    row => { row.references[0].annotations[0].end = 5; }, row => { row.target.annotations[0].start = -1; },
    row => { row.references[0].annotations[0].reviewed = 'yes'; }, row => { row.references[0].annotations[0].literal = 'x'.repeat(1001); },
    row => { row.target.annotations.push({ ...row.target.annotations[0], id: '1' }); },
    row => { row.references.push(structuredClone(row.references[0])); },
    row => { row.references = Array(3).fill(row.references[0]); },
    row => { row.runs[1].variant = 'baseline'; }, row => { row.mode = 'baseline'; },
    row => { row.runs[0].status = 'pending'; }, row => { row.runs[0].result.segments[0].uncertain = false; },
    row => { row.runs[0].result.segments[0].end = 4.1; }, row => { row.runs[0].result.segments[0].start = NaN; },
    row => { row.runs[0].result.usageMetadata.totalTokenCount = -1; },
    row => { row.evaluation.meaning = 'accurate'; }, row => { row.evaluation.note = 'x'.repeat(1001); },
  ];
  for (const edit of edits) { const value = auditFixture(); edit(value); assert.throws(() => normalizeAIAudit(value, 4), /AI 비교 기록/); }
  assert.throws(() => normalizeAIAudit(auditFixture(), 0), /영상 길이/);
});

test('partial failure, cancellation and abstention remain explicit without fabricated completed outputs', () => {
  const audit = auditFixture();
  audit.runs[1] = { variant: 'assisted', status: 'cancelled', error: '사용자가 취소함' };
  assert.equal(normalizeAIAudit(audit, 4).runs[1].result, undefined);
  audit.runs[1] = { variant: 'assisted', status: 'failed', error: '합성 API 오류' };
  assert.equal(normalizeAIAudit(audit, 4).runs[0].status, 'complete');
  assert.match(aiAuditText(audit, 4), /참고 예시 포함: 실패 · 합성 API 오류/);
  audit.runs[1].result = response('올바르지 않은 완료 표시');
  assert.throws(() => normalizeAIAudit(audit, 4), /실패·취소/);
  delete audit.runs[1].result; audit.runs[1].error = 'x'.repeat(501);
  assert.throws(() => normalizeAIAudit(audit, 4), /500자/);
  audit.runs[1] = { variant: 'assisted', status: 'complete', result: { segments: [], unreadableReason: '영상 근거가 부족하여 보류함', modelVersion: '' } };
  assert.equal(normalizeAIAudit(audit, 4).runs[1].result.segments.length, 0);
  audit.runs[1].result.modelVersion = null;
  assert.equal(normalizeAIAudit(audit, 4).runs[1].result.modelVersion, null, 'unavailable provider version remains explicitly unknown');
  audit.runs[1].result.unreadableReason = '';
  assert.throws(() => normalizeAIAudit(audit, 4), /판독 보류 사유/);
});

test('TXT exposes model/reference versions and evaluation while retaining the unvalidated KSL qualification', () => {
  const input = personalFixture();
  input.document.audit.evaluation = { meaning: 'neither', note: '두 결과 모두 질문을 서술문으로 바꿈' };
  const output = videoDocumentText(input.document);
  for (const expected of ['gemini-test-model', 'ksl-compare-v1', 'personal_reference / 버전 4', 'test-model-version', '둘 다 의미가 맞지 않음', '두 결과 모두 질문을 서술문으로 바꿈', '한국수어 성능 미검증', '범용 정확도를 나타내지 않습니다']) assert.ok(output.includes(expected), expected);
  assert.ok(output.includes('원본 AI 응답·참고 주석·평가용 대상 주석은 JSON'));
});

test('a forged backup or a different video cannot inherit unrelated audit provenance', async () => {
  const input = personalFixture();
  const backup = await encodePersonalBackup(input);
  const forged = await rewriteBackup(backup, header => { header.record.document.audit.references[0].revision = 0; });
  await assert.rejects(decodePersonalBackup(forged), /버전/);
  input.document.audit.target.sha256 = 'c'.repeat(64);
  assert.throws(() => normalizePersonalInput(input), /대상 영상/);
  await assert.rejects(encodePersonalBackup(input), /대상 영상/);
  const library = new PersonalLibrary({ indexedDB: null });
  delete input.sha256; delete input.id;
  await assert.rejects(library.save(input), /대상 영상/, 'hash mismatch must fail before entering unavailable storage');
});

test('the shared metadata cap includes nested audit annotations before any save or backup', () => {
  const input = personalFixture();
  const long = { ...annotation(), text: '글'.repeat(500), original: '원'.repeat(1000), ...Object.fromEntries(['literal', 'context', 'referents', 'intent', 'uncertainty'].map(field => [field, '문'.repeat(1000)])) };
  input.document.audit.references[0].annotations = Array.from({ length: 100 }, (_, index) => ({ ...long, id: index + 1 }));
  assert.throws(() => normalizePersonalInput(input), /주석 용량/);
});
