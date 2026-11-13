import Meyda from 'meyda';

import {
    estimateKey,
    getAudibleRange,
    getEnergyProfile,
    MixKey,
} from '/@/renderer/features/player/audio-player/utils/auto-mix';

export interface AnalysisWorkerRequest {
    id: number;
    sampleRate: number;
    samples: Float32Array;
}

export interface AnalysisWorkerResponse {
    error?: string;
    id: number;
    result?: SpectralAnalysis;
}

export interface SpectralAnalysis {
    audibleEnd: number;
    audibleStart: number;
    energy: number[];
    energyLevel: number;
    key: MixKey | null;
}

const FRAME = 4096;
// Every other frame is plenty for a track-wide key estimate.
const HOP = FRAME * 2;
const MIN_FRAME_RMS = 0.01;

// The renderer tsconfig has no WebWorker lib, so type the worker scope by hand.
const scope = self as unknown as {
    onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
    postMessage: (message: AnalysisWorkerResponse) => void;
};

scope.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
    const { id, sampleRate, samples } = event.data;
    try {
        const response: AnalysisWorkerResponse = { id, result: analyze(samples, sampleRate) };
        scope.postMessage(response);
    } catch (error) {
        const response: AnalysisWorkerResponse = {
            error: error instanceof Error ? error.message : 'Unknown error',
            id,
        };
        scope.postMessage(response);
    }
};

function analyze(samples: Float32Array, sampleRate: number): SpectralAnalysis {
    const range = getAudibleRange(samples, sampleRate);
    const profile = getEnergyProfile(samples, sampleRate);

    // Meyda caches its chroma filter bank from the first call, so the analyzer always
    // decodes at one fixed sample rate.
    Meyda.bufferSize = FRAME;
    Meyda.sampleRate = sampleRate;

    const chroma = new Float64Array(12);
    const from = Math.floor(range.audibleStart * sampleRate);
    const to = Math.floor(range.audibleEnd * sampleRate) - FRAME;
    for (let index = from; index <= to; index += HOP) {
        const frame = samples.subarray(index, index + FRAME);
        let sum = 0;
        for (let i = 0; i < FRAME; i++) sum += frame[i] ** 2;
        const rms = Math.sqrt(sum / FRAME);
        if (rms < MIN_FRAME_RMS) continue;

        const values = Meyda.extract(['chroma'], frame)?.chroma;
        if (!values) continue;
        for (let bin = 0; bin < 12; bin++) chroma[bin] += values[bin] * rms;
    }

    return { ...range, ...profile, key: estimateKey(chroma) };
}
