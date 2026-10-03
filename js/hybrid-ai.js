import { analyzeKSLVideo, createKSLApproval, validateKSLVideo, GEMINI_VIDEO_MODEL, GEMINI_PROMPT_VERSION, MAX_VIDEO_BYTES } from './gemini-video.js';
import { searchPersonalRecords } from './personal-library.js';
import { normalizeAIAudit } from './ai-audit.js';

// Only explicit local selections enter the preview. Search never reads target answers.
export function createHybridAI(store, hooks) {
  const $ = id => document.getElementById(id);
  const chosen = new Map();
  let candidates = [], prepared = null, phase = 'idle', active = null, shownAudit = null, searchToken = 0;
  const busy = () => ['preparing', 'running', 'canceling'].includes(phase);
  const element = (tag, text, className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
  const check = signal => { if (signal.aborted) throw new DOMException('작업을 취소했어요.', 'AbortError'); };
  const note = message => hooks.note(message);
  const annotations = record => record.document.segments.map(row => Object.fromEntries(['id', 'start', 'end', 'original', 'text', 'source', 'reviewed', 'literal', 'context', 'referents', 'intent', 'uncertainty'].map(key => [key, row[key] ?? (['literal', 'context', 'referents', 'intent', 'uncertainty'].includes(key) ? '' : row[key])])));
  function reviewedAnnotations(document) {
    return Array.isArray(document?.segments) && document.segments.length > 0 && document.segments.every(row =>
      row?.reviewed === true && typeof row.text === 'string' && row.text.trim()
      && typeof row.literal === 'string' && row.literal.trim()
      && (row.uncertainty === undefined || typeof row.uncertainty === 'string' && !row.uncertainty.trim()));
  }
  function requireComparisonReview(document) {
    if (!reviewedAnnotations(document)) throw new Error('비교 대상의 모든 구간에 직역·한국어 글을 작성하고 원본과 대조해 검토해 주세요. 불확실한 부분을 확인한 뒤 불확실성 메모를 정리하고 다시 저장해 주세요.');
  }
  function eligible(record) {
    return record && !record.broken && record.role === 'reference' && record.video instanceof Blob && reviewedAnnotations(record.document);
  }
  function snapshot() {
    const state = hooks.state();
    return JSON.stringify({ duration: state.duration, document: state.document, dirty: state.dirty, current: hooks.current(), chosen: [...chosen.values()], mode: $('aiRequestMode').value, tier: $('aiServiceTier').value, privacy: $('aiPrivacyType').value, checked: $('aiBillingConfirmed').checked });
  }
  function policy() {
    const tier = $('aiServiceTier').value, nonPersonal = $('aiPrivacyType').value === 'nonpersonal';
    if (!['paid', 'unpaid'].includes(tier) || !$('aiBillingConfirmed').checked) throw new Error('키가 속한 실제 프로젝트의 요금제·할당량·이용 조건을 확인해 주세요.');
    if (tier === 'unpaid' && !nonPersonal) throw new Error('개인 식별·민감·기밀 정보가 있거나 확실하지 않은 영상·주석은 무료 서비스로 전송할 수 없어요. 로컬 작업을 유지하거나 적합한 기존 유료 프로젝트 조건을 확인해 주세요.');
    return { tier, nonPersonal };
  }
  function invalidate() {
    $('aiUploadConsent').checked = false; prepared = null;
    if ($('aiReviewDialog').open) $('aiReviewDialog').close();
    if (phase === 'preview') phase = 'idle';
    if (phase === 'preparing') active?.controller.abort();
    update();
  }
  function clear() { invalidate(); shownAudit = null; $('aiComparisonPanel').hidden = true; }
  function cancel() {
    if (active) { active.controller.abort(); phase = 'canceling'; }
    invalidate();
  }
  function update() {
    const state = hooks.state(), locked = busy() || state.busy || state.canceling || state.loading;
    for (const id of ['aiRequestMode', 'aiServiceTier', 'aiPrivacyType', 'aiBillingConfirmed', 'aiReferenceSearch', 'aiFindReferences', 'aiUseLibrarySelection']) $(id).disabled = locked;
    $('aiReferenceCandidates').querySelectorAll('input').forEach(input => { input.disabled = locked; });
    $('aiSendBtn').disabled = !prepared || phase !== 'preview' || !$('aiUploadConsent').checked || !$('geminiKey').value.trim();
    for (const id of ['aiEvaluationPreference', 'aiEvaluationNote', 'aiComparisonExport', 'aiAdoptBaseline', 'aiAdoptAssisted']) $(id).disabled = locked;
    $('aiEvaluationPreference').disabled = locked || shownAudit?.mode !== 'comparison' || shownAudit.runs.filter(run => run.status === 'complete').length !== 2;
    $('aiAdoptBaseline').hidden = !shownAudit?.runs.some(run => run.variant === 'baseline' && run.status === 'complete');
    $('aiAdoptAssisted').hidden = !shownAudit?.runs.some(run => run.variant === 'assisted' && run.status === 'complete');
    if (state.document?.audit !== shownAudit) renderAudit(state.document?.audit || null);
  }
  function selectionStatus() {
    $('aiReferenceStatus').textContent = chosen.size ? `Gemini 참고 예시 ${chosen.size}개 선택: ${[...chosen.values()].map(row => row.title).join(', ')} · 전송 전 별도 승인 필요` : '선택한 Gemini 참고 예시가 없습니다.';
  }
  function renderCandidates() {
    const list = $('aiReferenceCandidates'); list.replaceChildren();
    if (!candidates.length) list.append(element('p', '조건에 맞는 참고 예시가 없습니다. 자료의 직역·한국어 글과 검토 상태를 확인해 주세요.', 'field-help'));
    for (const record of candidates) {
      const item = element('div', '', 'ai-reference-candidate'), label = element('label', '', 'consent-label'), input = document.createElement('input');
      input.type = 'checkbox'; input.checked = chosen.has(record.id); input.setAttribute('aria-label', `${record.title} Gemini 참고 예시`);
      input.addEventListener('change', () => {
        if (busy()) { input.checked = chosen.has(record.id); return; }
        if (input.checked && chosen.size >= 2) { input.checked = false; note('참고 예시는 최대 2개까지 선택해 주세요.'); return; }
        if (input.checked) chosen.set(record.id, { id: record.id, revision: record.revision, sha256: record.sha256, title: record.title });
        else chosen.delete(record.id);
        invalidate(); selectionStatus();
      });
      label.append(input, document.createTextNode(record.title)); item.append(label);
      item.append(element('p', `${record.captureDay || '날짜 미입력'} · ${record.session || '촬영 묶음 미입력'} · 수정 ${record.revision}`));
      item.append(element('p', record.document.segments.map(row => row.text).join(' ').slice(0, 160)));
      list.append(item);
    }
    selectionStatus(); update();
  }
  async function findReferences(importSelection = false) {
    if (busy() || hooks.state().busy) return;
    const token = ++searchToken;
    try {
      const all = (await store.list()).filter(eligible);
      if (token !== searchToken) return;
      if (importSelection) {
        const imported = hooks.selected();
        if (imported.length > 2) throw new Error('자료 목록에서 참고 예시를 2개 이하로 선택해 주세요.');
        if (imported.some(item => !all.some(record => record.id === item.id && record.revision === item.revision && record.sha256 === item.sha256))) throw new Error('선택한 자료 중 검토가 끝나지 않았거나 변경된 자료가 있어요. 직역·한국어 글·검토 상태와 불확실성 메모를 확인해 주세요.');
        chosen.clear(); imported.forEach(item => chosen.set(item.id, { ...item })); invalidate();
      }
      let removed = false;
      for (const [id, item] of chosen) {
        if (!all.some(row => row.id === id && row.revision === item.revision && row.sha256 === item.sha256)) { chosen.delete(id); removed = true; }
      }
      if (removed) { invalidate(); note('변경·삭제되거나 검토 조건에 맞지 않는 예시의 선택을 해제했어요. 최신 자료를 다시 선택해 주세요.'); }
      const matches = searchPersonalRecords(all, $('aiReferenceSearch').value).slice(0, 8);
      candidates = [...all.filter(record => chosen.has(record.id)), ...matches.filter(record => !chosen.has(record.id))];
      renderCandidates();
    } catch (error) { note(error.message); }
  }
  async function hash(file, signal) {
    check(signal); const buffer = await file.arrayBuffer(); check(signal);
    const digest = await crypto.subtle.digest('SHA-256', buffer); check(signal);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  async function probe(reference, signal) {
    const video = document.createElement('video'), url = URL.createObjectURL(reference.video);
    try {
      check(signal);
      await new Promise((resolve, reject) => {
        const finish = error => { clearTimeout(timer); signal.removeEventListener('abort', abort); video.onloadedmetadata = video.onerror = null; error ? reject(error) : resolve(); };
        const abort = () => finish(new DOMException('작업 취소', 'AbortError'));
        const timer = setTimeout(() => finish(new Error('참고 영상의 재생 정보를 확인하지 못했어요.')), 15000);
        signal.addEventListener('abort', abort, { once: true });
        video.onerror = () => finish(new Error('참고 영상을 재생할 수 없어요. 정상 원본을 다시 저장해 주세요.'));
        video.onloadedmetadata = () => finish(!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || Math.abs(video.duration - reference.duration) > .15 ? new Error('참고 영상과 구간의 길이가 일치하지 않아요.') : null);
        video.preload = 'metadata'; video.src = url; video.load();
      });
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    check(signal);
  }
  async function checkedReference(selected, signal) {
    const record = await store.get(selected.id); check(signal);
    if (!eligible(record) || record.revision !== selected.revision || record.sha256 !== selected.sha256) throw new Error('참고 예시가 변경·삭제되었거나 영상·검토 정보가 없어요. 최신 자료를 다시 선택하고 승인해 주세요.');
    validateKSLVideo(record.video, record.document.duration);
    return { id: record.id, revision: record.revision, sha256: record.sha256, title: record.title, session: record.session, captureDay: record.captureDay, video: record.video, duration: record.document.duration, annotations: annotations(record) };
  }
  function begin(nextPhase) {
    const controller = new AbortController();
    const operation = { controller, token: hooks.begin(controller) }; active = operation; phase = nextPhase; hooks.controls(); return operation;
  }
  function finish(operation) {
    if (active !== operation) return;
    active = null;
    if (phase !== 'preview') phase = 'idle';
    hooks.finish(operation.token); hooks.controls();
  }
  async function prepare() {
    const state = hooks.state();
    if (busy() || state.busy || state.canceling || state.loading || hooks.libraryBusy()) return;
    invalidate();
    const operation = begin('preparing'), signal = operation.controller.signal;
    const job = (async () => {
      try {
        const file = state.file, duration = state.duration, mode = $('aiRequestMode').value, current = hooks.current();
        validateKSLVideo(file, duration); const { tier, nonPersonal } = policy();
        if (!['baseline', 'assisted', 'comparison'].includes(mode)) throw new Error('실행 방법을 다시 선택해 주세요.');
        if (mode !== 'baseline' && !chosen.size) throw new Error('검토한 참고 예시를 먼저 선택해 주세요.');
        if (mode === 'comparison' && (!current.id || current.role !== 'test' || state.dirty || !current.session || !current.captureDay)) throw new Error('비교할 대상은 촬영 날짜·묶음을 입력해 별도 평가용으로 로컬 저장한 뒤 열어 주세요. 수정 내용도 먼저 저장해 주세요.');
        if (mode === 'comparison') requireComparisonReview(state.document);
        const stamp = snapshot(), sha256 = await hash(file, signal), references = [];
        if (mode !== 'baseline') for (const selected of chosen.values()) references.push(await checkedReference(selected, signal));
        if (references.length > 2 || file.size + references.reduce((sum, row) => sum + row.video.size, 0) > MAX_VIDEO_BYTES) throw new Error('대상과 참고 영상의 합계가 12MB를 넘어요. 예시 수나 영상 크기를 줄여 주세요.');
        if (references.some(row => row.sha256 === sha256) || new Set(references.map(row => row.sha256)).size !== references.length) throw new Error('대상과 같은 영상이나 중복 참고 영상은 예시에 넣을 수 없어요.');
        if (mode === 'comparison' && references.some(row => !row.session || !row.captureDay || row.session === current.session || row.captureDay === current.captureDay)) throw new Error('비교는 대상과 다른 촬영 날짜·묶음의 참고 예시를 사용해 주세요. 같은 촬영의 재편집본도 제외해야 합니다.');
        for (const reference of references) await probe(reference, signal);
        check(signal);
        if (state.file !== file || snapshot() !== stamp) throw new Error('전송할 내용이 변경됐어요. 다시 확인해 주세요.');
        if (mode === 'comparison') {
          const saved = await store.get(current.id); check(signal);
          if (!saved || saved.broken || saved.revision !== current.revision || saved.sha256 !== sha256 || saved.role !== 'test') throw new Error('평가용 저장본이 변경됐어요. 다시 열어 확인해 주세요.');
        }
        prepared = { file, duration, mode, current, sha256, references, tier, nonPersonal, stamp, loadToken: state.loadToken, groundTruth: mode === 'comparison' ? structuredClone(state.document.segments) : undefined };
        renderPreview(prepared); phase = 'preview'; $('aiReviewDialog').showModal(); $('aiUploadConsent').focus();
      } catch (error) { if (!signal.aborted) note(error.message); }
      finally { finish(operation); }
    })();
    hooks.job(job); await job;
  }
  function renderPreview(plan) {
    const box = $('aiReviewManifest'); box.replaceChildren();
    const calls = plan.mode === 'comparison' ? 2 : 1;
    box.append(element('p', `서비스: Google Gemini API · 모델: ${GEMINI_VIDEO_MODEL} · 생성 요청 ${calls}회 · ${plan.tier === 'paid' ? '유료 프로젝트: 사용량에 따라 과금' : '무료 프로젝트: 잔여 할당량 내에서만 가능'}`));
    const target = element('div', '', 'ai-review-record'); target.append(element('h3', `대상: ${plan.file.name}`), element('p', `${plan.duration.toFixed(1)}초 · ${(plan.file.size / 1024 / 1024).toFixed(2)}MB · 전체 영상 ${calls}회 전송 · 대상의 직역·수정문·문맥 주석은 전송하지 않음`)); box.append(target);
    for (const ref of plan.references) {
      const item = element('div', '', 'ai-review-record'); item.append(element('h3', `참고: ${ref.title} · 수정 ${ref.revision}`), element('p', `${ref.duration.toFixed(1)}초 · ${(ref.video.size / 1024 / 1024).toFixed(2)}MB · 전체 영상 1회 + 아래 주석`));
      const details = element('details', ''), summary = element('summary', `전송할 직역·의역·문맥 ${ref.annotations.length}개 구간 모두 확인`);
      details.append(summary);
      for (const row of ref.annotations) {
        const annotation = element('div', '', 'ai-preview-annotation');
        annotation.append(element('h4', `${row.start}–${row.end}초`));
        for (const [key, label] of [['literal', '직역'], ['text', '자연스러운 한국어 글'], ['context', '문맥'], ['referents', '가리키는 대상'], ['intent', '의도'], ['uncertainty', '불확실성']]) {
          const field = element('p', ''), heading = element('strong', `${label}: `);
          field.append(heading, document.createTextNode(row[key] || '(입력 없음)')); annotation.append(field);
        }
        details.append(annotation);
      }
      item.append(details); box.append(item);
    }
    if (!plan.references.length) box.append(element('p', '참고 영상·주석 전송 없음'));
    const seconds = plan.duration * calls + plan.references.reduce((sum, ref) => sum + ref.duration, 0);
    const textBytes = new TextEncoder().encode(JSON.stringify(plan.references.map(row => row.annotations))).length;
    const tokens = Math.ceil(seconds * (8 * 258 + 32) + textBytes + calls * 4000);
    const futureRates = new Date().getUTCFullYear() >= 2027, inputRate = futureRates ? 1.5 : .75, outputRate = futureRates ? 7.5 : 3.75;
    $('aiCostEstimate').textContent = `예상 사용량: 입력 약 ${tokens.toLocaleString('ko-KR')}토큰, 출력 요청당 최대 8,192토큰(추론 포함). 8fps 표본 가정으로 KSL 충분성을 보장하지 않습니다. 표준 유료 단가: 입력 $${inputRate}/100만·출력 $${outputRate}/100만 토큰. 계산 예 약 $${(tokens * inputRate / 1e6).toFixed(3)}–$${((tokens * inputRate + 8192 * calls * outputRate) / 1e6).toFixed(3)} USD이며 청구 상한이 아닙니다.`;
    $('aiUploadConsent').checked = false; $('aiReviewError').textContent = '';
  }
  async function verify(plan, signal) {
    check(signal);
    if (hooks.state().file !== plan.file || snapshot() !== plan.stamp) throw new Error('승인할 대상·설정·주석이 변경됐어요. 전송 내용을 다시 확인해 주세요.');
    if (plan.mode === 'comparison') requireComparisonReview(hooks.state().document);
    for (const reference of plan.references) await checkedReference(reference, signal);
    if (plan.mode === 'comparison') {
      const target = await store.get(plan.current.id); check(signal);
      if (!target || target.broken || target.revision !== plan.current.revision || target.sha256 !== plan.sha256 || target.role !== 'test') throw new Error('평가 대상 저장본이 변경됐어요. 다시 열어 주세요.');
    }
    check(signal);
  }
  function auditFor(plan, runs) {
    const target = { sha256: plan.sha256, session: plan.current.session || '', captureDay: plan.current.captureDay || '' };
    if (plan.current.id) Object.assign(target, { id: plan.current.id, revision: plan.current.revision });
    if (plan.groundTruth) target.annotations = plan.groundTruth;
    return normalizeAIAudit({ version: 1, runId: crypto.randomUUID(), createdAt: Date.now(), model: GEMINI_VIDEO_MODEL, promptVersion: GEMINI_PROMPT_VERSION, target, references: plan.references.map(({ video, ...reference }) => reference), mode: plan.mode, runs, evaluation: { meaning: 'unrated', note: '' } }, plan.duration);
  }
  async function confirm() {
    if (phase !== 'preview' || !prepared || !$('aiUploadConsent').checked) return;
    const plan = prepared, apiKey = $('geminiKey').value.trim();
    if (!apiKey) { $('aiReviewError').textContent = 'Gemini API 키를 직접 입력한 뒤 다시 확인해 주세요.'; return; }
    if (plan.mode !== 'comparison' && !hooks.confirmReplace()) return;
    const operation = begin('running'), signal = operation.controller.signal;
    $('aiReviewDialog').close(); $('aiUploadConsent').checked = false;
    const job = (async () => {
      const runs = [];
      try {
        await verify(plan, signal);
        const variants = plan.mode === 'comparison' ? ['baseline', 'assisted'] : [plan.mode];
        const approval = createKSLApproval({ file: plan.file, duration: plan.duration, references: plan.references, approved: true, serviceTier: plan.tier, nonPersonal: plan.nonPersonal, variants });
        for (const variant of variants) {
          try {
            await verify(plan, signal);
            const result = await analyzeKSLVideo({ file: plan.file, duration: plan.duration, references: plan.references, apiKey, signal, approval, variant, onProgress: payload => hooks.progress({ ...payload, message: `${variant === 'baseline' ? '예시 없음' : '예시 있음'} · ${payload.message}` }, operation.token) });
            check(signal); runs.push({ variant, status: 'complete', result });
          } catch (error) {
            runs.push({ variant, status: signal.aborted ? 'cancelled' : 'failed', error: signal.aborted ? '사용자 취소 · 이미 전송된 요청은 회수되지 않습니다.' : error.message });
            throw error;
          }
        }
        check(signal);
        const audit = auditFor(plan, runs);
        if (plan.mode === 'comparison') { hooks.attachAudit(audit); note('같은 영상의 두 초안을 준비했어요. 원본 의미와 비교하고 평가를 기록해 주세요.'); }
        else { hooks.result({ ...runs[0].result, audit }); note('초안을 확인하고 수정한 뒤 로컬 저장해 주세요. 참고 예시의 뜻을 그대로 복사했는지도 확인해 주세요.'); }
      } catch (error) {
        if (plan.mode === 'comparison' && runs.length && hooks.state().file === plan.file && hooks.state().loadToken === plan.loadToken) {
          try { hooks.attachAudit(auditFor(plan, runs)); } catch { /* Malformed provider data must not replace the existing document. */ }
        }
        if (hooks.state().file === plan.file && hooks.state().loadToken === plan.loadToken) note(signal.aborted ? 'Gemini 요청을 취소했어요. 기존 글은 유지되며 완료된 비교 결과는 기록에 남습니다. 이미 전송된 요청에는 비용이 생길 수 있습니다.' : error.message);
      } finally { prepared = null; finish(operation); }
    })();
    hooks.job(job); await job;
  }
  function renderAudit(audit) {
    shownAudit = audit; $('aiComparisonPanel').hidden = !audit;
    if (!audit) return;
    const box = $('aiComparisonResults'); box.replaceChildren();
    for (const run of audit.runs) {
      const card = element('section', '', 'ai-comparison-card');
      card.append(element('h3', run.variant === 'baseline' ? '예시 없음' : '선택 예시 있음'));
      if (run.status === 'complete') {
        card.append(element('p', run.result.segments.map(row => `${row.start.toFixed(1)}–${row.end.toFixed(1)}초: ${row.text}`).join('\n') || '확인한 해석 구간 없음'));
        if (run.result.unreadableReason) card.append(element('p', `보류·한계: ${run.result.unreadableReason}`));
        card.append(element('p', `응답 모델: ${run.result.modelVersion || audit.model} · 사용량: ${run.result.usageMetadata?.totalTokenCount ?? '제공되지 않음'} 토큰`, 'field-help'));
      } else card.append(element('p', `${run.status === 'cancelled' ? '취소' : '실패'}: ${run.error}`));
      box.append(card);
    }
    $('aiEvaluationPreference').value = audit.evaluation.meaning; $('aiEvaluationNote').value = audit.evaluation.note;
    $('aiComparisonStatus').textContent = `${audit.model} · 참고 ${audit.references.length}개 · ${audit.references.map(ref => `${ref.title} (수정 ${ref.revision})`).join(', ')} · 원본 초안·출처는 로컬 저장과 백업에 함께 남습니다.`;
    $('aiAdoptBaseline').hidden = !audit.runs.some(run => run.variant === 'baseline' && run.status === 'complete');
    $('aiAdoptAssisted').hidden = !audit.runs.some(run => run.variant === 'assisted' && run.status === 'complete');
  }
  function evaluate() {
    if (!shownAudit || busy()) return;
    shownAudit.evaluation.meaning = $('aiEvaluationPreference').value; shownAudit.evaluation.note = $('aiEvaluationNote').value;
    hooks.changed();
  }
  function adopt(variant) {
    if (busy() || !shownAudit) return;
    const run = shownAudit.runs.find(row => row.variant === variant && row.status === 'complete');
    if (!run || !hooks.confirmReplace()) return;
    hooks.result({ ...run.result, audit: shownAudit }); note('초안을 편집란에 적용했어요. 검토·수정 후 로컬 저장해 주세요. 평가용 원본 주석은 실행 기록에 유지됩니다.');
  }
  function bind() {
    $('aiFindReferences').addEventListener('click', () => findReferences());
    $('aiUseLibrarySelection').addEventListener('click', () => findReferences(true));
    for (const id of ['aiRequestMode', 'aiPrivacyType', 'aiBillingConfirmed']) $(id).addEventListener('input', invalidate);
    for (const id of ['aiServiceTier', 'geminiKey']) $(id).addEventListener('input', () => { $('aiBillingConfirmed').checked = false; invalidate(); });
    $('aiUploadConsent').addEventListener('change', update);
    $('aiSendBtn').addEventListener('click', confirm);
    $('aiReviewCancelBtn').addEventListener('click', invalidate);
    $('aiReviewDialog').addEventListener('close', () => { if (phase === 'preview') invalidate(); });
    $('aiEvaluationPreference').addEventListener('change', evaluate); $('aiEvaluationNote').addEventListener('input', evaluate);
    $('aiAdoptBaseline').addEventListener('click', () => adopt('baseline')); $('aiAdoptAssisted').addEventListener('click', () => adopt('assisted'));
    $('aiComparisonExport').addEventListener('click', () => { if (shownAudit && !busy()) hooks.download(shownAudit); });
    update();
  }
  return { bind, update, prepare, confirm, cancel, clear, invalidate, busy, findReferences, runState: () => ({ prepared, comparison: shownAudit, phase }) };
}
