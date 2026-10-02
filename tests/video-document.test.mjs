import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVideoDocument, validateVideoDocument, videoDocumentText } from '../js/video-document.js';

test('local candidates never become a Korean translation automatically', () => {
 const doc = createVideoDocument({ words: [{ word: '안녕', start: 0, end: 2 }] }, 'local', 4);
 assert.equal(doc.segments[0].text, '');
 assert.equal(doc.segments[0].original, '안녕');
 assert.match(videoDocumentText(doc), /문장 번역 아님/);
 assert.match(videoDocumentText(doc), /내용 확인 필요/);
});
test('AI originals, edits, uncertainty and partial abstention remain distinct', () => {
 const doc = createVideoDocument({ segments: [{ text: '원본', start: 0, end: 2 }], unreadableReason: '뒷부분 확인 필요' }, 'ai', 4);
 assert.equal(doc.segments[0].reviewed, false);
 doc.segments[0].text = '사용자 수정문'; doc.segments[0].reviewed = true;
 assert.equal(doc.segments[0].original, '원본');
 assert.match(videoDocumentText(doc), /사용자 수정문/);
 assert.match(videoDocumentText(doc), /사용자 검토함/);
 assert.match(videoDocumentText(doc), /성능 미검증/);
 assert.match(videoDocumentText(doc), /뒷부분 확인 필요/);
 assert.equal(JSON.parse(JSON.stringify(doc)).segments[0].original, '원본');
});
test('bad timestamps and oversized text cannot be exported', () => {
 for (const times of [[NaN,2],[-1,2],[2,2],[3,2],[0,5]]) {
  const doc=createVideoDocument({segments:[{text:'초안',start:times[0],end:times[1]}]},'ai',4);
  assert.match(validateVideoDocument(doc),/시작·끝/);
  assert.throws(()=>videoDocumentText(doc));
 }
 const doc=createVideoDocument({segments:[{text:'x'.repeat(501),start:0,end:2}]},'ai',4);
 assert.match(validateVideoDocument(doc),/500자/);
});
test('export sorts by time without mutating editor order and preserves empty intervals',()=>{
 const doc=createVideoDocument({segments:[{text:'뒤',start:2,end:3},{text:'',start:0,end:1}]},'ai',4);
 doc.segments[1].reviewed=true;
 const text=videoDocumentText(doc);
 assert.ok(text.indexOf('00:00.0')<text.indexOf('00:02.0'));
 assert.match(text,/검토 필요\] \[내용 확인 필요/);
 assert.equal(doc.segments[0].text,'뒤');
});
test('empty results keep their abstention reason',()=>{
 const doc=createVideoDocument({segments:[],unreadableReason:'판독을 보류했습니다.'},'ai',4);
 assert.match(videoDocumentText(doc),/작성된 변환문이 없습니다/);
 assert.match(videoDocumentText(doc),/판독을 보류/);
});

test('literal/context/uncertainty survive text export without declaring uncertainty reviewed', () => {
 const doc = createVideoDocument({ segments: [{ text: '자연스러운 문장', start: 0, end: 2 }] }, 'ai', 4);
 Object.assign(doc.segments[0], { literal: '수어 순서 직역', context: '사전에 알던 상황', referents: '왼쪽의 인물', intent: '질문', uncertainty: '날짜 확인 필요', reviewed: true });
 const exported = videoDocumentText(doc);
 for (const value of ['직역: 수어 순서 직역', '상황·문맥: 사전에 알던 상황', '지시 대상: 왼쪽의 인물', '의도: 질문', '불확실한 부분: 날짜 확인 필요', '[검토 필요]']) assert.ok(exported.includes(value));
 assert.equal(doc.segments[0].original, '자연스러운 문장');
 assert.equal(doc.segments[0].reviewed, true);
 doc.segments[0].literal = 'x'.repeat(1001);
 assert.match(validateVideoDocument(doc), /1000자/);
});
