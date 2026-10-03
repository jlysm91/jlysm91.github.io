import { normalizeAIAudit, aiAuditText } from './ai-audit.js';
// Review documents never equate a model suggestion with a verified translation.
export function createVideoDocument(result = {}, mode = 'manual', duration = 0) {
  const candidates = mode === 'local' ? result.words || [] : result.segments || [];
  return {
    source: mode, duration, limitation: result.unreadableReason || '',
    ...(result.audit !== undefined ? { audit: normalizeAIAudit(result.audit, duration) } : {}),
    segments: candidates.map((row, index) => ({
      id: index + 1, start: row.start, end: row.end,
      original: mode === 'local' ? row.word : row.text,
      text: mode === 'local' ? '' : row.text,
      source: mode, reviewed: false,
    })),
  };
}

export function validateVideoDocument(doc) {
  if (!doc || !Number.isFinite(doc.duration) || doc.duration <= 0) return '먼저 영상을 선택해 주세요.';
  if (!Array.isArray(doc.segments)) return '구간 정보가 올바르지 않습니다.';
  if (doc.segments.length > 100) return '구간은 최대 100개까지 작성할 수 있어요.';
  for (const [index, row] of doc.segments.entries()) {
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start || row.end > doc.duration) return `${index + 1}번 구간의 시작·끝을 영상 길이 안에서 지정해 주세요. 끝은 시작보다 뒤여야 해요.`;
    for (const field of ['literal', 'context', 'referents', 'intent', 'uncertainty']) {
      if (row[field] !== undefined && (typeof row[field] !== 'string' || row[field].length > 1000)) return `${index + 1}번 구간의 직역·문맥은 각각 1000자 이하로 작성해 주세요.`;
    }
    if (typeof row.text !== 'string' || row.text.length > 500) return `${index + 1}번 구간의 글은 500자 이하로 작성해 주세요.`;
  }
  if (doc.audit !== undefined) {
    try { normalizeAIAudit(doc.audit, doc.duration); } catch (error) { return error.message; }
  }
  return '';
}

export function videoDocumentText(doc) {
  const error = validateVideoDocument(doc);
  if (error) throw new Error(error);
  const time = seconds => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
  const source = { ai: 'AI 초안 기반 · 한국수어 번역 성능 미검증', local: '개인 사전 단어 후보 참고 · 문장 번역 아님', manual: '사용자 직접 작성' };
  const rows = [...doc.segments].sort((a, b) => a.start - b.start || a.end - b.end);
  return ['한국수어 영상 · 검토 문서', source[doc.source], '사용자 검토 표시는 모델 정확도나 번역 품질의 인증이 아닙니다.', '',
    ...rows.map(row => `${time(row.start)}–${time(row.end)} [${row.reviewed && row.text.trim() && !row.uncertainty?.trim() ? '사용자 검토함' : '검토 필요'}] ${row.text.trim() || '[내용 확인 필요]'}${row.source === 'local' ? `\n참고 단어 후보: ${row.original}` : ''}${[['literal','직역'],['context','상황·문맥'],['referents','지시 대상'],['intent','의도'],['uncertainty','불확실한 부분']].filter(([key]) => row[key]?.trim()).map(([key,label]) => `\n${label}: ${row[key]}`).join('')}`),
    ...(!rows.length ? ['작성된 변환문이 없습니다.'] : []),
    ...(doc.limitation ? ['', `분석 한계: ${doc.limitation}`] : []),
    ...(doc.audit !== undefined ? ['', aiAuditText(doc.audit, doc.duration)] : []),
  ].join('\n');
}
