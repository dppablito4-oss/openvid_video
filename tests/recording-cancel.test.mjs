import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCallbacks } from './source-loader.mjs';

function capture() {
    const intervals = new Set(), timeouts = new Set();
    const refs = Object.fromEntries(['screenStreamRef', 'cameraStreamRef', 'micStreamRef', 'audioCtxRef', 'screenRecorderRef', 'cameraRecorderRef', 'countdownIntervalRef', 'recordingStartTimeoutRef'].map(key => [key, { current: null }]));
    const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] };
    let started = 0, state = 'idle';
    const noop = () => {};
    const context = loadCallbacks('hooks/useScreenRecording.ts', ['cleanupStreams', 'startCountdown', 'cancelRecording'], {
        ...refs, cancelledRef: { current: false }, captureAttemptRef: { current: 0 }, stateRef: { current: 'countdown' },
        screenChunksRef: { current: [] }, cameraChunksRef: { current: [] },
        navigator: { mediaDevices: { getDisplayMedia: async () => stream } },
        setError: noop, setRecordingTime: noop, setCameraStream: noop, setCameraConfig: noop, setCountdown: noop,
        setState: value => { state = value; }, restoreOriginals: noop, stopRecording: noop,
        startRecording: () => { started++; },
        setInterval: cb => { intervals.add(cb); return cb; }, clearInterval: cb => intervals.delete(cb),
        setTimeout: cb => { timeouts.add(cb); return cb; }, clearTimeout: cb => timeouts.delete(cb),
    });
    return { context, refs, track, stream, intervals, timeouts, started: () => started, state: () => state };
}

const setup = { systemAudio: false, camera: { enabled: false }, microphone: { enabled: false } };
test('ending screen sharing during countdown clears pending starts', async () => {
    const recording = capture();
    await recording.context.startCountdown(setup);
    const tick = [...recording.intervals][0];
    recording.track.onended();
    assert.equal(recording.intervals.size, 0);
    for (let i = 0; i < 4; i++) tick(); // Even an already queued callback must be harmless.
    assert.equal(recording.started(), 0);
    assert.equal(recording.state(), 'idle');
});

test('explicit cancellation clears the delayed recorder start', async () => {
    const recording = capture();
    await recording.context.startCountdown(setup);
    recording.refs.recordingStartTimeoutRef.current = () => {};
    recording.timeouts.add(recording.refs.recordingStartTimeoutRef.current);
    recording.context.cancelRecording();
    assert.equal(recording.intervals.size, 0);
    assert.equal(recording.timeouts.size, 0);
    assert.equal(recording.track.readyState, 'ended');
    assert.equal(recording.started(), 0);
});

test('cancelling while permissions are pending stops the stream when it arrives', async () => {
    const recording = capture();
    let grant;
    recording.context.navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => { grant = resolve; });
    const pending = recording.context.startCountdown(setup);
    recording.context.cancelRecording();
    grant(recording.stream);
    await pending;
    assert.equal(recording.track.readyState, 'ended');
    assert.equal(recording.intervals.size, 0);
    assert.equal(recording.started(), 0);
});
