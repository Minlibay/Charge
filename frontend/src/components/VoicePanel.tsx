import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ChangeEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { Channel } from '../types';
import { useVoiceConnection } from '../hooks/useVoiceConnection';
import { useWorkspaceStore } from '../state/workspaceStore';
import { applyOutputDevice, isSetSinkIdSupported } from '../webrtc/devices';
import { StagePanel } from './voice/StagePanel';
import { logger } from '../services/logger';

interface VoicePanelProps {
  channels: Channel[];
}

interface VoiceParticipantRowProps {
  participantId: number;
  name: string;
  role: string;
  isLocal: boolean;
  muted: boolean;
  deafened: boolean;
  videoEnabled: boolean;
  speaking: boolean;
  level: number;
  stream: MediaStream | null;
  speakerDeviceId: string | null;
  youLabel: string;
  globalVolume: number;
  volume: number;
  onVolumeChange: (participantId: number, volume: number) => void;
  volumeAriaLabel: string;
  volumeValueText: string;
  menuLabel: string;
}

interface PlaybackAudioChain {
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  destination: MediaStreamAudioDestinationNode;
  stream: MediaStream;
}

function SvgIcon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      className="voice-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const MicOnIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
    <path d="M19 11a7 7 0 0 1-14 0" />
    <path d="M12 18v3" />
  </SvgIcon>
);

const MicOffIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M15 12V7a3 3 0 0 0-4.75-2.55" />
    <path d="M9 10v2a3 3 0 0 0 3 3c.7 0 1.36-.24 1.88-.64" />
    <path d="M19 11a7 7 0 0 1-7 7" />
    <path d="M5 11a7 7 0 0 0 2.1 4.9" />
    <path d="M12 18v3" />
    <path d="M3 3l18 18" />
  </SvgIcon>
);

const HeadsetIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M5 12a7 7 0 0 1 14 0" />
    <path d="M7 12v-1a5 5 0 0 1 10 0v1" />
    <path d="M5 12v3a2 2 0 0 0 2 2h1" />
    <path d="M19 12v3a2 2 0 0 1-2 2h-1" />
    <path d="M12 18v3" />
  </SvgIcon>
);

const HeadsetOffIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M8.6 6.4A5 5 0 0 1 17 11v1" />
    <path d="M5 12v3a2 2 0 0 0 2 2h1" />
    <path d="M19 14.5V12a7 7 0 0 0-9.4-6.6" />
    <path d="M12 18v3" />
    <path d="M3 3l18 18" />
  </SvgIcon>
);

const VideoOnIcon = (): JSX.Element => (
  <SvgIcon>
    <rect x="4" y="7" width="10" height="10" rx="2" ry="2" />
    <path d="M18 9v6l-4-2.5V11.5Z" />
  </SvgIcon>
);

const VideoOffIcon = (): JSX.Element => (
  <SvgIcon>
    <rect x="4" y="7" width="10" height="10" rx="2" ry="2" />
    <path d="M18 9v6l-3.6-2.1" />
    <path d="M5 5l14 14" />
  </SvgIcon>
);

const RefreshIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M4 10a8 8 0 0 1 13-4.6" />
    <path d="M17 4h3v3" />
    <path d="M20 14a8 8 0 0 1-13 4.6" />
    <path d="M7 20H4v-3" />
  </SvgIcon>
);

const RetryIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M5 11a7 7 0 0 1 11.9-4.9" />
    <path d="M17 4v4H13" />
    <path d="M19 13a7 7 0 0 1-11.9 4.9" />
    <path d="M7 20v-4h4" />
  </SvgIcon>
);

const PhoneIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M6 4h3l1.2 4.5-2 2a11 11 0 0 0 7.3 7.3l2-2L22 17v3a2 2 0 0 1-2 2A17 17 0 0 1 4 7a2 2 0 0 1 2-2Z" />
  </SvgIcon>
);

const PhoneHangupIcon = (): JSX.Element => (
  <SvgIcon>
    <path d="M4 15c3-3 13-3 16 0" />
    <path d="M4 15v3" />
    <path d="M20 15v3" />
  </SvgIcon>
);

interface VoiceControlButtonProps {
  label: string;
  onClick: () => void;
  icon: JSX.Element;
  active?: boolean;
  disabled?: boolean;
  toggle?: boolean;
}

function VoiceControlButton({
  label,
  onClick,
  icon,
  active = false,
  disabled = false,
  toggle = false,
}: VoiceControlButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={clsx('voice-control-button', { 'voice-control-button--active': active })}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={toggle ? active : undefined}
      disabled={disabled}
    >
      {icon}
    </button>
  );
}

function VoiceParticipantRow({
  participantId,
  name,
  role,
  isLocal,
  muted,
  deafened,
  videoEnabled,
  speaking,
  level,
  stream,
  speakerDeviceId,
  youLabel,
  globalVolume,
  volume,
  onVolumeChange,
  volumeAriaLabel,
  volumeValueText,
  menuLabel,
}: VoiceParticipantRowProps): JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackChainRef = useRef<PlaybackAudioChain | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const safeVolume = Number.isFinite(volume) ? Math.min(Math.max(volume, 0), 2) : 1;
  const combinedVolume = Math.min(Math.max(globalVolume * safeVolume, 0), 4);
  const volumeRef = useRef<number>(combinedVolume);
  volumeRef.current = combinedVolume;
  const volumeInputId = useMemo(() => `voice-participant-volume-${participantId}`, [participantId]);

  const disposePlaybackChain = useCallback((chain: PlaybackAudioChain | null) => {
    if (!chain) {
      return;
    }
    try {
      chain.source.disconnect();
    } catch (error) {
      void error;
    }
    try {
      chain.gain.disconnect();
    } catch (error) {
      void error;
    }
    try {
      chain.destination.disconnect();
    } catch (error) {
      void error;
    }
    void chain.context.close().catch(() => {
      // ignore close errors
    });
  }, []);

  useEffect(() => {
    logger.debug('=== AUDIO PLAYBACK EFFECT STARTED ===', {
      participantId,
      hasStream: stream !== null,
      streamId: stream?.id,
      isLocal,
      deafened,
    });
    
    // Skip if local participant (no audio playback needed)
    if (isLocal) {
      logger.debug('Skipping audio setup for local participant', { participantId });
      return;
    }
    
    // Wait for audio element to be available in DOM
    // Use requestAnimationFrame to ensure DOM is updated
    let retryCount = 0;
    const maxRetries = 10;
    
    const checkAndSetup = () => {
      const element = audioRef.current;
      if (!element) {
        retryCount++;
        if (retryCount < maxRetries) {
          logger.debug('Audio element not yet available, retrying', {
            participantId,
            retryCount,
            maxRetries,
          });
          requestAnimationFrame(checkAndSetup);
        } else {
          logger.warn('Audio element not available after all retries', {
            participantId,
            retryCount,
          });
        }
        return;
      }
      
      // Element is available, proceed with setup
      logger.debug('Audio element found, proceeding with setup', {
        participantId,
        retryCount,
        elementId: element.id,
      });
      
      // Continue with the rest of the effect...
      setupAudioPlayback(element);
    };
    
    // Start checking
    requestAnimationFrame(checkAndSetup);
    
    // Setup function extracted to avoid duplication
    function setupAudioPlayback(element: HTMLAudioElement) {
    
    logger.debug('Audio element available', {
      participantId,
      elementId: element.id,
      currentSrcObject: element.srcObject ? 'set' : 'null',
      paused: element.paused,
      readyState: element.readyState,
      volume: element.volume,
      muted: element.muted,
    });

    // Clean up previous chain if stream changed
    const previousChain = playbackChainRef.current;
    if (previousChain && previousChain.stream !== stream) {
      logger.debug('Stream changed, disposing previous chain', {
        participantId,
        previousStreamId: previousChain.stream?.id,
        newStreamId: stream?.id,
      });
      disposePlaybackChain(previousChain);
      playbackChainRef.current = null;
    }

    if (!stream) {
      logger.warn('=== NO STREAM FOR PARTICIPANT ===', {
        participantId,
        isLocal,
        allRemoteStreamsInStore: 'check store state',
      });
      if (previousChain) {
        disposePlaybackChain(previousChain);
        playbackChainRef.current = null;
      }
      if (element.srcObject) {
        element.srcObject = null;
      }
      return;
    }
    
    // Get all audio tracks
    const audioTracks = stream.getAudioTracks();
    logger.debug('=== STREAM ANALYSIS ===', {
      participantId,
      streamId: stream.id,
      audioTracksCount: audioTracks.length,
      videoTracksCount: stream.getVideoTracks().length,
      totalTracksCount: stream.getTracks().length,
      trackDetails: audioTracks.map((t, idx) => ({
        index: idx,
        id: t.id,
        enabled: t.enabled,
        readyState: t.readyState,
        muted: t.muted,
        label: t.label,
        kind: t.kind,
        settings: t.getSettings ? Object.keys(t.getSettings()) : 'N/A',
      })),
    });
    
    if (audioTracks.length === 0) {
      logger.warn('Stream has no audio tracks for participant', {
        participantId,
        streamId: stream.id,
        totalTracks: stream.getTracks().length,
        trackKinds: stream.getTracks().map(t => t.kind),
      });
      return;
    }
    
    // Aggressively ensure all tracks are enabled
    audioTracks.forEach((track, index) => {
      const beforeState = {
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted,
      };
      
      if (!track.enabled) {
        track.enabled = true;
        logger.debug(`[Track ${index}] Enabled audio track`, {
          participantId,
          trackId: track.id,
          before: beforeState,
          after: {
            enabled: track.enabled,
            readyState: track.readyState,
            muted: track.muted,
          },
        });
      }
    });
    
    const enabledTracks = audioTracks.filter(t => t.enabled && t.readyState !== 'ended');
    const liveTracks = audioTracks.filter(t => t.readyState === 'live');
    const mutedTracks = audioTracks.filter(t => t.muted);
    
    logger.debug('=== TRACK STATE SUMMARY ===', {
      participantId,
      totalTracks: audioTracks.length,
      enabledTracks: enabledTracks.length,
      liveTracks: liveTracks.length,
      mutedTracks: mutedTracks.length,
      endedTracks: audioTracks.filter(t => t.readyState === 'ended').length,
      trackBreakdown: {
        enabledAndLive: audioTracks.filter(t => t.enabled && t.readyState === 'live').length,
        enabledButMuted: audioTracks.filter(t => t.enabled && t.muted).length,
        enabledButNotLive: audioTracks.filter(t => t.enabled && t.readyState !== 'live').length,
      },
    });
    
    if (enabledTracks.length === 0) {
      logger.warn('No enabled audio tracks for participant', {
        participantId,
        totalTracks: audioTracks.length,
        allTracksEnded: audioTracks.every(t => t.readyState === 'ended'),
        trackStates: audioTracks.map(t => ({
          id: t.id,
          enabled: t.enabled,
          readyState: t.readyState,
        })),
      });
      return;
    }
    
    logger.debug('=== PROCEEDING WITH AUDIO SETUP ===', {
      participantId,
      enabledTracksCount: enabledTracks.length,
      liveTracksCount: liveTracks.length,
      mutedTracksCount: mutedTracks.length,
    });

    const AudioContextCtor: typeof AudioContext | undefined =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;

    // Fallback: use HTMLAudioElement directly if AudioContext not available
    if (!AudioContextCtor) {
      logger.debug('AudioContext not available, using direct audio element', { participantId });
      if (previousChain) {
        disposePlaybackChain(previousChain);
        playbackChainRef.current = null;
      }
      element.srcObject = stream;
      element.volume = Math.min(Math.max(volumeRef.current, 0), 1);
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch((error) => {
          logger.debug('Failed to play audio element', { participantId, error: error instanceof Error ? error.message : String(error) });
        });
      }
      return () => {
        if (element.srcObject === stream) {
          element.srcObject = null;
        }
      };
    }

    // Reuse existing chain if stream is the same
    if (previousChain && previousChain.stream === stream) {
      logger.debug('Reusing existing audio chain for participant', { participantId });
      // Only update srcObject if it's different to avoid interrupting playback
      if (element.srcObject !== previousChain.destination.stream) {
        // Wait for current play promise to finish before changing srcObject
        if (playPromiseRef.current) {
          void playPromiseRef.current.finally(() => {
            element.srcObject = previousChain.destination.stream;
            if (element.paused) {
              playPromiseRef.current = element.play() ?? null;
              if (playPromiseRef.current) {
                void playPromiseRef.current.catch((error) => {
                  if (error.name !== 'AbortError') {
                    logger.debug('Failed to play after srcObject change', { participantId });
                  }
                });
              }
            }
          }).catch(() => {
            // If current play failed, set srcObject immediately
            element.srcObject = previousChain.destination.stream;
            if (element.paused) {
              playPromiseRef.current = element.play() ?? null;
              if (playPromiseRef.current) {
                void playPromiseRef.current.catch(() => {
                  // autoplay may be blocked; ignore
                });
              }
            }
          });
        } else {
          element.srcObject = previousChain.destination.stream;
          if (element.paused) {
            playPromiseRef.current = element.play() ?? null;
            if (playPromiseRef.current) {
              void playPromiseRef.current.catch(() => {
                // autoplay may be blocked; ignore
              });
            }
          }
        }
      } else {
        // srcObject is already correct, just update volume and resume
        previousChain.gain.gain.setTargetAtTime(volumeRef.current, previousChain.context.currentTime, 0.05);
        void previousChain.context.resume().catch(() => {
          // ignore resume errors
        });
        // Only play if not already playing
        if (element.paused && !playPromiseRef.current) {
          playPromiseRef.current = element.play() ?? null;
          if (playPromiseRef.current) {
            void playPromiseRef.current.finally(() => {
              playPromiseRef.current = null;
            }).catch((error) => {
              playPromiseRef.current = null;
              if (error.name !== 'AbortError') {
                logger.debug('Failed to play (reuse)', { participantId });
              }
            });
          }
        }
      }
      return;
    }

    // Create new audio chain
    logger.debug('=== CREATING NEW AUDIO CHAIN ===', {
      participantId,
      streamId: stream.id,
      audioTracksInStream: stream.getAudioTracks().length,
    });
    
    const context = new AudioContextCtor();
    logger.debug('AudioContext created', {
      participantId,
      contextState: context.state,
      sampleRate: context.sampleRate,
      baseLatency: context.baseLatency,
      outputLatency: context.outputLatency,
    });
    
    // Create source from stream - this will work even if tracks are muted
    // Muted tracks will simply not produce audio data, but the chain will be ready
    let source: MediaStreamAudioSourceNode;
    try {
      source = context.createMediaStreamSource(stream);
      logger.debug('MediaStreamSource created', {
        participantId,
        sourceChannelCount: source.channelCount,
        sourceChannelCountMode: source.channelCountMode,
        sourceChannelInterpretation: source.channelInterpretation,
        numberOfInputs: source.numberOfInputs,
        numberOfOutputs: source.numberOfOutputs,
      });
    } catch (error) {
      logger.error('Failed to create MediaStreamSource', error instanceof Error ? error : new Error(String(error)), {
        participantId,
        streamId: stream.id,
        audioTracks: stream.getAudioTracks().length,
      });
      return;
    }
    
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    
    logger.debug('Audio nodes created', {
      participantId,
      gainChannelCount: gain.channelCount,
      destinationChannelCount: destination.channelCount,
      destinationStreamId: destination.stream.id,
      destinationStreamTracks: destination.stream.getTracks().length,
    });

    source.connect(gain);
    gain.connect(destination);
    
    const initialGain = (deafened || isLocal) ? 0 : volumeRef.current;
    const clampedGain = initialGain > 0 && initialGain < 0.02 ? 0.02 : initialGain;
    gain.gain.setValueAtTime(clampedGain, context.currentTime);
    
    logger.debug('Audio chain connected and gain set', {
      participantId,
      initialGain,
      clampedGain,
      deafened,
      isLocal,
      volumeRef: volumeRef.current,
    });

    playbackChainRef.current = { context, source, gain, destination, stream };
    
    logger.debug('Playback chain stored', {
      participantId,
      chainStreamId: playbackChainRef.current.stream.id,
      destinationStreamId: destination.stream.id,
    });

    // Set srcObject before playing to avoid interruption
    // If srcObject is already set, wait for current playback to finish
    let playAfterSet = true;
    if (element.srcObject && element.srcObject !== destination.stream) {
      // Wait for current play promise to finish
      if (playPromiseRef.current) {
        playAfterSet = false;
        void playPromiseRef.current.finally(() => {
          element.srcObject = destination.stream;
          element.volume = 1.0;
          if (element.paused) {
            playPromiseRef.current = element.play() ?? null;
            if (playPromiseRef.current) {
              void playPromiseRef.current.finally(() => {
                playPromiseRef.current = null;
              }).catch((error) => {
                playPromiseRef.current = null;
                if (error.name !== 'AbortError') {
                  logger.warn('Failed to play after srcObject change', { participantId, error: error instanceof Error ? error.message : String(error) });
                }
              });
            }
          }
        }).catch(() => {
          // If current play failed, set srcObject immediately
          element.srcObject = destination.stream;
          element.volume = 1.0;
          if (element.paused) {
            playPromiseRef.current = element.play() ?? null;
            if (playPromiseRef.current) {
              void playPromiseRef.current.finally(() => {
                playPromiseRef.current = null;
              }).catch((error) => {
                playPromiseRef.current = null;
                if (error.name !== 'AbortError') {
                  logger.warn('Failed to play after srcObject change (fallback)', { participantId, error: error instanceof Error ? error.message : String(error) });
                }
              });
            }
          }
        });
      } else {
        // No current play promise, can set immediately
        element.srcObject = destination.stream;
        element.volume = 1.0;
      }
    } else {
      // No existing srcObject or it's already correct
      element.srcObject = destination.stream;
      element.volume = 1.0; // Use gain node for volume control
    }
    
    // Set up comprehensive track event listeners
    const trackListeners: Array<() => void> = [];
    const allTracks = stream.getTracks();
    
    allTracks.forEach((track) => {
      if (track.kind !== 'audio') {
        return;
      }
      
      const handleUnmute = () => {
        logger.debug('Audio track unmuted for participant', { participantId, trackId: track.id });
        // Ensure track stays enabled
        if (!track.enabled) {
          track.enabled = true;
        }
        // Resume context and play (only if not already playing and no pending play)
        void context.resume().then(() => {
          if (element.paused && !playPromiseRef.current) {
            playPromiseRef.current = element.play() ?? null;
            if (playPromiseRef.current) {
              void playPromiseRef.current.finally(() => {
                playPromiseRef.current = null;
              }).catch((error) => {
                playPromiseRef.current = null;
                // Ignore AbortError - it means another play() was called
                if (error.name !== 'AbortError') {
                  logger.debug('Failed to play after unmute', { participantId, error: error instanceof Error ? error.message : String(error) });
                }
              });
            }
          }
        }).catch(() => {
          // ignore resume errors
        });
      };
      
      const handleMute = () => {
        logger.debug('Audio track muted for participant', { participantId, trackId: track.id });
        // Keep track enabled even when muted
        if (!track.enabled) {
          track.enabled = true;
        }
      };
      
      const handleStarted = () => {
        logger.debug('Audio track started for participant', { participantId, trackId: track.id });
        if (!track.enabled) {
          track.enabled = true;
        }
        void context.resume().catch(() => {
          // ignore resume errors
        });
      };
      
      track.addEventListener('unmute', handleUnmute);
      track.addEventListener('mute', handleMute);
      track.addEventListener('started', handleStarted);
      
      trackListeners.push(() => {
        track.removeEventListener('unmute', handleUnmute);
        track.removeEventListener('mute', handleMute);
        track.removeEventListener('started', handleStarted);
      });
    });
    
    // Listen to stream track changes
    const handleAddTrack = (event: MediaStreamTrackEvent) => {
      logger.debug('Track added to stream for participant', { participantId, trackId: event.track.id, kind: event.track.kind });
      if (event.track.kind === 'audio' && !event.track.enabled) {
        event.track.enabled = true;
      }
    };
    
    const handleRemoveTrack = (event: MediaStreamTrackEvent) => {
      logger.debug('Track removed from stream for participant', { participantId, trackId: event.track.id, kind: event.track.kind });
    };
    
    stream.addEventListener('addtrack', handleAddTrack);
    stream.addEventListener('removetrack', handleRemoveTrack);
    
    trackListeners.push(() => {
      stream.removeEventListener('addtrack', handleAddTrack);
      stream.removeEventListener('removetrack', handleRemoveTrack);
    });
    
    // Aggressively resume context and play
    const startPlayback = async () => {
      logger.debug('=== STARTING PLAYBACK ===', {
        participantId,
        contextState: context.state,
        elementSrcObject: element.srcObject ? 'set' : 'null',
        expectedSrcObject: destination.stream.id,
        srcObjectMatches: element.srcObject === destination.stream,
        elementPaused: element.paused,
        hasPendingPlay: Boolean(playPromiseRef.current),
        elementReadyState: element.readyState,
        elementVolume: element.volume,
        elementMuted: element.muted,
      });
      
      try {
        const beforeResume = context.state;
        await context.resume();
        logger.debug('Audio context resumed', {
          participantId,
          beforeState: beforeResume,
          afterState: context.state,
          currentTime: context.currentTime,
        });
      } catch (error) {
          logger.error('Failed to resume audio context', error instanceof Error ? error : new Error(String(error)), {
            participantId,
            contextState: context.state,
          });
        return;
      }
      
      // Verify srcObject is set correctly
      if (element.srcObject !== destination.stream) {
        logger.warn('srcObject mismatch before play', {
          participantId,
          currentSrcObject: element.srcObject ? 'different stream' : 'null',
          expectedStreamId: destination.stream.id,
          destinationTracks: destination.stream.getTracks().length,
        });
        // Try to set it
        element.srcObject = destination.stream;
        element.volume = 1.0;
      }
      
      // Only play if srcObject is set, element is paused, and no pending play
      const canPlay = element.srcObject === destination.stream && element.paused && !playPromiseRef.current;
      logger.debug('Playback readiness check', {
        participantId,
        canPlay,
        srcObjectMatches: element.srcObject === destination.stream,
        elementPaused: element.paused,
        hasPendingPlay: Boolean(playPromiseRef.current),
      });
      
      if (canPlay) {
        try {
          logger.debug('Calling element.play()', {
            participantId,
            elementState: {
              paused: element.paused,
              readyState: element.readyState,
              volume: element.volume,
              muted: element.muted,
              srcObject: element.srcObject ? 'set' : 'null',
            },
          });
          
          playPromiseRef.current = element.play() ?? null;
          if (playPromiseRef.current) {
            await playPromiseRef.current;
            playPromiseRef.current = null;
            
            logger.debug('Audio playback started successfully', {
              participantId,
              elementPaused: element.paused,
              elementReadyState: element.readyState,
              contextState: context.state,
            });
            
            // Verify audio is actually playing
            setTimeout(() => {
              logger.debug('Playback verification', {
                participantId,
                elementPaused: element.paused,
                elementReadyState: element.readyState,
                contextState: context.state,
                srcObject: element.srcObject ? 'set' : 'null',
                destinationStreamTracks: destination.stream.getTracks().length,
                sourceStreamTracks: stream.getTracks().length,
              });
            }, 100);
          } else {
            logger.warn('element.play() returned undefined', { participantId });
          }
        } catch (error) {
          playPromiseRef.current = null;
          // Ignore AbortError - it means another play() was called or srcObject changed
          if (error instanceof Error && error.name === 'AbortError') {
            logger.debug('Play interrupted (expected AbortError)', {
              participantId,
              errorName: error.name,
              errorMessage: error.message,
            });
            return;
          }
          logger.error('Failed to play audio', error instanceof Error ? error : new Error(String(error)), {
            participantId,
            errorName: error instanceof Error ? error.name : 'Unknown',
            errorMessage: error instanceof Error ? error.message : String(error),
            elementState: {
              paused: element.paused,
              readyState: element.readyState,
              srcObject: element.srcObject ? 'set' : 'null',
            },
          });
          // Retry after a short delay only if srcObject hasn't changed and no pending play
          setTimeout(() => {
            if (element.srcObject === destination.stream && element.paused && !playPromiseRef.current) {
              logger.debug('Retrying play after error', { participantId });
              playPromiseRef.current = element.play() ?? null;
              if (playPromiseRef.current) {
                void playPromiseRef.current.finally(() => {
                  playPromiseRef.current = null;
                }).catch((retryError) => {
                  playPromiseRef.current = null;
                  // Ignore AbortError on retry too
                  if (retryError instanceof Error && retryError.name !== 'AbortError') {
                    logger.debug('Retry play failed', { participantId, error: retryError instanceof Error ? retryError.message : String(retryError) });
                  }
                });
              }
            }
          }, 100);
        }
      } else {
        logger.debug('Cannot play - conditions not met', {
          participantId,
          reasons: {
            srcObjectMismatch: element.srcObject !== destination.stream,
            notPaused: !element.paused,
            hasPendingPlay: Boolean(playPromiseRef.current),
          },
        });
      }
    };
    
    // Start playback
    void startPlayback();

      return () => {
        logger.debug('Cleaning up audio chain for participant', { participantId });
        trackListeners.forEach(cleanup => cleanup());
        playPromiseRef.current = null;
        const activeChain = playbackChainRef.current;
        if (activeChain && activeChain.stream === stream) {
          disposePlaybackChain(activeChain);
          playbackChainRef.current = null;
        }
      };
    }
    
    // Return cleanup for the retry mechanism
    return () => {
      // Cleanup will be handled by setupAudioPlayback's return
    };
  }, [disposePlaybackChain, stream, participantId, deafened, isLocal]);

  useEffect(() => {
    const element = audioRef.current;
    const chain = playbackChainRef.current;
    const nextVolume = volumeRef.current;
    if (chain) {
      chain.gain.gain.setTargetAtTime(nextVolume, chain.context.currentTime, 0.05);
    } else if (element) {
      element.volume = Math.min(Math.max(nextVolume, 0), 1);
    }
  }, [combinedVolume]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) {
      return;
    }
    const shouldMute = deafened || isLocal;
    element.muted = shouldMute;
    if (!shouldMute) {
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {
          // autoplay may be blocked; ignore
        });
      }
      const chain = playbackChainRef.current;
      if (chain) {
        void chain.context.resume().catch(() => {
          // ignore resume errors
        });
      }
    }
  }, [deafened, isLocal]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element || isLocal || !stream) {
      return;
    }
    if (!isSetSinkIdSupported()) {
      return;
    }
    void applyOutputDevice(element, speakerDeviceId ?? null);
  }, [isLocal, speakerDeviceId, stream]);

  const handleVolumeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onVolumeChange(participantId, Number(event.target.value));
    },
    [onVolumeChange, participantId],
  );

  const initials = useMemo(() => name.trim().charAt(0).toUpperCase() || '•', [name]);

  return (
    <li
      key={participantId}
      className={clsx('voice-participant', {
        'voice-participant--muted': muted,
        'voice-participant--deafened': deafened,
        'voice-participant--speaking': speaking,
        'voice-participant--local': isLocal,
      })}
    >
      <span className="presence-avatar" aria-hidden="true">
        {initials}
      </span>
      <div className="voice-participant__details">
        <span className="presence-name">
          {name}
          {isLocal ? ` (${youLabel})` : ''}
        </span>
        <span className="voice-participant__role">{role}</span>
      </div>
      <div className="voice-participant__status">
        <div className="voice-participant__indicators" role="group" aria-label="Media state">
          <span className={clsx('voice-indicator', 'voice-indicator--mic', { 'is-off': muted })} aria-hidden="true">
            {muted ? '🔇' : '🎙️'}
          </span>
          <span className={clsx('voice-indicator', 'voice-indicator--deaf', { 'is-off': !deafened })} aria-hidden="true">
            {deafened ? '🙉' : '👂'}
          </span>
          <span className={clsx('voice-indicator', 'voice-indicator--video', { 'is-off': !videoEnabled })} aria-hidden="true">
            {videoEnabled ? '🎥' : '📷'}
          </span>
          <span className="voice-activity" aria-hidden="true" style={{ '--voice-level': level } as CSSProperties} />
        </div>
        {!isLocal ? (
          <details className="voice-participant__menu">
            <summary
              className="voice-participant__menu-trigger"
              role="button"
              aria-haspopup="menu"
              aria-label={menuLabel}
            >
              ⋯
            </summary>
            <div className="voice-participant__menu-content" role="menu">
              <label className="sr-only" htmlFor={volumeInputId}>
                {volumeAriaLabel}
              </label>
              <div className="voice-participant__menu-row">
                <span className="voice-participant__menu-label">{volumeValueText}</span>
                <input
                  id={volumeInputId}
                  className="voice-participant__menu-slider"
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={safeVolume}
                  onChange={handleVolumeChange}
                  aria-valuemin={0}
                  aria-valuemax={2}
                  aria-valuenow={Number.isFinite(safeVolume) ? Number(safeVolume.toFixed(2)) : 1}
                  aria-valuetext={volumeValueText}
                  title={volumeValueText}
                />
              </div>
            </div>
          </details>
        ) : null}
      </div>
      {!isLocal ? <audio ref={audioRef} autoPlay playsInline /> : null}
    </li>
  );
}

export function VoicePanel({ channels }: VoicePanelProps): JSX.Element {
  const { t } = useTranslation();
  const {
    join,
    leave,
    toggleMute,
    toggleDeafened,
    toggleVideo,
    selectMicrophone,
    selectSpeaker,
    selectCamera,
    refreshDevices,
    retry,
    setScreenShareQuality,
    setHandRaised,
  } = useVoiceConnection();

  const roomSlug = useWorkspaceStore((state) => state.selectedRoomSlug);
  const participants = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.voiceParticipantsByRoom[state.selectedRoomSlug] ?? [] : [],
  );
  const connectionStatus = useWorkspaceStore((state) => state.voiceConnectionStatus);
  const connectionError = useWorkspaceStore((state) => state.voiceConnectionError);
  const activeChannelId = useWorkspaceStore((state) => state.activeVoiceChannelId);
  const muted = useWorkspaceStore((state) => state.muted);
  const deafened = useWorkspaceStore((state) => state.deafened);
  const videoEnabled = useWorkspaceStore((state) => state.videoEnabled);
  const devices = useWorkspaceStore((state) => state.voiceDevices);
  const selectedMicrophoneId = useWorkspaceStore((state) => state.selectedMicrophoneId);
  const selectedSpeakerId = useWorkspaceStore((state) => state.selectedSpeakerId);
  const selectedCameraId = useWorkspaceStore((state) => state.selectedCameraId);
  const voicePlaybackVolume = useWorkspaceStore((state) => state.voicePlaybackVolume);
  const setVoicePlaybackVolumeState = useWorkspaceStore((state) => state.setVoicePlaybackVolume);
  const voiceParticipantVolumes = useWorkspaceStore((state) => state.voiceParticipantVolumes);
  const setVoiceParticipantVolume = useWorkspaceStore((state) => state.setVoiceParticipantVolume);
  const voiceGain = useWorkspaceStore((state) => state.voiceGain);
  const voiceAutoGain = useWorkspaceStore((state) => state.voiceAutoGain);
  const voiceInputLevel = useWorkspaceStore((state) => state.voiceInputLevel);
  const setVoiceGain = useWorkspaceStore((state) => state.setVoiceGain);
  const setVoiceAutoGain = useWorkspaceStore((state) => state.setVoiceAutoGain);
  const voiceActivity = useWorkspaceStore((state) => state.voiceActivity);
  const remoteStreams = useWorkspaceStore((state) => state.voiceRemoteStreams);
  const localParticipantId = useWorkspaceStore((state) => state.voiceLocalParticipantId);
  const screenShareQuality = useWorkspaceStore((state) => state.screenShareQuality);
  const voiceStats = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.voiceStatsByRoom[state.selectedRoomSlug] ?? null : null,
  );

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeChannelId) ?? null,
    [channels, activeChannelId],
  );
  const stageChannelActive = activeChannel?.type === 'stage';

  const handleGainChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setVoiceGain(Number(event.target.value));
    },
    [setVoiceGain],
  );

  const handleAutoGainChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setVoiceAutoGain(event.target.checked);
    },
    [setVoiceAutoGain],
  );

  const handlePlaybackVolumeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setVoicePlaybackVolumeState(Number(event.target.value));
    },
    [setVoicePlaybackVolumeState],
  );

  const handleParticipantVolumeChange = useCallback(
    (participantId: number, value: number) => {
      setVoiceParticipantVolume(participantId, value);
    },
    [setVoiceParticipantVolume],
  );

  const levelPercent = useMemo(() => Math.min(100, Math.round(voiceInputLevel * 100)), [voiceInputLevel]);
  const gainValueText = useMemo(
    () => t('voice.microphoneSettings.gainValue', { value: voiceGain.toFixed(2) }),
    [t, voiceGain],
  );

  const playbackValueText = useMemo(
    () => t('voice.playbackSettings.volumeValue', { value: Math.round(voicePlaybackVolume * 100) }),
    [t, voicePlaybackVolume],
  );

  const [devicesOpen, setDevicesOpen] = useState(false);

  const statusLabel = useMemo(() => {
    switch (connectionStatus) {
      case 'connected':
        return t('voice.status.connected');
      case 'connecting':
        return t('voice.status.connecting');
      case 'error':
        return t('voice.status.error');
      default:
        return t('voice.status.disconnected');
    }
  }, [connectionStatus, t]);

  const handleJoin = useCallback(
    async (channelId: number) => {
      if (activeChannelId === channelId && connectionStatus === 'connected') {
        leave();
        return;
      }
      await join(channelId);
    },
    [activeChannelId, connectionStatus, join, leave],
  );


  const handleLeave = useCallback(() => {
    if (!activeChannelId || connectionStatus === 'connecting') {
      return;
    }
    leave();
  }, [activeChannelId, connectionStatus, leave]);

  const sectionTitles = useMemo(
    () => ({
      status: t('voice.sections.status', { defaultValue: 'Status' }),
      channels: t('voice.sections.channels', { defaultValue: 'Channels' }),
      devices: t('voice.sections.devices', { defaultValue: 'Devices' }),
      participants: t('voice.sections.participants', { defaultValue: 'Participants' }),
    }),
    [t],
  );

  const callBarLabel = t('voice.controls.label');
  const canLeaveCall = Boolean(activeChannelId) && connectionStatus !== 'connecting';

  const callBar = (
    <footer className="voice-call-bar" role="toolbar" aria-label={callBarLabel}>
      <div className="voice-call-bar__controls">
        <VoiceControlButton
          label={muted ? t('voice.controls.unmute') : t('voice.controls.mute')}
          onClick={toggleMute}
          icon={muted ? <MicOffIcon /> : <MicOnIcon />}
          active={!muted}
          toggle
        />
        <VoiceControlButton
          label={deafened ? t('voice.controls.undeafen') : t('voice.controls.deafen')}
          onClick={toggleDeafened}
          icon={deafened ? <HeadsetOffIcon /> : <HeadsetIcon />}
          active={!deafened}
          toggle
        />
        <VoiceControlButton
          label={videoEnabled ? t('voice.controls.videoOff') : t('voice.controls.videoOn')}
          onClick={toggleVideo}
          icon={videoEnabled ? <VideoOffIcon /> : <VideoOnIcon />}
          active={videoEnabled}
          toggle
        />
        <VoiceControlButton
          label={t('voice.controls.refreshDevices')}
          onClick={() => void refreshDevices()}
          icon={<RefreshIcon />}
          disabled={connectionStatus === 'connecting'}
        />
        {connectionStatus === 'error' ? (
          <VoiceControlButton
            label={t('voice.controls.retry')}
            onClick={() => void retry()}
            icon={<RetryIcon />}
          />
        ) : null}
      </div>
      <button
        type="button"
        className="voice-call-bar__leave"
        onClick={handleLeave}
        disabled={!canLeaveCall}
      >
        {t('voice.leave')}
      </button>
    </footer>
  );

  // Close dialog on ESC
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDevicesOpen(false);
    };
    if (devicesOpen) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [devicesOpen]);

  if (stageChannelActive) {
    return (
      <section className="voice-panel voice-panel--stage" aria-labelledby="voice-title">
        <header className="voice-panel__header">
          <span className="voice-panel__section-label">{sectionTitles.status}</span>
          <div className="voice-panel__title-row">
            <h2 id="voice-title">{t('voice.title')}</h2>
            <span
              className={clsx('voice-status', `voice-status--${connectionStatus}`)}
              role="status"
              aria-live="polite"
            >
              {statusLabel}
            </span>
          </div>
          {connectionStatus === 'error' && connectionError ? (
            <p className="voice-status__error" role="alert">
              {connectionError}
            </p>
          ) : null}
          {!roomSlug ? <p className="panel-empty">{t('voice.noRoomSelected')}</p> : null}
        </header>
        {roomSlug ? (
          <div className="voice-panel__stage-content">
            <div className="voice-card voice-card--stage">
              <StagePanel
                participants={participants}
                localParticipantId={localParticipantId}
                stats={voiceStats}
                screenShareQuality={screenShareQuality}
                onScreenShareQualityChange={setScreenShareQuality}
                onToggleHand={setHandRaised}
              />
            </div>
          </div>
        ) : null}
        {callBar}
      </section>
    );
  }

  const devicesDialog = devicesOpen
    ? createPortal(
        <div className="voice-devices-overlay" role="presentation" onClick={() => setDevicesOpen(false)}>
          <div
            className="voice-devices-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-devices-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="voice-devices-header">
              <h3 id="voice-devices-title">{sectionTitles.devices}</h3>
              <button type="button" className="ghost" onClick={() => setDevicesOpen(false)}>
                {t('common.close', { defaultValue: 'Закрыть' })}
              </button>
            </header>
            <div className="voice-devices-content">
              <div className="voice-mic-settings" role="group" aria-label={t('voice.microphoneSettings.label')}>
                <div className="voice-mic-settings__row voice-mic-settings__row--level">
                  <span className="voice-mic-settings__label">{t('voice.microphoneSettings.level')}</span>
                  <div className="voice-mic-settings__meter" role="meter" aria-valuenow={levelPercent} aria-valuemin={0} aria-valuemax={100}>
                    <div className="voice-mic-settings__meter-bar" style={{ width: `${levelPercent}%` }} />
                  </div>
                  <span className="voice-mic-settings__value">{levelPercent}%</span>
                </div>
                <label className="voice-mic-settings__row">
                  <span className="voice-mic-settings__label">{t('voice.microphoneSettings.gain')}</span>
                  <input
                    className="voice-mic-settings__slider"
                    type="range"
                    min={0.1}
                    max={4}
                    step={0.05}
                    value={voiceGain}
                    onChange={handleGainChange}
                    disabled={voiceAutoGain}
                    aria-valuemin={0.1}
                    aria-valuemax={4}
                    aria-valuenow={voiceGain}
                    aria-valuetext={gainValueText}
                  />
                  <span className="voice-mic-settings__value">{gainValueText}</span>
                </label>
                <label className="voice-mic-settings__toggle">
                  <input type="checkbox" checked={voiceAutoGain} onChange={handleAutoGainChange} />
                  <span>{t('voice.microphoneSettings.auto')}</span>
                </label>
              </div>

              <div className="voice-playback-settings" role="group" aria-label={t('voice.playbackSettings.label')}>
                <label className="voice-playback-settings__row">
                  <span className="voice-playback-settings__label">{t('voice.playbackSettings.volume')}</span>
                  <input
                    className="voice-playback-settings__slider"
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={voicePlaybackVolume}
                    onChange={handlePlaybackVolumeChange}
                    aria-valuemin={0}
                    aria-valuemax={2}
                    aria-valuenow={Number(voicePlaybackVolume.toFixed(2))}
                    aria-valuetext={playbackValueText}
                  />
                  <span className="voice-playback-settings__value">{playbackValueText}</span>
                </label>
              </div>

              <div className="voice-devices" role="group" aria-label={t('voice.devices.label')}>
                <label className="voice-device">
                  <span>{t('voice.devices.microphone')}</span>
                  <select value={selectedMicrophoneId ?? ''} onChange={(event) => selectMicrophone(event.target.value || null)}>
                    {devices.microphones.length === 0 ? (
                      <option value="">{t('voice.devices.none')}</option>
                    ) : (
                      devices.microphones.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t('voice.devices.unknown')}
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <label className="voice-device">
                  <span>{t('voice.devices.speaker')}</span>
                  <select
                    value={selectedSpeakerId ?? ''}
                    onChange={(event) => selectSpeaker(event.target.value || null)}
                    disabled={!isSetSinkIdSupported()}
                  >
                    {devices.speakers.length === 0 ? (
                      <option value="">{t('voice.devices.none')}</option>
                    ) : (
                      devices.speakers.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t('voice.devices.unknown')}
                        </option>
                      ))
                    )}
                  </select>
                  {!isSetSinkIdSupported() ? (
                    <span className="voice-device__hint">{t('voice.devices.sinkNotSupported')}</span>
                  ) : null}
                </label>
                <label className="voice-device">
                  <span>{t('voice.devices.camera')}</span>
                  <select value={selectedCameraId ?? ''} onChange={(event) => selectCamera(event.target.value || null)}>
                    {devices.cameras.length === 0 ? (
                      <option value="">{t('voice.devices.none')}</option>
                    ) : (
                      devices.cameras.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || t('voice.devices.unknown')}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <section className="voice-panel" aria-labelledby="voice-title">
      {devicesDialog}
      <header className="voice-panel__header">
        <span className="voice-panel__section-label">{sectionTitles.status}</span>
        <div className="voice-panel__title-row">
          <h2 id="voice-title">{t('voice.title')}</h2>
          <span
            className={clsx('voice-status', `voice-status--${connectionStatus}`)}
            role="status"
            aria-live="polite"
          >
            {statusLabel}
          </span>
        </div>
        {connectionStatus === 'error' && connectionError ? (
          <p className="voice-status__error" role="alert">
            {connectionError}
          </p>
        ) : null}
        {!roomSlug ? <p className="panel-empty">{t('voice.noRoomSelected')}</p> : null}
        <div className="voice-panel__actions">
          <button type="button" className="ghost" onClick={() => setDevicesOpen(true)}>
            {t('voice.devices.openButton', { defaultValue: 'Устройства и вход' })}
          </button>
        </div>
      </header>
      <div className="voice-panel__body">
        <div className="voice-panel__main">
          <section className="voice-card voice-card--channels" aria-labelledby="voice-channels-title">
            <div className="voice-card__header">
              <h3 id="voice-channels-title">{sectionTitles.channels}</h3>
            </div>
            <div className="voice-card__body voice-card__body--scroll">
              {channels.length === 0 ? (
                <p className="panel-empty">{t('voice.connectHint')}</p>
              ) : (
                <ul className="voice-channel-list">
                  {channels.map((channel) => {
                    const isActive = activeChannelId === channel.id;
                    const joinLabel = isActive ? t('voice.leave') : t('voice.join');
                    const disabled = connectionStatus === 'connecting' && isActive;
                    return (
                      <li key={channel.id}>
                        <button
                          type="button"
                          className={clsx('voice-channel-card', { 'voice-channel-card--active': isActive })}
                          onClick={() => void handleJoin(channel.id)}
                          disabled={disabled}
                          aria-pressed={isActive}
                          title={joinLabel}
                        >
                          <span className="voice-channel-card__icon" aria-hidden="true">
                            {isActive ? <PhoneHangupIcon /> : <PhoneIcon />}
                          </span>
                          <span className="voice-channel-card__details">
                            <span className="voice-channel-card__name">{channel.name}</span>
                            <span className="voice-channel-card__status">{joinLabel}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

        </div>

        <aside className="voice-panel__aside" aria-labelledby="voice-participants-title">
          <div className="voice-card voice-card--participants">
            <div className="voice-card__header">
              <h3 id="voice-participants-title">{sectionTitles.participants}</h3>
            </div>
            <div className="voice-card__body voice-card__body--scroll">
              {participants.length === 0 ? (
                <p className="panel-empty">{t('voice.empty')}</p>
              ) : (
                <ul className="voice-participants-list">
                  {participants.map((participant) => {
                    const activity = voiceActivity[participant.id];
                    const stream = remoteStreams[participant.id] ?? null;
                    const isLocal = participant.id === localParticipantId;
                    
                    // Don't log in render - it causes spam
                    // Stream availability will be logged in the audio playback effect
                    const participantVolume = voiceParticipantVolumes[participant.id] ?? 1;
                    const participantVolumeText = t('voice.playbackSettings.participantValue', {
                      value: Math.round(participantVolume * 100),
                    });
                    const participantVolumeLabel = t('voice.playbackSettings.participantSlider', {
                      name: participant.displayName,
                    });
                    const participantMenuLabel = t('voice.playbackSettings.participantMenu', {
                      defaultValue: 'Audio options for {{name}}',
                      name: participant.displayName,
                    });
                    return (
                      <VoiceParticipantRow
                        key={participant.id}
                        participantId={participant.id}
                        name={participant.displayName}
                        role={participant.role}
                        isLocal={isLocal}
                        muted={participant.muted}
                        deafened={participant.deafened}
                        videoEnabled={participant.videoEnabled}
                        speaking={activity?.speaking ?? false}
                        level={activity?.level ?? 0}
                        stream={isLocal ? null : stream}
                        speakerDeviceId={selectedSpeakerId}
                        youLabel={t('voice.participantYou')}
                        globalVolume={voicePlaybackVolume}
                        volume={participantVolume}
                        onVolumeChange={handleParticipantVolumeChange}
                        volumeAriaLabel={participantVolumeLabel}
                        volumeValueText={participantVolumeText}
                        menuLabel={participantMenuLabel}
                      />
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </aside>
      </div>
      {callBar}
    </section>
  );

}
