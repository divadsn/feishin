import isElectron from 'is-electron';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { clearAnalysisCache } from '/@/renderer/features/player/audio-player/utils/auto-mix-analyzer';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    getDefaultAudioDevice,
    useAudioDevices,
} from '/@/renderer/features/settings/components/playback/audio-settings';
import {
    ListConfigBooleanControl,
    ListConfigTable,
} from '/@/renderer/features/shared/components/list-config-menu';
import {
    usePlaybackType,
    usePlayerActions,
    usePlayerProperties,
    usePlayerSongProperties,
    usePlayerSpeed,
    usePlayerStatus,
    usePlayerStoreBase,
} from '/@/renderer/store';
import {
    AutoMixSettings,
    useAutoMixSettings,
    useCombinedLyricsAndVisualizer,
    useMicrotonalPitchControls,
    usePlaybackSettings,
    useSettingsStore,
    useSettingsStoreActions,
    useShowLyricsInSidebar,
    useShowQueueInSidebar,
    useShowVisualizerInSidebar,
} from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Paper } from '/@/shared/components/paper/paper';
import { Popover } from '/@/shared/components/popover/popover';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Select } from '/@/shared/components/select/select';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { Switch } from '/@/shared/components/switch/switch';
import { Text } from '/@/shared/components/text/text';
import { toast } from '/@/shared/components/toast/toast';
import { CrossfadeStyle, PlayerStatus, PlayerStyle, PlayerType } from '/@/shared/types/types';

const ipc = isElectron() ? window.api.ipc : null;

export const PlayerConfig = () => {
    const { t } = useTranslation();
    const preservePitch = useSettingsStore((state) => state.playback.preservePitch);
    const showLyricsInSidebar = useShowLyricsInSidebar();
    const showQueueInSidebar = useShowQueueInSidebar();
    const showVisualizerInSidebar = useShowVisualizerInSidebar();
    const combinedLyricsAndVisualizer = useCombinedLyricsAndVisualizer();
    const { transitionType } = usePlayerProperties();

    const playbackSettings = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();

    const setPreservePitch = useCallback(
        (value: boolean) => {
            setSettings({
                playback: { ...playbackSettings, preservePitch: value },
            });
        },
        [playbackSettings, setSettings],
    );

    const audioOptions = useMemo(
        () => [
            {
                component: <AudioPlayerTypeConfig />,
                id: 'audioPlayerType',
                label: t('setting.audioPlayer'),
            },
            {
                component: <AudioDeviceConfig />,
                id: 'audioDevice',
                label: t('setting.audioDevice'),
            },
        ],
        [t],
    );

    const transitionOptions = useMemo(
        () => [
            {
                component: <TransitionTypeConfig />,
                id: 'transitionType',
                label: t('setting.playbackStyle'),
            },
            {
                component: <CrossfadeStyleConfig />,
                id: 'crossfadeStyle',
                isHidden: transitionType !== PlayerStyle.CROSSFADE,
                label: t('setting.crossfadeStyle'),
            },
            {
                component: <CrossfadeDurationConfig />,
                id: 'crossfadeDuration',
                isHidden: transitionType !== PlayerStyle.CROSSFADE,
                label: t('setting.crossfadeDuration'),
            },
            ...AUTO_MIX_OPTIONS.map(({ component: Component, id }) => ({
                component: <Component />,
                id,
                isHidden: transitionType !== PlayerStyle.AUTO_MIX,
                label: t(`setting.${id}`),
            })),
        ],
        [t, transitionType],
    );

    const playbackOptions = useMemo(
        () => [
            {
                component: <PlaybackSpeedSlider />,
                id: 'playbackSpeed',
                label: t('player.playbackSpeed'),
            },
            {
                component: <PitchControls />,
                id: 'pitchControls',
                isHidden: preservePitch,
                label: '',
            },
            {
                component: (
                    <ListConfigBooleanControl onChange={setPreservePitch} value={preservePitch} />
                ),
                id: 'preservePitch',
                label: t('setting.preservePitch'),
            },
        ],
        [preservePitch, setPreservePitch, t],
    );

    const sidebarOptions = useMemo(
        () => [
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    showQueueInSidebar: value,
                                },
                            });
                        }}
                        value={showQueueInSidebar}
                    />
                ),
                id: 'showQueueInSidebar',
                label: t('setting.showQueueInSidebar'),
            },
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    showLyricsInSidebar: value,
                                },
                            });
                        }}
                        value={showLyricsInSidebar}
                    />
                ),
                id: 'showLyricsInSidebar',
                label: t('setting.showLyricsInSidebar'),
            },
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    showVisualizerInSidebar: value,
                                },
                            });
                        }}
                        value={showVisualizerInSidebar}
                    />
                ),
                id: 'showVisualizerInSidebar',
                label: t('setting.showVisualizerInSidebar'),
            },
            {
                component: (
                    <ListConfigBooleanControl
                        onChange={(value) => {
                            setSettings({
                                general: {
                                    combinedLyricsAndVisualizer: value,
                                },
                            });
                        }}
                        value={combinedLyricsAndVisualizer}
                    />
                ),
                id: 'combinedLyricsAndVisualizer',
                label: t('setting.combinedLyricsAndVisualizer'),
            },
        ],
        [
            combinedLyricsAndVisualizer,
            setSettings,
            showLyricsInSidebar,
            showQueueInSidebar,
            showVisualizerInSidebar,
            t,
        ],
    );

    return (
        <Popover position="top" withArrow>
            <Popover.Target>
                <ActionIcon
                    icon="mediaSettings"
                    iconProps={{
                        size: 'lg',
                    }}
                    size="sm"
                    stopsPropagation
                    tooltip={{
                        label: t('common.setting', { count: 2 }),
                        openDelay: 0,
                    }}
                    variant="subtle"
                />
            </Popover.Target>
            <Popover.Dropdown maw={720} miw={540} onClick={(e) => e.stopPropagation()} p="sm">
                <Stack gap="sm">
                    <Paper p="md" radius="md">
                        <ListConfigTable options={audioOptions} />
                    </Paper>
                    <Paper p="md" radius="md">
                        <ListConfigTable options={transitionOptions} />
                    </Paper>
                    <Paper p="md" radius="md">
                        <ListConfigTable options={playbackOptions} />
                    </Paper>
                    <Paper p="md" radius="md">
                        <ListConfigTable options={sidebarOptions} />
                    </Paper>
                </Stack>
            </Popover.Dropdown>
        </Popover>
    );
};

const AudioPlayerTypeConfig = () => {
    const { t } = useTranslation();
    const status = usePlayerStatus();
    const playbackSettings = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();
    const { mediaStop } = usePlayer();

    const showRefreshButton = playbackSettings.type === PlayerType.LOCAL;

    const isCasting = playbackSettings.type === PlayerType.DLNA;

    return (
        <Group gap="xs" wrap="nowrap">
            <Select
                comboboxProps={{ withinPortal: false }}
                data={[
                    {
                        disabled: !isElectron(),
                        label: 'MPV',
                        value: PlayerType.LOCAL,
                    },
                    { label: 'Web', value: PlayerType.WEB },
                    { label: 'Jukebox', value: PlayerType.JUKEBOX },
                    ...(isCasting
                        ? [{ disabled: true, label: 'DLNA', value: PlayerType.DLNA }]
                        : []),
                ]}
                defaultValue={playbackSettings.type}
                disabled={status === PlayerStatus.PLAYING || isCasting}
                onChange={(e) => {
                    setSettings({
                        playback: { ...playbackSettings, type: e as PlayerType },
                    });
                    ipc?.send('settings-set', {
                        property: 'playbackType',
                        value: e,
                    });
                }}
                variant="filled"
                width="100%"
            />
            {showRefreshButton && (
                <ActionIcon
                    icon="refresh"
                    iconProps={{ size: 'md' }}
                    onClick={() => {
                        mediaStop();
                        eventEmitter.emit('MPV_RELOAD', {});
                    }}
                    tooltip={{ label: t('common.reload') }}
                    variant="transparent"
                />
            )}
        </Group>
    );
};

const AudioDeviceConfig = () => {
    const status = usePlayerStatus();
    const playbackType = usePlaybackType();
    const playbackSettings = usePlaybackSettings();
    const { setSettings } = useSettingsStoreActions();

    const audioDevices = useAudioDevices(playbackType);
    const audioDeviceId =
        playbackType === PlayerType.LOCAL
            ? playbackSettings.mpvAudioDeviceId
            : playbackSettings.audioDeviceId;

    return (
        <Select
            comboboxProps={{ withinPortal: false }}
            data={audioDevices}
            disabled={status === PlayerStatus.PLAYING}
            key={playbackType}
            onChange={(e) => {
                setSettings({
                    playback: {
                        ...playbackSettings,
                        ...(playbackType === PlayerType.LOCAL
                            ? { mpvAudioDeviceId: e }
                            : { audioDeviceId: e }),
                    },
                });
            }}
            value={audioDeviceId ?? getDefaultAudioDevice(audioDevices, playbackType)}
            variant="filled"
            width="100%"
        />
    );
};

const TransitionTypeConfig = () => {
    const { t } = useTranslation();
    const status = usePlayerStatus();
    const playbackSettings = usePlaybackSettings();
    const { transitionType } = usePlayerProperties();
    const { setTransitionType } = usePlayerActions();

    return (
        <SegmentedControl
            data={[
                {
                    label: t('setting.playbackStyle', {
                        context: 'optionNormal',
                    }),
                    value: PlayerStyle.GAPLESS,
                },
                {
                    label: t('setting.playbackStyle', {
                        context: 'optionCrossFade',
                    }),
                    value: PlayerStyle.CROSSFADE,
                },
                {
                    label: t('setting.playbackStyle', {
                        context: 'optionAutoMix',
                    }),
                    value: PlayerStyle.AUTO_MIX,
                },
            ]}
            disabled={playbackSettings.type !== PlayerType.WEB || status === PlayerStatus.PLAYING}
            onChange={(value) => setTransitionType(value as PlayerStyle)}
            size="sm"
            value={transitionType}
            w="100%"
        />
    );
};

const CrossfadeStyleConfig = () => {
    const status = usePlayerStatus();
    const playbackSettings = usePlaybackSettings();
    const { crossfadeStyle, transitionType } = usePlayerProperties();
    const { setCrossfadeStyle } = usePlayerActions();

    return (
        <Select
            comboboxProps={{ withinPortal: false }}
            data={[
                { label: 'Linear', value: CrossfadeStyle.LINEAR },
                { label: 'Equal Power', value: CrossfadeStyle.EQUAL_POWER },
                { label: 'S-Curve', value: CrossfadeStyle.S_CURVE },
                { label: 'Exponential', value: CrossfadeStyle.EXPONENTIAL },
            ]}
            defaultValue={crossfadeStyle}
            disabled={
                playbackSettings.type !== PlayerType.WEB ||
                transitionType !== PlayerStyle.CROSSFADE ||
                status === PlayerStatus.PLAYING
            }
            onChange={(e) => {
                if (e) {
                    setCrossfadeStyle(e as CrossfadeStyle);
                }
            }}
            variant="filled"
            width="100%"
        />
    );
};

const useSetAutoMix = () => {
    const { setSettings } = useSettingsStoreActions();
    return useCallback(
        <K extends keyof AutoMixSettings>(key: K, value: AutoMixSettings[K]) => {
            const { playback } = useSettingsStore.getState();
            setSettings({
                playback: { ...playback, autoMix: { ...playback.autoMix, [key]: value } },
            });
            if (key !== 'eqTransitions' && key !== 'lookahead') {
                usePlayerStoreBase.getState().reorderUpcomingForAutoMix();
            }
        },
        [setSettings],
    );
};

const AutoMixSwitch = ({ setting }: { setting: 'harmonicMixing' | 'reorderQueue' }) => {
    const value = useAutoMixSettings()[setting];
    const setAutoMix = useSetAutoMix();
    return <ListConfigBooleanControl onChange={(v) => setAutoMix(setting, v)} value={value} />;
};

const AutoMixEqConfig = () => {
    const { t } = useTranslation();
    const { autoMix, webAudio } = usePlaybackSettings();
    const setAutoMix = useSetAutoMix();
    return (
        <Group justify="flex-end" w="100%">
            {!webAudio && (
                <Text isMuted size="xs">
                    {t('setting.autoMixEqTransitions_requiresWebAudio')}
                </Text>
            )}
            <Switch
                checked={webAudio && autoMix.eqTransitions}
                disabled={!webAudio}
                onChange={(e) => setAutoMix('eqTransitions', e.currentTarget.checked)}
            />
        </Group>
    );
};

const AutoMixEnergyFlowConfig = () => {
    const { t } = useTranslation();
    const { energyFlow } = useAutoMixSettings();
    const setAutoMix = useSetAutoMix();
    return (
        <Select
            comboboxProps={{ withinPortal: false }}
            data={[
                { label: t('setting.autoMixEnergyFlow_optionAuto'), value: 'auto' },
                { label: t('setting.autoMixEnergyFlow_optionSteady'), value: 'steady' },
                { label: t('setting.autoMixEnergyFlow_optionBuild'), value: 'build' },
                { label: t('setting.autoMixEnergyFlow_optionFree'), value: 'free' },
            ]}
            onChange={(value) => {
                if (value) setAutoMix('energyFlow', value as AutoMixSettings['energyFlow']);
            }}
            value={energyFlow}
            variant="filled"
            width="100%"
        />
    );
};

const AutoMixBlendLengthConfig = () => {
    const { t } = useTranslation();
    const { blendLength } = useAutoMixSettings();
    const setAutoMix = useSetAutoMix();
    return (
        <Select
            comboboxProps={{ withinPortal: false }}
            data={[
                { label: t('setting.autoMixBlendLength_optionAuto'), value: 'auto' },
                ...[4, 8, 16, 32].map((bars) => ({
                    label: t('setting.autoMixBlendLength_optionBars', { count: bars }),
                    value: String(bars),
                })),
            ]}
            onChange={(value) => {
                if (value) setAutoMix('blendLength', value === 'auto' ? 'auto' : Number(value));
            }}
            value={String(blendLength)}
            variant="filled"
            width="100%"
        />
    );
};

const AutoMixTempoConfig = () => {
    const { maxTempoAdjust } = useAutoMixSettings();
    const setAutoMix = useSetAutoMix();
    return (
        <Slider
            defaultValue={maxTempoAdjust}
            label={(value) => `±${value}%`}
            marks={[0, 4, 8, 12].map((value) => ({ label: `${value}%`, value }))}
            max={12}
            min={0}
            onChangeEnd={(value) => setAutoMix('maxTempoAdjust', value)}
            w="100%"
        />
    );
};

const AutoMixLookaheadConfig = () => {
    const { lookahead, reorderQueue } = useAutoMixSettings();
    const setAutoMix = useSetAutoMix();
    return (
        <Slider
            defaultValue={lookahead}
            disabled={!reorderQueue}
            marks={[4, 8, 12, 16, 20].map((value) => ({ label: String(value), value }))}
            max={20}
            min={4}
            onChangeEnd={(value) => setAutoMix('lookahead', value)}
            w="100%"
        />
    );
};

const AutoMixCacheConfig = () => {
    const { t } = useTranslation();
    return (
        <Group justify="flex-end" w="100%">
            <Button
                onClick={async () => {
                    try {
                        await clearAnalysisCache();
                        toast.success({ message: t('setting.clearCacheSuccess') });
                    } catch (error) {
                        toast.error({ message: (error as Error).message });
                    }
                }}
                size="compact-sm"
                variant="default"
            >
                {t('setting.autoMixClearCache_button')}
            </Button>
        </Group>
    );
};

const AUTO_MIX_OPTIONS = [
    { component: () => <AutoMixSwitch setting="reorderQueue" />, id: 'autoMixReorderQueue' },
    { component: () => <AutoMixSwitch setting="harmonicMixing" />, id: 'autoMixHarmonicMixing' },
    { component: AutoMixEnergyFlowConfig, id: 'autoMixEnergyFlow' },
    { component: AutoMixBlendLengthConfig, id: 'autoMixBlendLength' },
    { component: AutoMixTempoConfig, id: 'autoMixMaxTempoAdjust' },
    { component: AutoMixEqConfig, id: 'autoMixEqTransitions' },
    { component: AutoMixLookaheadConfig, id: 'autoMixLookahead' },
    { component: AutoMixCacheConfig, id: 'autoMixClearCache' },
];

const CrossfadeDurationConfig = () => {
    const status = usePlayerStatus();
    const playbackSettings = usePlaybackSettings();
    const { crossfadeDuration, transitionType } = usePlayerProperties();
    const { setCrossfadeDuration } = usePlayerActions();

    return (
        <Slider
            defaultValue={crossfadeDuration}
            disabled={
                playbackSettings.type !== PlayerType.WEB ||
                transitionType !== PlayerStyle.CROSSFADE ||
                status === PlayerStatus.PLAYING
            }
            marks={[
                { label: '3', value: 3 },
                { label: '6', value: 6 },
                { label: '9', value: 9 },
                { label: '12', value: 12 },
                { label: '15', value: 15 },
                { label: '18', value: 18 },
                { label: '21', value: 21 },
            ]}
            max={21}
            min={3}
            onChangeEnd={setCrossfadeDuration}
            styles={{
                root: {},
            }}
            w="100%"
        />
    );
};

export const PlaybackSpeedSlider = () => {
    const speed = usePlayerSpeed();
    const { setSpeed } = usePlayerActions();
    const { bpm } = usePlayerSongProperties(['bpm']) ?? {};

    const formatPlaybackSpeedSliderLabel = useMemo(
        () => (value: number) => {
            const bpmValue = Number(bpm);
            if (bpmValue > 0) {
                return `${value.toFixed(2)} x / ${(bpmValue * value).toFixed(1)} BPM`;
            }
            return `${value.toFixed(2)} x`;
        },
        [bpm],
    );

    return (
        <Slider
            label={formatPlaybackSpeedSliderLabel}
            marks={[
                { label: '0.5', value: 0.5 },
                { label: '0.75', value: 0.75 },
                { label: '1', value: 1 },
                { label: '1.25', value: 1.25 },
                { label: '1.5', value: 1.5 },
                { label: '1.75', value: 1.75 },
                { label: '2', value: 2 },
            ]}
            max={2}
            min={0.5}
            onChange={setSpeed}
            onDoubleClick={() => setSpeed(1)}
            step={0.01}
            value={speed}
            w="320px"
        />
    );
};

export const PitchControls = () => {
    const microtonal = useMicrotonalPitchControls();
    const speed = usePlayerSpeed();
    const { setSpeed } = usePlayerActions();

    const speedToPitch = (speed: number) => {
        return 12 * Math.log2(speed);
    };

    const pitchToSpeed = (pitch: number) => {
        return 2 ** (pitch / 12);
    };

    const adjustMusicalSpeed = (adjustment: number) => {
        const curPitch = speedToPitch(speed);
        const newSpeed = pitchToSpeed(curPitch + adjustment);
        setSpeed(newSpeed);
    };

    return (
        <Group gap={microtonal ? 'xs' : 'md'} my="md" w="100%" wrap="nowrap">
            <Button
                aria-label="-1 semitone"
                fullWidth
                fw={400}
                onClick={() => adjustMusicalSpeed(-1)}
                size="compact-xs"
            >
                -1st
            </Button>
            {microtonal && (
                <Button
                    aria-label="-10 cents"
                    fullWidth
                    fw={400}
                    onClick={() => adjustMusicalSpeed(-0.1)}
                    size="compact-xs"
                >
                    -10ct
                </Button>
            )}
            <Text size="sm" style={{ fontFamily: 'monospace' }} ta="center">
                {speed.toFixed(2)}x {speedToPitch(speed) > 0 && '+'}
                {speedToPitch(speed) == 0 && '±'}
                {speedToPitch(speed).toFixed(2)}st
            </Text>
            {microtonal && (
                <Button
                    aria-label="+10 cents"
                    fullWidth
                    fw={400}
                    onClick={() => adjustMusicalSpeed(0.1)}
                    size="compact-xs"
                >
                    +10ct
                </Button>
            )}
            <Button
                aria-label="+1 semitone"
                fullWidth
                fw={400}
                onClick={() => adjustMusicalSpeed(1)}
                size="compact-xs"
            >
                +1st
            </Button>
        </Group>
    );
};
