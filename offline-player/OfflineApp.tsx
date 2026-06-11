import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Captions,
  CaptionsOff,
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import type { Action } from '@/lib/types/action';
import type { SceneContent } from '@/lib/types/stage';
import { OfflineQuizView } from './OfflineQuizView';
import { OfflineSlideCanvas } from './OfflineSlideCanvas';
import type { OfflineClassroom, OfflineScene } from './types';

type PlaybackState = 'idle' | 'playing' | 'paused';
const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;
const CONTROL_HIDE_DELAY_MS = 2600;
let sharedSpeechAudio: HTMLAudioElement | null = null;

function getTitle(classroom: OfflineClassroom): string {
  return (
    classroom.name ||
    classroom.title ||
    classroom.stage?.name ||
    classroom.stage?.title ||
    'OpenMAIC Offline Classroom'
  );
}

function getSpeechAudioSrc(action: Action): string | undefined {
  if (action.type !== 'speech') return undefined;
  const withOfflineSrc = action as Action & { audioSrc?: string };
  return withOfflineSrc.audioSrc || action.audioUrl;
}

function getSharedSpeechAudio(): HTMLAudioElement {
  sharedSpeechAudio ||= new Audio();
  return sharedSpeechAudio;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('Playback aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function waitForMediaEnded(media: HTMLMediaElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      media.removeEventListener('ended', onEnded);
      media.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      media.pause();
      cleanup();
      reject(new DOMException('Playback aborted', 'AbortError'));
    };
    media.addEventListener('ended', onEnded, { once: true });
    media.addEventListener('error', onError, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function OfflineApp({ classroom }: { readonly classroom: OfflineClassroom }) {
  const scenes = classroom.scenes || [];
  const [sceneIndex, setSceneIndex] = useState(0);
  const [playbackState, setPlaybackState] = useState<PlaybackState>('idle');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [muted, setMuted] = useState(false);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [subtitle, setSubtitle] = useState('');
  const [discussion, setDiscussion] = useState('');
  const [controlsVisible, setControlsVisible] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackStateRef = useRef<PlaybackState>('idle');
  const playbackRateRef = useRef(playbackRate);
  const mutedRef = useRef(muted);
  const resumeWaitersRef = useRef<Array<() => void>>([]);
  const controlsHideTimerRef = useRef<number | null>(null);

  const currentScene = scenes[sceneIndex];

  const applyMediaSettings = useCallback(() => {
    const nextPlaybackRate = playbackRateRef.current;
    const nextMuted = mutedRef.current;

    if (audioRef.current) {
      audioRef.current.playbackRate = nextPlaybackRate;
      audioRef.current.muted = nextMuted;
    }
    document.querySelectorAll('video').forEach((video) => {
      video.playbackRate = nextPlaybackRate;
      video.muted = nextMuted;
    });
    (
      window as typeof window & {
        OPENMAIC_OFFLINE_MEDIA_SETTINGS?: { muted: boolean; playbackRate: number };
      }
    ).OPENMAIC_OFFLINE_MEDIA_SETTINGS = { muted: nextMuted, playbackRate: nextPlaybackRate };
  }, []);

  useEffect(() => {
    playbackRateRef.current = playbackRate;
    mutedRef.current = muted;
    applyMediaSettings();
  }, [applyMediaSettings, muted, playbackRate, sceneIndex]);

  useEffect(() => {
    playbackStateRef.current = playbackState;
  }, [playbackState]);

  const clearControlsHideTimer = useCallback(() => {
    if (controlsHideTimerRef.current != null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  }, []);

  const showControls = useCallback(() => {
    clearControlsHideTimer();
    setControlsVisible(true);

    if (playbackStateRef.current === 'playing') {
      controlsHideTimerRef.current = window.setTimeout(() => {
        setControlsVisible(false);
        controlsHideTimerRef.current = null;
      }, CONTROL_HIDE_DELAY_MS);
    }
  }, [clearControlsHideTimer]);

  useEffect(() => clearControlsHideTimer, [clearControlsHideTimer]);

  const clearScenePlaybackState = useCallback(() => {
    useCanvasStore.getState().clearAllEffects();
    useCanvasStore.getState().pauseVideo();
    setSubtitle('');
    setDiscussion('');
  }, []);

  const controller = useMemo(
    () => ({
      sceneId: currentScene?.id || '',
      sceneType: currentScene?.type || 'slide',
      getSnapshot: () => currentScene?.content as SceneContent,
      updateSceneData: () => undefined,
    }),
    [currentScene],
  );

  const stopPlayback = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    audioRef.current?.pause();
    useCanvasStore.getState().pauseVideo();
    playbackStateRef.current = 'idle';
    clearControlsHideTimer();
    setControlsVisible(true);
    setPlaybackState('idle');
    resumeWaitersRef.current.splice(0).forEach((resolve) => resolve());
  };

  const pausePlayback = () => {
    audioRef.current?.pause();
    document.querySelectorAll('video').forEach((video) => video.pause());
    playbackStateRef.current = 'paused';
    clearControlsHideTimer();
    setControlsVisible(true);
    setPlaybackState('paused');
  };

  const releasePausedWaiters = () => {
    resumeWaitersRef.current.splice(0).forEach((resolve) => resolve());
  };

  const showPausedPlaybackState = () => {
    playbackStateRef.current = 'paused';
    clearControlsHideTimer();
    setControlsVisible(true);
    setPlaybackState('paused');
  };

  const resumePlayback = () => {
    applyMediaSettings();
    const activeVideoId = useCanvasStore.getState().playingVideoElementId;
    const activeVideo = activeVideoId
      ? document.querySelector<HTMLVideoElement>(
          `[data-offline-video-id="${CSS.escape(activeVideoId)}"]`,
        )
      : null;

    if (audioRef.current && !audioRef.current.ended) {
      audioRef.current.play().catch((err) => {
        console.warn('[OpenMAIC Offline] audio resume failed', err);
      });
    }

    if (activeVideo && !activeVideo.ended) {
      activeVideo.play().catch((err) => {
        console.warn('[OpenMAIC Offline] video resume failed', err);
      });
    }

    playbackStateRef.current = 'playing';
    setPlaybackState('playing');
    showControls();
    releasePausedWaiters();
  };

  const waitUntilResumed = (signal: AbortSignal) => {
    if (playbackStateRef.current !== 'paused') return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        resumeWaitersRef.current = resumeWaitersRef.current.filter((waiter) => waiter !== onResume);
      };
      const onResume = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(new DOMException('Playback aborted', 'AbortError'));
      };
      resumeWaitersRef.current.push(onResume);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  const waitForDuration = async (ms: number, signal: AbortSignal) => {
    let activeElapsed = 0;
    while (activeElapsed < ms) {
      await waitUntilResumed(signal);
      const slice = Math.min(100, ms - activeElapsed);
      const sliceStartedAt = performance.now();
      await wait(slice, signal);
      if (playbackStateRef.current !== 'paused') {
        activeElapsed += performance.now() - sliceStartedAt;
      }
    }
  };

  const playMediaWithUnlockRetry = async (media: HTMLMediaElement, signal: AbortSignal) => {
    while (!signal.aborted) {
      await waitUntilResumed(signal);

      try {
        await media.play();
        return;
      } catch (err) {
        if (signal.aborted) {
          throw new DOMException('Playback aborted', 'AbortError');
        }

        const errorName = err instanceof DOMException ? err.name : '';
        if (
          playbackStateRef.current === 'paused' ||
          errorName === 'AbortError' ||
          errorName === 'NotAllowedError'
        ) {
          showPausedPlaybackState();
          await waitUntilResumed(signal);
          continue;
        }

        console.warn('[OpenMAIC Offline] media playback failed', err);
        return;
      }
    }

    throw new DOMException('Playback aborted', 'AbortError');
  };

  const cyclePlaybackRate = () => {
    setPlaybackRate((currentRate) => {
      const currentIndex = PLAYBACK_RATES.findIndex((rate) => rate === currentRate);
      const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length];
      playbackRateRef.current = nextRate;
      return nextRate;
    });
  };

  const runAction = async (action: Action, signal: AbortSignal) => {
    const canvas = useCanvasStore.getState();
    switch (action.type) {
      case 'speech': {
        setSubtitle(action.text || '');
        const src = getSpeechAudioSrc(action);
        if (!src) {
          await waitForDuration(Math.max(1200, (action.text || '').length * 90), signal);
          return;
        }
        const audio = getSharedSpeechAudio();
        audio.pause();
        audio.setAttribute('src', src);
        audio.load();
        audio.playbackRate = playbackRateRef.current;
        audio.muted = mutedRef.current;
        audioRef.current = audio;
        await playMediaWithUnlockRetry(audio, signal);
        await waitForMediaEnded(audio, signal);
        return;
      }
      case 'spotlight':
        canvas.setSpotlight(action.elementId, { dimness: action.dimOpacity ?? 0.7 });
        await waitForDuration(1200 / playbackRateRef.current, signal);
        canvas.clearSpotlight();
        return;
      case 'laser':
        canvas.setLaser(action.elementId, { color: action.color });
        await waitForDuration(1200 / playbackRateRef.current, signal);
        canvas.clearLaser();
        return;
      case 'play_video': {
        canvas.playVideo(action.elementId);
        const video = document.querySelector<HTMLVideoElement>(
          `[data-offline-video-id="${CSS.escape(action.elementId)}"]`,
        );
        if (video) {
          await playMediaWithUnlockRetry(video, signal);
          await waitForMediaEnded(video, signal);
        } else {
          await waitForDuration(1000, signal);
        }
        canvas.pauseVideo();
        return;
      }
      case 'discussion':
        setDiscussion(action.topic || action.prompt || 'Discussion');
        await waitForDuration(2200 / playbackRateRef.current, signal);
        return;
      default:
        await waitForDuration(350 / playbackRateRef.current, signal);
    }
  };

  const playFromCurrentScene = async () => {
    if (!currentScene) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    playbackStateRef.current = 'playing';
    setPlaybackState('playing');
    showControls();

    try {
      for (let i = sceneIndex; i < scenes.length; i += 1) {
        clearScenePlaybackState();
        setSceneIndex(i);
        await waitForDuration(100, abort.signal);
        const scene = scenes[i] as OfflineScene;
        const actions = scene.actions || [];
        for (const action of actions) {
          await runAction(action, abort.signal);
        }
      }
      clearControlsHideTimer();
      setControlsVisible(true);
      setPlaybackState('idle');
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error('[OpenMAIC Offline] playback failed', err);
      }
    }
  };

  const goToScene = (nextIndex: number) => {
    stopPlayback();
    clearScenePlaybackState();
    setSceneIndex(Math.max(0, Math.min(nextIndex, scenes.length - 1)));
  };

  const handleStageClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.omaic-controls, video, button, input, select, textarea, a')) return;

    if (playbackState === 'playing' && !controlsVisible) {
      showControls();
      return;
    }

    if (playbackState === 'playing') {
      pausePlayback();
      return;
    }
    if (playbackState === 'paused') {
      resumePlayback();
      return;
    }
    void playFromCurrentScene();
  };

  if (!currentScene) {
    return <div className="omaic-empty">No classroom scenes found.</div>;
  }

  return (
    <div className="omaic-app">
      <header className="omaic-topbar">
        <div>
          <div className="omaic-title">{getTitle(classroom)}</div>
        </div>
      </header>

      <main
        className="omaic-stage"
        onClick={handleStageClick}
        onMouseMove={showControls}
        onTouchStart={showControls}
      >
        {currentScene.content.type === 'slide' ? (
          <SceneProvider controller={controller}>
            <OfflineSlideCanvas />
          </SceneProvider>
        ) : currentScene.content.type === 'quiz' ? (
          <OfflineQuizView questions={currentScene.content.questions} title={currentScene.title} />
        ) : (
          <div className="omaic-unsupported-scene">
            <strong>{currentScene.title || 'Unsupported scene'}</strong>
            <span>{currentScene.type} scenes are not supported by the offline player yet.</span>
          </div>
        )}
        {playbackState === 'paused' && (
          <div className="omaic-stage-play-overlay" aria-hidden="true">
            <div className="omaic-stage-play-button">
              <Play aria-hidden="true" />
            </div>
          </div>
        )}
        <div
          className={`omaic-controls${controlsVisible ? '' : ' omaic-controls-hidden'}`}
          aria-label="Playback controls"
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="omaic-scene-count"
            aria-label={`Scene ${sceneIndex + 1} of ${scenes.length}`}
          >
            {sceneIndex + 1}
            <span>/</span>
            {scenes.length}
          </div>
          <div className="omaic-control-divider" />
          <button
            type="button"
            className="omaic-icon-button"
            onClick={() => goToScene(sceneIndex - 1)}
            disabled={sceneIndex === 0}
            aria-label="Previous scene"
            title="Previous scene"
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          {playbackState === 'playing' ? (
            <button
              type="button"
              className="omaic-icon-button omaic-icon-button-active"
              onClick={pausePlayback}
              aria-label="Pause"
              title="Pause"
            >
              <Pause aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="omaic-icon-button"
              onClick={playbackState === 'paused' ? resumePlayback : playFromCurrentScene}
              aria-label="Play"
              title="Play"
            >
              <Play aria-hidden="true" className="omaic-play-icon" />
            </button>
          )}
          <button
            type="button"
            className="omaic-icon-button"
            onClick={stopPlayback}
            aria-label="Stop"
            title="Stop"
          >
            <Square aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`omaic-speed-button${playbackRate !== 1 ? ' omaic-speed-button-active' : ''}`}
            onClick={cyclePlaybackRate}
            aria-label={`Playback speed ${playbackRate}x`}
            title="Playback speed"
          >
            {playbackRate}x
          </button>
          <button
            type="button"
            className={`omaic-icon-button${captionsEnabled ? ' omaic-icon-button-active' : ''}`}
            onClick={() => setCaptionsEnabled((value) => !value)}
            aria-label={captionsEnabled ? 'Hide captions' : 'Show captions'}
            title={captionsEnabled ? 'Hide captions' : 'Show captions'}
            aria-pressed={captionsEnabled}
          >
            {captionsEnabled ? <Captions aria-hidden="true" /> : <CaptionsOff aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={`omaic-icon-button${muted ? ' omaic-icon-button-muted' : ''}`}
            onClick={() =>
              setMuted((value) => {
                const nextMuted = !value;
                mutedRef.current = nextMuted;
                return nextMuted;
              })
            }
            aria-label={muted ? 'Unmute' : 'Mute'}
            title={muted ? 'Unmute' : 'Mute'}
          >
            {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="omaic-icon-button"
            onClick={() => goToScene(sceneIndex + 1)}
            disabled={sceneIndex >= scenes.length - 1}
            aria-label="Next scene"
            title="Next scene"
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </main>

      {captionsEnabled && (subtitle || discussion) && (
        <footer className="omaic-caption">
          {subtitle && <div>{subtitle}</div>}
          {discussion && <div className="omaic-discussion">{discussion}</div>}
        </footer>
      )}
    </div>
  );
}
