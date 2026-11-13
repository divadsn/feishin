import { useEffect } from 'react';

import { getSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import {
    analyzeSong,
    cancelLowPriorityAnalyses,
    loadCachedAnalyses,
} from '/@/renderer/features/player/audio-player/utils/auto-mix-analyzer';
import {
    isShuffleEnabled,
    useAutoDJSettings,
    useAutoMixSettings,
    usePlaybackSettings,
    usePlayerStoreBase,
} from '/@/renderer/store';
import { QueueSong } from '/@/shared/types/domain-types';

const REORDER_DEBOUNCE_MS = 2000;

/**
 * Analyzes the next few upcoming songs in the background and reorders the queue as results
 * arrive, so the mix keeps flowing past the next track (including Auto DJ additions).
 */
export function useAutoMixLookahead(enabled: boolean) {
    const settings = useAutoMixSettings();
    const autoDJ = useAutoDJSettings();
    const { transcode } = usePlaybackSettings();

    const count = Math.max(
        settings.lookahead,
        autoDJ.enabled ? autoDJ.timing + autoDJ.itemCount : 0,
    );
    const active = enabled && settings.reorderQueue;

    useEffect(() => {
        if (!active) return;

        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const reorder = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (!disposed) usePlayerStoreBase.getState().reorderUpcomingForAutoMix();
            }, REORDER_DEBOUNCE_MS);
        };

        const getUpcoming = (): QueueSong[] => {
            const state = usePlayerStoreBase.getState();
            if (isShuffleEnabled(state)) return [];
            const start = state.player.index + 1;
            return state.queue.default
                .slice(start, start + count)
                .map((id) => state.queue.songs[id])
                .filter((song): song is QueueSong => Boolean(song));
        };

        const run = async () => {
            const upcoming = getUpcoming();
            if (upcoming.length === 0) return;

            await loadCachedAnalyses(upcoming);
            if (disposed) return;
            reorder();

            for (const song of upcoming) {
                analyzeSong(song, () => getSongUrl(song, transcode), 'low')
                    .then(() => {
                        if (!disposed) reorder();
                    })
                    // Failures are logged by the analyzer; the song keeps its tag features.
                    .catch(() => undefined);
            }
        };

        run();
        const unsubscribe = usePlayerStoreBase.subscribe(
            () =>
                getUpcoming()
                    .map((song) => song._uniqueId)
                    .join(),
            () => {
                if (!disposed) run();
            },
        );

        return () => {
            disposed = true;
            clearTimeout(timer);
            unsubscribe();
            cancelLowPriorityAnalyses();
        };
    }, [active, count, settings, transcode]);
}
