import type { ExportSettings } from "@/types/video.types";
import type { VideoTrackClip } from "@/types/video-track.types";
import { resolveClipTrimStart } from "./ffmpeg.utils";

export async function mixAudioTracksToBuffer(
    duration: number,
    trimStart: number,
    speed: number,
    settings: ExportSettings,
    clips: VideoTrackClip[],
    clipBlobs?: Map<string, Blob>,
    clipAudioStates?: Record<string, boolean>,
): Promise<AudioBuffer | null> {
    try {
        const AudioCtxClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtxClass) return null;
        const decodeCtx = new AudioCtxClass();
        const sampleRate = 44100;
        const outputDuration = duration / speed;
        const totalSamples = Math.ceil(outputDuration * sampleRate);
        if (totalSamples <= 0) return null;

        const offlineCtx = new OfflineAudioContext(2, totalSamples, sampleRate);
        let hasAnyAudio = false;

        const masterVolume = settings.masterVolume ?? 1;
        const hasMultipleClips = clips && clips.length > 1 && clipBlobs;
        const hasOriginalAudio = !settings.muteOriginalAudio && settings.videoHasAudioTrack !== false;

        // 1. Process Video Clip / Source Audio
        if (hasOriginalAudio) {
            if (hasMultipleClips && clipBlobs) {
                for (const clip of clips) {
                    if (clipAudioStates && clipAudioStates[clip.libraryVideoId] === false) continue;
                    const blob = clipBlobs.get(clip.libraryVideoId);
                    if (!blob) continue;
                    try {
                        const arrayBuffer = await blob.arrayBuffer();
                        const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
                        const sourceNode = offlineCtx.createBufferSource();
                        sourceNode.buffer = audioBuffer;
                        sourceNode.playbackRate.value = speed;

                        const gainNode = offlineCtx.createGain();
                        gainNode.gain.value = masterVolume;

                        sourceNode.connect(gainNode);
                        gainNode.connect(offlineCtx.destination);

                        const start = Math.max(clip.startTime, trimStart);
                        const end = Math.min(clip.startTime + clip.trimEnd - clip.trimStart, trimStart + duration);
                        if (end <= start) continue;
                        sourceNode.start((start - trimStart) / speed, clip.trimStart + start - clip.startTime, end - start);
                        hasAnyAudio = true;
                    } catch (e) {
                        console.warn("Could not decode clip audio via Web Audio API:", e);
                    }
                }
            } else if (settings.videoBlob && settings.videoBlob.size > 0) {
                try {
                    const arrayBuffer = await settings.videoBlob.arrayBuffer();
                    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
                    const sourceNode = offlineCtx.createBufferSource();
                    sourceNode.buffer = audioBuffer;
                    sourceNode.playbackRate.value = speed;

                    const gainNode = offlineCtx.createGain();
                    gainNode.gain.value = masterVolume;

                    sourceNode.connect(gainNode);
                    gainNode.connect(offlineCtx.destination);

                    const sourceTrimStart = resolveClipTrimStart(clips, trimStart);
                    sourceNode.start(0, sourceTrimStart, duration);
                    hasAnyAudio = true;
                } catch (e) {
                    console.warn("Could not decode source video audio via Web Audio API:", e);
                }
            }
        }

        // 2. Extra Timeline Audio Tracks
        if (settings.audioTracks && settings.audioTracks.length > 0) {
            for (const track of settings.audioTracks) {
                if (!track.audioUrl) continue;
                try {
                    const response = await fetch(track.audioUrl);
                    const arrayBuffer = await response.arrayBuffer();
                    const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
                    const sourceNode = offlineCtx.createBufferSource();
                    sourceNode.buffer = audioBuffer;
                    sourceNode.playbackRate.value = speed;

                    const gainNode = offlineCtx.createGain();
                    gainNode.gain.value = (track.volume ?? 1) * masterVolume;

                    sourceNode.connect(gainNode);
                    gainNode.connect(offlineCtx.destination);

                    const start = Math.max(track.startTime, trimStart);
                    const end = Math.min(track.startTime + track.duration, trimStart + duration);
                    if (end <= start) continue;
                    sourceNode.start((start - trimStart) / speed, (track.trimStart ?? 0) + start - track.startTime, end - start);
                    hasAnyAudio = true;
                } catch (e) {
                    console.warn("Could not decode audio track:", e);
                }
            }
        }

        await decodeCtx.close().catch(() => {});

        if (!hasAnyAudio) return null;

        const renderedBuffer = await offlineCtx.startRendering();
        return renderedBuffer;
    } catch (e) {
        console.warn("Audio mixing with Web Audio API failed:", e);
        return null;
    }
}
