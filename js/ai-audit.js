/** Local comparison provenance. This module neither builds requests nor sends data. */
export const AI_AUDIT_VERSION = 1;
const SOURCES = new Set(['manual', 'local', 'ai']);
const VARIANTS = new Set(['baseline', 'assisted']);
const MODES = new Set(['baseline', 'assisted', 'comparison']);
const STATUSES = new Set(['complete', 'failed', 'cancelled']);
const MEANINGS = new Set(['unrated', 'baseline', 'assisted', 'equal', 'neither']);
const ANNOTATIONS = ['literal', 'context', 'referents', 'intent', 'uncertainty'];
const TOKEN_COUNTS = ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount'];

function fail(message) { throw new Error(`AI 비교 기록: ${message}`); }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value, label, maximum, optional = false) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label}은 ${maximum}자 이하의 글이어야 합니다.`);
  return value;
}
function requiredText(value, label, maximum) {
  const result = text(value, label, maximum);
  if (!result.trim()) fail(`${label}이 비어 있습니다.`);
  return result;
}
function id(value, label = '식별자') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail(`${label}가 올바르지 않습니다.`);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('참고 자료의 버전이 올바르지 않습니다.');
  return value;
}
function sha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('영상 확인값이 올바르지 않습니다.');
  return value;
}
function duration(value) {
  if (!Number.isFinite(value) || value <= 0 || value > 60) fail('영상 길이는 60초 이하여야 합니다.');
  return value;
}
function day(value) {
  const result = text(value, '촬영일', 10, true);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(`${result}T00:00:00Z`)) || new Date(`${result}T00:00:00Z`).toISOString().slice(0, 10) !== result)) fail('촬영일이 올바르지 않습니다.');
  return result;
}
function times(row, maximum) {
  if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start || row.end > maximum) fail('구간의 시작·끝을 해당 영상 길이 안에서 지정해 주세요.');
  return { start: row.start, end: row.end };
}
function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function annotations(rows, maximum) {
  if (!Array.isArray(rows) || rows.length > 100) fail('자료별 주석은 최대 100개 구간이어야 합니다.');
  const ids = new Set();
  return Array.from(rows, row => {
    if (!isObject(row)) fail('자료의 주석 형식이 올바르지 않습니다.');
    if (!(Number.isSafeInteger(row.id) && row.id > 0) && !(typeof row.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(row.id))) fail('주석의 구간 식별자가 올바르지 않습니다.');
    if (ids.has(String(row.id))) fail('주석의 구간 식별자가 중복됩니다.');
    ids.add(String(row.id));
    if (!SOURCES.has(row.source) || typeof row.reviewed !== 'boolean') fail('주석의 원본·검토 정보가 올바르지 않습니다.');
    const result = {
      id: row.id, ...times(row, maximum), source: row.source,
      original: text(row.original, '원본 후보', 1000, true),
      text: text(row.text, '의역', 500), reviewed: row.reviewed,
    };
    for (const field of ANNOTATIONS) result[field] = text(row[field], '직역·문맥', 1000, true);
    return result;
  });
}
function targetRecord(raw, maximum) {
  if (!isObject(raw)) fail('대상 영상 정보가 올바르지 않습니다.');
  const result = { sha256: sha256(raw.sha256), session: text(raw.session, '촬영 회차', 120, true), captureDay: day(raw.captureDay) };
  if (raw.id !== undefined || raw.revision !== undefined) {
    result.id = id(raw.id, '대상 자료 식별자');
    result.revision = revision(raw.revision);
  }
  // Ground truth stays local. A transport must never consume this snapshot.
  if (raw.annotations !== undefined) result.annotations = annotations(raw.annotations, maximum);
  return result;
}
function referenceRecord(raw) {
  if (!isObject(raw)) fail('참고 자료 정보가 올바르지 않습니다.');
  const maximum = raw.duration === undefined ? 60 : duration(raw.duration);
  const result = {
    id: id(raw.id, '참고 자료 식별자'), revision: revision(raw.revision), sha256: sha256(raw.sha256),
    title: requiredText(raw.title, '참고 자료 제목', 120),
    session: text(raw.session, '참고 촬영 회차', 120, true), captureDay: day(raw.captureDay),
    annotations: annotations(raw.annotations, maximum),
  };
  if (raw.duration !== undefined) result.duration = maximum;
  return result;
}
function resultRecord(raw, maximum) {
  if (!isObject(raw) || !Array.isArray(raw.segments) || raw.segments.length > 30) fail('AI 원본 응답은 최대 30개 구간이어야 합니다.');
  let total = 0;
  const segments = Array.from(raw.segments, row => {
    if (!isObject(row) || row.uncertain !== true) fail('AI 원본 구간은 검토가 필요한 초안으로 표시해야 합니다.');
    const content = requiredText(row.text, 'AI 원본 구간', 500);
    total += content.length;
    if (total > 3000) fail('AI 원본 응답의 전체 글은 3000자 이하여야 합니다.');
    return { ...times(row, maximum), text: content, uncertain: true };
  });
  const result = { segments, unreadableReason: text(raw.unreadableReason, '판독 보류 사유', 500, true) };
  if (!segments.length && !result.unreadableReason.trim()) fail('빈 AI 응답에는 판독 보류 사유가 필요합니다.');
  if (raw.summary !== undefined) result.summary = text(raw.summary, 'AI 원본 요약', 500);
  if (raw.model !== undefined) result.model = text(raw.model, '응답 모델', 120);
  if (raw.modelVersion !== undefined) result.modelVersion = raw.modelVersion === null ? null : text(raw.modelVersion, '응답 모델 버전', 120);
  if (raw.usageMetadata !== undefined) {
    if (!isObject(raw.usageMetadata)) fail('사용량 정보가 올바르지 않습니다.');
    result.usageMetadata = {};
    for (const field of TOKEN_COUNTS) {
      const value = raw.usageMetadata[field];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 0) fail('사용량 정보는 음수가 아닌 정수여야 합니다.');
        result.usageMetadata[field] = value;
      }
    }
  }
  return result;
}
function runRecord(raw, maximum) {
  if (!isObject(raw) || !VARIANTS.has(raw.variant) || !STATUSES.has(raw.status)) fail('실행 종류·상태가 올바르지 않습니다.');
  const result = { variant: raw.variant, status: raw.status };
  if (raw.status === 'complete') {
    result.result = resultRecord(raw.result, maximum);
  } else {
    if (raw.result !== undefined) fail('실패·취소한 실행에 완료 결과를 함께 기록할 수 없습니다.');
    result.error = text(raw.error, '실패·취소 사유', 500, true);
  }
  return result;
}

/** Normalize persisted provenance; originals are frozen, while evaluation remains editable. */
export function normalizeAIAudit(raw, videoDuration) {
  const maximum = duration(videoDuration);
  if (!isObject(raw) || raw.version !== AI_AUDIT_VERSION || !MODES.has(raw.mode)) fail('지원하는 형식·버전이 아닙니다.');
  if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 || raw.createdAt > 8640000000000000) fail('실행 날짜가 올바르지 않습니다.');
  if (!Array.isArray(raw.references) || raw.references.length > 2) fail('참고 자료는 최대 2개까지 기록합니다.');
  if (!Array.isArray(raw.runs) || raw.runs.length > 2) fail('AI 실행은 최대 2개까지 기록합니다.');
  const references = Array.from(raw.references, referenceRecord);
  if (new Set(references.map(row => row.id)).size !== references.length) fail('참고 자료의 식별자가 중복됩니다.');
  const runs = Array.from(raw.runs, row => runRecord(row, maximum));
  if (new Set(runs.map(row => row.variant)).size !== runs.length) fail('같은 종류의 AI 실행을 중복 기록할 수 없습니다.');
  if (raw.mode !== 'comparison' && runs.some(row => row.variant !== raw.mode)) fail('실행 종류가 분석 방식과 일치하지 않습니다.');
  const evaluation = raw.evaluation === undefined ? { meaning: 'unrated', note: '' } : raw.evaluation;
  if (!isObject(evaluation) || !MEANINGS.has(evaluation.meaning)) fail('의미 충실성 평가가 올바르지 않습니다.');
  const result = {
    version: AI_AUDIT_VERSION, runId: id(raw.runId, '실행 식별자'), createdAt: raw.createdAt,
    model: requiredText(raw.model, '요청 모델', 120), promptVersion: requiredText(raw.promptVersion, '프롬프트 버전', 100),
    target: targetRecord(raw.target, maximum), references, mode: raw.mode, runs,
    evaluation: { meaning: evaluation.meaning, note: text(evaluation.note, '평가 메모', 1000, true) },
  };
  // Only this fresh copy is frozen. Never freeze a caller's working document.
  for (const field of ['target', 'references', 'runs']) {
    Object.defineProperty(result, field, { value: frozen(result[field]), enumerable: true, writable: false, configurable: false });
  }
  return result;
}

/** Concise TXT provenance; normalized original outputs stay in JSON and full-video backups. */
export function aiAuditText(raw, videoDuration) {
  const audit = normalizeAIAudit(raw, videoDuration);
  const variants = { baseline: '대상 영상만', assisted: '참고 예시 포함', comparison: '두 방식 비교' };
  const statuses = { complete: '완료', failed: '실패', cancelled: '취소' };
  const meanings = { unrated: '평가 전', baseline: '대상 영상만이 더 충실함', assisted: '참고 예시 포함이 더 충실함', equal: '두 결과가 비슷함', neither: '둘 다 의미가 맞지 않음' };
  return [
    'AI 비교 기록 · 한국수어 성능 미검증',
    `실행: ${audit.runId} · ${new Date(audit.createdAt).toISOString()}`,
    `방식: ${variants[audit.mode]} · 요청 모델: ${audit.model} · 프롬프트 버전: ${audit.promptVersion}`,
    `대상 영상 SHA-256: ${audit.target.sha256}${audit.target.id ? ` · 자료 ${audit.target.id} / 버전 ${audit.target.revision}` : ''}`,
    ...audit.references.map(row => `참고 자료: ${row.title} · ${row.id} / 버전 ${row.revision} · SHA-256 ${row.sha256}`),
    ...audit.runs.map(row => `${variants[row.variant]}: ${statuses[row.status]}${row.result?.modelVersion ? ` · 응답 모델 버전 ${row.result.modelVersion}` : ''}${row.error ? ` · ${row.error}` : ''}`),
    `사용자 의미 충실성 평가: ${meanings[audit.evaluation.meaning]}`,
    ...(audit.evaluation.note ? [`평가 메모: ${audit.evaluation.note}`] : []),
    '이 평가는 해당 영상의 사용자 검토이며 범용 정확도를 나타내지 않습니다.',
    '원본 AI 응답·참고 주석·평가용 대상 주석은 JSON 또는 영상 포함 백업에서 확인할 수 있습니다.',
  ].join('\n');
}
