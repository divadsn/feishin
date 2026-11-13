import { useEffect, useState } from 'react';

import { BeatGrid } from '/@/renderer/features/player/audio-player/utils/auto-mix';
import { logger } from '/@/renderer/utils/logger';
import { QueueSong } from '/@/shared/types/domain-types';

interface Analysis {
    end: BeatGrid;
    start: BeatGrid;
}

const MAX_BYTES = 48 * 1024 * 1024;
const MAX_DURATION_MS = 15 * 60 * 1000;
const WINDOW_SECONDS = 30;

export function useBeatAnalysis(
    song: QueueSong | undefined,
    url: string | undefined,
    enabled: boolean,
): Analysis | null {
    const [result, setResult] = useState<null | { analysis: Analysis; key: string }>(null);
    const duration = song?.duration;
    const bpm = song?.bpm ?? null;
    const key = song && url ? `${song._uniqueId}:${bpm}:${url}` : '';

    useEffect(() => {
        if (!enabled || !key || !url) return;
        if (result?.key === key) return;
        if (!duration || duration > MAX_DURATION_MS) {
            logger.warn('Auto mix analysis skipped: track duration is unavailable or too long');
            return;
        }

        const controller = new AbortController();
        analyzeTrack(url, bpm, controller.signal)
            .then((analysis) => {
                if (!controller.signal.aborted) setResult({ analysis, key });
            })
            .catch((error: unknown) => {
                if (!controller.signal.aborted) {
                    logger.warn('Auto mix analysis failed; using crossfade', {
                        error: error instanceof Error ? error.message : 'Unknown error',
                    });
                }
            });
        return () => controller.abort();
    }, [bpm, duration, enabled, key, result?.key, url]);

    return enabled && result?.key === key ? result.analysis : null;
}

async function analyzeTrack(
    url: string,
    bpm: null | number,
    signal: AbortSignal,
): Promise<Analysis> {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) {
        throw new Error(`Audio analysis request failed (${response.status})`);
    }

    const length = Number(response.headers.get('content-length'));
    if (length > MAX_BYTES) {
        await response.body.cancel();
        throw new Error('Track exceeds the audio analysis size limit');
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {
                await reader.cancel();
                throw new Error('Track exceeds the audio analysis size limit');
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, position);
        position += chunk.byteLength;
    }

    // The detector skips sampleRate / 4 samples, so use a rate divisible by four.
    const context = new OfflineAudioContext(1, 1, 24000);
    const buffer = await context.decodeAudioData(bytes.buffer);
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (buffer.duration < 10 || buffer.duration * 1000 > MAX_DURATION_MS) {
        throw new Error('Track duration is outside the audio analysis limits');
    }

    const { guess } = await import('web-audio-beat-detector');
    const window = Math.min(WINDOW_SECONDS, buffer.duration);
    const endOffset = buffer.duration - window;
    const [start, end] = await Promise.all([
        guess(buffer, 0, window),
        guess(buffer, endOffset, window),
    ]);

    const toGrid = (result: typeof start, offset: number): BeatGrid => {
        // Prefer tagged BPM only when it agrees with the analyzed tempo.
        const tagged = bpm && Number.isFinite(bpm) && bpm > 0 ? bpm : result.bpm;
        const candidates = [tagged / 2, tagged, tagged * 2];
        const closest = candidates.sort(
            (a, b) => Math.abs(a - result.bpm) - Math.abs(b - result.bpm),
        )[0];
        return {
            bpm: Math.abs(closest - result.bpm) < 0.25 ? closest : result.bpm,
            offset: offset + result.offset,
        };
    };

    return { end: toGrid(end, endOffset), start: toGrid(start, 0) };
}
