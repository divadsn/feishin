export interface BeatGrid {
    bpm: number;
    offset: number;
}

export interface MixPlan {
    rate: number;
    start: number;
}

export function planMix(
    outgoing: BeatGrid,
    incoming: BeatGrid,
    duration: number,
    fadeDuration: number,
    speed: number,
): MixPlan | null {
    if (
        ![
            outgoing.bpm,
            incoming.bpm,
            outgoing.offset,
            incoming.offset,
            duration,
            fadeDuration,
            speed,
        ].every(Number.isFinite) ||
        outgoing.bpm <= 0 ||
        incoming.bpm <= 0 ||
        speed <= 0 ||
        fadeDuration <= 0
    ) {
        return null;
    }

    // Half- and double-time BPM values describe the same beat grid.
    const ratio = [0.5, 1, 2]
        .map((factor) => outgoing.bpm / (incoming.bpm * factor))
        .sort((a, b) => Math.abs(1 - a) - Math.abs(1 - b))[0];
    if (Math.abs(1 - ratio) > 0.08) return null;

    const beat = 60 / outgoing.bpm;
    const firstStart = outgoing.offset - (incoming.offset * speed) / (speed * ratio);
    const earliest = Math.max(0, duration - fadeDuration);
    const start = firstStart + Math.ceil((earliest - firstStart) / beat) * beat;
    if (start > duration - 2) return null;

    return { rate: speed * ratio, start };
}
