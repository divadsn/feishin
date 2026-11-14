import type { MixPlan } from '/@/renderer/features/player/audio-player/utils/auto-mix';

/** Per-deck DJ filters inserted between the media source and the deck gain. */
export interface DeckFx {
    delay: DelayNode;
    feedback: GainNode;
    highpass: BiquadFilterNode;
    lowshelf: BiquadFilterNode;
    /** Feeds the echo; the delay loop keeps ringing after it closes. */
    send: GainNode;
}

const BASS_CUT_DB = -24;
const ECHO_FEEDBACK = 0.5;
const ECHO_MAX_DELAY = 4;
const ECHO_SEND = 0.7;
const HIGHPASS_NEUTRAL_HZ = 10;
const HIGHPASS_SWEEP_HZ = 800;
const LOWSHELF_HZ = 200;

export function connectDeckFx(
    source: AudioNode,
    fx: DeckFx | null | undefined,
    destination: AudioNode,
) {
    if (!fx) {
        source.connect(destination);
        return;
    }
    source.connect(fx.highpass);
    fx.lowshelf.connect(destination);
    fx.delay.connect(destination);
}

export function createDeckFx(context: AudioContext): DeckFx {
    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = HIGHPASS_NEUTRAL_HZ;
    highpass.Q.value = 0.7;

    const lowshelf = context.createBiquadFilter();
    lowshelf.type = 'lowshelf';
    lowshelf.frequency.value = LOWSHELF_HZ;
    lowshelf.gain.value = 0;

    const send = context.createGain();
    send.gain.value = 0;
    const delay = context.createDelay(ECHO_MAX_DELAY);
    const feedback = context.createGain();
    feedback.gain.value = ECHO_FEEDBACK;

    highpass.connect(lowshelf);
    lowshelf.connect(send);
    send.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    return { delay, feedback, highpass, lowshelf, send };
}

export function resetDeckFx(fx: DeckFx | null | undefined) {
    if (!fx) return;
    const now = fx.highpass.context.currentTime;
    for (const [param, value] of [
        [fx.highpass.frequency, HIGHPASS_NEUTRAL_HZ],
        [fx.lowshelf.gain, 0],
        [fx.send.gain, 0],
    ] as const) {
        param.cancelScheduledValues(now);
        param.setTargetAtTime(value, now, 0.05);
    }
}

/**
 * Schedules a bass swap and a high-pass sweep on the outgoing deck, or an echo-out for
 * `style: 'echo'`. Times in `plan` are in
 * outgoing track seconds and are converted to the audio clock using the current media time.
 * Without a plan (no beat match), the swap happens halfway through `fadeDuration`.
 */
export function scheduleMixFx(args: {
    context: AudioContext;
    fadeDuration: number;
    incoming: DeckFx;
    mediaTime: number;
    outgoing: DeckFx;
    plan: MixPlan | null;
    rate: number;
}) {
    const { context, fadeDuration, incoming, mediaTime, outgoing, plan, rate } = args;
    const now = context.currentTime;
    const toClock = (time: number) => now + Math.max(0, (time - mediaTime) / rate);

    const fadeEnd = toClock(plan?.fadeEnd ?? mediaTime + fadeDuration);
    const beat = plan ? plan.beat / rate : 0.5;

    if (plan?.style === 'echo') {
        const cut = toClock(plan.start);
        resetDeckFx(incoming);
        outgoing.lowshelf.gain.cancelScheduledValues(now);
        outgoing.lowshelf.gain.setValueAtTime(0, now);
        outgoing.delay.delayTime.cancelScheduledValues(now);
        outgoing.delay.delayTime.setValueAtTime(Math.min(beat, ECHO_MAX_DELAY), now);
        outgoing.feedback.gain.cancelScheduledValues(now);
        outgoing.feedback.gain.setValueAtTime(ECHO_FEEDBACK, now);
        // Thin the echo out so it does not fight the incoming low end.
        outgoing.highpass.frequency.cancelScheduledValues(now);
        outgoing.highpass.frequency.setValueAtTime(HIGHPASS_NEUTRAL_HZ, cut);
        outgoing.highpass.frequency.exponentialRampToValueAtTime(HIGHPASS_SWEEP_HZ, fadeEnd);
        outgoing.send.gain.cancelScheduledValues(now);
        outgoing.send.gain.setValueAtTime(ECHO_SEND, cut);
        outgoing.send.gain.setValueAtTime(ECHO_SEND, fadeEnd);
        outgoing.send.gain.linearRampToValueAtTime(0, fadeEnd + 0.05);
        return;
    }

    const swapAt = plan ? toClock(plan.bassSwapAt) : now + (fadeEnd - now) / 2;
    const sweepFrom = plan ? Math.max(now, fadeEnd - beat * 8) : swapAt;

    // Incoming deck: bass cut until the swap.
    incoming.lowshelf.gain.cancelScheduledValues(now);
    incoming.lowshelf.gain.setValueAtTime(BASS_CUT_DB, now);
    incoming.lowshelf.gain.setValueAtTime(BASS_CUT_DB, swapAt);
    incoming.lowshelf.gain.linearRampToValueAtTime(0, swapAt + beat);
    incoming.highpass.frequency.cancelScheduledValues(now);
    incoming.highpass.frequency.setValueAtTime(HIGHPASS_NEUTRAL_HZ, now);

    // Outgoing deck: hand over the bass, then thin out towards the end.
    outgoing.lowshelf.gain.cancelScheduledValues(now);
    outgoing.lowshelf.gain.setValueAtTime(0, swapAt);
    outgoing.lowshelf.gain.linearRampToValueAtTime(BASS_CUT_DB, swapAt + beat);
    outgoing.highpass.frequency.cancelScheduledValues(now);
    outgoing.highpass.frequency.setValueAtTime(HIGHPASS_NEUTRAL_HZ, sweepFrom);
    outgoing.highpass.frequency.exponentialRampToValueAtTime(HIGHPASS_SWEEP_HZ, fadeEnd);
}
