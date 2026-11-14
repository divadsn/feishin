/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test file */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    arcFlow,
    camelotDistance,
    DEFAULT_AUTO_MIX_OPTIONS,
    estimateKey,
    findIntroEnd,
    findOutroStart,
    getAudibleRange,
    getEnergyProfile,
    mixGains,
    orderForMix,
    parseKeyTag,
    pickForMix,
    planEchoOut,
    planMix,
    shouldSkipAutoMixAfterSeek,
    syncPlaybackRate,
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
    // Drop (intro end, ~9 bars in) lands at the end of the 8-bar blend.
    assert.equal(plan.incomingStart, 0.2 + (60 / 125) * 4);
    assert.ok(plan.fadeDuration >= 15 && plan.fadeDuration <= 17);
    const outgoingBars = (plan.start - outgoing.end.offset) / 2;
    assert.ok(Math.abs(outgoingBars - Math.round(outgoingBars)) < 1e-9);
});

test('handles half-time BPM and user playback speed', () => {
    const plan = planMix(track(120, 0, 0, 100), track(60, 0, 0, 100, { introEnd: 40 }), 100, 1.5);
    assert.deepEqual(plan, {
        bars: 8,
        bassSwapAt: 92,
        beat: 0.5,
        fadeDuration: 16,
        fadeEnd: 100,
        // 10-bar intro at 60 BPM, 8-bar blend: start 2 bars in so the drop lands at the end.
        incomingStart: 8,
        rate: 1.5,
        start: 84,
        style: 'blend',
    });
});

test('mixes out at the outro phrase and skips the tail', () => {
    const outgoing = track(120, 0, 0, 240, { outroStart: 176 });
    const incoming = track(120, 0, 0, 240, { introEnd: 16 });
    const plan = planMix(outgoing, incoming, 240, 1);
    assert.equal(plan.start, 176);
    assert.equal(plan.bars, 8);
    assert.equal(plan.fadeEnd, 192);
    assert.equal(plan.incomingStart, 0);
    assert.equal(plan.bassSwapAt, 184);
});

test('blends into the tail when the outro is too short', () => {
    const plan = planMix(
        track(120, 0, 0, 180, { outroStart: 176 }),
        track(120, 0, 0, 180, { introEnd: 16 }),
        180,
        1,
    );
    assert.equal(plan.fadeEnd, 180);
    assert.equal(plan.start, 164);
});

test('swaps the bass at the incoming drop when the intro is short', () => {
    const plan = planMix(
        track(120, 0, 0, 240, { outroStart: 176 }),
        track(120, 0, 0, 240, { introEnd: 4 }),
        240,
        1,
        options({ blendLength: 8 }),
    );
    assert.equal(plan.incomingStart, 0);
    assert.equal(plan.bassSwapAt, 180);
});

test('shapes DJ gains: incoming up early, outgoing out after the swap', () => {
    const plan = planMix(
        track(120, 0, 0, 240, { outroStart: 176 }),
        track(120, 0, 0, 240, { introEnd: 16 }),
        240,
        1,
    );
    assert.deepEqual(mixGains(plan, 176), { incoming: 0, outgoing: 1 });
    const middle = mixGains(plan, 182);
    assert.equal(middle.incoming, 1);
    assert.equal(middle.outgoing, 1);
    const late = mixGains(plan, 190);
    assert.ok(late.outgoing < 0.5 && late.incoming === 1);
    assert.ok(mixGains(plan, 192).outgoing < 1e-9);
});

test('plans an echo-out on a downbeat for unmatched tempos', () => {
    const outgoing = track(120, 0.1, 0, 200, { outroStart: 170.1 });
    const incoming = track(90, 0.3, 1, 200);
    assert.equal(planMix(outgoing, incoming, 200, 1), null);
    const plan = planEchoOut(outgoing, incoming, 200, 1);
    assert.equal(plan.style, 'echo');
    assert.equal(plan.start, 170.1);
    assert.equal(plan.fadeEnd, 170.6);
    assert.equal(plan.rate, 1);
    assert.ok(Math.abs(plan.incomingStart - (0.3 + (60 / 90) * 4)) < 1e-9);
    assert.deepEqual(mixGains(plan, 170.1), { incoming: 1, outgoing: 1 });
    assert.equal(planEchoOut(track(0, 0, 0, 200), incoming, 200, 1), null);
});

test('nudges the incoming deck back onto the beat', () => {
    assert.equal(syncPlaybackRate(0.005, 1), 1);
    assert.ok(syncPlaybackRate(0.05, 1) < 1);
    assert.ok(syncPlaybackRate(-0.05, 1) > 1);
    assert.ok(syncPlaybackRate(0.09, 1) >= 0.97);
    assert.equal(syncPlaybackRate(0.5, 1), null);
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

const energyCurve = (length, quiet) =>
    Array.from({ length }, (_, second) => (quiet(second) ? 0.2 : 1));

test('mixes out a phrase before a quiet outro to keep the energy up', () => {
    const outgoing = track(120, 0, 0, 240, {
        energy: energyCurve(240, (second) => second >= 176),
        outroStart: 176,
    });
    const incoming = track(120, 0, 0, 240, {
        energy: energyCurve(240, (second) => second < 16),
        introEnd: 16,
    });
    const plan = planMix(outgoing, incoming, 240, 1);
    // The incoming drop now lands where the outgoing breaks down.
    assert.equal(plan.start, 160);
    assert.equal(plan.fadeEnd, 176);
});

test('mixes late into the outro when the incoming track starts loud', () => {
    const outgoing = track(120, 0, 0, 240, {
        energy: energyCurve(240, (second) => second >= 176),
        outroStart: 176,
    });
    const incoming = track(120, 0, 0, 240, { energy: energyCurve(240, () => false), introEnd: 0 });
    const plan = planMix(outgoing, incoming, 240, 1);
    assert.equal(plan.start, 224);
    assert.equal(plan.fadeEnd, 240);
});

test('never mixes out more than a minute before the outro', () => {
    const outgoing = track(120, 0, 0, 300, {
        energy: energyCurve(300, (second) => second >= 100),
        outroStart: 236,
    });
    const incoming = track(120, 0, 0, 300, {
        energy: energyCurve(300, (second) => second < 16),
        introEnd: 16,
    });
    const plan = planMix(outgoing, incoming, 300, 1);
    assert.ok(plan.fadeEnd >= 236 - 60, `fadeEnd ${plan.fadeEnd}`);
});

test('keeps the outro mix point without energy profiles', () => {
    const plan = planMix(
        track(120, 0, 0, 240, { outroStart: 176 }),
        track(120, 0, 0, 240, { introEnd: 16 }),
        240,
        1,
    );
    assert.equal(plan.start, 176);
});

test('follows a DJ set arc with the auto energy flow', () => {
    assert.equal(arcFlow(0), 'build');
    assert.equal(arcFlow(7), 'build');
    assert.equal(arcFlow(8), 'steady');
    assert.equal(arcFlow(18), 'release');
    assert.equal(arcFlow(20), 'build');
    assert.equal(arcFlow(24), 'steady');

    const tracks = [feat('down', 120, null, 0.3), feat('up', 120, null, 0.6)];
    const current = feat('current', 120, null, 0.45);
    const auto = options({ energyFlow: 'auto' });
    assert.equal(orderForMix(tracks, current, auto, 0)[0].id, 'up');
    assert.equal(orderForMix(tracks, current, auto, 18)[0].id, 'down');
});
