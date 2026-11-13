import type { TrackAnalysis } from '/@/renderer/features/player/audio-player/utils/auto-mix';

import { useEffect, useState } from 'react';

import {
    analyzeSong,
    getCachedAnalysis,
} from '/@/renderer/features/player/audio-player/utils/auto-mix-analyzer';
import { QueueSong } from '/@/shared/types/domain-types';

/** Analysis for a song loaded in a deck, fetched with high priority. */
export function useMixAnalysis(
    song: QueueSong | undefined,
    url: string | undefined,
    enabled: boolean,
): null | TrackAnalysis {
    const [result, setResult] = useState<null | { analysis: TrackAnalysis; key: string }>(null);
    const key = song ? `${song._serverId}:${song.id}` : '';

    useEffect(() => {
        if (!enabled || !song || !url || getCachedAnalysis(song)) return;

        let active = true;
        analyzeSong(song, async () => url, 'high')
            .then((analysis) => {
                if (active) setResult({ analysis, key });
            })
            // Failures are logged by the analyzer; the deck falls back to a plain blend.
            .catch(() => undefined);
        return () => {
            active = false;
        };
    }, [enabled, key, song, url]);

    if (!enabled || !song) return null;
    return getCachedAnalysis(song) ?? (result?.key === key ? result.analysis : null);
}
