import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVideoRecorder, finalizeWebMDuration, finalizeRecordedVideo } from '../js/video-recorder.js';

class FakeTrack extends EventTarget {
  stopped = 0;
  stop() { this.stopped++; }
  getSettings() { return { deviceId: 'synthetic-camera' }; }
}
const makeStream = () => {
  const track = new FakeTrack();
  return { track, getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
};
const video = () => ({ srcObject: null, muted: false, playsInline: false, play: async () => {}, pause() {} });
function clock() {
  let time = 0, id = 0;
  const timers = new Map();
  const add = (callback, delay, repeat) => { timers.set(++id, { callback, due: time + delay, repeat }); return id; };
  return {
    now: () => time,
    setTimeout: (fn, delay) => add(fn, delay, 0), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => add(fn, delay, delay), clearInterval: id => timers.delete(id),
    count: () => timers.size,
    tick(delta) {
      const end = time + delta;
      while (true) {
        const next = [...timers].filter(([,timer]) => timer.due <= end).sort((a,b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [timerId, timer] = next; time = timer.due;
        if (timer.repeat) timer.due += timer.repeat; else timers.delete(timerId);
        timer.callback();
      }
      time = end;
    },
  };
}
function harness({ getUserMedia, finalize, Recorder, maxSeconds = 60, maxBytes = 50 * 1024 * 1024, play } = {}) {
  const timers = clock(), streams = [], calls = [], recorders = [], states = [];
  const doc = new EventTarget(), win = new EventTarget(); doc.hidden = false;
  const preview = video(); if (play) preview.play = play;
  class FakeRecorder {
    static isTypeSupported(type) { return type === 'video/webm;codecs=vp8'; }
    constructor(stream, options) { this.stream = stream; this.mimeType = options.mimeType; this.state = 'inactive'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['synthetic-video'], { type: this.mimeType }) });
        this.onstop?.();
      });
    }
  }
  const media = new EventTarget();
  media.getUserMedia = constraints => {
    calls.push(constraints);
    if (getUserMedia) return getUserMedia(constraints);
    const stream = makeStream(); streams.push(stream); return Promise.resolve(stream);
  };
  media.enumerateDevices = async () => [{ kind: 'audioinput', deviceId: 'never-requested' }, { kind: 'videoinput', deviceId: 'synthetic-camera', label: '합성 카메라' }];
  const recorder = createVideoRecorder({ video: preview, onState: state => states.push(state), deps: {
    mediaDevices: media, MediaRecorder: Recorder || FakeRecorder, document: doc, window: win, ...timers, maxSeconds, maxBytes,
    finalize: finalize || (async (blob, elapsed) => ({ file: new File([blob], 'synthetic.webm', { type: 'video/webm' }), duration: elapsed, width: 320, height: 240, mirrored: false })),
  } });
  return { recorder, timers, streams, calls, recorders, states, doc, win, preview, media };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('construction/device listing does not open a camera; explicit open requests video without audio', async () => {
  const h = harness(); assert.equal(h.calls.length, 0);
  const devices = await h.recorder.listDevices(); assert.equal(h.calls.length, 0);
  assert.deepEqual(devices, [{ deviceId: 'synthetic-camera', label: '합성 카메라' }]);
  await h.recorder.open('synthetic-camera');
  assert.equal(h.calls[0].audio, false);
  assert.deepEqual(h.calls[0].video.deviceId, { exact: 'synthetic-camera' });
  assert.equal(h.preview.srcObject, h.streams[0]);
  assert.equal(h.preview.muted, true); assert.equal(h.preview.playsInline, true);
  assert.equal(h.recorder.state.phase, 'preview');
  h.recorder.close(); assert.equal(h.streams[0].track.stopped, 1); assert.equal(h.preview.srcObject, null);
});

test('repeated pending open shares one permission request; cancel settles immediately and stops a late stream', async () => {
  let grant;
  const h = harness({ getUserMedia: () => new Promise(resolve => { grant = resolve; }) });
  const first = h.recorder.open(), second = h.recorder.open();
  assert.equal(first, second); await flush(); assert.equal(h.calls.length, 1);
  h.recorder.cancel();
  await assert.rejects(first, { name: 'AbortError' });
  const late = makeStream(); grant(late); await flush();
  assert.equal(late.track.stopped, 1); assert.equal(h.preview.srcObject, null);
  assert.equal(h.recorder.state.phase, 'idle'); assert.equal(h.timers.count(), 0);
});


test('immediate close invalidates a queued permission request before it is sent', async () => {
  const h = harness();
  const pending = h.recorder.open(); h.recorder.close();
  await assert.rejects(pending, { name: 'AbortError' }); await flush();
  assert.equal(h.calls.length, 0); assert.equal(h.recorder.state.phase, 'idle');
  h.recorder.destroy();
});

test('a late previous permission cannot replace a newer camera after cancel and reopen', async () => {
  const grants = [];
  const h = harness({ getUserMedia: () => new Promise(resolve => grants.push(resolve)) });
  const stale = h.recorder.open('old'); await flush();
  h.recorder.close(); const latest = h.recorder.open('new'); await flush();
  await assert.rejects(stale, { name: 'AbortError' });
  const oldStream = makeStream(), newStream = makeStream();
  grants[1](newStream); await latest;
  grants[0](oldStream); await flush();
  assert.equal(oldStream.track.stopped, 1); assert.equal(newStream.track.stopped, 0);
  assert.equal(h.preview.srcObject, newStream); h.recorder.destroy();
});

test('recording starts once, stop waits for final data, repeated stop shares completion, and all tracks close', async () => {
  const h = harness(); await h.recorder.open(); h.recorder.start(); h.recorder.start();
  assert.equal(h.recorders.length, 1); h.timers.tick(1250);
  const first = h.recorder.stop(), second = h.recorder.stop(); assert.equal(first, second);
  const result = await first;
  assert.equal(await result.file.text(), 'synthetic-video'); assert.equal(result.duration, 1.25);
  assert.equal(result.mirrored, false); assert.equal(h.streams[0].track.stopped, 1);
  assert.equal(h.timers.count(), 0); assert.equal(h.preview.srcObject, null);
  assert.equal(h.recorder.state.phase, 'ready');
  assert.equal(await h.recorder.stop(), result);
  await h.recorder.open(); assert.equal(h.recorder.state.result, null); h.recorder.destroy();
});

test('camera changes are blocked during capture and reopening preview stops the old camera', async () => {
  const h = harness(); await h.recorder.open('first');
  await h.recorder.open('second'); assert.equal(h.streams[0].track.stopped, 1);
  h.recorder.start(); await assert.rejects(h.recorder.open('third'), /촬영을 종료/);
  assert.equal(h.calls.length, 2); h.recorder.cancel(); assert.equal(h.streams[1].track.stopped, 1);
});

test('automatic duration stop completes locally without leaving timers or a live camera', async () => {
  const h = harness({ maxSeconds: 1 }); await h.recorder.open(); h.recorder.start();
  h.timers.tick(1000); await flush();
  assert.equal(h.recorder.state.phase, 'ready'); assert.equal(h.recorder.state.result.duration, 0.9);
  assert.equal(h.streams[0].track.stopped, 1); assert.equal(h.timers.count(), 0);
});

test('cancel during finalization blocks the old result even if finalization ignores its abort signal', async () => {
  let finish, signal;
  const h = harness({ finalize: (blob, elapsed, options) => { signal = options.signal; return new Promise(resolve => { finish = () => resolve({ file: new File([blob], 'stale.webm'), duration: elapsed, width: 320, height: 240, mirrored: false }); }); } });
  await h.recorder.open(); h.recorder.start(); h.timers.tick(1000);
  const pending = h.recorder.stop(); await flush();
  assert.equal(h.streams[0].track.stopped, 1); h.recorder.close();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(signal.aborted, true);
  await h.recorder.open(); finish(); await flush();
  assert.equal(h.recorder.state.phase, 'preview'); assert.equal(h.recorder.state.result, null); h.recorder.destroy();
});

test('track loss, page hiding and pagehide discard unfinished capture and release every resource', async () => {
  for (const trigger of [h => h.streams[0].track.dispatchEvent(new Event('ended')), h => { h.doc.hidden = true; h.doc.dispatchEvent(new Event('visibilitychange')); }, h => h.win.dispatchEvent(new Event('pagehide'))]) {
    const h = harness(); await h.recorder.open(); h.recorder.start(); h.timers.tick(500); trigger(h);
    await flush(); assert.equal(h.streams[0].track.stopped, 1); assert.equal(h.timers.count(), 0);
    assert.equal(h.recorder.state.result, null); assert.ok(['idle', 'error'].includes(h.recorder.state.phase));
    h.recorder.destroy();
  }
});

test('permission errors, unsupported recording and preview failure never leak camera tracks', async () => {
  const denied = harness({ getUserMedia: () => Promise.reject(new DOMException('synthetic', 'NotAllowedError')) });
  await assert.rejects(denied.recorder.open(), /권한/); assert.equal(denied.recorder.state.phase, 'error');
  const unplayable = harness({ play: async () => { throw new Error('synthetic preview failure'); } });
  await assert.rejects(unplayable.recorder.open(), /카메라를 열지/); assert.equal(unplayable.streams[0].track.stopped, 1);
  class Unsupported { static isTypeSupported() { return false; } }
  const unsupported = harness({ Recorder: Unsupported });
  await assert.rejects(unsupported.recorder.open(), /직접 촬영을 지원하지/); assert.equal(unsupported.calls.length, 0);
});

test('oversized data, recorder errors and missing stop events fail without claiming a completed video', async () => {
  const oversized = harness({ maxBytes: 12 }); await oversized.recorder.open(); oversized.recorder.start(); oversized.timers.tick(500);
  const tooBig = oversized.recorder.stop(); await assert.rejects(tooBig, /50MiB/);
  assert.equal(oversized.recorder.state.result, null); assert.equal(oversized.timers.count(), 0);
  const error = harness(); await error.recorder.open(); error.recorder.start(); error.recorders[0].onerror();
  assert.equal(error.recorder.state.phase, 'error'); assert.equal(error.streams[0].track.stopped, 1);
  const silent = harness(); await silent.recorder.open(); silent.recorder.start(); silent.timers.tick(500);
  silent.recorders[0].stop = () => { silent.recorders[0].state = 'inactive'; };
  const stalled = silent.recorder.stop(); silent.timers.tick(5000);
  await assert.rejects(stalled, /종료 응답/); assert.equal(silent.streams[0].track.stopped, 1); assert.equal(silent.timers.count(), 0);
});

function ebml(id, content) {
  assert.ok(content.length < 127);
  return new Uint8Array([...id, 0x80 | content.length, ...content]);
}
function webm({ knownDuration = false, indexed = false, scale = [0x0f, 0x42, 0x40], streaming = false, tailIndex = false } = {}) {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], []);
  const scaleElement = ebml([0x2a, 0xd7, 0xb1], scale);
  const float = new Uint8Array(8); new DataView(float.buffer).setFloat64(0, 1234, false);
  const duration = knownDuration ? ebml([0x44, 0x89], float) : [];
  const info = ebml([0x15, 0x49, 0xa9, 0x66], [...scaleElement, ...duration]);
  const frame = ebml([0xa3], [0x81, 0, 0, 0x80, 0x19, 0x01]);
  const cluster = streaming ? new Uint8Array([0x1f, 0x43, 0xb6, 0x75, 0xff, ...frame]) : ebml([0x1f, 0x43, 0xb6, 0x75], frame);
  const seek = ebml([0x11, 0x4d, 0x9b, 0x74], []);
  const segment = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0xff, ...(indexed ? seek : []), ...info, ...cluster, ...(tailIndex ? seek : [])]);
  return new Blob([header, segment], { type: 'video/webm' });
}

test('WebM duration is durable metadata while encoded frame bytes remain unchanged', async () => {
  for (const streaming of [false, true]) {
    const input = webm({ streaming });
    const output = await finalizeWebMDuration(input, 2.5);
    const bytes = new Uint8Array(await output.arrayBuffer());
    const durationOffset = bytes.findIndex((byte, index) => byte === 0x44 && bytes[index + 1] === 0x89 && bytes[index + 2] === 0x88);
    assert.ok(durationOffset >= 0);
    assert.equal(new DataView(bytes.buffer).getFloat64(durationOffset + 3, false), 2500);
    assert.deepEqual([...bytes.slice(-8)], [0xa3, 0x86, 0x81, 0, 0, 0x80, 0x19, 0x01]);
    assert.equal((await finalizeWebMDuration(output, 3)).size, output.size, 'already finite duration is retained');
  }
  const existing = webm({ knownDuration: true, indexed: true }); assert.equal(await finalizeWebMDuration(existing, 2), existing);
});

test('WebM repair handles timestamp scales and rejects unsafe indexes, malformed/truncated data and cancellation', async () => {
  const scaled = new Uint8Array(await (await finalizeWebMDuration(webm({ scale: [0x1e, 0x84, 0x80] }), 2.5)).arrayBuffer());
  const at = scaled.findIndex((byte, index) => byte === 0x44 && scaled[index + 1] === 0x89);
  assert.equal(new DataView(scaled.buffer).getFloat64(at + 3, false), 1250);
  await assert.rejects(finalizeWebMDuration(webm({ indexed: true }), 2), /안전하게/);
  await assert.rejects(finalizeWebMDuration(webm({ streaming: true, tailIndex: true }), 2), /안전하게/);
  await assert.rejects(finalizeWebMDuration(new Blob(['bad']), 2), /WebM/);
  const valid = webm(); await assert.rejects(finalizeWebMDuration(valid.slice(0, valid.size - 1), 2), /끊겼/);
  await assert.rejects(finalizeWebMDuration(valid, 61), /길이/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(finalizeWebMDuration(valid, 2, controller.signal), { name: 'AbortError' });
});

test('finalization requires finite playable metadata, cleans object URLs and never mirrors recorded bytes', async () => {
  let revoked = 0;
  const player = { readyState: 2, duration: 2, videoWidth: 320, videoHeight: 240, removeAttribute() { this.removed = true; }, load() { if (!this.removed) queueMicrotask(() => this.onloadeddata?.()); } };
  const options = { document: { createElement: () => player }, URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => revoked++ } };
  const result = await finalizeRecordedVideo(new Blob(['synthetic-mp4'], { type: 'video/mp4' }), 2, options);
  assert.equal(result.file.type, 'video/mp4'); assert.equal(result.duration, 2); assert.equal(result.mirrored, false); assert.equal(revoked, 1);
  assert.equal(await result.file.text(), 'synthetic-mp4');
  player.removed = false; player.duration = Infinity;
  await assert.rejects(finalizeRecordedVideo(new Blob(['synthetic-mp4'], { type: 'video/mp4' }), 2, options), /재생 시간/);
  assert.equal(revoked, 2);
  await assert.rejects(finalizeRecordedVideo(new Blob(['other'], { type: 'video/ogg' }), 2, options), /지원하지/);
});

test('cancelling or timing out the playback probe revokes its URL and removes pending timers', async () => {
  for (const cancelled of [true, false]) {
    const timers = clock(), controller = new AbortController(); let revoked = 0, removed = 0;
    const player = { load() {}, removeAttribute() { removed++; } };
    const pending = finalizeRecordedVideo(new Blob(['synthetic-mp4'], { type: 'video/mp4' }), 2, {
      signal: controller.signal, document: { createElement: () => player },
      URL: { createObjectURL: () => 'blob:synthetic-probe', revokeObjectURL: () => revoked++ },
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    });
    if (cancelled) controller.abort(); else timers.tick(10000);
    await assert.rejects(pending, cancelled ? { name: 'AbortError' } : /확인 시간이 초과/);
    assert.equal(revoked, 1); assert.equal(removed, 1); assert.equal(timers.count(), 0);
    assert.equal(player.onloadeddata, null); assert.equal(player.onerror, null);
  }
});
