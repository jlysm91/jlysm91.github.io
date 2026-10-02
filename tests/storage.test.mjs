import assert from 'node:assert/strict';
import { SignStore, validateImport, splitExportData, MAX_IMPORT_BYTES } from '../js/storage.js';

class LocalStorage {
  values = new Map();
  quota = false;
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { if (this.quota && key === 'signflow.local.v1') throw new Error('quota'); this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}
const makeSample = (n = 0) => ({ duration: 2.5, featureVersion: 2, frames: Array.from({ length: 24 }, () => Array(136).fill(n)) });
const makeFile = signs => JSON.stringify({ schemaVersion: 1, featureVersion: 2, signs });
const storage = new LocalStorage();
storage.setItem('signLanguageData', JSON.stringify({ trainedSigns: { '안녕': { features: [[1, 2, 3]], timestamp: 1728000000000 } }, savedAt: 1728000000000 }));
const original = storage.getItem('signLanguageData');
const store = await new SignStore({ localStorage: storage }).init();
assert.equal(store.mode, 'localstorage');
let signs = await store.list();
assert.equal(signs.length, 1);
assert.equal(signs[0].legacy, true);
assert.equal(signs[0].samples.length, 0);
assert.equal(storage.getItem('signLanguageData'), original);
const video = new Blob(['valid recording fixture'], { type: 'video/webm;codecs=vp8,opus' });
const saved = await store.saveSample(' 안녕 ', makeSample(), video);
assert.equal(saved.legacy, false);
assert.equal(saved.hasVideo, true);
assert.equal(saved.samples.length, 1);
assert.equal(await (await store.getVideo(saved.id)).text(), 'valid recording fixture');
const reloaded = await new SignStore({ localStorage: storage }).init();
assert.equal((await reloaded.list())[0].samples.length, 1);
assert.equal(await (await reloaded.getVideo(saved.id)).text(), 'valid recording fixture');
const exported = await store.exportData();
assert.equal(JSON.parse(exported).featureVersion, 2);
assert.equal(exported.includes('videoDataURL'), false);
await store.importData(exported);
assert.equal((await store.list())[0].samples.length, 1);
const badSamples = [
  { ...makeSample(), featureVersion: 1 },
  { ...makeSample(), frames: [Array(135).fill(0)] },
  { ...makeSample(), frames: [Array(136).fill(NaN)] },
  { ...makeSample(), frames: [Array(136)] },
  { ...makeSample(), frames: Array(4) },
  { ...makeSample(), frames: Array.from({length: 181}, () => Array(136).fill(0)) },
  { ...makeSample(), duration: -1 }
];
for (const sample of badSamples) await assert.rejects(store.saveSample('새 단어', sample));
assert.throws(() => validateImport(makeFile([{ word: '긴'.repeat(41), samples: [makeSample()] }])));
assert.throws(() => validateImport(makeFile([{ word: '제어\u0000', samples: [makeSample()] }])));
assert.throws(() => validateImport('{bad json'));
assert.throws(() => validateImport(' '.repeat(MAX_IMPORT_BYTES + 1)));
assert.throws(() => validateImport(JSON.stringify({schemaVersion: 99, featureVersion: 2, signs: []})));
const duplicate = { word: '중복', samples: [makeSample(), makeSample()] };
assert.equal(validateImport(makeFile([duplicate, duplicate])).signs[0].samples.length, 1);
await assert.rejects(store.importData(makeFile([{ word: '실패', samples: [{ ...makeSample(), duration: 0 }] }]), { replace: true }));
assert.equal((await store.list())[0].word, '안녕');
storage.quota = true;
await assert.rejects(store.saveSample('저장 실패', makeSample()));
assert.equal((await store.list()).length, 1);
storage.quota = false;
await Promise.all([store.saveSample('동시', makeSample(1)), store.saveSample('동시', makeSample(2))]);
assert.equal((await store.list()).find(sign => sign.word === '동시').samples.length, 2);
await store.importData(makeFile([]), { replace: true });
assert.deepEqual(await store.list(), []);
const clean = await new SignStore({ localStorage: storage }).init();
assert.deepEqual(await clean.list(), []); // Deleted legacy words must not resurrect.
await clean.saveSample('__proto__', makeSample());
assert.equal((await clean.list())[0].word, '__proto__');
assert.equal({}.polluted, undefined);
console.log('PASS: legacy migration, fallback video persistence, schema validation, atomic failures, duplicate merge, concurrent saves, replacement and safe keys.');

// A large collection must produce files that can all be restored through the
// same 10MB import API. Never split one word across two independently merged parts.
class RestrictedStorage { getItem() { return null; } setItem() { throw new Error('restricted'); } }
const large = await new SignStore({ localStorage: new RestrictedStorage() }).init();
for (let index = 0; index < 32; index++) {
  const number = 0.12345678901234568 + index * 0.0001;
  await large.saveSample(`분할 테스트 ${index}`, {
    id: `large_sample_${index}`, duration: 8, featureVersion: 2,
    frames: Array.from({ length: 180 }, () => Array(136).fill(number))
  });
}
const parts = await large.exportParts();
assert.ok(parts.length > 1, 'fixture must exceed one import-sized backup');
await assert.rejects(large.exportData(), /분할 백업/);
const restored = await new SignStore({ localStorage: new RestrictedStorage() }).init();
const coveredWords = new Set();
for (const part of parts) {
  assert.ok(new TextEncoder().encode(part).byteLength <= MAX_IMPORT_BYTES);
  const normalized = validateImport(part);
  for (const sign of normalized.signs) {
    assert.equal(coveredWords.has(sign.word), false, 'a word must stay in one file');
    coveredWords.add(sign.word);
  }
  await restored.importData(part);
}
const sourceSigns = (await large.list()).sort((a, b) => a.word.localeCompare(b.word));
const restoredSigns = (await restored.list()).sort((a, b) => a.word.localeCompare(b.word));
assert.deepEqual(restoredSigns, sourceSigns);
assert.equal(coveredWords.size, 32);
assert.equal(splitExportData([]).length, 1);
assert.deepEqual(validateImport(splitExportData([])[0]).signs, []);
assert.throws(() => splitExportData([{ word: '과도한 단어', samples: [], extra: 'x'.repeat(MAX_IMPORT_BYTES) }]), /10MB/);
console.log(`PASS: ${32} large words split into ${parts.length} files <=10MB and merge roundtrip exactly; empty and oversized-single-word guards.`);
