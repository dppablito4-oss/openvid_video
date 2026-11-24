import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCallbacks, loadSource } from './source-loader.mjs';

const editor = 'app/[locale]/(editor)/editor/page.tsx';
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('switching projects flushes and awaits the latest snapshot after older writes', async () => {
    const olderWrite = deferred(), latestWrite = deferred();
    const events = [];
    const timer = { current: 12 };
    const context = loadCallbacks(editor, ['savePhotoProjectNow', 'handleSelectImageProject'], {
        isPhotoMode: true, imageUrl: 'data:image/png', currentProjectId: 'A',
        autoSaveTimeoutRef: timer, isRestoringProjectRef: { current: false },
        isSwitchingPhotoProjectRef: { current: false },
        photoSaveQueueRef: { current: olderWrite.promise },
        clearTimeout: id => events.push(`cancel timer ${id}`),
        buildPhotoProjectSnapshot: () => ({ padding: 22 }),
        saveCurrentProject: async snapshot => { events.push(`save ${snapshot.padding}`); await latestWrite.promise; },
        switchToProject: async id => events.push(`switch ${id}`),
    });
    const switching = context.handleSelectImageProject('B');
    assert.equal(timer.current, null);
    assert.deepEqual(events, ['cancel timer 12']);
    olderWrite.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['cancel timer 12', 'save 22']);
    latestWrite.resolve();
    await switching;
    assert.deepEqual(events, ['cancel timer 12', 'save 22', 'switch B']);
});

test('failed flush keeps the current project selected and unlocks switching', async () => {
    let switched = false;
    const lock = { current: false };
    const context = loadCallbacks(editor, ['savePhotoProjectNow', 'handleSelectImageProject'], {
        isPhotoMode: true, imageUrl: 'data:image/png', currentProjectId: 'A',
        autoSaveTimeoutRef: { current: null }, isRestoringProjectRef: { current: false },
        isSwitchingPhotoProjectRef: lock, photoSaveQueueRef: { current: Promise.resolve() },
        buildPhotoProjectSnapshot: () => ({ padding: 22 }),
        saveCurrentProject: async () => { throw Error('Storage quota exceeded'); },
        switchToProject: async () => { switched = true; }, console: { error() {} },
    });
    await context.handleSelectImageProject('B');
    assert.equal(switched, false);
    assert.equal(lock.current, false);
});

test('photo and video snapshots round-trip all 3D fields; legacy projects get defaults', () => {
    const { DEFAULT_MOCKUP_DEVICE_STATE: defaults } = loadSource('types/mockup-device.types.ts');
    const device = { ...defaults, imagePhoneActive: true, imagePhoneX: 23, imagePhoneY: -40, imagePhoneScale: 1.7, imagePhoneRotX: 15, imagePhoneRotY: 25, imagePhoneRotZ: -8, imagePhonePerspective: 700, imagePhoneDevice: 'iphone-duo', imagePhonePresetId: 'custom', imagePhoneOpening: 0, imagePhoneShadow: 0, imagePhoneShadowColor: '#123456', imagePhoneRefWidth: 640 };
    const restored = {};
    const setters = Object.fromEntries(Object.keys(defaults).map(key => [`set${key[0].toUpperCase()}${key.slice(1)}`, value => { restored[key] = value; }]));
    const state = {
        mockupDeviceState: device, DEFAULT_MOCKUP_DEVICE_STATE: defaults, ...setters,
        backgroundTab: 'wallpaper', selectedWallpaper: 1, backgroundBlur: 0, selectedImageUrl: '',
        backgroundColorConfig: null, padding: 10, roundedCorners: 10, shadows: 10, aspectRatio: 'auto',
        customDimensions: null, cropArea: undefined, mockupId: 'none', mockupConfig: {}, canvasElements: [],
        videoTransform: { rotation: 0, translateX: 0, translateY: 0 }, imageTransform: {}, apply3DToBackground: false,
        imageMaskConfig: {}, mockupCamera: {}, imageZoomScale: 1, videoClips: [], trimRange: { start: 0, end: 5 },
        globalSpeed: 1, zoomFragments: [], zoomMovements: [], audioTracks: [], uploadedAudios: [],
        muteOriginalAudio: false, masterVolume: 1, mockupCameraKeyframes: [], mockupMotionFragments: [],
        unsplashBgUrl: '', videoMaskConfig: {}, cameraConfig: null, cameraOverlayKeyframes: [], cameraUrl: null,
    };
    const context = loadCallbacks(editor, ['buildPhotoProjectSnapshot', 'buildVideoProjectSnapshot', 'restoreMockupDeviceState'], state);
    for (const snapshot of [context.buildPhotoProjectSnapshot(), context.buildVideoProjectSnapshot()]) {
        context.restoreMockupDeviceState(JSON.parse(JSON.stringify(snapshot)));
        assert.deepEqual(restored, device);
    }
    context.restoreMockupDeviceState({});
    assert.deepEqual(restored, { ...defaults });
});

test('project save resolves only after IndexedDB commits and rejects an aborted transaction', async () => {
    for (const abort of [false, true]) {
        let writeTransaction;
        const existing = { id: 'A', imageDataUrl: 'data:image/png', thumbnailDataUrl: 'thumbnail', padding: 10 };
        const db = {
            transaction(store, mode) {
                const transaction = { objectStore: () => ({
                    get() {
                        const request = { result: existing };
                        queueMicrotask(() => request.onsuccess());
                        return request;
                    },
                    put() { writeTransaction = transaction; return {}; },
                }) };
                assert.ok(['readonly', 'readwrite'].includes(mode));
                return transaction;
            },
        };
        const { updateImageProject } = loadSource('lib/image-projects-cache.ts', {
            globals: { indexedDB: { open() {
                const request = { result: db };
                queueMicrotask(() => request.onsuccess());
                return request;
            } }, console: { error() {} } },
        });
        let settled = false;
        const saving = updateImageProject('A', { padding: 22 });
        saving.then(() => { settled = true; }, () => { settled = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
        if (abort) {
            writeTransaction.error = Error('Quota exceeded during commit');
            writeTransaction.onabort();
            await assert.rejects(saving, /Quota exceeded/);
        } else {
            writeTransaction.oncomplete();
            assert.equal((await saving).padding, 22);
        }
    }
});
