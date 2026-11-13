import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planMix } from '../src/renderer/features/player/audio-player/utils/auto-mix.ts';

test('aligns the incoming beat and adjusts tempo within the fade window', () => {
    const outgoing = { bpm: 120, offset: 0.1 };
    const incoming = { bpm: 125, offset: 0.2 };
    const plan = planMix(outgoing, incoming, 180, 10, 1);
    assert.ok(plan);
    assert.equal(plan.rate, 120 / 125);
    assert.ok(plan.start >= 170 && plan.start <= 178);
    const outgoingBeats = (plan.start + incoming.offset / plan.rate - outgoing.offset) / 0.5;
    assert.ok(Math.abs(outgoingBeats - Math.round(outgoingBeats)) < 1e-9);
});

test('handles half-time BPM and user playback speed', () => {
    const plan = planMix({ bpm: 120, offset: 0 }, { bpm: 60, offset: 0 }, 100, 8, 1.5);
    assert.deepEqual(plan, { rate: 1.5, start: 92 });
});

test('does not beatmatch incompatible or invalid tracks', () => {
    assert.equal(planMix({ bpm: 120, offset: 0 }, { bpm: 140, offset: 0 }, 100, 8, 1), null);
    assert.equal(planMix({ bpm: 0, offset: 0 }, { bpm: 120, offset: 0 }, 100, 8, 1), null);
    assert.equal(planMix({ bpm: 120, offset: 0 }, { bpm: 120, offset: 0 }, 1, 8, 1), null);
});
