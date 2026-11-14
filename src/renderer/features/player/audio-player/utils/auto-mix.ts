// Pure auto mix logic. Keep this file free of path aliases and DOM APIs so
// scripts/auto-mix.test.mjs can import it directly.

export interface AutoMixOptions {
    /** Fixed blend length in bars, or 'auto' to derive it from intro/outro energy. */
    blendLength: 'auto' | number;
    energyFlow: EnergyFlow;
    harmonicMixing: boolean;
    /** Maximum tempo adjustment in percent. */
    maxTempoAdjust: number;
}

export interface BeatGrid {
    bpm: number;
    offset: number;
}

export type EnergyFlow = 'auto' | 'build' | 'free' | 'steady';

export interface MixCandidate extends MixFeatures {
    /** Consecutive tracks sharing a group (album) move as one block. */
    group?: null | string;
    id: string;
}

export interface MixFeatures {
    bpm: null | number;
    camelot: null | string;
    /** Overall loudness, 0..1. */
    energy: null | number;
}

export interface MixKey {
    camelot: string;
    confidence: number;
}

export interface MixPlan {
    bars: number;
    /** Outgoing track time at which the low end swaps from the outgoing to the incoming track. */
    bassSwapAt: number;
    /** Outgoing beat length in track seconds. */
    beat: number;
    fadeDuration: number;
    /** Outgoing track time at which the mix is done; before the track end when mixing out early. */
    fadeEnd: number;
    incomingStart: number;
    rate: number;
    start: number;
    style: MixStyle;
}

export type MixStyle = 'blend' | 'echo';

export interface TrackAnalysis {
    audibleEnd: number;
    audibleStart: number;
    end: BeatGrid;
    /** RMS per second, normalized to the loudest second (0..1). */
    energy: number[];
    /** Overall loudness, 0..1. */
    energyLevel: number;
    introEnd: number;
    key: MixKey | null;
    outroStart: number;
    start: BeatGrid;
}

type FlowMode = 'build' | 'free' | 'release' | 'steady';

export const DEFAULT_AUTO_MIX_OPTIONS: AutoMixOptions = {
    blendLength: 'auto',
    energyFlow: 'auto',
    harmonicMixing: true,
    maxTempoAdjust: 8,
};

const BEATS_PER_BAR = 4;
const AUTO_BLEND_BARS = [32, 16, 8];
const MIN_AUTO_BLEND_BARS = 8;
const KEY_CLASH_BLEND_BARS = 4;
const MAX_SECTION_BARS = 32;
const PHRASE_BARS = 8;
// Seconds a blend may end before the outro starts to keep the energy up.
const MAX_EARLY_MIX_OUT = 60;
// Mix points scoring within this of the best are equal; the latest one wins.
const ENERGY_MARGIN = 0.12;
// Tracks this close in tempo mix without adjustment even when tempo matching is off.
const TEMPO_TOLERANCE = 0.02;
const TEMPO_FACTORS = [0.5, 1, 2];

/** End of the low-energy intro, aligned to the bar grid. */
export function findIntroEnd(energy: number[], grid: BeatGrid, audibleStart: number): number {
    const bar = barLength(grid.bpm);
    const threshold = energyThreshold(energy);
    if (threshold === null || !bar) return audibleStart;

    const smoothed = smooth(energy);
    let loud = Math.ceil(audibleStart);
    while (loud < smoothed.length && smoothed[loud] < threshold) loud++;

    const limit = audibleStart + MAX_SECTION_BARS * bar;
    return Math.max(audibleStart, Math.min(limit, snapToGrid(loud, grid.offset, bar)));
}

/** Start of the low-energy outro, aligned to the bar grid. */
export function findOutroStart(energy: number[], grid: BeatGrid, audibleEnd: number): number {
    const bar = barLength(grid.bpm);
    const threshold = energyThreshold(energy);
    if (threshold === null || !bar) return audibleEnd;

    const smoothed = smooth(energy);
    let loud = Math.min(smoothed.length, Math.floor(audibleEnd)) - 1;
    while (loud >= 0 && smoothed[loud] < threshold) loud--;

    const limit = audibleEnd - MAX_SECTION_BARS * bar;
    return Math.min(audibleEnd, Math.max(limit, snapToGrid(loud + 1, grid.offset, bar)));
}

export function getAudibleRange(
    samples: Float32Array,
    sampleRate: number,
): { audibleEnd: number; audibleStart: number } {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
        return { audibleEnd: 0, audibleStart: 0 };
    }

    const windowSize = Math.max(1, Math.floor(sampleRate / 4));
    const levels = windowRms(samples, windowSize);
    const maxLevel = Math.max(0, ...levels);

    if (maxLevel < 0.0001) {
        return { audibleEnd: samples.length / sampleRate, audibleStart: 0 };
    }

    const threshold = maxLevel * 0.015;
    let first = -1;
    let last = -1;
    for (let index = 0; index < levels.length; index++) {
        if (levels[index] >= threshold) {
            if (first === -1) first = index;
            last = index;
        }
    }

    return {
        audibleEnd: Math.min(samples.length, (last + 1) * windowSize) / sampleRate,
        audibleStart: Math.max(0, first * windowSize) / sampleRate,
    };
}

/** Per-second RMS profile normalized to the loudest second, plus overall loudness (0..1). */
export function getEnergyProfile(
    samples: Float32Array,
    sampleRate: number,
): { energy: number[]; energyLevel: number } {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || samples.length === 0) {
        return { energy: [], energyLevel: 0 };
    }

    const levels = windowRms(samples, Math.max(1, Math.floor(sampleRate)));
    const max = Math.max(0, ...levels);
    let sum = 0;
    for (const level of levels) sum += level ** 2;
    const rms = Math.sqrt(sum / levels.length);
    const db = 20 * Math.log10(Math.max(rms, 1e-6));

    return {
        energy: levels.map((level) => (max > 0 ? round(level / max) : 0)),
        // -30 dBFS (quiet) .. -6 dBFS (brickwalled) mapped to 0..1
        energyLevel: round(clamp((db + 30) / 24, 0, 1)),
    };
}

export function shouldSkipAutoMixAfterSeek(
    timestamp: number,
    duration: number,
    plan: MixPlan | null,
    fallbackFadeDuration: number,
): boolean {
    const transitionStart = plan?.start ?? duration - fallbackFadeDuration;
    return (
        Number.isFinite(timestamp) &&
        Number.isFinite(transitionStart) &&
        timestamp >= transitionStart
    );
}

const FIFTH_HARMONIC_WEIGHT = 0.3;
// Below this the chroma has no clear tonal centre (noise, drums, speech).
const MIN_KEY_CORRELATION = 0.3;
// Krumhansl-Kessler key profiles, index 0 = tonic.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Estimates the key from a 12-bin chroma vector (index 0 = C). */
export function estimateKey(raw: ArrayLike<number>): MixKey | null {
    if (raw.length !== 12) return null;

    // The 3rd harmonic of every note lands a fifth above it and drags the estimate one
    // step around the circle of fifths; subtract part of it.
    const chroma = Array.from(raw, (value, bin) =>
        Math.max(0, value - FIFTH_HARMONIC_WEIGHT * raw[(bin + 5) % 12]),
    );

    let best = { camelot: '', r: -Infinity };
    for (let tonic = 0; tonic < 12; tonic++) {
        for (const minor of [false, true]) {
            const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
            const rotated = Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12]);
            const r = correlation(chroma, rotated);
            if (r > best.r) best = { camelot: toCamelot(tonic, minor), r };
        }
    }

    if (!Number.isFinite(best.r) || best.r < MIN_KEY_CORRELATION) return null;
    return { camelot: best.camelot, confidence: round(best.r) };
}

const NOTE_PITCH: Record<string, number> = { A: 9, B: 11, C: 0, D: 2, E: 4, F: 5, G: 7 };

/** Steps between two Camelot keys: 0 same, 1 adjacent or relative, 2+ further apart. */
export function camelotDistance(a: string, b: string): number {
    const parsedA = parseCamelot(a);
    const parsedB = parseCamelot(b);
    if (!parsedA || !parsedB) return Infinity;
    const diff = Math.abs(parsedA.number - parsedB.number);
    return Math.min(diff, 12 - diff) + (parsedA.letter === parsedB.letter ? 0 : 1);
}

/** Deck volumes (0..1) at outgoing track `time` during a mix. */
export function mixGains(plan: MixPlan, time: number): { incoming: number; outgoing: number } {
    const length = Math.max(1e-3, plan.fadeEnd - plan.start);
    if (plan.style === 'echo') {
        return { incoming: 1, outgoing: 1 - clamp((time - plan.start) / length, 0, 1) };
    }

    // Bring the incoming deck up early (its bass is cut until the swap), keep the outgoing deck
    // at full until the swap, then take it out.
    const rise = Math.max(plan.beat * BEATS_PER_BAR, length / 4);
    const fadeIn = clamp((time - plan.start) / rise, 0, 1);
    const fadeOut = clamp(
        (time - plan.bassSwapAt) / Math.max(1e-3, plan.fadeEnd - plan.bassSwapAt),
        0,
        1,
    );
    return {
        incoming: Math.sin((Math.PI / 2) * fadeIn),
        outgoing: Math.cos((Math.PI / 2) * fadeOut),
    };
}

/**
 * Greedy nearest-neighbour ordering by tempo, key and energy. Tracks without usable features,
 * or without a good match, keep their relative order. Consecutive tracks of the same group
 * (album) move as one block.
 */
export function orderForMix<T extends MixCandidate>(
    tracks: readonly T[],
    current: MixFeatures | null,
    options: AutoMixOptions = DEFAULT_AUTO_MIX_OPTIONS,
    /** Queue position of the first track, for the 'auto' set arc. */
    startPosition = 0,
): T[] {
    const remaining = groupBlocks(tracks);
    const sorted: T[] = [];
    let previous = current;

    while (remaining.length > 0) {
        let bestIndex = 0;
        let bestCost = Number.POSITIVE_INFINITY;
        if (previous) {
            for (let index = 0; index < remaining.length; index++) {
                const cost = transitionCost(
                    previous,
                    remaining[index][0],
                    options,
                    startPosition + sorted.length,
                );
                if (cost !== null && cost < bestCost) {
                    bestCost = cost;
                    bestIndex = index;
                }
            }
        }

        // No good match: keep the existing order.
        if (bestCost > 1) bestIndex = 0;

        const [block] = remaining.splice(bestIndex, 1);
        sorted.push(...block);
        previous = block[block.length - 1];
    }

    return sorted;
}

/** Parses a key tag (Camelot like "8A", or notation like "Am", "F# minor", "Bbmaj"). */
export function parseKeyTag(value: null | string | undefined): null | string {
    const text = value?.trim();
    if (!text) return null;

    const camelot = /^(1[0-2]|[1-9])\s*([AB])$/i.exec(text);
    if (camelot) return `${Number(camelot[1])}${camelot[2].toUpperCase()}`;

    const note = /^([A-G])\s*([#♯b♭]?)\s*(.*)$/i.exec(text);
    if (!note) return null;

    const mode = note[3].trim();
    let minor: boolean;
    if (mode === '' || mode === 'M' || /^(maj|major)$/i.test(mode)) {
        minor = false;
    } else if (/^(m|min|minor)$/i.test(mode)) {
        minor = true;
    } else {
        return null;
    }

    const accidental = note[2];
    const shift = accidental === '#' || accidental === '♯' ? 1 : accidental ? -1 : 0;
    return toCamelot((NOTE_PITCH[note[1].toUpperCase()] + shift + 12) % 12, minor);
}

/** Picks the `count` candidates that best continue the mix from `last`. */
export function pickForMix<T extends MixCandidate>(
    candidates: readonly T[],
    last: MixFeatures | null,
    count: number,
    options: AutoMixOptions = DEFAULT_AUTO_MIX_OPTIONS,
    startPosition = 0,
): T[] {
    return orderForMix(candidates, last, options, startPosition).slice(0, Math.max(0, count));
}

/**
 * Echo-out for tracks whose tempos cannot be matched: on a downbeat at the outro the outgoing
 * track drops out within a beat while an echo of it rings on, and the incoming track starts on
 * its first bar at full volume.
 */
export function planEchoOut(
    outgoing: TrackAnalysis,
    incoming: TrackAnalysis,
    duration: number,
    speed: number,
): MixPlan | null {
    const grid = outgoing.end;
    const bar = barLength(grid.bpm);
    if (
        !bar ||
        ![
            duration,
            speed,
            grid.offset,
            outgoing.audibleStart,
            outgoing.audibleEnd,
            outgoing.outroStart,
            incoming.audibleStart,
            incoming.audibleEnd,
        ].every(Number.isFinite) ||
        speed <= 0
    ) {
        return null;
    }

    const audibleEnd = Math.min(duration, outgoing.audibleEnd);
    const cut = snapToGrid(Math.min(outgoing.outroStart, audibleEnd - bar), grid.offset, bar);
    const beat = bar / BEATS_PER_BAR;
    const incomingStart = barLength(incoming.start.bpm)
        ? firstBarAfter(incoming.audibleStart, incoming.start)
        : incoming.audibleStart;
    if (
        cut <= 0 ||
        cut < outgoing.audibleStart ||
        cut + beat > duration ||
        incomingStart < 0 ||
        incomingStart >= incoming.audibleEnd
    ) {
        return null;
    }

    return {
        bars: 0,
        bassSwapAt: cut,
        beat,
        fadeDuration: beat,
        fadeEnd: cut + beat,
        incomingStart,
        rate: speed,
        start: cut,
        style: 'echo',
    };
}

export function planMix(
    outgoing: TrackAnalysis,
    incoming: TrackAnalysis,
    duration: number,
    speed: number,
    options: AutoMixOptions = DEFAULT_AUTO_MIX_OPTIONS,
): MixPlan | null {
    const outgoingGrid = outgoing.end;
    const incomingGrid = incoming.start;
    if (
        ![
            outgoingGrid.bpm,
            incomingGrid.bpm,
            outgoingGrid.offset,
            incomingGrid.offset,
            duration,
            outgoing.audibleStart,
            outgoing.audibleEnd,
            incoming.audibleStart,
            incoming.audibleEnd,
            speed,
        ].every(Number.isFinite) ||
        outgoingGrid.bpm <= 0 ||
        incomingGrid.bpm <= 0 ||
        speed <= 0 ||
        duration <= 0 ||
        outgoing.audibleEnd <= outgoing.audibleStart ||
        incoming.audibleEnd <= incoming.audibleStart
    ) {
        return null;
    }

    // Half- and double-time BPM values describe the same beat grid.
    const closest = TEMPO_FACTORS.map(
        (factor) => outgoingGrid.bpm / (incomingGrid.bpm * factor),
    ).sort((a, b) => Math.abs(1 - a) - Math.abs(1 - b))[0];
    const limit = Math.max(0, options.maxTempoAdjust) / 100;
    if (Math.abs(1 - closest) > Math.max(limit, TEMPO_TOLERANCE)) return null;
    const ratio = Math.abs(1 - closest) <= limit ? closest : 1;

    const bar = barLength(outgoingGrid.bpm);
    const incomingBar = barLength(incomingGrid.bpm);
    const audibleEnd = Math.min(duration, outgoing.audibleEnd);
    const firstBar = firstBarAfter(incoming.audibleStart, incomingGrid);
    const introBars = Math.max(0, Math.round((incoming.introEnd - firstBar) / incomingBar));

    let bars: number;
    if (options.blendLength === 'auto') {
        const outroBars = (audibleEnd - outgoing.outroStart) / bar;
        const available = Math.min(outroBars, introBars);
        bars = AUTO_BLEND_BARS.find((count) => count <= available) ?? MIN_AUTO_BLEND_BARS;
    } else {
        bars = options.blendLength;
    }

    if (
        options.harmonicMixing &&
        outgoing.key &&
        incoming.key &&
        camelotDistance(outgoing.key.camelot, incoming.key.camelot) > 1
    ) {
        bars = Math.min(bars, KEY_CLASH_BLEND_BARS);
    }

    // Keep phrase-length blends, at most a quarter of the track.
    while (bars > 2 && bars * bar > duration * 0.25) bars /= 2;

    // Mix out at the start of the outro like a DJ and skip the tail. When the outro is too
    // short for the blend (abrupt ending), blend into the end of the track instead.
    const outroStart = snapToGrid(outgoing.outroStart, outgoingGrid.offset, bar);
    const mixOut = outroStart + bars * bar <= audibleEnd + 1e-6;
    const start = mixOut
        ? outroStart
        : snapToGrid(audibleEnd - bar * bars, outgoingGrid.offset, bar);
    const fadeEnd = mixOut ? outroStart + bars * bar : audibleEnd;
    const actualFadeDuration = fadeEnd - start;
    const actualBars = Math.round(actualFadeDuration / bar);

    // Line the incoming drop (end of its intro) up with the end of the blend.
    const leadBars = Math.min(introBars, actualBars);
    const incomingStart = firstBar + (introBars - leadBars) * incomingBar;

    if (
        start < 0 ||
        start < outgoing.audibleStart ||
        incomingStart < 0 ||
        incomingStart >= incoming.audibleEnd ||
        actualFadeDuration < bar * 2
    ) {
        return null;
    }

    // Swap the bass halfway, or at the incoming drop when it arrives earlier.
    const swapBars = Math.max(1, Math.min(Math.round(actualFadeDuration / 2 / bar), leadBars));
    const planAt = (from: number): MixPlan => ({
        bars: actualBars,
        bassSwapAt: from + swapBars * bar,
        beat: bar / BEATS_PER_BAR,
        fadeDuration: actualFadeDuration,
        fadeEnd: from + actualFadeDuration,
        incomingStart,
        rate: speed * ratio,
        start: from,
        style: 'blend',
    });

    const anchor = planAt(start);
    const outgoingBody = bodyLevel(outgoing.energy);
    const incomingBody = bodyLevel(incoming.energy);
    if (!outgoingBody || !incomingBody) return anchor;

    // Like a DJ keeping the floor going: try mixing out whole phrases earlier (up to a minute
    // before the outro) or later, and keep the latest point whose blend holds the energy about
    // as well as the best one.
    const phrase = PHRASE_BARS * bar;
    const earliestEnd = Math.max(
        outroStart - MAX_EARLY_MIX_OUT,
        duration / 2 + actualFadeDuration,
        outgoing.audibleStart + actualFadeDuration,
    );
    const candidates: MixPlan[] = [];
    for (let k = -Math.ceil(MAX_EARLY_MIX_OUT / phrase) - 1; ; k++) {
        const candidate = planAt(start + k * phrase);
        if (candidate.fadeEnd > audibleEnd + 1e-6) break;
        if (k === 0 || candidate.fadeEnd >= earliestEnd) candidates.push(candidate);
    }
    const scored = candidates.map((candidate) => ({
        candidate,
        score: blendEnergy(candidate, outgoing, outgoingBody, incoming, incomingBody, ratio),
    }));
    const best = Math.max(...scored.map(({ score }) => score));
    return scored.filter(({ score }) => score >= best - ENERGY_MARGIN).pop()?.candidate ?? anchor;
}

const SYNC_TOLERANCE = 0.015;
const SYNC_MAX_DRIFT = 0.1;
const SYNC_MAX_NUDGE = 0.03;
// Rate change per second of drift; quantized to 1% steps to avoid constant rate changes.
const SYNC_GAIN = 0.6;

/**
 * Playback rate that pulls the incoming deck back onto the beat. `drift` is how far the incoming
 * deck is ahead (positive) or behind (negative) in seconds. Returns null when it is too far off
 * to nudge and should be seeked instead.
 */
export function syncPlaybackRate(drift: number, rate: number): null | number {
    if (!Number.isFinite(drift) || Math.abs(drift) > SYNC_MAX_DRIFT) return null;
    if (Math.abs(drift) < SYNC_TOLERANCE) return rate;
    const nudge = clamp(Math.round(drift * SYNC_GAIN * 100) / 100, -SYNC_MAX_NUDGE, SYNC_MAX_NUDGE);
    return rate * (1 - (nudge || Math.sign(drift) * 0.01));
}

// Set arc in tracks: warm up, then repeat peak, breather and build.
const ARC_WARM_UP = 8;
const ARC_CYCLE: [FlowMode, number][] = [
    ['steady', 10],
    ['release', 2],
    ['build', 4],
];

/** Energy direction for the track at `position` in the queue with the 'auto' set arc. */
export function arcFlow(position: number): FlowMode {
    if (position < ARC_WARM_UP) return 'build';
    const cycle = ARC_CYCLE.reduce((total, [, length]) => total + length, 0);
    let step = (position - ARC_WARM_UP) % cycle;
    for (const [mode, length] of ARC_CYCLE) {
        if (step < length) return mode;
        step -= length;
    }
    return 'steady';
}

/** Cost of mixing from `a` into `b`: 0 is perfect, above 1 is a poor match, null is unknown. */
export function transitionCost(
    a: MixFeatures,
    b: MixFeatures,
    options: AutoMixOptions = DEFAULT_AUTO_MIX_OPTIONS,
    /** Queue position of `b`, for the 'auto' set arc. */
    position = 0,
): null | number {
    let total = 0;
    let weights = 0;

    const bpmA = a.bpm;
    const bpmB = b.bpm;
    if (isPositive(bpmA) && isPositive(bpmB)) {
        const distance = Math.min(
            ...TEMPO_FACTORS.map((factor) => Math.abs(Math.log(bpmA / (bpmB * factor)))),
        );
        const tolerance = Math.log(1 + Math.max(options.maxTempoAdjust / 100, TEMPO_TOLERANCE));
        total += distance / tolerance;
        weights += 1;
    }

    if (options.harmonicMixing && a.camelot && b.camelot) {
        const distance = camelotDistance(a.camelot, b.camelot);
        if (Number.isFinite(distance)) {
            total += 0.6 * (Math.min(distance, 3) / 3);
            weights += 0.6;
        }
    }

    const flow = options.energyFlow === 'auto' ? arcFlow(position) : options.energyFlow;
    if (flow !== 'free' && isFiniteNumber(a.energy) && isFiniteNumber(b.energy)) {
        const delta = b.energy - a.energy;
        // Build favours small rises, release small drops, steady neither.
        const cost =
            flow === 'build'
                ? delta < 0
                    ? -delta / 0.1
                    : delta / 0.4
                : flow === 'release'
                  ? delta > 0
                      ? delta / 0.1
                      : -delta / 0.4
                  : Math.abs(delta) / 0.3;
        total += 0.4 * cost;
        weights += 0.4;
    }

    return weights > 0 ? total / weights : null;
}

function barLength(bpm: number): number {
    return Number.isFinite(bpm) && bpm > 0 ? (60 / bpm) * BEATS_PER_BAR : 0;
}

/** Mean energy of the mix over a blend, relative to each track's typical (body) level. */
function blendEnergy(
    plan: MixPlan,
    outgoing: TrackAnalysis,
    outgoingBody: number,
    incoming: TrackAnalysis,
    incomingBody: number,
    ratio: number,
): number {
    let sum = 0;
    let count = 0;
    for (let time = plan.start; time < plan.fadeEnd; time += 1) {
        const gains = mixGains(plan, time);
        const incomingTime = plan.incomingStart + (time - plan.start) * ratio;
        const out = (outgoing.energy[Math.floor(time)] ?? 0) / outgoingBody;
        const into = (incoming.energy[Math.floor(incomingTime)] ?? 0) / incomingBody;
        sum += Math.min(1.5, Math.max(out * gains.outgoing, into * gains.incoming));
        count++;
    }
    return count ? sum / count : 0;
}

/** Typical loudness of the audible part of a track, or 0 without a usable profile. */
function bodyLevel(energy: number[]): number {
    const audible = energy.filter((value) => value > 0.02).sort((a, b) => a - b);
    return audible.length < 8 ? 0 : audible[Math.floor(audible.length / 2)];
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const n = a.length;
    let meanA = 0;
    let meanB = 0;
    for (let i = 0; i < n; i++) {
        meanA += a[i] / n;
        meanB += b[i] / n;
    }
    let cov = 0;
    let varA = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
        cov += (a[i] - meanA) * (b[i] - meanB);
        varA += (a[i] - meanA) ** 2;
        varB += (b[i] - meanB) ** 2;
    }
    return varA && varB ? cov / Math.sqrt(varA * varB) : 0;
}

function energyThreshold(energy: number[]): null | number {
    const body = bodyLevel(energy);
    return body ? body * 0.6 : null;
}

/** First bar of `grid` at or after `time`. */
function firstBarAfter(time: number, grid: BeatGrid): number {
    const bar = barLength(grid.bpm);
    return grid.offset + Math.ceil((time - grid.offset) / bar - 1e-9) * bar;
}

function groupBlocks<T extends MixCandidate>(tracks: readonly T[]): T[][] {
    const blocks: T[][] = [];
    for (const track of tracks) {
        const last = blocks[blocks.length - 1];
        if (last && track.group && last[0].group === track.group) {
            last.push(track);
        } else {
            blocks.push([track]);
        }
    }
    return blocks;
}

function isFiniteNumber(value: null | number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: null | number | undefined): value is number {
    return isFiniteNumber(value) && value > 0;
}

function parseCamelot(value: string): null | { letter: string; number: number } {
    const match = /^(1[0-2]|[1-9])([AB])$/.exec(value);
    return match ? { letter: match[2], number: Number(match[1]) } : null;
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function smooth(values: number[]): number[] {
    return values.map((_, index) => {
        const window = values.slice(Math.max(0, index - 2), index + 2);
        return window.reduce((sum, value) => sum + value, 0) / window.length;
    });
}

function snapToGrid(time: number, offset: number, step: number): number {
    return offset + Math.round((time - offset) / step) * step;
}

/** Camelot key for a tonic pitch class (0 = C). */
function toCamelot(pitch: number, minor: boolean): string {
    const majorPitch = minor ? (pitch + 3) % 12 : pitch;
    return `${((majorPitch * 7 + 7) % 12) + 1}${minor ? 'A' : 'B'}`;
}

function windowRms(samples: Float32Array, windowSize: number): number[] {
    const count = Math.ceil(samples.length / windowSize);
    const levels: number[] = new Array(count);
    for (let window = 0; window < count; window++) {
        const start = window * windowSize;
        const end = Math.min(start + windowSize, samples.length);
        let sum = 0;
        for (let index = start; index < end; index++) sum += samples[index] ** 2;
        levels[window] = Math.sqrt(sum / (end - start));
    }
    return levels;
}
