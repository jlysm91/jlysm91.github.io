import assert from 'node:assert/strict';
import {
  SignEngine, extractHandFeatures, downsampleSequence,
  frameDistance, sequenceDistance, matchSequence,
  prepareSignTemplates, matchRecentSequences,
} from '../js/engine.js';

const hand = Array.from({ length: 21 }, (_, i) => ({ x: 0.45 + Math.sin(i * 0.8) * 0.06, y: 0.65 - i * 0.012, z: i * 0.001 }));
const right = extractHandFeatures([hand], [{ label: 'Right' }]);
const baseSequence = Array.from({ length: 24 }, () => right);
const transformed = hand.map((point) => ({ x: (point.x - 0.45) * 1.6 + 0.35, y: (point.y - 0.65) * 1.6 + 0.55, z: point.z * 1.6 }));
const scaled = extractHandFeatures([transformed], [{ label: 'Right' }]);
assert.ok(sequenceDistance(baseSequence, Array.from({ length: 40 }, () => scaled)) < 0.01, 'Scale, translation and timing changes should preserve a recorded pose.');

const secondHand = hand.map((point) => ({ ...point, x: point.x + 0.3 }));
assert.deepEqual(
  extractHandFeatures([hand, secondHand], [{ label: 'Left' }, { label: 'Right' }]),
  extractHandFeatures([secondHand, hand], [{ label: 'Right' }, { label: 'Left' }]),
  'Detector result order must not change hand slots.',
);
assert.equal(extractHandFeatures([]), null);
assert.equal(extractHandFeatures([[{ x: NaN, y: 0 }]]), null);
assert.equal(frameDistance(Array(136).fill(0), Array(136).fill(0)), Infinity, 'Missing hands must never match.');
assert.equal(matchSequence([], [{ word: '안녕', frames: baseSequence }]), null);
assert.equal(matchSequence(baseSequence, [{ word: '안녕', id: 'one', frames: baseSequence }]).word, '안녕');
assert.equal(matchSequence(baseSequence, [{ word: '안녕', frames: baseSequence }, { word: '다른 단어', frames: baseSequence }]), null, 'Indistinguishable words must be rejected as ambiguous.');
assert.equal(downsampleSequence(Array.from({ length: 1000 }, () => right)).length, 32);
const left = extractHandFeatures([hand], [{ label: 'Left' }]);
assert.ok(sequenceDistance(baseSequence, Array.from({ length: 24 }, () => left)) > 1, 'Absent/present hand mismatches need a large penalty.');

const moving = Array.from({ length: 24 }, (_, i) => {
  const frame = right.slice();
  frame[131] += i * 0.007;
  return frame;
});
assert.ok(sequenceDistance(moving, moving.toReversed()) > 0.15, 'Reversing a movement must change its temporal match.');

const signs = Array.from({ length: 40 }, (_, wordIndex) => ({
  word: `단어-${wordIndex}`,
  samples: Array.from({ length: 3 }, (_, sampleIndex) => ({
    id: `${wordIndex}-${sampleIndex}`, duration: 2,
    frames: baseSequence.map((frame) => {
      const changed = frame.slice();
      for (let index = 68; index < 131; index += 1) changed[index] += wordIndex * 0.08 + sampleIndex * 0.005;
      return changed;
    }),
  })),
}));
const engine = new SignEngine();
engine.setSamples(signs);
const timestamp = 5000;
engine._recent = signs[25].samples[2].frames.map((frame, i) => ({ frame, timestamp: timestamp - (23 - i) * 85 }));
engine._recognize(timestamp);
assert.ok(engine._recognitionStats.templates <= 24, 'Large libraries must bound exact DTW work.');
assert.ok(engine._recognitionStats.exactComparisons <= 72);
assert.equal(engine._recognitionStats.words, 12, 'Repeated samples must not crowd out competing words.');
assert.equal(engine._candidate?.word, '단어-25', 'The coarse stage must retain the exact matching template.');

let frameEvent;
const invalidEngine = new SignEngine({ video: { videoWidth: 640, videoHeight: 480 }, onFrame: (event) => { frameEvent = event; } });
invalidEngine._onResults({ multiHandLandmarks: [[{ x: NaN, y: 0 }]], multiHandedness: [{ label: 'Right' }] });
assert.equal(frameEvent.handCount, 0, 'Malformed landmark results must report zero usable hands.');
assert.equal(invalidEngine._recent.length, 0);

assert.equal(prepareSignTemplates([{ word: '구형 단어', features: baseSequence, legacy: true }]).length, 0, 'Legacy formats must not silently become compatible templates.');
const prepared = prepareSignTemplates([{ word: '안녕', samples: [{ id: 'shared', frames: baseSequence, duration: 2 }] }]);
const sharedResult = matchRecentSequences(baseSequence.map((frame, i) => ({ frame, timestamp: 5000 - (23 - i) * 90 })), prepared, { timestamp: 5000 });
assert.equal(sharedResult.match.word, '안녕', 'Camera and uploaded video must share the same pure matcher.');
assert.ok(sharedResult.match.windowDuration > 0 && sharedResult.match.windowDuration <= 8);

const heldEvents = [];
const heldEngine = new SignEngine({ onRecognition: (event) => heldEvents.push(event) });
heldEngine.setSamples([{ word: '유지', samples: [{ id: 'held', duration: 4, frames: baseSequence }] }]);
const supplyHeld = (timestamp, spacing) => {
  heldEngine._recent = baseSequence.map((frame, i) => ({ frame, timestamp: timestamp - (23 - i) * spacing }));
  heldEngine._recognize(timestamp);
};
for (const timestamp of [5000, 5350, 5700]) supplyHeld(timestamp, 150);
assert.equal(heldEvents.length, 1);
for (const timestamp of [6800, 7150, 7500]) supplyHeld(timestamp, 50);
assert.equal(heldEngine._released, false, 'Refilling a cleared window must not release a held pose.');
for (const timestamp of [8000, 8350, 8700]) supplyHeld(timestamp, 150);
assert.equal(heldEvents.length, 1, 'A continuously held pose must not repeat after the cooldown.');
console.log('Engine: 23 geometry, temporal matching, shared-video matching, ambiguity, validity and bounded-shortlist checks passed.');
