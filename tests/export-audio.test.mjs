import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './source-loader.mjs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { Input, BufferSource, ALL_FORMATS } from 'mediabunny';

function mixer() {
    const starts = [];
    let closed = false;
    class Decoder {
        async decodeAudioData() { return { duration: 30 }; }
        async close() { closed = true; }
    }
    class Offline {
        createBufferSource() {
            return { playbackRate: { value: 1 }, connect() {}, start(...args) { starts.push(args); } };
        }
        createGain() { return { gain: { value: 1 }, connect() {} }; }
        async startRendering() { return { mixed: true }; }
    }
    const { mixAudioTracksToBuffer } = loadSource('lib/export-audio.ts', {
        globals: { window: { AudioContext: Decoder }, OfflineAudioContext: Offline, fetch: async () => ({ arrayBuffer: async () => new ArrayBuffer(1) }) },
    });
    return { mix: mixAudioTracksToBuffer, starts, closed: () => closed };
}

test('single trimmed clip keeps audio aligned with source video, including timeline trim', async () => {
    const audio = mixer();
    const clip = { trimStart: 3, trimEnd: 8, startTime: 0 };
    await audio.mix(5, 0, 1, { videoBlob: new Blob(['video']) }, [clip]);
    assert.deepEqual(audio.starts[0], [0, 3, 5]);
    await audio.mix(3, 2, 1, { videoBlob: new Blob(['video']) }, [clip]);
    assert.deepEqual(audio.starts[1], [0, 5, 3]);
    assert.equal(audio.closed(), true);
});

test('multiple clips and overlay audio respect the exported timeline window and speed', async () => {
    const audio = mixer();
    const clips = [{ libraryVideoId: 'a', trimStart: 1, trimEnd: 6, startTime: 0 }, { libraryVideoId: 'b', trimStart: 2, trimEnd: 7, startTime: 5 }];
    await audio.mix(5, 3, 2, { audioTracks: [{ audioUrl: 'blob:audio', startTime: 1, trimStart: 4, duration: 9, volume: 1 }] }, clips, new Map([['a', new Blob(['a'])], ['b', new Blob(['b'])]]));
    assert.deepEqual(audio.starts, [[0, 4, 2], [1, 2, 3], [0, 6, 5]]);
});

test('muting original audio produces no original track', async () => {
    const audio = mixer();
    assert.equal(await audio.mix(5, 0, 1, { videoBlob: new Blob(['video']), muteOriginalAudio: true }, []), null);
    assert.equal(audio.starts.length, 0);
});

test('WebM muxes mixed audio and releases FFmpeg on success and failure', async () => {
    for (const fail of [false, true]) {
        const writes = new Map();
        let command, terminated = false, downloaded = false;
        class FFmpeg {
            async load() {}
            async writeFile(name, bytes) { writes.set(name, bytes); }
            async deleteFile() {}
            on() {}
            async exec(args) { command = args; return fail ? 1 : 0; }
            async readFile() { return new Uint8Array([1, 2]); }
            terminate() { terminated = true; }
        }
        const { exportWithFFmpegWebM } = loadSource('hooks/useVideoExport.ts', {
            expose: ['exportWithFFmpegWebM'],
            globals: { window: { location: { origin: 'http://localhost' } } },
            mocks: {
                react: {}, mediabunny: {}, '@/lib/constants': {},
                '@ffmpeg/ffmpeg': { FFmpeg }, '@ffmpeg/util': { toBlobURL: async url => url },
                '@/lib/video.utils': { waitForVideoFrame: async () => {}, downloadBlob: () => { downloaded = true; } },
                '@/lib/export-audio': { mixAudioTracksToBuffer: async () => ({ numberOfChannels: 2, sampleRate: 44100, length: 2, getChannelData: () => new Float32Array(2) }) },
            },
        });
        const run = exportWithFFmpegWebM({ pause() {} }, { drawFrame: async () => {} }, { toBlob: cb => cb(new Blob(['frame'])) }, 0.1, 0, 10, 2, 2, () => {}, { cancelled: false }, 1, { bitrate: 3_000_000 });
        if (fail) await assert.rejects(run, /WebM encoding failed/); else await run;
        assert.equal(writes.has('audio.wav'), true);
        assert.equal(Buffer.from(writes.get('audio.wav')).toString('ascii', 0, 4), 'RIFF');
        assert.ok(command.includes('libvorbis'));
        assert.ok(command.includes('1:a:0'));
        assert.equal(downloaded, !fail);
        assert.equal(terminated, true);
    }
});

test('packaged FFmpeg produces a playable WebM with VP8 video and stereo Vorbis audio through the export path', async () => {
    const require = createRequire(import.meta.url);
    const createCore = require('../public/ffmpeg/ffmpeg-core.js');
    let downloaded;
    class FFmpeg {
        async load() {
            // The bundled build targets a worker; provide its location while
            // loading WASM directly, with no network or browser required.
            const previous = globalThis.self;
            globalThis.self = { location: { href: 'file:///ffmpeg-core.js' } };
            try {
                this.core = await createCore({ wasmBinary: fs.readFileSync(new URL('../public/ffmpeg/ffmpeg-core.wasm', import.meta.url)) });
                this.logs = [];
                this.core.setLogger(({ message }) => this.logs.push(message));
            } finally {
                if (previous === undefined) delete globalThis.self; else globalThis.self = previous;
            }
        }
        async writeFile(name, data) { this.core.FS.writeFile(name, data); }
        async deleteFile(name) { this.core.FS.unlink(name); }
        on(event, callback) { if (event === 'progress') this.core.setProgress(callback); }
        async exec(args) {
            try { return this.core.exec(...args); }
            catch (error) { throw Error(`${error.message}\n${this.logs.slice(-12).join('\n')}`); }
        }
        async readFile(name) { return this.core.FS.readFile(name); }
        terminate() { this.core = null; }
    }
    const frame = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff000080' } }).webp().toBuffer();
    const { exportWithFFmpegWebM } = loadSource('hooks/useVideoExport.ts', {
        expose: ['exportWithFFmpegWebM'], globals: { window: { location: { origin: 'http://localhost' } } },
        mocks: {
            react: {}, mediabunny: {}, '@/lib/constants': {},
            '@ffmpeg/ffmpeg': { FFmpeg }, '@ffmpeg/util': { toBlobURL: async url => url },
            '@/lib/video.utils': { waitForVideoFrame: async () => {}, downloadBlob: blob => { downloaded = blob; } },
            '@/lib/export-audio': { mixAudioTracksToBuffer: async () => ({ numberOfChannels: 2, sampleRate: 44100, length: 8820, getChannelData: () => Float32Array.from({ length: 8820 }, (_, i) => Math.sin(i * 440 * 2 * Math.PI / 44100) * 0.2) }) },
        },
    });
    await exportWithFFmpegWebM({ pause() {} }, { drawFrame: async () => {} }, { toBlob: cb => cb(new Blob([frame])) }, 0.2, 0, 10, 16, 16, () => {}, { cancelled: false }, 1, {});
    const input = new Input({ source: new BufferSource(await downloaded.arrayBuffer()), formats: ALL_FORMATS });
    try {
        const videoTracks = await input.getVideoTracks();
        const audioTracks = await input.getAudioTracks();
        assert.equal(videoTracks.length, 1);
        assert.equal(audioTracks.length, 1);
        assert.equal(videoTracks[0].codec, 'vp8');
        assert.equal(audioTracks[0].codec, 'vorbis');
    } finally {
        input.dispose();
    }
});
