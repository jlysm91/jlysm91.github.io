/** Local-only sign recordings. Feature backups deliberately exclude video blobs. */
export const FEATURE_VERSION = 2;
export const FEATURE_DIMENSION = 136;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_SAMPLE_FRAMES = 180;
export const MAX_SAMPLES_PER_WORD = 12;
const MAX_WORDS = 200;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const DB_NAME = 'signflow-local';
const STORAGE_KEY = 'signflow.local.v1';
const LEGACY_KEY = 'signLanguageData';
const LEGACY_MARKER = 'signflow.legacy-migrated.v1';

function fail(message) { throw new Error(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function makeId(prefix = 'sign') {
    return `${prefix}_${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`}`;
}
function validId(value, prefix) {
    if (value == null) return makeId(prefix);
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail('백업 파일의 식별자가 올바르지 않아요.');
    return value;
}
function timestamp(value, fallback = Date.now()) {
    if (value == null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8640000000000000) fail('저장 날짜가 올바르지 않아요.');
    return value;
}
function wordKey(value) { return value.toLocaleLowerCase('ko-KR'); }

export function normalizeWord(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) fail('단어를 올바르게 입력해 주세요.');
    const word = value.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!word || Array.from(word).length > 40) fail('단어는 1~40자로 입력해 주세요.');
    return word;
}

export function normalizeSample(value, inheritedFeatureVersion = FEATURE_VERSION) {
    if (!isObject(value)) fail('학습 샘플 형식이 올바르지 않아요.');
    if ((value.featureVersion ?? inheritedFeatureVersion) !== FEATURE_VERSION) fail('이 샘플은 현재 인식 모델과 호환되지 않아요. 다시 촬영해 주세요.');
    if (!Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > MAX_SAMPLE_FRAMES) fail('학습 샘플은 1~180개 프레임이어야 해요.');
    const frames = Array.from(value.frames, frame => {
        if (!Array.isArray(frame) || frame.length !== FEATURE_DIMENSION || !Array.from(frame).every(number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1000000)) {
            fail('학습 샘플의 손 동작 데이터가 올바르지 않아요.');
        }
        return frame.slice();
    });
    // Engine samples express duration in seconds.
    if (typeof value.duration !== 'number' || !Number.isFinite(value.duration) || value.duration <= 0 || value.duration > 120) fail('학습 샘플의 촬영 시간이 올바르지 않아요.');
    return {
        id: validId(value.id, 'sample'),
        createdAt: timestamp(value.createdAt),
        duration: value.duration,
        featureVersion: FEATURE_VERSION,
        frames
    };
}

function normalizeSign(value, inheritedFeatureVersion = FEATURE_VERSION) {
    if (!isObject(value)) fail('단어 데이터 형식이 올바르지 않아요.');
    const word = normalizeWord(value.word);
    if (!Array.isArray(value.samples) || value.samples.length > MAX_SAMPLES_PER_WORD) fail('단어마다 최대 12개의 학습 샘플을 보관할 수 있어요.');
    if (!value.samples.length && value.legacy !== true) fail('학습 샘플이 없는 단어가 포함되어 있어요.');
    const now = Date.now();
    const normalizedSamples = value.samples.map(sample => normalizeSample(sample, inheritedFeatureVersion));
    const uniqueSamples = [];
    const fingerprints = new Set();
    const ids = new Set();
    for (const sample of normalizedSamples) {
        const fingerprint = sampleFingerprint(sample);
        if (fingerprints.has(fingerprint)) continue;
        if (ids.has(sample.id)) sample.id = makeId('sample');
        fingerprints.add(fingerprint);
        ids.add(sample.id);
        uniqueSamples.push(sample);
    }
    return {
        id: validId(value.id, 'sign'), word,
        samples: uniqueSamples,
        createdAt: timestamp(value.createdAt, now),
        updatedAt: timestamp(value.updatedAt, now),
        legacy: value.legacy === true && value.samples.length === 0
    };
}

function sampleFingerprint(sample) { return JSON.stringify([sample.duration, sample.frames]); }

function mergeSigns(existing, incoming) {
    const merged = { ...existing, updatedAt: Math.max(existing.updatedAt, incoming.updatedAt), samples: existing.samples.slice() };
    const fingerprints = new Set(merged.samples.map(sampleFingerprint));
    const ids = new Set(merged.samples.map(sample => sample.id));
    for (const sample of incoming.samples) {
        const fingerprint = sampleFingerprint(sample);
        if (fingerprints.has(fingerprint)) continue;
        const added = ids.has(sample.id) ? { ...sample, id: makeId('sample') } : sample;
        merged.samples.push(added);
        ids.add(added.id);
        fingerprints.add(fingerprint);
    }
    if (merged.samples.length > MAX_SAMPLES_PER_WORD) fail(`“${merged.word}”의 샘플이 12개를 초과해요. 일부 샘플을 정리한 뒤 가져와 주세요.`);
    merged.createdAt = Math.min(existing.createdAt, incoming.createdAt);
    merged.legacy = merged.samples.length === 0;
    return merged;
}

/** Pure validation: returns normalized schema without changing storage. */
export function validateImport(input) {
    let data = input;
    if (typeof input === 'string') {
        if (new TextEncoder().encode(input).byteLength > MAX_IMPORT_BYTES) fail('백업 파일은 10MB 이하여야 해요.');
        try { data = JSON.parse(input); } catch { fail('JSON 백업 파일을 읽을 수 없어요.'); }
    } else {
        let serialized;
        try { serialized = JSON.stringify(input); } catch { fail('백업 데이터 형식이 올바르지 않아요.'); }
        if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_IMPORT_BYTES) fail('백업 파일은 10MB 이하여야 해요.');
    }
    if (!isObject(data) || data.schemaVersion !== 1 || data.featureVersion !== FEATURE_VERSION || !Array.isArray(data.signs) || data.signs.length > MAX_WORDS) {
        fail('지원하는 수어 백업 파일이 아니에요.');
    }
    const byWord = new Map();
    const signIds = new Set();
    for (const raw of data.signs) {
        const sign = normalizeSign(raw, data.featureVersion);
        const key = wordKey(sign.word);
        if (byWord.has(key)) {
            byWord.set(key, mergeSigns(byWord.get(key), sign));
        } else {
            if (signIds.has(sign.id)) sign.id = makeId('sign');
            signIds.add(sign.id);
            byWord.set(key, sign);
        }
    }
    return { schemaVersion: 1, featureVersion: FEATURE_VERSION, signs: [...byWord.values()] };
}

function requestResult(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('저장소를 읽을 수 없어요.'));
    });
}
function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('저장하지 못했어요.'));
        transaction.onabort = () => reject(transaction.error || new Error('저장이 취소되었어요.'));
    });
}
function publicSign(sign) {
    return {
        id: sign.id, word: sign.word, createdAt: sign.createdAt, updatedAt: sign.updatedAt,
        legacy: sign.legacy === true, hasVideo: sign.videoBlob instanceof Blob,
        samples: sign.samples.map(sample => ({ ...sample, frames: sample.frames.map(frame => frame.slice()) }))
    };
}

/** Each compact backup fits the import ceiling and keeps a word's samples together. */
export function splitExportData(signs, exportedAt = new Date().toISOString()) {
    if (!Array.isArray(signs) || signs.length > MAX_WORDS) fail('백업할 단어 데이터가 올바르지 않아요.');
    const encoder = new TextEncoder();
    const prefix = `${JSON.stringify({ schemaVersion: 1, featureVersion: FEATURE_VERSION, exportedAt }).slice(0, -1)},"signs":[`;
    const suffix = ']}';
    const overhead = encoder.encode(prefix + suffix).byteLength;
    const parts = [];
    let records = [], bytes = overhead;
    for (const record of signs) {
        // Video bytes and original incompatible features stay in this browser.
        const { hasVideo, videoBlob, videoDataURL, legacyData, ...sign } = record;
        const serialized = JSON.stringify(sign);
        const size = encoder.encode(serialized).byteLength;
        if (size + overhead > MAX_IMPORT_BYTES) fail(`“${sign.word}”의 백업이 10MB를 초과해요. 연습 예시를 정리한 뒤 다시 백업해 주세요.`);
        const separator = records.length ? 1 : 0;
        if (bytes + separator + size > MAX_IMPORT_BYTES) {
            parts.push(prefix + records.join(',') + suffix);
            records = []; bytes = overhead;
        }
        if (records.length) bytes += 1;
        records.push(serialized); bytes += size;
    }
    if (records.length || !parts.length) parts.push(prefix + records.join(',') + suffix);
    return parts;
}
async function blobToDataURL(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return `data:${blob.type || 'video/webm'};base64,${btoa(binary)}`;
}
function dataURLToBlob(value) {
    if (typeof value !== 'string' || value.length > MAX_VIDEO_BYTES * 1.4) return null;
    const match = /^data:(video\/[a-zA-Z0-9.+-]+(?:;[^\r\n]{1,120})?);base64,([A-Za-z0-9+/=]*)$/.exec(value);
    if (!match) return null;
    try {
        const binary = atob(match[2]);
        return new Blob([Uint8Array.from(binary, character => character.charCodeAt(0))], { type: match[1] });
    } catch { return null; }
}

export class SignStore {
    constructor(options = {}) {
        this.mode = 'memory';
        this.warning = '';
        this._records = new Map();
        this._db = null;
        this._initPromise = null;
        this._mutation = Promise.resolve();
        try { this._indexedDB = options.indexedDB ?? globalThis.indexedDB; } catch { this._indexedDB = null; }
        try { this._localStorage = options.localStorage ?? globalThis.localStorage; } catch { this._localStorage = null; }
    }

    async init() {
        if (!this._initPromise) this._initPromise = this._initialize();
        await this._initPromise;
        return this;
    }

    async _initialize() {
        let migrated = false;
        if (this._indexedDB) {
            try {
                this._db = await new Promise((resolve, reject) => {
                    const request = this._indexedDB.open(DB_NAME, 1);
                    let settled = false;
                    const timer = setTimeout(() => { settled = true; reject(new Error('저장소 연결 시간 초과')); }, 4000);
                    request.onupgradeneeded = () => {
                        const db = request.result;
                        if (!db.objectStoreNames.contains('signs')) db.createObjectStore('signs', { keyPath: 'id' });
                        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
                    };
                    request.onsuccess = () => { clearTimeout(timer); if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
                    request.onerror = () => { clearTimeout(timer); settled = true; reject(request.error); };
                    request.onblocked = () => { clearTimeout(timer); settled = true; reject(new Error('저장소가 다른 탭에서 사용 중이에요.')); };
                });
                this._db.onversionchange = () => { this._db?.close(); this._db = null; this.mode = 'memory'; this.warning = '저장소가 변경되었어요. 페이지를 새로고침해 주세요.'; };
                const transaction = this._db.transaction(['signs', 'meta'], 'readonly');
                const [records, marker] = await Promise.all([
                    requestResult(transaction.objectStore('signs').getAll()),
                    requestResult(transaction.objectStore('meta').get('legacyMigration'))
                ]);
                this._restoreRecords(records);
                migrated = marker === true;
                this.mode = 'indexeddb';
                if (!migrated && !this._records.size) this._restoreFallback();
            } catch {
                this._db?.close(); this._db = null;
                this.warning = '브라우저의 기본 저장소를 사용할 수 없어 보조 저장소를 사용해요.';
            }
        }
        if (!this._db) {
            try {
                if (!this._localStorage) throw new Error('No local storage');
                const probe = `${STORAGE_KEY}.probe`;
                this._localStorage.setItem(probe, '1');
                this._localStorage.removeItem(probe);
                this.mode = 'localstorage';
                migrated = this._restoreFallback() || this._localStorage.getItem(LEGACY_MARKER) === '1';
            } catch {
                this.mode = 'memory';
                this.warning = '브라우저 저장이 제한되어 있어요. 현재 세션에서 사용할 수 있으며, 새로고침 전에 백업해 주세요.';
            }
        }
        if (!migrated) this._migrateLegacy();
        // Commit restored fallback/legacy data before recording the migration marker.
        if (this.mode !== 'memory') {
            try {
                await this._persist(this._records, true);
                if (this.mode === 'indexeddb') {
                    const transaction = this._db.transaction('meta', 'readwrite');
                    const done = transactionDone(transaction);
                    transaction.objectStore('meta').put(true, 'legacyMigration');
                    await done;
                } else this._localStorage.setItem(LEGACY_MARKER, '1');
            } catch {
                this.warning = '기존 데이터는 불러왔지만 저장 공간이 부족해요. 백업한 뒤 저장 공간을 확보해 주세요.';
            }
        }
    }

    _restoreRecords(records) {
        if (!Array.isArray(records)) return;
        for (const record of records.slice(0, MAX_WORDS)) {
            try {
                const sign = normalizeSign(record);
                if (record.legacyData && isObject(record.legacyData)) sign.legacyData = record.legacyData;
                if (record.videoBlob instanceof Blob && record.videoBlob.size <= MAX_VIDEO_BYTES) sign.videoBlob = record.videoBlob;
                else if (record.videoDataURL) sign.videoBlob = dataURLToBlob(record.videoDataURL);
                const existing = [...this._records.values()].find(item => wordKey(item.word) === wordKey(sign.word));
                if (existing) this._records.set(existing.id, mergeSigns(existing, sign));
                else {
                    if (this._records.has(sign.id)) sign.id = makeId('sign');
                    this._records.set(sign.id, sign);
                }
            } catch { this.warning = '일부 손상된 학습 데이터를 건너뛰었어요.'; }
        }
    }

    _restoreFallback() {
        try {
            const raw = this._localStorage?.getItem(STORAGE_KEY);
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (data.schemaVersion !== 1 || !Array.isArray(data.signs)) return false;
            this._restoreRecords(data.signs);
            return data.legacyMigrated === true;
        } catch { return false; }
    }

    _migrateLegacy() {
        try {
            const raw = this._localStorage?.getItem(LEGACY_KEY);
            if (!raw || raw.length > MAX_IMPORT_BYTES) return;
            const data = JSON.parse(raw);
            const signs = data.trainedSigns;
            if (!isObject(signs)) return;
            for (const [word, legacyData] of Object.entries(signs).slice(0, MAX_WORDS)) {
                if (this._records.size >= MAX_WORDS) break;
                try {
                    const normalized = normalizeWord(word);
                    if (!isObject(legacyData) || [...this._records.values()].some(sign => wordKey(sign.word) === wordKey(normalized))) continue;
                    const date = timestamp(legacyData.timestamp, timestamp(data.savedAt));
                    const sign = { id: makeId('legacy'), word: normalized, samples: [], createdAt: date, updatedAt: date, legacy: true, legacyData };
                    this._records.set(sign.id, sign);
                } catch { /* Preserve malformed original entries in the untouched legacy key. */ }
            }
        } catch { /* The original legacy key is always left untouched. */ }
    }

    async _persist(records, replace = false) {
        if (this.mode === 'indexeddb' && this._db) {
            const transaction = this._db.transaction('signs', 'readwrite');
            const done = transactionDone(transaction);
            const store = transaction.objectStore('signs');
            if (replace) store.clear();
            for (const sign of records.values()) store.put(sign);
            try { await done; } catch { fail('저장 공간이 부족하거나 브라우저 저장이 제한되어 있어요. 백업한 뒤 다시 시도해 주세요.'); }
        } else if (this.mode === 'localstorage') {
            const signs = await Promise.all([...records.values()].map(async record => {
                const { videoBlob, ...sign } = record;
                return videoBlob instanceof Blob ? { ...sign, videoDataURL: await blobToDataURL(videoBlob) } : sign;
            }));
            try { this._localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, legacyMigrated: true, signs })); }
            catch { fail('보조 저장소가 가득 찼어요. 일부 단어를 삭제하거나 다른 브라우저에서 다시 시도해 주세요.'); }
        }
    }

    _serializeMutation(operation) {
        const result = this._mutation.then(operation);
        this._mutation = result.catch(() => {});
        return result;
    }

    async list() {
        await this.init();
        await this._mutation;
        return [...this._records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(publicSign);
    }

    async saveSample(word, sample, videoBlob = null) {
        await this.init();
        return this._serializeMutation(async () => {
            const normalized = normalizeWord(word);
            const normalizedSample = normalizeSample(sample);
            if (videoBlob != null && (!(videoBlob instanceof Blob) || videoBlob.size > MAX_VIDEO_BYTES || (videoBlob.type && !videoBlob.type.startsWith('video/')))) fail('영상은 20MB 이하의 영상 파일이어야 해요.');
            const existing = [...this._records.values()].find(sign => wordKey(sign.word) === wordKey(normalized));
            if (!existing && this._records.size >= MAX_WORDS) fail('최대 200개의 단어를 보관할 수 있어요.');
            const now = Date.now();
            const sign = existing ? { ...existing, samples: existing.samples.slice() } : { id: makeId('sign'), word: normalized, samples: [], createdAt: now };
            if (sign.samples.some(item => item.id === normalizedSample.id)) normalizedSample.id = makeId('sample');
            sign.samples.push(normalizedSample);
            sign.samples = sign.samples.slice(-MAX_SAMPLES_PER_WORD);
            sign.updatedAt = now;
            sign.legacy = false;
            if (videoBlob instanceof Blob && videoBlob.size) sign.videoBlob = videoBlob;
            const next = new Map(this._records).set(sign.id, sign);
            await this._persist(next);
            this._records = next;
            return publicSign(sign);
        });
    }

    async remove(id) {
        await this.init();
        return this._serializeMutation(async () => {
            if (!this._records.has(id)) return false;
            const next = new Map(this._records);
            next.delete(id);
            await this._persist(next, true);
            this._records = next;
            return true;
        });
    }

    async getVideo(id) {
        await this.init();
        await this._mutation;
        const blob = this._records.get(id)?.videoBlob;
        return blob instanceof Blob ? blob : null;
    }

    async exportData() {
        const parts = await this.exportParts();
        if (parts.length > 1) fail('학습 데이터가 10MB를 초과해요. 분할 백업으로 모든 파일을 내려받아 주세요.');
        return parts[0];
    }

    async exportParts() {
        return splitExportData(await this.list());
    }

    async importData(json, { replace = false } = {}) {
        const validated = validateImport(json);
        await this.init();
        return this._serializeMutation(async () => {
            const next = replace ? new Map() : new Map(this._records);
            for (const incoming of validated.signs) {
                const existing = [...next.values()].find(sign => wordKey(sign.word) === wordKey(incoming.word));
                if (existing) next.set(existing.id, mergeSigns(existing, incoming));
                else {
                    const sign = next.has(incoming.id) ? { ...incoming, id: makeId('sign') } : incoming;
                    next.set(sign.id, sign);
                }
            }
            if (next.size > MAX_WORDS) fail('백업을 포함해 최대 200개의 단어를 보관할 수 있어요.');
            await this._persist(next, true);
            this._records = next;
            return { count: validated.signs.length };
        });
    }
}
