import { encodePersonalBackup, decodePersonalBackup, searchPersonalRecords } from './personal-library.js';

// This controller handles only local files. It never reads keys or sends requests.
export function createLibraryUI(store, hooks) {
  const $ = id => document.getElementById(id);
  let records = [], linked = null, active = null, refreshToken = 0;
  const selected = new Map(), knownBroken = new Map();
  const metaIds = ['personalTitle', 'personalCaptureDay', 'personalSession', 'personalRole'];
  const roles = { reference: '참고 예시', development: '개발 확인용', test: '별도 평가용', unassigned: '용도 미정' };
  function node(tag, text, className = '') {
    const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
  }
  function action(label, callback) {
    const el = node('button', label, 'button button-outline'); el.type = 'button';
    el.disabled = Boolean(active); el.addEventListener('click', callback); return el;
  }
  function status(message, error = false) {
    for (const id of ['personalSaveStatus', 'libraryStatus']) {
      $(id).textContent = message; $(id).classList.toggle('is-error', error);
    }
  }
  function update() {
    const state = hooks.state();
    const blocked = Boolean(active || state.busy || state.canceling || state.loading);
    $('personalFields').disabled = blocked || !state.file;
    $('personalSaveBtn').disabled = blocked || !state.file || !state.document || Boolean(hooks.validate(state.document));
    $('personalSaveBtn').textContent = linked ? '영상 자료 수정 저장' : '영상 포함 로컬 저장';
    if (state.dirty && linked && !active && !$('personalSaveStatus').classList.contains('is-error')) $('personalSaveStatus').textContent = `수정 ${linked.revision} 저장본에 연결되어 있어요. 현재 변경은 다시 로컬 저장해야 보관됩니다.`;
    $('personalUnlinkBtn').hidden = !linked; $('personalUnlinkBtn').disabled = blocked;
    for (const id of ['libraryImportBtn', 'libraryImportFile', 'libraryRefreshBtn']) $(id).disabled = Boolean(active);
    for (const id of ['libraryCancelBtn', 'personalCancelBtn']) $(id).hidden = !active;
    $('libraryList').querySelectorAll('button,input').forEach(el => { el.disabled = Boolean(active) || el.dataset.unavailable === 'true'; });
    if (active) {
      for (const id of ['videoAnalyzeBtn', 'videoClearBtn', 'videoAddSegment', 'videoEditor', 'videoDownloadBtn', 'videoJSONBtn', 'videoReturnToSegment', 'videoFile']) $(id).disabled = true;
      $('videoDropzone').setAttribute('aria-disabled', 'true');
    } else { $('videoFile').disabled = false; $('videoDropzone').removeAttribute('aria-disabled'); }
  }
  function selectionStatus() {
    $('librarySelectionStatus').textContent = selected.size ? `참고 예시 ${selected.size}개 선택: ${[...selected.values()].map(r => r.title).join(', ')} · 이번 방문 동안만 유지` : '선택한 참고 예시가 없습니다.';
    $('libraryClearSelection').disabled = !selected.size || Boolean(active);
  }
  function render() {
    const list = $('libraryList'); list.replaceChildren();
    const matches = searchPersonalRecords(records, $('librarySearch').value);
    if (!matches.length) list.append(node('p', records.length ? '검색에 맞는 주석이 없습니다. 다른 단어로 검색해 주세요.' : '아직 저장한 영상 자료가 없습니다. 영상에서 구간을 작성한 뒤 로컬 저장을 눌러 주세요.', 'library-empty'));
    for (const record of matches) {
      const card = node('article', '', 'panel library-card'); card.dataset.libraryId = record.id;
      card.append(node('h2', record.title || '제목 없는 자료'));
      card.append(node('p', `${roles[record.role] || '용도 미정'} · ${record.captureDay || '촬영 날짜 미입력'} · ${record.session || '촬영 묶음 미입력'} · 수정 ${record.revision || '?'}`, 'library-meta'));
      if (record.broken) card.append(node('p', `${record.error || '영상 자료가 손상되었습니다.'} 영상 포함 백업을 복원한 뒤 손상된 항목을 삭제하세요.`, 'is-error'));
      else {
        const segments = record.document?.segments || [];
        const pending = segments.filter(row => !row.reviewed || !row.text.trim() || row.uncertainty?.trim()).length;
        card.append(node('p', `${segments.length}개 구간 · ${pending}개 검토 또는 불확실성 확인 필요 · ${(record.video.size / 1024 / 1024).toFixed(1)}MB`, 'library-meta'));
        const query = $('librarySearch').value.trim().toLocaleLowerCase();
        const row = segments.find(r => [r.text, r.literal, r.context, r.referents, r.intent, r.uncertainty].some(v => v?.toLocaleLowerCase().includes(query))) || segments[0];
        if (row) {
          card.append(node('p', `직역: ${row.literal || '미입력'}`, 'library-excerpt'));
          card.append(node('p', `한국어 글: ${row.text || '내용 확인 필요'}`, 'library-excerpt'));
          if (row.uncertainty) card.append(node('p', `불확실성: ${row.uncertainty}`, 'library-excerpt'));
        }
      }
      const controls = node('div', '', 'personal-actions');
      const open = action('열기', () => openRecord(record.id));
      const backup = action('영상 포함 백업', () => backupRecord(record.id));
      for (const button of [open, backup]) { button.dataset.unavailable = String(Boolean(record.broken)); button.disabled = Boolean(active || record.broken); }
      controls.append(open, backup, action('삭제', () => deleteRecord(record)));
      card.append(controls);
      if (!record.broken && record.role === 'reference') {
        const label = node('label', '', 'consent-label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(record.id);
        checkbox.setAttribute('aria-label', `${record.title} 참고 예시 선택`); checkbox.disabled = Boolean(active);
        checkbox.addEventListener('change', () => {
          if (!checkbox.checked) { selected.delete(record.id); selectionStatus(); return; }
          operate('참고 예시 확인', async signal => {
            const current = await checkedRecord(record.id); check(signal);
            if (current.revision !== record.revision || current.role !== 'reference') { await refresh(); throw new Error('자료가 변경됐어요. 최신 자료를 확인하고 다시 선택해 주세요.'); }
            selected.set(current.id, { id: current.id, revision: current.revision, title: current.title, sha256: current.sha256 });
            status('참고 예시를 선택했어요. 선택만으로 전송하지 않습니다. 영상 화면에서 전송 내용을 확인하고 별도로 승인해 주세요.');
          });
        });
        label.append(checkbox, document.createTextNode('참고 예시로 선택')); card.append(label);
      }
      list.append(card);
    }
    selectionStatus(); update();
  }
  async function refresh() {
    const token = ++refreshToken;
    let next;
    try { next = await store.list(); } catch (error) { status(error.message, true); throw error; }
    if (token !== refreshToken) return;
    records = next.map(record => {
      const broken = knownBroken.get(record.id);
      if (broken && broken.revision === record.revision && broken.sha256 === record.sha256) return { ...record, broken: true, error: broken.error };
      knownBroken.delete(record.id); return record;
    });
    let invalid = false;
    for (const [id, item] of selected) {
      if (!records.some(r => r.id === id && r.revision === item.revision && r.sha256 === item.sha256 && !r.broken && r.role === 'reference')) { selected.delete(id); invalid = true; }
    }
    render();
    if (invalid) status('수정·삭제되었거나 읽을 수 없는 참고 자료의 선택을 해제했어요. 최신 자료를 다시 확인해 주세요.');
  }
  async function operate(label, work) {
    if (active) return;
    const focused = document.activeElement;
    const focusTarget = { id: focused?.id, card: focused?.closest('[data-library-id]')?.dataset.libraryId, label: focused?.textContent, aria: focused?.getAttribute('aria-label') };
    const operation = { controller: new AbortController(), label, view: document.querySelector('.view:not([hidden])')?.id }; active = operation;
    status(`${label} 중…`); hooks.controls(); render();
    try { await work(operation.controller.signal); }
    catch (error) {
      const aborted = error.name === 'AbortError';
      status(aborted ? '작업을 취소했어요. 완료 전인 변경은 저장하지 않았습니다.' : (/[가-힣]/.test(error.message) ? error.message : '로컬 자료 작업에 실패했어요. 저장공간·파일을 확인하고 다시 시도해 주세요.'), !aborted);
    } finally {
      if (active === operation) active = null;
      const restoreFocus = document.activeElement === document.body || document.activeElement === focused || ['libraryCancelBtn', 'personalCancelBtn'].includes(document.activeElement?.id);
      hooks.controls(); render();
      if (restoreFocus && !operation.navigating && operation.view === document.querySelector('.view:not([hidden])')?.id) {
        const card = [...$('libraryList').children].find(el => el.dataset.libraryId === focusTarget.card);
        const target = focusTarget.id ? $(focusTarget.id) : [...(card?.querySelectorAll('button,input') || [])].find(el => focusTarget.aria ? el.getAttribute('aria-label') === focusTarget.aria : el.textContent === focusTarget.label);
        if (target && !target.disabled && !target.hidden) target.focus();
        else if (operation.view === 'view-library') $('libraryTitle').focus();
      }
    }
  }
  const check = signal => { if (signal.aborted) throw new DOMException('취소', 'AbortError'); };
  async function probe(videoBlob, expectedDuration, signal) {
    check(signal);
    const video = document.createElement('video'), url = URL.createObjectURL(videoBlob);
    try {
      await new Promise((resolve, reject) => {
        const stop = error => { clearTimeout(timer); video.onloadedmetadata = video.onerror = null; signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => stop(new DOMException('취소', 'AbortError'));
        const timer = setTimeout(() => stop(new Error('영상 재생 확인 시간이 초과됐어요. 다른 브라우저에서 확인해 주세요.')), 15000);
        signal.addEventListener('abort', abort, { once: true });
        video.onerror = () => stop(new Error('저장된 영상을 재생할 수 없어요. 원본을 다시 선택하거나 정상 백업을 복원해 주세요.'));
        video.onloadedmetadata = () => stop(!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0 || video.duration > 60 || Math.abs(video.duration - expectedDuration) > .15 ? new Error('백업의 영상 길이·화면과 주석이 맞지 않아요. 원본과 구간 시간을 확인해 주세요.') : null);
        video.preload = 'metadata'; video.src = url; video.load();
      });
    } finally { video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
    check(signal);
  }
  async function save() {
    const state = hooks.state();
    if (active || state.busy || state.loading || state.canceling || !state.document || !state.file) return;
    const input = { title: $('personalTitle').value.trim(), captureDay: $('personalCaptureDay').value, session: $('personalSession').value.trim(), role: $('personalRole').value, document: structuredClone(state.document), video: state.file, fileName: state.file.name };
    if (linked) Object.assign(input, { id: linked.id, expectedRevision: linked.revision });
    await operate('영상 자료 저장', async signal => {
      const record = await store.save({ ...input, signal });
      linked = { id: record.id, revision: record.revision };
      hooks.saved();
      await refresh();
      status(`이 브라우저에 영상과 해석을 저장했어요. 수정 ${record.revision} · 내 영상 자료에서 다시 열 수 있습니다.`);
    });
  }
  async function checkedRecord(id) {
    const record = await store.get(id);
    if (record?.broken) knownBroken.set(id, record);
    if (!record || record.broken) {
      selected.delete(id); await refresh();
      throw new Error(record?.error || '자료가 삭제되었어요. 목록을 다시 확인해 주세요.');
    }
    return record;
  }
  async function openRecord(id) {
    await operate('영상 자료 열기', async signal => {
      const record = await checkedRecord(id); check(signal);
      await probe(record.video, record.document.duration, signal); check(signal);
      const opened = await hooks.open(record, signal); check(signal);
      if (!opened) { status('열기를 취소했어요. 작성 중인 내용을 유지합니다.'); return; }
      linked = { id: record.id, revision: record.revision };
      $('personalTitle').value = record.title; $('personalCaptureDay').value = record.captureDay; $('personalSession').value = record.session; $('personalRole').value = record.role;
      status(`저장된 영상과 해석을 열었어요. 수정 ${record.revision} · 변경 후 다시 저장해 주세요.`);
      active.navigating = true; hooks.navigate();
    });
  }
  async function backupRecord(id) {
    await operate('영상 포함 백업 준비', async signal => {
      const record = await checkedRecord(id); check(signal);
      const blob = await encodePersonalBackup(record); check(signal);
      const link = document.createElement('a'), url = URL.createObjectURL(blob);
      link.href = url; link.download = `${record.title.replace(/[\\/:*?"<>|]/g, '_') || '개인-영상'}.kslvideo`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      status('영상 포함 백업 다운로드를 요청했어요. 파일에 개인 영상과 해석이 들어 있으니 안전하게 보관하세요.');
    });
  }
  async function restore(file) {
    if (!file) return;
    await operate('영상 백업 복원', async signal => {
      const input = await decodePersonalBackup(file); check(signal);
      await probe(input.video, input.document.duration, signal); check(signal);
      await store.save({ ...input, signal });
      await refresh(); status('영상과 해석을 새 자료로 복원했어요. 기존 자료는 그대로 유지됩니다.');
    });
  }
  async function deleteRecord(record) {
    if (active || !window.confirm(`“${record.title || '손상 자료'}”의 저장된 영상과 해석을 삭제할까요? 필요한 경우 먼저 영상 포함 백업을 내려받으세요.`)) return;
    await operate('자료 삭제', async signal => {
      await store.remove(record.id, record.revision, signal);
      if (linked?.id === record.id) { linked = null; hooks.changed(); }
      selected.delete(record.id); await refresh();
      status('저장된 자료를 삭제했어요. 편집 화면에 열려 있는 내용은 새 자료로 다시 저장할 수 있습니다.');
    });
  }
  function cancel() { active?.controller.abort(); if (active?.label === '영상 자료 열기') hooks.cancelOpen(); }
  function viewChanged(view) {
    if (active?.label === '영상 자료 열기' && !active.navigating && view !== 'library') cancel();
  }
  function reset() {
    linked = null;
    for (const id of metaIds) $(id).value = id === 'personalRole' ? 'unassigned' : '';
    if (!active) status('');
  }
  function bind() {
    $('personalSaveBtn').addEventListener('click', save);
    $('personalUnlinkBtn').addEventListener('click', () => { if (active) return; linked = null; hooks.changed(); status('현재 작업과 저장본의 연결을 해제했어요. 저장본은 그대로 있으며 다음 저장은 새 자료가 됩니다.'); update(); });
    for (const id of metaIds) $(id).addEventListener('input', () => hooks.changed());
    for (const id of ['personalCancelBtn', 'libraryCancelBtn']) $(id).addEventListener('click', cancel);
    $('libraryImportBtn').addEventListener('click', () => $('libraryImportFile').click());
    $('libraryImportFile').addEventListener('change', event => { const file = event.target.files?.[0]; event.target.value = ''; restore(file); });
    $('librarySearch').addEventListener('input', render);
    $('libraryRefreshBtn').addEventListener('click', () => operate('목록 확인', async () => { await refresh(); status('저장된 목록을 확인했어요.'); }));
    $('libraryClearSelection').addEventListener('click', () => { selected.clear(); render(); });
    render();
  }
  const current = () => ({ ...(linked || {}), title: $('personalTitle').value.trim(), captureDay: $('personalCaptureDay').value, session: $('personalSession').value.trim(), role: $('personalRole').value });
  return { current, bind, update, reset, viewChanged, refresh, save, restore, openRecord, cancel, busy: () => Boolean(active), selected: () => [...selected.values()] };
}
