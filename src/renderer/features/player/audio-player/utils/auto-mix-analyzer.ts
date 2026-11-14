import type {
    AnalysisWorkerRequest,
    AnalysisWorkerResponse,
    SpectralAnalysis,
} from '/@/renderer/features/player/audio-player/utils/auto-mix-analysis.worker';

import { clear, createStore, get, getMany, set, UseStore } from 'idb-keyval';

import {
    BeatGrid,
    findIntroEnd,
    findOutroStart,
    MixCandidate,
    MixFeatures,
    parseKeyTag,
    TrackAnalysis,
} from '/@/renderer/features/player/audio-player/utils/auto-mix';
import { logger } from '/@/renderer/utils/logger';
import { QueueSong } from '/@/shared/types/domain-types';

export type AnalysisPriority = 'high' | 'low';

type AnalyzableSong = Pick<QueueSong, '_serverId' | 'albumId' | 'bpm' | 'duration' | 'id' | 'tags'>;

const CACHE_VERSION = 1;
const MAX_BYTES = 48 * 1024 * 1024;
const MAX_DURATION_MS = 15 * 60 * 1000;
const MAX_MEMORY_ENTRIES = 500;
// Divisible by four for the beat detector; one fixed rate for Meyda's cached filter bank.
const SAMPLE_RATE = 24000;
// A worker that never answers (e.g. blocked by CSP) must not stall the queue.
const ANALYSIS_TIMEOUT_MS = 2 * 60 * 1000;
const WINDOW_SECONDS = 30;

const memory = new Map<string, TrackAnalysis>();
const pending = new Map<string, Promise<TrackAnalysis>>();
// Songs that failed this session (too large, decode error, ...) are not retried.
const failed = new Map<string, Error>();
const jobs: {
    cancel: () => void;
    key: string;
    priority: AnalysisPriority;
    run: () => void;
}[] = [];
let running = false;
let idbStore: undefined | UseStore;
let worker: undefined | Worker;
let workerRequestId = 0;
const workerRequests = new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: SpectralAnalysis) => void }
>();

/**
 * Analyzes a song once and caches the result in memory and IndexedDB. Jobs run one at a
 * time so only one decoded track is held in memory; high priority (deck) jobs jump the queue.
 */
export function analyzeSong(
    song: AnalyzableSong,
    getUrl: () => Promise<string | undefined>,
    priority: AnalysisPriority,
): Promise<TrackAnalysis> {
    const key = getAnalysisKey(song);
    const cached = memory.get(key);
    if (cached) return Promise.resolve(cached);

    const failure = failed.get(key);
    if (failure) return Promise.reject(failure);

    const existing = pending.get(key);
    if (existing) {
        if (priority === 'high') promote(key);
        return existing;
    }

    const promise = new Promise<TrackAnalysis>((resolve, reject) => {
        const job = {
            cancel: () => reject(new DOMException('Analysis cancelled', 'AbortError')),
            key,
            priority,
            run: () => {
                withTimeout(loadOrAnalyze(song, key, getUrl), ANALYSIS_TIMEOUT_MS)
                    .catch((error: unknown) => {
                        const reason =
                            error instanceof Error ? error : new Error('Unknown analysis error');
                        failed.set(key, reason);
                        logger.warn('Auto mix analysis failed; using a plain blend', {
                            error: reason.message,
                            songId: song.id,
                        });
                        throw reason;
                    })
                    .then(resolve, reject)
                    .finally(() => {
                        pending.delete(key);
                        running = false;
                        next();
                    });
            },
        };
        if (priority === 'high') {
            const firstLow = jobs.findIndex((queued) => queued.priority === 'low');
            jobs.splice(firstLow === -1 ? jobs.length : firstLow, 0, job);
        } else {
            jobs.push(job);
        }
        next();
    });
    pending.set(key, promise);
    return promise;
}

/** Drops queued (not yet running) lookahead jobs. */
export function cancelLowPriorityAnalyses() {
    for (let index = jobs.length - 1; index >= 0; index--) {
        if (jobs[index].priority === 'low') {
            const [job] = jobs.splice(index, 1);
            pending.delete(job.key);
            job.cancel();
        }
    }
}

export async function clearAnalysisCache() {
    memory.clear();
    failed.clear();
    await clear(getStore());
}

export function getCachedAnalysis(song: AnalyzableSong): null | TrackAnalysis {
    return memory.get(getAnalysisKey(song)) ?? null;
}

/** Ordering features from analysis when available, otherwise from tags. */
export function getMixCandidate(song: AnalyzableSong & { _uniqueId: string }): MixCandidate {
    return { ...getMixFeatures(song), group: song.albumId || null, id: song._uniqueId };
}

export function getMixFeatures(song: AnalyzableSong): MixFeatures {
    const analysis = getCachedAnalysis(song);
    return {
        bpm: analysis?.start.bpm ?? (song.bpm && song.bpm > 0 ? song.bpm : null),
        camelot: analysis?.key?.camelot ?? getTaggedKey(song),
        energy: analysis?.energyLevel ?? null,
    };
}

/** Loads persisted analyses into memory so ordering can use them without downloading. */
export async function loadCachedAnalyses(songs: AnalyzableSong[]) {
    const keys = [...new Set(songs.map(getAnalysisKey))].filter((key) => !memory.has(key));
    if (keys.length === 0) return;
    try {
        const values = await getMany<TrackAnalysis | undefined>(keys, getStore());
        values.forEach((value, index) => {
            if (value) remember(keys[index], value);
        });
    } catch (error) {
        logger.warn('Auto mix could not read the analysis cache', {
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
}

async function analyzeTrack(song: AnalyzableSong, url: string): Promise<TrackAnalysis> {
    const bytes = await download(url);
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const buffer = await context.decodeAudioData(bytes.buffer as ArrayBuffer);
    if (buffer.duration < 10 || buffer.duration * 1000 > MAX_DURATION_MS) {
        throw new Error('Track duration is outside the audio analysis limits');
    }

    const { guess } = await import('web-audio-beat-detector');
    const window = Math.min(WINDOW_SECONDS, buffer.duration);
    const endOffset = buffer.duration - window;
    const [startBeat, endBeat] = await Promise.all([
        guess(buffer, 0, window),
        guess(buffer, endOffset, window),
    ]);
    const spectral = await runWorker(buffer.getChannelData(0).slice(), buffer.sampleRate);

    const toGrid = (result: typeof startBeat, offset: number): BeatGrid => {
        // Prefer tagged BPM only when it agrees with the analyzed tempo.
        const tagged = song.bpm && Number.isFinite(song.bpm) && song.bpm > 0 ? song.bpm : null;
        const closest = tagged
            ? [tagged / 2, tagged, tagged * 2].sort(
                  (a, b) => Math.abs(a - result.bpm) - Math.abs(b - result.bpm),
              )[0]
            : result.bpm;
        return {
            bpm: Math.abs(closest - result.bpm) < 0.25 ? closest : result.bpm,
            offset: offset + result.offset,
        };
    };

    const start = toGrid(startBeat, 0);
    const end = toGrid(endBeat, endOffset);
    const taggedKey = getTaggedKey(song);

    return {
        audibleEnd: spectral.audibleEnd,
        audibleStart: spectral.audibleStart,
        end,
        energy: spectral.energy,
        energyLevel: spectral.energyLevel,
        introEnd: findIntroEnd(spectral.energy, start, spectral.audibleStart),
        key: taggedKey ? { camelot: taggedKey, confidence: 1 } : spectral.key,
        outroStart: findOutroStart(spectral.energy, end, spectral.audibleEnd),
        start,
    };
}

async function download(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
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
    return bytes;
}

function getAnalysisKey(song: AnalyzableSong): string {
    return `v${CACHE_VERSION}:${song._serverId}:${song.id}`;
}

function getStore(): UseStore {
    idbStore ??= createStore('feishin-auto-mix', 'analysis');
    return idbStore;
}

function getTaggedKey(song: AnalyzableSong): null | string {
    const tags = song.tags;
    return parseKeyTag(tags?.initialkey?.[0] ?? tags?.key?.[0]);
}

function getWorker(): Worker {
    if (!worker) {
        worker = new Worker(new URL('./auto-mix-analysis.worker.ts', import.meta.url), {
            type: 'module',
        });
        worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
            const request = workerRequests.get(event.data.id);
            workerRequests.delete(event.data.id);
            if (!request) return;
            if (event.data.result) request.resolve(event.data.result);
            else request.reject(new Error(event.data.error ?? 'Analysis worker failed'));
        };
        worker.onerror = (event) => {
            for (const request of workerRequests.values()) {
                request.reject(new Error(event.message || 'Analysis worker failed'));
            }
            workerRequests.clear();
            worker?.terminate();
            worker = undefined;
        };
    }
    return worker;
}

async function loadOrAnalyze(
    song: AnalyzableSong,
    key: string,
    getUrl: () => Promise<string | undefined>,
): Promise<TrackAnalysis> {
    try {
        const stored = await get<TrackAnalysis>(key, getStore());
        if (stored) return remember(key, stored);
    } catch (error) {
        logger.warn('Auto mix could not read the analysis cache', {
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }

    if (!song.duration || song.duration > MAX_DURATION_MS) {
        throw new Error('Track duration is unavailable or too long for analysis');
    }

    const url = await getUrl();
    if (!url) throw new Error('No stream URL for analysis');

    const analysis = await analyzeTrack(song, url);
    logger.info('Auto mix analyzed track', {
        bpm: analysis.start.bpm,
        energy: analysis.energyLevel,
        key: analysis.key?.camelot,
        songId: song.id,
    });

    set(key, analysis, getStore()).catch((error: unknown) => {
        logger.warn('Auto mix could not persist analysis', {
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    });
    return remember(key, analysis);
}

function next() {
    if (running) return;
    const job = jobs.shift();
    if (!job) return;
    running = true;
    job.run();
}

function promote(key: string) {
    const index = jobs.findIndex((job) => job.key === key);
    if (index <= 0) return;
    const [job] = jobs.splice(index, 1);
    job.priority = 'high';
    jobs.unshift(job);
}

function remember(key: string, analysis: TrackAnalysis): TrackAnalysis {
    memory.delete(key);
    memory.set(key, analysis);
    if (memory.size > MAX_MEMORY_ENTRIES) {
        memory.delete(memory.keys().next().value as string);
    }
    return analysis;
}

function runWorker(samples: Float32Array, sampleRate: number): Promise<SpectralAnalysis> {
    const instance = getWorker();
    const id = ++workerRequestId;
    return new Promise((resolve, reject) => {
        workerRequests.set(id, { reject, resolve });
        const request: AnalysisWorkerRequest = { id, sampleRate, samples };
        instance.postMessage(request, [samples.buffer]);
    });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Audio analysis timed out')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
