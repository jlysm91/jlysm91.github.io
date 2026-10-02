import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SignEngine, extractHandFeatures } from '../js/engine.js';

function gesture(wordIndex, variation = 0, frameCount = 48) {
  return Array.from({ length: frameCount }, (_, i) => {
    const progress = i / (frameCount - 1);
    const wrist = { x: 0.5 + Math.sin(progress * Math.PI) * 0.025, y: 0.72 - progress * 0.025, z: 0 };
    const points = [wrist];
    for (let finger = 0; finger < 5; finger += 1) {
      const curl = ((wordIndex >> (finger * 2)) & 3) / 3;
      for (let joint = 1; joint <= 4; joint += 1) {
        points.push({
          x: wrist.x + (finger - 2) * 0.037 + variation * 0.001 * Math.sin(joint + progress),
          y: wrist.y - 0.055 - joint * 0.035 * (1 - curl) + curl * 0.014 * Math.sin(joint),
          z: -curl * joint * 0.012,
        });
      }
    }
    return extractHandFeatures([points], [{ label: wordIndex % 2 ? 'Right' : 'Left' }], { aspectRatio: 16 / 9 });
  });
}

const results = [];
for (const samplesPerWord of [3, 12]) {
  const signs = Array.from({ length: 200 }, (_, wordIndex) => ({ word: `수어-${wordIndex}`, samples: Array.from({ length: samplesPerWord }, (_, variation) => ({ id: `${wordIndex}-${variation}`, duration: 4, frames: gesture(wordIndex, variation) })) }));
  const engine = new SignEngine();
  const prepareStarted = performance.now();
  engine.setSamples(signs);
  const prepareMs = performance.now() - prepareStarted;
  const target = signs[173].samples[samplesPerWord - 1].frames;
  const durations = [];
  for (let run = 0; run < 14; run += 1) {
    const timestamp = 10000;
    engine._resetRecognition();
    engine._recent = target.map((frame, i) => ({ frame, timestamp: timestamp - (target.length - 1 - i) * 82 }));
    const started = performance.now();
    engine._recognize(timestamp);
    const elapsed = performance.now() - started;
    if (run > 2) durations.push(elapsed);
    assert.equal(engine._candidate?.word, '수어-173', 'The exact target survives shortlist and ambiguity checks.');
    assert.ok(engine._recognitionStats.templates <= 24);
    assert.ok(engine._recognitionStats.exactComparisons <= 72);
    assert.equal(engine._recognitionStats.words, 12);
  }
  durations.sort((a, b) => a - b);
  results.push({ words: 200, samplesPerWord, sampleCount: engine.samples.length, prepareMs: +prepareMs.toFixed(2), recognitionMedianMs: +durations[Math.floor(durations.length / 2)].toFixed(2), recognitionP95Ms: +durations[Math.floor(durations.length * 0.95)].toFixed(2), stats: engine._recognitionStats });
}
console.log(JSON.stringify(results, null, 2));
