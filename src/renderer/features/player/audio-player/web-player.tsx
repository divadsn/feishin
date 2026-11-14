import type { Dispatch } from 'react';
import type ReactPlayer from 'react-player';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { playerHandoff } from './engine/player-handoff';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import {
    WebPlayerEngine,
    WebPlayerEngineHandle,
} from '/@/renderer/features/player/audio-player/engine/web-player-engine';
import { useAutoMixLookahead } from '/@/renderer/features/player/audio-player/hooks/use-auto-mix-lookahead';
import { useMixAnalysis } from '/@/renderer/features/player/audio-player/hooks/use-mix-analysis';
import { usePlayerEvents } from '/@/renderer/features/player/audio-player/hooks/use-player-events';
import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { PlayerOnProgressProps } from '/@/renderer/features/player/audio-player/types';
import {
    mixGains,
    MixPlan,
    planEchoOut,
    planMix,
    shouldSkipAutoMixAfterSeek,
    syncPlaybackRate,
    TrackAnalysis,
} from '/@/renderer/features/player/audio-player/utils/auto-mix';
import {
    connectDeckFx,
    createDeckFx,
    DeckFx,
    resetDeckFx,
    scheduleMixFx,
} from '/@/renderer/features/player/audio-player/utils/auto-mix-fx';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import {
    useAutoMixSettings,
    useMpvSettings,
    usePlaybackSettings,
    usePlayerActions,
    usePlayerData,
    usePlayerMuted,
    usePlayerProperties,
    usePlayerRepeat,
    usePlayerStoreBase,
    usePlayerVolume,
} from '/@/renderer/store';
import { logger } from '/@/renderer/utils/logger';
import { toast } from '/@/shared/components/toast/toast';
import { QueueSong } from '/@/shared/types/domain-types';
import { CrossfadeStyle, PlayerRepeat, PlayerStatus, PlayerStyle } from '/@/shared/types/types';

const PLAY_PAUSE_FADE_DURATION = 300;
const PLAY_PAUSE_FADE_INTERVAL = 10;
const AUTO_MIX_FALLBACK_FADE_DURATION = 8;

interface MixHandlers {
    /** Deck EQ is available, so both decks can play at full while the bass is swapped. */
    djGains: boolean;
    fadeStart: number | undefined;
    nextId: string | undefined;
    onCancel: () => void;
    onError: (incoming: HTMLMediaElement) => void;
    /** Hands over to the next track when the plan mixes out before the track ends. */
    onFinished: () => void;
    onPlaying: (incoming: HTMLMediaElement) => void;
    onStarted: (
        incoming: HTMLMediaElement,
        fadeStart: number,
        rate: number,
        nextId: string,
    ) => void;
    onSync: (drift: number, seeked: boolean) => void;
    plan: MixPlan | null;
    speed: number;
}

export function WebPlayer() {
    const playerRef = useRef<null | WebPlayerEngineHandle>(null);
    const { t } = useTranslation();
    const { num, player1, player2, status } = usePlayerData();
    const repeat = usePlayerRepeat();
    const repeatOneProgressRef = useRef({ player1: 0, player2: 0 });
    const { mediaAutoNext, mediaPause, setTimestamp } = usePlayerActions();
    const playback = useMpvSettings();
    const { webAudio } = useWebAudio();

    const { crossfadeDuration, crossfadeStyle, speed, transitionType } = usePlayerProperties();
    const isMuted = usePlayerMuted();
    const volume = usePlayerVolume();
    const { audioFadeOnStatusChange, preservePitch, transcode } = usePlaybackSettings();
    const player1Url = useSongUrl(player1, num === 1, transcode);
    const player2Url = useSongUrl(player2, num === 2, transcode);
    const mixEnabled = transitionType === PlayerStyle.AUTO_MIX && repeat !== PlayerRepeat.ONE;
    const analysis1 = useMixAnalysis(player1, player1Url, mixEnabled && Boolean(player2));
    const analysis2 = useMixAnalysis(player2, player2Url, mixEnabled && Boolean(player1));
    const autoMix = useAutoMixSettings();
    useAutoMixLookahead(mixEnabled);
    const deckFxRef = useRef<[DeckFx | null, DeckFx | null]>([null, null]);

    const pendingLocalSeekRef = useRef(-1);
    const mixRef = useRef<null | {
        fadeStart: number;
        handedOff: boolean;
        incoming: HTMLMediaElement;
        maxDrift: number;
        nextId: string;
        outgoing: 1 | 2;
        rate: number;
        seeks: number;
        style: MixPlan['style'] | null;
    }>(null);
    const mixRampRef = useRef<null | ReturnType<typeof setInterval>>(null);
    const mixHandoffRef = useRef(false);
    const skipAutoMixForTrackRef = useRef(false);

    const [localPlayerStatus, setLocalPlayerStatus] = useState<PlayerStatus>(() => {
        if (playerHandoff.pendingLocalSeek > 0) {
            pendingLocalSeekRef.current = playerHandoff.pendingLocalSeek;
            playerHandoff.pendingLocalSeek = -1;
            return PlayerStatus.PAUSED;
        }
        return status;
    });
    const [isTransitioning, setIsTransitioning] = useState<boolean | string>(false);
    const fadeIntervalRef = useRef<NodeJS.Timeout | null>(null);

    const [player1Source, setPlayer1Source] = useState<MediaElementAudioSourceNode | null>(null);
    const [player2Source, setPlayer2Source] = useState<MediaElementAudioSourceNode | null>(null);

    const cancelMix = useCallback(() => {
        if (mixRampRef.current) {
            clearInterval(mixRampRef.current);
            mixRampRef.current = null;
        }
        const mix = mixRef.current;
        mixRef.current = null;
        if (!mix) return;
        resetDeckFx(deckFxRef.current[0]);
        resetDeckFx(deckFxRef.current[1]);
        mix.incoming.playbackRate = usePlayerStoreBase.getState().player.speed;
        if (!mix.handedOff) {
            mix.incoming.pause();
            if (mix.incoming.readyState > 0) {
                try {
                    mix.incoming.currentTime = 0;
                } catch (error) {
                    logger.warn('Auto mix could not reset the next track', { error });
                }
            }
            playerRef.current?.setVolume(usePlayerStoreBase.getState().player.volume);
        }
        setIsTransitioning(false);
    }, []);

    const finishMix = useCallback(
        (outgoing: 1 | 2) => {
            const mix = mixRef.current;
            if (!mix || mix.outgoing !== outgoing) return;
            const state = usePlayerStoreBase.getState();
            if (
                state.player.status !== PlayerStatus.PLAYING ||
                state.getCurrentSong()?._uniqueId !== mix.nextId
            ) {
                cancelMix();
                return;
            }
            if (mix.style === 'blend') {
                logger.debug('Auto mix beat sync', {
                    maxDriftMs: Math.round(mix.maxDrift * 1000),
                    seeks: mix.seeks,
                });
            }
            mix.handedOff = true;
            resetDeckFx(deckFxRef.current[0]);
            resetDeckFx(deckFxRef.current[1]);
            const initialTime = mix.incoming.currentTime;
            const target = state.player.speed;
            if (mix.rate === target) {
                mixRef.current = null;
                return;
            }
            mixRampRef.current = setInterval(() => {
                const progress = Math.min(
                    1,
                    Math.max(0, (mix.incoming.currentTime - initialTime) / 20),
                );
                mix.incoming.playbackRate = mix.rate + (target - mix.rate) * progress;
                if (progress === 1) {
                    if (mixRampRef.current) clearInterval(mixRampRef.current);
                    mixRampRef.current = null;
                    mixRef.current = null;
                }
            }, 100);
        },
        [cancelMix],
    );

    const scheduleFx = useCallback(
        (outgoing: 1 | 2, plan: MixPlan | null, mediaTime: number, fadeDuration: number) => {
            const outgoingFx = deckFxRef.current[outgoing - 1];
            const incomingFx = deckFxRef.current[2 - outgoing];
            if (!webAudio || !autoMix.eqTransitions || !outgoingFx || !incomingFx) return;
            scheduleMixFx({
                context: webAudio.context,
                fadeDuration,
                incoming: incomingFx,
                mediaTime,
                outgoing: outgoingFx,
                plan,
                rate: usePlayerStoreBase.getState().player.speed,
            });
        },
        [autoMix.eqTransitions, webAudio],
    );

    const fadeAndSetStatus = useCallback(
        async (startVolume: number, endVolume: number, duration: number, status: PlayerStatus) => {
            // Cancel any in-progress fade
            if (fadeIntervalRef.current) {
                clearInterval(fadeIntervalRef.current);
                fadeIntervalRef.current = null;
            }

            // Set initial volume immediately to ensure we start from the correct position
            // This is especially important when cancelling a previous fade
            playerRef.current?.setVolume(startVolume);

            const steps = duration / PLAY_PAUSE_FADE_INTERVAL;
            const volumeStep = (endVolume - startVolume) / steps;
            let currentStep = 0;

            const promise = new Promise<void>((resolve) => {
                fadeIntervalRef.current = setInterval(() => {
                    currentStep++;
                    const newVolume = startVolume + volumeStep * currentStep;

                    playerRef.current?.setVolume(newVolume);

                    if (currentStep >= steps) {
                        if (fadeIntervalRef.current) {
                            clearInterval(fadeIntervalRef.current);
                            fadeIntervalRef.current = null;
                        }
                        // Ensure final volume is exactly the target
                        playerRef.current?.setVolume(endVolume);
                        resolve();
                    }
                }, PLAY_PAUSE_FADE_INTERVAL);
            });

            if (status === PlayerStatus.PLAYING) {
                setLocalPlayerStatus(status);
                await promise;
            } else {
                await promise;
                setLocalPlayerStatus(status);
                playerRef.current?.setVolume(startVolume);
            }
        },
        [],
    );

    const handleRepeatOne = useCallback(
        (playerId: 1 | 2, playedSeconds: number, duration: number) => {
            if (repeat !== PlayerRepeat.ONE || duration <= 0 || num !== playerId) {
                return;
            }

            const key = playerId === 1 ? 'player1' : 'player2';
            const last = repeatOneProgressRef.current[key];
            repeatOneProgressRef.current[key] = playedSeconds;

            if (last > duration * 0.85 && playedSeconds < duration * 0.15) {
                setTimestamp(0);
                eventEmitter.emit('PLAYER_REPEATED', {
                    index: usePlayerStoreBase.getState().player.index,
                });
            }
        },
        [num, repeat, setTimestamp],
    );

    const handleOnEndedPlayer1 = useCallback(() => {
        mixHandoffRef.current = true;
        mediaAutoNext();
        mixHandoffRef.current = false;
        finishMix(1);
        const storeStatus = usePlayerStoreBase.getState().player.status;
        if (storeStatus === PlayerStatus.PAUSED) {
            setLocalPlayerStatus(PlayerStatus.PAUSED);
            playerRef.current?.pause();
        } else {
            playerRef.current?.player1()?.ref?.getInternalPlayer().pause();

            // If mediaAutoNext resulted in a stopped/paused state (e.g. end of queue,
            // or pauseOnNextSongEnd flag), stop all audio instead of restoring volume.
            const currentStatus = usePlayerStoreBase.getState().player.status;
            if (currentStatus !== PlayerStatus.PLAYING) {
                playerRef.current?.pause();
            } else {
                playerRef.current?.setVolume(volume);
            }
            setIsTransitioning(false);
        }
    }, [finishMix, mediaAutoNext, volume]);
    const handleOnEndedPlayer2 = useCallback(() => {
        mixHandoffRef.current = true;
        mediaAutoNext();
        mixHandoffRef.current = false;
        finishMix(2);
        const storeStatus = usePlayerStoreBase.getState().player.status;
        if (storeStatus === PlayerStatus.PAUSED) {
            setLocalPlayerStatus(PlayerStatus.PAUSED);
            playerRef.current?.pause();
        } else {
            playerRef.current?.player2()?.ref?.getInternalPlayer().pause();

            const currentStatus = usePlayerStoreBase.getState().player.status;
            if (currentStatus !== PlayerStatus.PLAYING) {
                playerRef.current?.pause();
            } else {
                playerRef.current?.setVolume(volume);
            }
            setIsTransitioning(false);
        }
    }, [finishMix, mediaAutoNext, volume]);

    const hasMixFx = useCallback(
        () =>
            Boolean(
                webAudio && autoMix.eqTransitions && deckFxRef.current[0] && deckFxRef.current[1],
            ),
        [autoMix.eqTransitions, webAudio],
    );

    const getAutoMixPlan = useCallback(
        (outgoing: 1 | 2, duration: number): MixPlan | null => {
            const outgoingAnalysis = outgoing === 1 ? analysis1 : analysis2;
            const incomingAnalysis = outgoing === 1 ? analysis2 : analysis1;
            if (!outgoingAnalysis || !incomingAnalysis) return null;
            return (
                planMix(outgoingAnalysis, incomingAnalysis, duration, speed, autoMix) ??
                (hasMixFx()
                    ? planEchoOut(outgoingAnalysis, incomingAnalysis, duration, speed)
                    : null)
            );
        },
        [analysis1, analysis2, autoMix, hasMixFx, speed],
    );

    const createMix = useCallback(
        (
            outgoing: 1 | 2,
            nextId: string | undefined,
            plan: MixPlan | null,
            fadeDuration: number,
        ): MixHandlers => ({
            djGains: hasMixFx(),
            fadeStart: mixRef.current?.fadeStart,
            nextId,
            onCancel: cancelMix,
            onError: (incoming) => {
                if (mixRef.current?.incoming === incoming) mediaPause();
            },
            onFinished: () => {
                // Progress ticks can run again before the store update re-renders.
                const state = usePlayerStoreBase.getState();
                if (!nextId || state.getCurrentSong()?._uniqueId === nextId) return;
                if (outgoing === 1) handleOnEndedPlayer1();
                else handleOnEndedPlayer2();
            },
            onPlaying: (incoming) => {
                if (mixRef.current?.incoming === incoming) {
                    incoming.playbackRate = mixRef.current.rate;
                }
            },
            onStarted: (incoming, fadeStart, rate, startedId) => {
                if (mixRef.current?.handedOff) cancelMix();
                mixRef.current = {
                    fadeStart,
                    handedOff: false,
                    incoming,
                    maxDrift: 0,
                    nextId: startedId,
                    outgoing,
                    rate,
                    seeks: 0,
                    style: plan?.style ?? null,
                };
                logAutoMixStart(
                    plan,
                    outgoing === 1 ? analysis1 : analysis2,
                    outgoing === 1 ? analysis2 : analysis1,
                    hasMixFx(),
                    fadeStart,
                );
                scheduleFx(outgoing, plan, fadeStart, fadeDuration);
            },
            onSync: (drift, seeked) => {
                const mix = mixRef.current;
                if (!mix) return;
                mix.maxDrift = Math.max(mix.maxDrift, Math.abs(drift));
                if (seeked) mix.seeks++;
            },
            plan,
            speed,
        }),
        [
            analysis1,
            analysis2,
            cancelMix,
            handleOnEndedPlayer1,
            handleOnEndedPlayer2,
            hasMixFx,
            mediaPause,
            scheduleFx,
            speed,
        ],
    );

    const handleProgress = useCallback(
        (playerNum: 1 | 2, e: PlayerOnProgressProps) => {
            const engine = playerRef.current;
            const currentPlayer = playerNum === 1 ? engine?.player1() : engine?.player2();
            const nextPlayer = playerNum === 1 ? engine?.player2() : engine?.player1();
            const nextSong = playerNum === 1 ? player2 : player1;
            if (!currentPlayer || !nextPlayer) {
                return;
            }

            if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
                return;
            }

            if (num === playerNum) {
                setTimestamp(e.playedSeconds);
            }

            const currentDuration = getDuration(currentPlayer.ref);
            if (repeat === PlayerRepeat.ONE) {
                handleRepeatOne(playerNum, e.playedSeconds, currentDuration);
                return;
            }
            if (transitionType === PlayerStyle.AUTO_MIX && skipAutoMixForTrackRef.current) return;

            switch (transitionType) {
                case PlayerStyle.AUTO_MIX:
                case PlayerStyle.CROSSFADE: {
                    const isMix = transitionType === PlayerStyle.AUTO_MIX;
                    const plan =
                        isMix && num === playerNum ? getAutoMixPlan(num, currentDuration) : null;
                    const fadeDuration = isMix
                        ? (plan?.fadeDuration ?? AUTO_MIX_FALLBACK_FADE_DURATION)
                        : crossfadeDuration;
                    crossfadeHandler({
                        crossfadeDuration: fadeDuration,
                        crossfadeStyle: isMix ? CrossfadeStyle.EQUAL_POWER : crossfadeStyle,
                        currentPlayer,
                        currentPlayerNum: num,
                        currentTime: e.playedSeconds,
                        duration: currentDuration,
                        hasNextSong: Boolean(nextSong),
                        isTransitioning,
                        mix: isMix
                            ? createMix(playerNum, nextSong?._uniqueId, plan, fadeDuration)
                            : undefined,
                        nextPlayer,
                        playerNum,
                        setIsTransitioning,
                        volume,
                    });
                    break;
                }
                case PlayerStyle.GAPLESS:
                    gaplessHandler({
                        currentTime: e.playedSeconds,
                        duration: currentDuration,
                        hasNextSong: Boolean(nextSong),
                        isFlac: false,
                        isTransitioning,
                        nextPlayer,
                        setIsTransitioning,
                    });
                    break;
            }
        },
        [
            createMix,
            crossfadeDuration,
            crossfadeStyle,
            getAutoMixPlan,
            handleRepeatOne,
            isTransitioning,
            num,
            player1,
            player2,
            repeat,
            setTimestamp,
            transitionType,
            volume,
        ],
    );

    const onProgressPlayer1 = useCallback(
        (e: PlayerOnProgressProps) => handleProgress(1, e),
        [handleProgress],
    );
    const onProgressPlayer2 = useCallback(
        (e: PlayerOnProgressProps) => handleProgress(2, e),
        [handleProgress],
    );

    const player = usePlayer();

    usePlayerEvents(
        {
            onCurrentSongChange: () => {
                skipAutoMixForTrackRef.current = false;
                if (!mixHandoffRef.current) cancelMix();
                setIsTransitioning(false);
            },
            onPlayerQueueChange: () => {
                if (!mixHandoffRef.current && mixRef.current && !mixRef.current.handedOff) {
                    const data = usePlayerStoreBase.getState().getPlayerData();
                    if (data.nextSong?._uniqueId !== mixRef.current.nextId) cancelMix();
                }
                if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
                    setIsTransitioning(false);
                }
            },
            onPlayerRepeat: () => {
                skipAutoMixForTrackRef.current = false;
                cancelMix();
            },
            onPlayerSeekToTimestamp: (properties) => {
                const timestamp = properties.timestamp;
                if (transitionType === PlayerStyle.AUTO_MIX) {
                    const currentDuration = getDuration(
                        num === 1
                            ? playerRef.current?.player1()?.ref
                            : playerRef.current?.player2()?.ref,
                    );
                    skipAutoMixForTrackRef.current = shouldSkipAutoMixAfterSeek(
                        timestamp,
                        currentDuration,
                        getAutoMixPlan(num, currentDuration),
                        AUTO_MIX_FALLBACK_FADE_DURATION,
                    );
                }

                cancelMix();
                setIsTransitioning(false);

                // Reset transition state if seeking during a crossfade transition
                if (isTransitioning && transitionType === PlayerStyle.CROSSFADE) {
                    setIsTransitioning(false);

                    if (num === 1) {
                        playerRef.current?.player1()?.setVolume(volume);
                        playerRef.current?.player2()?.setVolume(0);
                        playerRef.current?.player2()?.ref?.getInternalPlayer()?.pause();
                    } else {
                        playerRef.current?.player2()?.setVolume(volume);
                        playerRef.current?.player1()?.setVolume(0);
                        playerRef.current?.player1()?.ref?.getInternalPlayer()?.pause();
                    }
                }

                let type: 'fraction' | 'seconds' | undefined = undefined;

                if (timestamp < 1) {
                    type = 'seconds';
                }

                if (num === 1) {
                    playerRef.current?.player1()?.ref?.seekTo(timestamp, type);
                } else {
                    playerRef.current?.player2()?.ref?.seekTo(timestamp, type);
                }
            },
            onPlayerShuffle: () => cancelMix(),
            onPlayerSpeed: () => cancelMix(),
            onPlayerStatus: async (properties) => {
                if (properties.status !== PlayerStatus.PLAYING) cancelMix();
                setIsTransitioning(false);

                const status = properties.status;

                // Reset crossfade transition if paused/stopped during a crossfade transition
                if (
                    status !== PlayerStatus.PLAYING &&
                    isTransitioning &&
                    transitionType === PlayerStyle.CROSSFADE
                ) {
                    if (num === 1) {
                        playerRef.current?.player1()?.setVolume(volume);
                        playerRef.current?.player2()?.setVolume(0);
                        playerRef.current?.player2()?.ref?.getInternalPlayer()?.pause();
                    } else {
                        playerRef.current?.player2()?.setVolume(volume);
                        playerRef.current?.player1()?.setVolume(0);
                        playerRef.current?.player1()?.ref?.getInternalPlayer()?.pause();
                    }
                }

                if (audioFadeOnStatusChange) {
                    if (status === PlayerStatus.PLAYING) {
                        fadeAndSetStatus(0, volume, PLAY_PAUSE_FADE_DURATION, PlayerStatus.PLAYING);
                    } else {
                        fadeAndSetStatus(volume, 0, PLAY_PAUSE_FADE_DURATION, status);
                    }
                } else {
                    if (status === PlayerStatus.PLAYING) {
                        playerRef.current?.setVolume(volume);
                        setLocalPlayerStatus(PlayerStatus.PLAYING);
                    } else {
                        playerRef.current?.setVolume(volume);
                        setLocalPlayerStatus(status);
                    }
                }
            },
            onPlayerVolume: (properties) => {
                const volume = properties.volume;
                playerRef.current?.setVolume(volume);
            },
            onQueueCleared: () => {
                player.mediaStop();
            },
        },
        [
            audioFadeOnStatusChange,
            cancelMix,
            getAutoMixPlan,
            isTransitioning,
            num,
            transitionType,
            volume,
        ],
    );

    // Cleanup fade interval on unmount
    useEffect(() => {
        return () => {
            cancelMix();
            if (fadeIntervalRef.current) {
                clearInterval(fadeIntervalRef.current);
                fadeIntervalRef.current = null;
            }
        };
    }, [cancelMix]);

    useEffect(() => {
        if (transitionType !== PlayerStyle.AUTO_MIX) {
            skipAutoMixForTrackRef.current = false;
            cancelMix();
        }
    }, [cancelMix, transitionType]);

    useEffect(() => {
        if (status !== PlayerStatus.PLAYING) {
            return;
        }

        const interval = setInterval(() => {
            const activePlayer =
                num === 1 ? playerRef.current?.player1() : playerRef.current?.player2();
            const internalPlayer =
                activePlayer?.ref?.getInternalPlayer() as HTMLAudioElement | null;

            if (!internalPlayer) {
                return;
            }

            const currentTime = internalPlayer.currentTime;

            if (
                transitionType === PlayerStyle.CROSSFADE ||
                transitionType === PlayerStyle.AUTO_MIX ||
                transitionType === PlayerStyle.GAPLESS
            ) {
                setTimestamp(currentTime);
            }
        }, 500);

        return () => clearInterval(interval);
    }, [status, num, setTimestamp, transitionType]);

    useEffect(() => {
        if (status !== PlayerStatus.PLAYING || localPlayerStatus === PlayerStatus.PLAYING) {
            return;
        }
        if (fadeIntervalRef.current) {
            clearInterval(fadeIntervalRef.current);
            fadeIntervalRef.current = null;
        }
        playerRef.current?.setVolume(volume);
        setLocalPlayerStatus(PlayerStatus.PLAYING);
    }, [status, localPlayerStatus, volume]);

    const calculateReplayGain = useCallback(
        (song: QueueSong): number => {
            if (playback.replayGainMode === 'no') {
                return 1;
            }

            let gain: number | undefined;
            let peak: number | undefined;

            if (playback.replayGainMode === 'track') {
                gain = song.gain?.track ?? song.gain?.album;
                peak = song.peak?.track ?? song.peak?.album;
            } else {
                gain = song.gain?.album ?? song.gain?.track;
                peak = song.peak?.album ?? song.peak?.track;
            }

            if (gain === undefined) {
                gain = playback.replayGainFallbackDB;

                if (!gain) {
                    return 1;
                }
            }

            if (peak === undefined) {
                peak = 1;
            }

            const preAmp = playback.replayGainPreampDB ?? 0;

            // https://wiki.hydrogenaud.io/index.php?title=ReplayGain_1.0_specification&section=19
            // Normalized to max gain
            let expectedGain = 10 ** ((gain + preAmp) / 20);

            // Nothing in the system should allow this. But, in the case that preAmp is a
            // bad value (not a number, for example), a NaN gain will cause the entire system to panic
            if (isNaN(expectedGain)) {
                expectedGain = 1;
            }

            if (playback.replayGainClip) {
                return Math.min(expectedGain, 1 / peak);
            }
            return expectedGain;
        },
        [
            playback.replayGainClip,
            playback.replayGainFallbackDB,
            playback.replayGainMode,
            playback.replayGainPreampDB,
        ],
    );

    useEffect(() => {
        if (!webAudio || !player1 || !player1Source) return;

        const newGain = calculateReplayGain(player1);

        // Apply per player slot whenever its song/source is ready so pre-started
        // inactive players have correct gain before gapless/crossfade transitions.
        try {
            webAudio.gains[0].gain.setValueAtTime(
                Math.max(0, newGain),
                webAudio.context.currentTime,
            );
        } catch (error) {
            console.error('Error setting gain', error);
        }
    }, [calculateReplayGain, player1, player1Source, webAudio]);

    useEffect(() => {
        if (!webAudio || !player2 || !player2Source) return;

        const newGain = calculateReplayGain(player2);

        try {
            webAudio.gains[1].gain.setValueAtTime(
                Math.max(0, newGain),
                webAudio.context.currentTime,
            );
        } catch (error) {
            console.error('Error setting gain', error);
        }
    }, [calculateReplayGain, player2, player2Source, webAudio]);

    const applyPendingSeekIfNeeded = useCallback(
        (reactPlayer: ReactPlayer, activeSlot: 1 | 2) => {
            if (pendingLocalSeekRef.current <= 0) return;
            if (activeSlot !== num) return;
            const seekTo = pendingLocalSeekRef.current;
            pendingLocalSeekRef.current = -1;
            reactPlayer.seekTo(seekTo, 'seconds');
            if (status === PlayerStatus.PLAYING) {
                playerRef.current?.setVolume(volume);
                setLocalPlayerStatus(PlayerStatus.PLAYING);
            }
        },
        [num, status, volume],
    );

    const handlePlayer1Start = useCallback(
        async (reactPlayer: ReactPlayer) => {
            applyPendingSeekIfNeeded(reactPlayer, 1);
            if (!webAudio || player1Source) return;
            if (player1Url) {
                // This should fire once, only if the source is real (meaning we
                // saw the dummy source) and the context is not ready
                if (webAudio.context.state !== 'running') {
                    await webAudio.context.resume();
                }
            }

            const internal = reactPlayer.getInternalPlayer() as HTMLMediaElement | undefined;
            if (internal) {
                const { context, gains } = webAudio;
                const source = context.createMediaElementSource(internal);
                deckFxRef.current[0] = createDeckFx(context);
                connectDeckFx(source, deckFxRef.current[0], gains[0]);
                setPlayer1Source(source);
            }
        },
        [applyPendingSeekIfNeeded, player1Source, player1Url, webAudio],
    );

    const handlePlayer2Start = useCallback(
        async (reactPlayer: ReactPlayer) => {
            applyPendingSeekIfNeeded(reactPlayer, 2);
            if (!webAudio || player2Source) return;
            if (player2Url) {
                if (webAudio.context.state !== 'running') {
                    await webAudio.context.resume();
                }
            }

            const internal = reactPlayer.getInternalPlayer() as HTMLMediaElement | undefined;
            if (internal) {
                const { context, gains } = webAudio;
                const source = context.createMediaElementSource(internal);
                deckFxRef.current[1] = createDeckFx(context);
                connectDeckFx(source, deckFxRef.current[1], gains[1]);
                setPlayer2Source(source);
            }
        },
        [applyPendingSeekIfNeeded, player2Source, player2Url, webAudio],
    );

    const handleOnErrorPause = useCallback(() => {
        mediaPause();
        toast.error({
            message: t('error.playbackPausedDueToError'),
        });
    }, [mediaPause, t]);

    const loopPlayer1 = repeat === PlayerRepeat.ONE && num === 1;
    const loopPlayer2 = repeat === PlayerRepeat.ONE && num === 2;

    return (
        <WebPlayerEngine
            isMuted={isMuted}
            isTransitioning={Boolean(isTransitioning)}
            loopPlayer1={loopPlayer1}
            loopPlayer2={loopPlayer2}
            mixMode={mixEnabled}
            onEndedPlayer1={handleOnEndedPlayer1}
            onEndedPlayer2={handleOnEndedPlayer2}
            onErrorPause={handleOnErrorPause}
            onProgressPlayer1={onProgressPlayer1}
            onProgressPlayer2={onProgressPlayer2}
            onStartedPlayer1={handlePlayer1Start}
            onStartedPlayer2={handlePlayer2Start}
            playerNum={num}
            playerRef={playerRef}
            playerStatus={localPlayerStatus}
            preservesPitch={preservePitch}
            speed={speed}
            src1={player1Url}
            src2={player2Url}
            volume={volume}
        />
    );
}

function crossfadeHandler(args: {
    crossfadeDuration: number;
    crossfadeStyle: CrossfadeStyle;
    currentPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    currentPlayerNum: number;
    currentTime: number;
    duration: number;
    hasNextSong: boolean;
    isTransitioning: boolean | string;
    mix?: MixHandlers;
    nextPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    playerNum: number;
    setIsTransitioning: Dispatch<boolean | string>;
    volume: number;
}) {
    const {
        crossfadeDuration,
        crossfadeStyle,
        currentPlayer,
        currentPlayerNum,
        currentTime,
        duration,
        hasNextSong,
        isTransitioning,
        mix,
        nextPlayer,
        playerNum,
        setIsTransitioning,
        volume,
    } = args;
    const player = `player${playerNum}`;

    if (mix && currentPlayerNum !== playerNum) return;
    if (mix && usePlayerStoreBase.getState().player.pauseOnNextSongEnd) {
        mix.onCancel();
        return;
    }

    if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
        if (isTransitioning) {
            setIsTransitioning(false);
        }
        return;
    }

    // If there is no next song to transition to, ensure we don't enter or stay in a transition
    if (!hasNextSong) {
        currentPlayer.setVolume(volume);
        nextPlayer.setVolume(0);
        nextPlayer.ref?.getInternalPlayer()?.pause();

        if (isTransitioning) {
            setIsTransitioning(false);
        }

        return;
    }

    if (!isTransitioning) {
        const start = mix?.plan?.start ?? duration - crossfadeDuration;
        if (duration > 0 && currentTime >= start) {
            // Skip pre-starting next player if pauseOnNextSongEnd is set
            if (usePlayerStoreBase.getState().player.pauseOnNextSongEnd) {
                return;
            }

            const incoming = nextPlayer.ref?.getInternalPlayer() as HTMLMediaElement | undefined;
            if (mix) {
                if (
                    mix.fadeStart !== undefined ||
                    !incoming ||
                    !mix.nextId ||
                    incoming.readyState < 3
                )
                    return;
                const plan = mix.plan;
                const rate = plan ? plan.rate : mix.speed;
                incoming.playbackRate = rate;
                if (incoming.readyState > 0) {
                    try {
                        // Start in phase even when the start was a few ticks late.
                        incoming.currentTime = plan
                            ? plan.incomingStart + ((currentTime - start) * rate) / mix.speed
                            : 0;
                    } catch (error) {
                        logger.warn('Auto mix could not seek the next track', { error });
                        incoming.playbackRate = mix.speed;
                    }
                }
                incoming.volume = 0;
                mix.onStarted(incoming, currentTime, incoming.playbackRate, mix.nextId);
            }
            nextPlayer.setVolume(0);
            const play = incoming?.play();
            if (mix && play && incoming) {
                play.then(() => mix.onPlaying(incoming)).catch((error: unknown) => {
                    logger.error('Auto mix could not start the next track', {
                        error: error instanceof Error ? error.message : 'Unknown error',
                    });
                    mix.onError(incoming);
                });
            }
            return setIsTransitioning(player);
        }

        return;
    }

    if (isTransitioning !== player && currentPlayerNum !== playerNum) {
        return;
    }

    const plan = mix?.plan;
    if (mix && plan) {
        if (currentTime >= plan.fadeEnd && plan.fadeEnd < duration - 0.25) {
            mix.onFinished();
            return;
        }
        const incoming = nextPlayer.ref?.getInternalPlayer() as HTMLMediaElement | undefined;
        if (plan.style === 'blend' && mix.fadeStart !== undefined && incoming) {
            const sync = syncIncoming(incoming, plan, currentTime, mix.speed);
            if (sync) mix.onSync(sync.drift, sync.seeked);
        }
        if (mix.djGains) {
            const gains = mixGains(plan, currentTime);
            currentPlayer.setVolume(gains.outgoing * volume);
            nextPlayer.setVolume(gains.incoming * volume);
            return;
        }
    }

    const fadeEnd = plan?.fadeEnd ?? duration;
    const timeLeft = fadeEnd - currentTime;
    const fadeDuration = mix?.fadeStart === undefined ? crossfadeDuration : fadeEnd - mix.fadeStart;
    const progress = (fadeDuration - timeLeft) / fadeDuration;

    const { easeIn, easeOut } = getCrossfadeEasing(crossfadeStyle);

    const easedProgressOut = easeOut(progress);
    const easedProgressIn = easeIn(progress);

    const currentPlayerVolume = (1 - easedProgressOut) * volume;
    const nextPlayerVolume = easedProgressIn * volume;

    // Set volumes for both players
    currentPlayer.setVolume(currentPlayerVolume);
    nextPlayer.setVolume(nextPlayerVolume);
}

/**
 * Equal power easing - maintains constant power during crossfade
 * Fade in: sin(π/2 * t)
 * Fade out: 1 - cos(π/2 * t) so that (1 - result) = cos(π/2 * t)
 */
function equalPowerEaseIn(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    return Math.sin((Math.PI / 2) * clampedT);
}

function equalPowerEaseOut(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    return 1 - Math.cos((Math.PI / 2) * clampedT);
}

/**
 * Exponential easing - natural exponential decay/rise
 * Fade in: 1 - exp(-k * t) where k controls the curve steepness
 * Fade out: exp(-k * t) normalized to go from 1 to 0
 */
function exponentialEaseIn(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    const k = 5;
    return 1 - Math.exp(-k * clampedT);
}

function exponentialEaseOut(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    const k = 5;
    // Exponential decay: exp(-k * t) goes from 1 (at t=0) to exp(-k) (at t=1)
    // Normalize to go from 1 to 0
    const startValue = Math.exp(0); // = 1
    const endValue = Math.exp(-k);
    return (Math.exp(-k * clampedT) - endValue) / (startValue - endValue);
}

function gaplessHandler(args: {
    currentTime: number;
    duration: number;
    hasNextSong: boolean;
    isFlac: boolean;
    isTransitioning: boolean | string;
    nextPlayer: {
        ref: null | ReactPlayer;
        setVolume: (volume: number) => void;
    };
    setIsTransitioning: Dispatch<boolean | string>;
}) {
    const {
        currentTime,
        duration,
        hasNextSong,
        isFlac,
        isTransitioning,
        nextPlayer,
        setIsTransitioning,
    } = args;

    if (usePlayerStoreBase.getState().player.status !== PlayerStatus.PLAYING) {
        if (isTransitioning) {
            setIsTransitioning(false);
        }
        return null;
    }

    if (!hasNextSong) {
        nextPlayer.ref?.getInternalPlayer()?.pause();
        if (isTransitioning) setIsTransitioning(false);
        return null;
    }

    // Ignore invalid durations (e.g. during URL load or empty source placeholder)
    if (!Number.isFinite(duration) || duration < 2) {
        if (isTransitioning) {
            setIsTransitioning(false);
        }
        return null;
    }

    if (!isTransitioning) {
        if (currentTime > duration - 2) {
            return setIsTransitioning(true);
        }

        return null;
    }

    const durationPadding = getDurationPadding(isFlac);

    if (currentTime + durationPadding >= duration) {
        // Skip pre-starting next player if pauseOnNextSongEnd is set
        if (usePlayerStoreBase.getState().player.pauseOnNextSongEnd) {
            return null;
        }

        return nextPlayer.ref
            ?.getInternalPlayer()
            ?.play()
            .catch(() => {});
    }

    return null;
}

function getCrossfadeEasing(style: CrossfadeStyle): {
    easeIn: (t: number) => number;
    easeOut: (t: number) => number;
} {
    switch (style) {
        case CrossfadeStyle.EQUAL_POWER:
            return {
                easeIn: equalPowerEaseIn,
                easeOut: equalPowerEaseOut,
            };
        case CrossfadeStyle.EXPONENTIAL:
            return {
                easeIn: exponentialEaseIn,
                easeOut: exponentialEaseOut,
            };
        case CrossfadeStyle.LINEAR:
            return {
                easeIn: linearEase,
                easeOut: linearEase,
            };
        case CrossfadeStyle.S_CURVE:
            return {
                easeIn: sCurveEase,
                easeOut: sCurveEase,
            };
        // Default to equal power for other styles
        default:
            return {
                easeIn: equalPowerEaseIn,
                easeOut: equalPowerEaseOut,
            };
    }
}

function getDuration(ref: null | ReactPlayer | undefined) {
    return ref?.getInternalPlayer()?.duration || 0;
}

function getDurationPadding(isFlac: boolean) {
    switch (isFlac) {
        case false:
            return 0.116;
        case true:
            return 0.065;
    }
}

/**
 * Linear easing - simple linear interpolation
 */
function linearEase(t: number): number {
    return Math.max(0, Math.min(1, t));
}

/** One line per transition: which kind was chosen, where, and why. */
function logAutoMixStart(
    plan: MixPlan | null,
    outgoing: null | TrackAnalysis,
    incoming: null | TrackAnalysis,
    hasFx: boolean,
    at: number,
) {
    const tracks = {
        incomingBpm: incoming ? round2(incoming.start.bpm) : undefined,
        incomingKey: incoming?.key?.camelot,
        outgoingBpm: outgoing ? round2(outgoing.end.bpm) : undefined,
        outgoingKey: outgoing?.key?.camelot,
    };
    if (!plan) {
        const reason =
            !outgoing || !incoming
                ? `missing analysis (${!outgoing ? 'outgoing' : 'incoming'})`
                : hasFx
                  ? 'no beat-matched blend or echo-out fits'
                  : 'tempos not matchable and echo-out needs web audio EQ';
        logger.info('Auto mix transition: crossfade fallback', {
            at: round2(at),
            reason,
            ...tracks,
        });
        return;
    }
    logger.info(`Auto mix transition: ${plan.style}`, {
        bars: plan.bars,
        bassSwapAt: round2(plan.bassSwapAt),
        cutBeforeOutro: outgoing ? round2(outgoing.outroStart - plan.fadeEnd) : undefined,
        fadeEnd: round2(plan.fadeEnd),
        incomingStart: round2(plan.incomingStart),
        rate: round2(plan.rate),
        start: round2(plan.start),
        ...tracks,
    });
}

function round2(value: number) {
    return Math.round(value * 100) / 100;
}

/**
 * S-Curve easing (smoothstep) - smooth S-shaped curve
 * Uses smoothstep function: t²(3 - 2t)
 */
function sCurveEase(t: number): number {
    const clampedT = Math.max(0, Math.min(1, t));
    return clampedT * clampedT * (3 - 2 * clampedT);
}

/** Keeps the incoming deck on the outgoing beat grid during a blend. */
function syncIncoming(
    incoming: HTMLMediaElement,
    plan: MixPlan,
    currentTime: number,
    speed: number,
): null | { drift: number; seeked: boolean } {
    if (incoming.paused || incoming.seeking || currentTime < plan.start) return null;
    const expected = plan.incomingStart + ((currentTime - plan.start) * plan.rate) / speed;
    const drift = incoming.currentTime - expected;
    const rate = syncPlaybackRate(drift, plan.rate);
    try {
        if (rate === null) {
            incoming.currentTime = expected;
        } else if (Math.abs(incoming.playbackRate - rate) > 1e-4) {
            incoming.playbackRate = rate;
        }
    } catch (error) {
        logger.warn('Auto mix could not sync the next track', { error });
    }
    return { drift, seeked: rate === null };
}
