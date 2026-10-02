import assert from 'node:assert/strict';
import { VideoSignAnalyzer } from '../js/video-engine.js';

const errors = [];
const analyzer = new VideoSignAnalyzer({ onError: (error) => errors.push(error) });
await assert.rejects(analyzer.analyze(), /영상 파일을 선택/);
await assert.rejects(analyzer.analyze({ file: { size: 50 * 1024 * 1024 + 1, type: 'video/mp4' } }), /50MB 이하/);
await assert.rejects(analyzer.analyze({ file: { size: 100, type: 'image/png' } }), /동영상 파일을 선택/);
await assert.rejects(analyzer.analyze({ file: { size: 100, type: 'video/mp4' }, signs: [{ word: '구형 단어', features: [], legacy: true }] }), /내 사전에 수어 동작을 등록/);
assert.equal(errors.length, 4, 'Validation errors should be reported once.');
assert.equal(analyzer._active, null, 'Failed validation must not leave an active job.');

const controller = new AbortController();
controller.abort();
await assert.rejects(analyzer.analyze({ signal: controller.signal }), (error) => error.name === 'AbortError');
assert.equal(errors.length, 4, 'User cancellation must not emit an error notification.');
assert.equal(analyzer._active, null);
await analyzer.cancel();
console.log('Video engine: 9 file validation, cancellation and resource-state checks passed.');
