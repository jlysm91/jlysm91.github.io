import { normalizeAIAudit } from './ai-audit.js';
/** Personal KSL examples are local video/annotation records, never model training. */
export const PERSONAL_DB_NAME = 'ksl-personal-library';
export const PERSONAL_STORE_NAME = 'videos';
export const MAX_PERSONAL_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_PERSONAL_TOTAL_BYTES = 200 * 1024 * 1024;
export const MAX_PERSONAL_RECORDS = 20;
export const MAX_PERSONAL_SECONDS = 60;
export const MAX_PERSONAL_HEADER_BYTES = 1024 * 1024;
const MAGIC = new TextEncoder().encode('KSLVID1\n');
const PREFIX_BYTES = MAGIC.length + 4;
const SOURCES = new Set(['manual', 'local', 'ai']);
const ROLES = new Set(['unassigned', 'reference', 'development', 'test']);
const ANNOTATIONS = ['literal', 'context', 'intent', 'referents', 'uncertainty'];
const MAX_METADATA_BYTES = MAX_PERSONAL_HEADER_BYTES - 4096;

function fail(message) { throw new Error(message); }
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function abortError() { return new DOMException('개인 영상 자료 작업을 취소했습니다.', 'AbortError'); }
function checkSignal(signal) { if (signal?.aborted) throw abortError(); }
function textField(value, label, maximum, { optional = false, trim = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || value.length > maximum) fail(`${label}은 ${maximum}자 이하의 글로 입력해 주세요.`);
  return trim ? value.trim() : value;
}
function validId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) fail('자료 식별자가 올바르지 않습니다.');
  return id;
}
function validRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) fail('자료 버전이 올바르지 않습니다. 다시 열어 주세요.');
  return revision;
}
function validTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) fail('자료의 저장 날짜가 올바르지 않습니다.');
  return value;
}
function validHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('영상 확인값이 올바르지 않습니다. 영상 포함 백업에서 복원해 주세요.');
  return value;
}
function validCaptureDay(value) {
  const day = textField(value, '촬영일', 10, { optional: true, trim: true });
  if (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)) fail('촬영일을 올바른 날짜로 입력해 주세요.');
  return day;
}
function videoType(video, fileName) {
  if (!(video instanceof Blob) || video.size < 1) fail('연결된 영상이 없습니다. 영상 포함 백업에서 복원하거나 영상을 다시 선택해 주세요.');
  if (video.size > MAX_PERSONAL_VIDEO_BYTES) fail('개인 자료의 영상은 50MiB 이하여야 합니다.');
  if (video.type) {
    if (!/^video\/[a-z0-9.+-]+(?:;[^\r\n]{1,120})?$/i.test(video.type)) fail('영상 형식의 파일을 선택해 주세요.');
    return video.type;
  }
  const extension = fileName.split('.').pop().toLowerCase();
  const types = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', mpeg: 'video/mpeg', mpg: 'video/mpeg', avi: 'video/x-msvideo', mkv: 'video/x-matroska' };
  if (!types[extension]) fail('영상 파일의 형식을 확인할 수 없습니다. MP4 또는 WebM 영상을 선택해 주세요.');
  return types[extension];
}

/** Copy only supported annotation fields; unknown properties never enter backups. */
export function normalizePersonalInput(input) {
  if (!isObject(input)) fail('개인 영상 자료 형식이 올바르지 않습니다.');
  const title = textField(input.title, '자료 제목', 120, { trim: true });
  if (!title) fail('자료 제목을 입력해 주세요.');
  const fileName = textField(input.fileName, '영상 파일명', 255, { trim: true });
  if (!fileName || /[\r\n]/.test(fileName)) fail('영상 파일명이 올바르지 않습니다.');
  videoType(input.video, fileName);
  const role = input.role ?? 'unassigned';
  if (!ROLES.has(role)) fail('자료의 참고·비교 구분이 올바르지 않습니다.');
  const raw = input.document;
  if (!isObject(raw) || !SOURCES.has(raw.source) || !Number.isFinite(raw.duration) || raw.duration <= 0 || raw.duration > MAX_PERSONAL_SECONDS || !Array.isArray(raw.segments) || raw.segments.length > 100) fail('개인 자료는 60초 이하 영상과 최대 100개 구간으로 저장해 주세요.');
  const ids = new Set();
  const segments = Array.from(raw.segments, (row, index) => {
    if (!isObject(row)) fail(`${index + 1}번 구간 형식이 올바르지 않습니다.`);
    const id = row.id;
    if (!(Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id))) fail(`${index + 1}번 구간 식별자가 올바르지 않습니다.`);
    // String and numeric IDs must not become duplicate DOM identifiers.
    if (ids.has(String(id))) fail('구간 식별자가 중복되어 있습니다.');
    ids.add(String(id));
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start || row.end > raw.duration) fail(`${index + 1}번 구간의 시작·끝을 영상 길이 안에서 지정해 주세요.`);
    if (!SOURCES.has(row.source) || typeof row.reviewed !== 'boolean') fail(`${index + 1}번 구간의 원본·검토 정보가 올바르지 않습니다.`);
    const normalized = {
      id, start: row.start, end: row.end,
      original: textField(row.original, '원본 후보', 1000, { optional: true }),
      text: textField(row.text, '구간의 의역', 500),
      source: row.source, reviewed: row.reviewed,
    };
    for (const field of ANNOTATIONS) normalized[field] = textField(row[field], '구간의 직역·문맥', 1000, { optional: true });
    return normalized;
  });
  const normalized = {
    title, captureDay: validCaptureDay(input.captureDay),
    session: textField(input.session, '촬영 회차', 120, { optional: true, trim: true }),
    role, fileName,
    document: { source: raw.source, duration: raw.duration, limitation: textField(raw.limitation, '분석 한계', 2000, { optional: true }), segments },
  };
  if (raw.audit !== undefined) {
    normalized.document.audit = normalizeAIAudit(raw.audit, raw.duration);
    if (input.sha256 !== undefined && normalized.document.audit.target.sha256 !== input.sha256) fail('AI 비교 기록의 대상 영상이 현재 자료와 다릅니다. 원본 영상을 확인해 주세요.');
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_METADATA_BYTES) fail('자료 한 건의 주석 용량은 1MiB 미만이어야 합니다. 구간이나 주석을 나누어 저장해 주세요.');
  return { ...normalized, video: input.video };
}

async function hashVideo(video) {
  if (!globalThis.crypto?.subtle) fail('이 환경에서 영상 무결성을 확인할 수 없습니다. HTTPS 또는 localhost에서 열어 주세요.');
  const hash = await globalThis.crypto.subtle.digest('SHA-256', await video.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function storageError(error) {
  if (error?.name === 'AbortError') return error;
  if (error?.name === 'QuotaExceededError') return new Error('브라우저 저장 공간이 부족합니다. 영상 포함 백업을 내려받고 불필요한 자료를 삭제한 뒤 다시 저장해 주세요.');
  if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return new Error('이 브라우저에서 개인 영상 저장소를 사용할 수 없습니다. 저장을 허용한 일반 창에서 다시 열어 주세요.');
  if (error instanceof Error && !['UnknownError', 'NotFoundError', 'DataError', 'TransactionInactiveError', 'ConstraintError', 'VersionError'].includes(error.name)) return error;
  return new Error('개인 영상 자료를 저장하거나 읽지 못했습니다. 영상 포함 백업을 보관하고 다시 시도해 주세요.');
}
function normalizedRecord(raw) {
  const record = normalizePersonalInput(raw);
  return { ...record, id: validId(raw.id), revision: validRevision(raw.revision), sha256: validHash(raw.sha256), createdAt: validTimestamp(raw.createdAt), updatedAt: validTimestamp(raw.updatedAt), broken: false };
}
function brokenRecord(raw, error) {
  return {
    id: typeof raw?.id === 'string' ? raw.id : '',
    revision: Number.isSafeInteger(raw?.revision) && raw.revision > 0 ? raw.revision : undefined,
    title: typeof raw?.title === 'string' ? raw.title.slice(0, 120) : '읽을 수 없는 자료',
    fileName: typeof raw?.fileName === 'string' ? raw.fileName.slice(0, 255) : '',
    captureDay: typeof raw?.captureDay === 'string' ? raw.captureDay.slice(0, 10) : '',
    session: typeof raw?.session === 'string' ? raw.session.slice(0, 120) : '',
    role: ROLES.has(raw?.role) ? raw.role : 'unassigned',
    document: null, video: raw?.video instanceof Blob ? raw.video : null,
    sha256: typeof raw?.sha256 === 'string' ? raw.sha256 : '',
    createdAt: Number.isFinite(raw?.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0,
    broken: true, error: error?.message || '자료를 읽을 수 없습니다. 영상 포함 백업에서 복원해 주세요.',
  };
}

/** Separate IndexedDB from the existing personal sign dictionary. No volatile fallback. */
export class PersonalLibrary {
  constructor({ indexedDB = globalThis.indexedDB, dbName = PERSONAL_DB_NAME } = {}) {
    this.indexedDB = indexedDB;
    this.dbName = dbName;
    this.dbPromise = null;
  }
  async init() { await this._database(); return this; }
  async _database() {
    if (!this.indexedDB) fail('이 브라우저에서 영상 포함 로컬 저장을 사용할 수 없습니다. 영상 포함 백업을 이용해 주세요.');
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        let settled = false;
        const request = this.indexedDB.open(this.dbName, 1);
        const rejectOnce = error => { if (!settled) { settled = true; reject(storageError(error)); } };
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(PERSONAL_STORE_NAME)) request.result.createObjectStore(PERSONAL_STORE_NAME, { keyPath: 'id' });
        };
        request.onerror = () => rejectOnce(request.error);
        request.onblocked = () => rejectOnce(new Error('다른 탭이 개인 자료 저장소를 사용 중입니다. 다른 탭을 닫고 다시 시도해 주세요.'));
        request.onsuccess = () => {
          const db = request.result;
          if (settled) { db.close(); return; }
          settled = true;
          db.onversionchange = () => { db.close(); this.dbPromise = null; };
          resolve(db);
        };
      }).catch(error => { this.dbPromise = null; throw storageError(error); });
    }
    return this.dbPromise;
  }
  async _read(id) {
    const db = await this._database();
    return new Promise((resolve, reject) => {
      let result;
      const transaction = db.transaction(PERSONAL_STORE_NAME, 'readonly');
      const store = transaction.objectStore(PERSONAL_STORE_NAME);
      const request = id === undefined ? store.getAll() : store.get(id);
      request.onsuccess = () => { result = request.result; };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(storageError(transaction.error || request.error));
    });
  }
  async list() {
    const rows = await this._read();
    return rows.map(raw => { try { return normalizedRecord(raw); } catch (error) { return brokenRecord(raw, error); } }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  async get(id) {
    const raw = await this._read(validId(id));
    if (!raw) return null;
    try {
      const record = normalizedRecord(raw);
      if (await hashVideo(record.video) !== record.sha256) fail('저장된 영상의 확인값이 일치하지 않습니다. 영상 포함 백업에서 복원해 주세요.');
      return record;
    } catch (error) {
      return brokenRecord(raw, error);
    }
  }
  async _mutate(mutate, signal) {
    checkSignal(signal);
    const db = await this._database();
    checkSignal(signal);
    return new Promise((resolve, reject) => {
      let result, failure;
      const transaction = db.transaction(PERSONAL_STORE_NAME, 'readwrite');
      const abort = () => { try { transaction.abort(); } catch { /* A completed transaction is already durable. */ } };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      transaction.oncomplete = () => { cleanup(); resolve(result); };
      transaction.onabort = () => { cleanup(); reject(failure ? storageError(failure) : (signal?.aborted ? abortError() : storageError(transaction.error))); };
      // An unhandled IDB request error aborts the transaction. Reject only on its terminal event.
      transaction.onerror = () => {};
      const store = transaction.objectStore(PERSONAL_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        try { checkSignal(signal); result = mutate(store, request.result); }
        catch (error) { failure = error; abort(); }
      };
    });
  }
  async save(input) {
    checkSignal(input?.signal);
    const record = normalizePersonalInput(input);
    const replacing = input.id !== undefined;
    const id = replacing ? validId(input.id) : `personal_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
    const expectedRevision = replacing ? validRevision(input.expectedRevision) : undefined;
    const sha256 = await hashVideo(record.video);
    checkSignal(input.signal);
    if (record.document.audit && record.document.audit.target.sha256 !== sha256) fail('AI 비교 기록의 대상 영상이 현재 영상과 다릅니다. 원본 영상을 확인해 주세요.');
    if (input.sha256 !== undefined && validHash(input.sha256) !== sha256) fail('영상 확인값이 일치하지 않습니다. 원본 영상 또는 영상 포함 백업을 확인해 주세요.');
    return this._mutate((store, rows) => {
      const existing = rows.find(row => row.id === id);
      if (replacing && (!existing || existing.revision !== expectedRevision)) fail('다른 탭에서 이 자료가 변경되었거나 삭제되었습니다. 다시 열어 확인한 뒤 저장해 주세요.');
      if (!replacing && rows.length >= MAX_PERSONAL_RECORDS) fail('개인 자료는 최대 20개까지 보관합니다. 영상 포함 백업 후 불필요한 자료를 삭제해 주세요.');
      const total = rows.reduce((sum, row) => sum + (row.id === id || !(row.video instanceof Blob) ? 0 : row.video.size), 0) + record.video.size;
      if (total > MAX_PERSONAL_TOTAL_BYTES) fail('개인 자료의 영상 합계는 200MiB까지 보관합니다. 영상 포함 백업 후 불필요한 자료를 삭제해 주세요.');
      const now = Date.now();
      const saved = { ...record, id, revision: existing ? existing.revision + 1 : 1, sha256, createdAt: existing ? validTimestamp(existing.createdAt) : now, updatedAt: now };
      validRevision(saved.revision);
      store.put(saved);
      return { ...saved, broken: false };
    }, input.signal);
  }
  async remove(id, expectedRevision, signal) {
    validId(id);
    return this._mutate((store, rows) => {
      const existing = rows.find(row => row.id === id);
      if (!existing) fail('이 자료는 이미 삭제되었습니다. 자료 목록을 새로고침해 주세요.');
      const revision = Number.isSafeInteger(existing.revision) && existing.revision > 0 ? existing.revision : undefined;
      if (revision !== expectedRevision) fail('다른 탭에서 이 자료가 변경되었습니다. 다시 열어 확인한 뒤 삭제해 주세요.');
      store.delete(id);
      return true;
    }, signal);
  }
  async close() {
    const pending = this.dbPromise;
    this.dbPromise = null;
    if (pending) (await pending).close();
  }
}

/** A binary backup contains one normalized annotation record plus the original video bytes. */
export async function encodePersonalBackup(input) {
  const record = normalizedRecord(input);
  if (await hashVideo(record.video) !== record.sha256) fail('영상 확인값이 일치하지 않아 백업할 수 없습니다. 원본 영상을 확인해 주세요.');
  const { video, broken, ...metadata } = record;
  const header = new TextEncoder().encode(JSON.stringify({ format: 'ksl-personal-video', version: 1, record: metadata, video: { size: video.size, type: videoType(video, record.fileName) } }));
  if (header.byteLength > MAX_PERSONAL_HEADER_BYTES) fail('백업의 주석 용량이 너무 큽니다. 자료를 나누어 주세요.');
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.byteLength, false);
  return new Blob([MAGIC, length, header, video], { type: 'application/octet-stream' });
}

/** Returns a new-record input: importing never reuses a saved ID or overwrites its revision. */
export async function decodePersonalBackup(backup) {
  if (!(backup instanceof Blob) || backup.size <= PREFIX_BYTES || backup.size > PREFIX_BYTES + MAX_PERSONAL_HEADER_BYTES + MAX_PERSONAL_VIDEO_BYTES) fail('지원하는 영상 포함 백업(.kslvideo)이 아니거나 파일 용량이 너무 큽니다.');
  const prefix = new Uint8Array(await backup.slice(0, PREFIX_BYTES).arrayBuffer());
  if (!MAGIC.every((byte, index) => prefix[index] === byte)) fail('영상 포함 백업(.kslvideo) 파일을 선택해 주세요. TXT·JSON은 영상 포함 백업이 아닙니다.');
  const headerLength = new DataView(prefix.buffer).getUint32(MAGIC.length, false);
  if (headerLength < 2 || headerLength > MAX_PERSONAL_HEADER_BYTES || PREFIX_BYTES + headerLength >= backup.size) fail('백업 파일의 주석 길이가 올바르지 않습니다.');
  let header;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await backup.slice(PREFIX_BYTES, PREFIX_BYTES + headerLength).arrayBuffer())); }
  catch { fail('백업 파일의 주석을 읽을 수 없습니다.'); }
  if (!isObject(header) || header.format !== 'ksl-personal-video' || header.version !== 1 || !isObject(header.video) || !isObject(header.record)) fail('지원하지 않는 영상 포함 백업 버전입니다.');
  if (!Number.isSafeInteger(header.video.size) || header.video.size < 1 || header.video.size > MAX_PERSONAL_VIDEO_BYTES || header.video.size !== backup.size - PREFIX_BYTES - headerLength || typeof header.video.type !== 'string' || !/^video\/[a-z0-9.+-]+(?:;[^\r\n]{1,120})?$/i.test(header.video.type)) fail('백업의 영상 크기 또는 형식이 올바르지 않습니다.');
  const video = backup.slice(PREFIX_BYTES + headerLength, backup.size, header.video.type);
  const record = normalizedRecord({ ...header.record, video });
  if (await hashVideo(video) !== record.sha256) fail('백업의 영상 확인값이 일치하지 않습니다. 손상되지 않은 영상 포함 백업을 선택해 주세요.');
  const { id, revision, createdAt, updatedAt, broken, ...input } = record;
  return input;
}

/** Annotation-only search: no video embedding, semantic recognition, or model training. */
export function searchPersonalRecords(records, query = '') {
  const terms = String(query).normalize('NFC').toLocaleLowerCase('ko-KR').trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return records.slice();
  return records.filter(record => {
    const rows = Array.isArray(record.document?.segments) ? record.document.segments : [];
    const fields = [record.title, record.fileName, record.captureDay, record.session, ...rows.flatMap(row => [row.text, row.original, ...ANNOTATIONS.map(field => row[field])])];
    const haystack = fields.filter(field => typeof field === 'string').join('\n').normalize('NFC').toLocaleLowerCase('ko-KR');
    return terms.every(term => haystack.includes(term));
  });
}
