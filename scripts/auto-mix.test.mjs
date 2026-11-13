/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test file */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    camelotDistance,
    DEFAULT_AUTO_MIX_OPTIONS,
    estimateKey,
    findIntroEnd,
    findOutroStart,
    getAudibleRange,
    getEnergyProfile,
    orderForMix,
    parseKeyTag,
    pickForMix,
    planMix,
    shouldSkipAutoMixAfterSeek,
} from '../src/renderer/features/player/audio-player/utils/auto-mix.ts';

// 8-bar intro and outro at 120 BPM unless overridden.
const track = (bpm, offset, audibleStart, audibleEnd, extra = {}) => ({
    audibleEnd,
    audibleStart,
    end: { bpm, offset },
    energy: [],
    energyLevel: 0.5,
    introEnd: audibleStart + 17,
    key: null,
    outroStart: audibleEnd - 16,
    start: { bpm, offset },
    ...extra,
});

const options = (overrides) => ({ ...DEFAULT_AUTO_MIX_OPTIONS, ...overrides });

test('aligns a phrase-length transition and adjusts tempo', () => {
    const outgoing = track(120, 0.1, 0, 180);
    const incoming = track(125, 0.2, 0, 180);
    const plan = planMix(outgoing, incoming, 180, 1);
    assert.ok(plan);
    assert.equal(plan.rate, 120 / 125);
    assert.equal(plan.fadeEnd, 180);
    assert.equal(plan.incomingStart, 0.2);
    assert.ok(plan.fadeDuration >= 15 && plan.fadeDuration <= 17);
    const outgoingBars = (plan.start - outgoing.end.offset) / 2;
    assert.ok(Math.abs(outgoingBars - Math.round(outgoingBars)) < 1e-9);
});

test('handles half-time BPM and user playback speed', () => {
    const plan = planMix(track(120, 0, 0, 100), track(60, 0, 0, 100, { introEnd: 40 }), 100, 1.5);
    assert.deepEqual(plan, {
        bars: 8,
        bassSwapAt: 92,
        fadeDuration: 16,
        fadeEnd: 100,
        incomingStart: 0,
        rate: 1.5,
        start: 84,
    });
});

test('does not beatmatch incompatible or invalid tracks', () => {
    assert.equal(planMix(track(120, 0, 0, 100), track(140, 0, 0, 100), 100, 1), null);
    assert.equal(planMix(track(0, 0, 0, 100), track(120, 0, 0, 100), 100, 1), null);
    assert.equal(planMix(track(120, 0, 0, 1), track(120, 0, 0, 1), 1, 1), null);
});

test('uses detected silence to start and end transitions at audible phrases', () => {
    const plan = planMix(track(120, 0.1, 0, 162), track(120, 0.2, 9, 180), 180, 1);
    assert.ok(plan);
    assert.equal(plan.fadeEnd, 162);
    assert.equal(plan.incomingStart, 10.2);
});

test('derives blend length from intro and outro and shortens on key clash', () => {
    const long = { introEnd: 70, outroStart: 236 };
    const plan = planMix(track(120, 0, 0, 300, long), track(120, 0, 0, 300, long), 300, 1);
    assert.equal(plan.bars, 32);
    assert.equal(plan.start, 236);
    assert.equal(plan.bassSwapAt, 268);
    // A quarter of a 180 s track caps the blend at 16 bars.
    const shorter = { introEnd: 70, outroStart: 116 };
    const capped = planMix(track(120, 0, 0, 180, shorter), track(120, 0, 0, 180, shorter), 180, 1);
    assert.equal(capped.bars, 16);

    const clash = planMix(
        track(120, 0, 0, 300, { ...long, key: { camelot: '8A', confidence: 0.8 } }),
        track(120, 0, 0, 300, { ...long, key: { camelot: '2B', confidence: 0.8 } }),
        300,
        1,
    );
    assert.equal(clash.bars, 4);

    const ignored = planMix(
        track(120, 0, 0, 300, { ...long, key: { camelot: '8A', confidence: 0.8 } }),
        track(120, 0, 0, 300, { ...long, key: { camelot: '2B', confidence: 0.8 } }),
        300,
        1,
        options({ harmonicMixing: false }),
    );
    assert.equal(ignored.bars, 32);
});

test('honours fixed blend length and tempo adjustment limit', () => {
    const fixed = planMix(
        track(120, 0, 0, 180),
        track(120, 0, 0, 180),
        180,
        1,
        options({ blendLength: 16 }),
    );
    assert.equal(fixed.bars, 16);

    assert.equal(
        planMix(
            track(120, 0, 0, 180),
            track(125, 0, 0, 180),
            180,
            1,
            options({ maxTempoAdjust: 2 }),
        ),
        null,
    );
    const unadjusted = planMix(
        track(120, 0, 0, 180),
        track(121, 0, 0, 180),
        180,
        1,
        options({ maxTempoAdjust: 0 }),
    );
    assert.equal(unadjusted.rate, 1);
});

test('finds audible bounds and safely handles silent audio', () => {
    const range = getAudibleRange(new Float32Array([0, 0, 1, 1, 1, 1, 0, 0]), 8);
    assert.deepEqual(range, { audibleEnd: 0.75, audibleStart: 0.25 });
    assert.deepEqual(getAudibleRange(new Float32Array(8), 8), {
        audibleEnd: 1,
        audibleStart: 0,
    });
});

test('builds a normalized energy profile', () => {
    const samples = new Float32Array(4);
    samples.set([0.5, 0.5, 0.25, 0.25]);
    const { energy, energyLevel } = getEnergyProfile(samples, 2);
    assert.deepEqual(energy, [1, 0.5]);
    assert.ok(energyLevel > 0 && energyLevel <= 1);
});

test('finds bar-aligned intro end and outro start from energy', () => {
    // 20 s quiet intro, loud body, quiet outro from 160 s.
    const energy = Array.from({ length: 180 }, (_, i) => (i < 20 || i >= 160 ? 0.2 : 1));
    const grid = { bpm: 120, offset: 0 };
    const introEnd = findIntroEnd(energy, grid, 0);
    const outroStart = findOutroStart(energy, grid, 180);
    assert.ok(Math.abs(introEnd - 20) <= 2 && introEnd % 2 === 0, `intro ${introEnd}`);
    assert.ok(Math.abs(outroStart - 160) <= 2 && outroStart % 2 === 0, `outro ${outroStart}`);
    assert.equal(findOutroStart([], grid, 180), 180);
});

test('estimates keys from chroma and parses key tags', () => {
    const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const minor = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const rotate = (profile, tonic) =>
        Array.from({ length: 12 }, (_, i) => profile[(i - tonic + 12) % 12]);
    assert.equal(estimateKey(major).camelot, '8B');
    assert.equal(estimateKey(rotate(minor, 9)).camelot, '8A');
    assert.equal(estimateKey(rotate(major, 7)).camelot, '9B');
    assert.equal(estimateKey(new Array(12).fill(1)), null);

    assert.equal(parseKeyTag('8a'), '8A');
    assert.equal(parseKeyTag('Am'), '8A');
    assert.equal(parseKeyTag('A minor'), '8A');
    assert.equal(parseKeyTag('F#m'), '11A');
    assert.equal(parseKeyTag('Gb'), '2B');
    assert.equal(parseKeyTag('Bbmaj'), '6B');
    assert.equal(parseKeyTag('B'), '1B');
    assert.equal(parseKeyTag('nonsense'), null);
    assert.equal(parseKeyTag(undefined), null);
});

test('measures Camelot distance with wrap-around', () => {
    assert.equal(camelotDistance('8A', '8A'), 0);
    assert.equal(camelotDistance('8A', '8B'), 1);
    assert.equal(camelotDistance('12A', '1A'), 1);
    assert.equal(camelotDistance('8A', '10A'), 2);
    assert.equal(camelotDistance('8A', 'x'), Infinity);
});

const feat = (id, bpm, camelot = null, energy = null, group = null) => ({
    bpm,
    camelot,
    energy,
    group,
    id,
});

test('reorders tracks to follow compatible BPMs and preserves incompatible ordering', () => {
    const tracks = [feat('a', 130), feat('b', 102), feat('c', 105), feat('d', 90)];
    assert.deepEqual(
        orderForMix(tracks, feat('current', 100)).map((t) => t.id),
        ['b', 'c', 'a', 'd'],
    );
    assert.deepEqual(orderForMix(tracks, null), tracks);
    assert.deepEqual(
        orderForMix([feat('unknown', null)], feat('current', 100)).map((t) => t.id),
        ['unknown'],
    );
});

test('prefers harmonically compatible keys at equal tempo', () => {
    const tracks = [feat('clash', 120, '3B'), feat('match', 120, '9A')];
    const current = feat('current', 120, '8A');
    assert.deepEqual(
        orderForMix(tracks, current).map((t) => t.id),
        ['match', 'clash'],
    );
    assert.deepEqual(
        orderForMix(tracks, current, options({ harmonicMixing: false })).map((t) => t.id),
        ['clash', 'match'],
    );
});

test('builds energy when requested', () => {
    const tracks = [
        feat('low', 120, null, 0.2),
        feat('mid', 120, null, 0.45),
        feat('high', 120, null, 0.6),
    ];
    const ordered = orderForMix(
        tracks,
        feat('current', 120, null, 0.4),
        options({ energyFlow: 'build' }),
    );
    assert.deepEqual(
        ordered.slice(0, 2).map((t) => t.id),
        ['mid', 'high'],
    );
});

test('keeps album blocks intact', () => {
    const tracks = [
        feat('a1', 90, null, null, 'album'),
        feat('a2', 140, null, null, 'album'),
        feat('b', 101),
    ];
    assert.deepEqual(
        orderForMix(tracks, feat('current', 100)).map((t) => t.id),
        ['b', 'a1', 'a2'],
    );
});

test('picks the best-fitting candidates', () => {
    const candidates = [feat('x', 150), feat('y', 121), feat('z', 119), feat('w', 80)];
    assert.deepEqual(
        pickForMix(candidates, feat('last', 120), 2).map((t) => t.id),
        ['y', 'z'],
    );
});

test('skips the scheduled mix when seeking into its transition window', () => {
    const plan = planMix(track(120, 0, 0, 180), track(120, 0, 0, 180), 180, 1);
    assert.ok(plan);
    assert.equal(shouldSkipAutoMixAfterSeek(plan.start - 1, 180, plan, 8), false);
    assert.equal(shouldSkipAutoMixAfterSeek(plan.start, 180, plan, 8), true);
    assert.equal(shouldSkipAutoMixAfterSeek(172, 180, null, 8), true);
});
