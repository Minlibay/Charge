import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CSSProperties, ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useWorkspaceStore } from '../../state/workspaceStore';
import { applyOutputDevice, isSetSinkIdSupported } from '../../webrtc/devices';
import { logger } from '../../services/logger';
import {
  MicIcon,
  MicOffIcon,
  HeadphonesIcon,
  HeadphonesOffIcon,
  VideoIcon,
  VideoOffIcon,
  Volume2Icon,
  VolumeXIcon,
} from '../icons/LucideIcons';

interface VoiceParticipantRowProps {
  participantId: number;
  name: string;
  role: string;
  isLocal: boolean;
  muted: boolean;
  deafened: boolean;
  listenerDeafened: boolean;
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
  analyser: AnalyserNode;
  destination: MediaStreamAudioDestinationNode;
  stream: MediaStream;
}

function VoiceParticipantRow({
  participantId,
  name,
  role,
  isLocal,
  muted,
  deafened,
  listenerDeafened,
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
  const lastStreamIdRef = useRef<string | null>(null);
  const isSettingUpRef = useRef(false);
  const usingDirectPlaybackRef = useRef(false);
  const directPlaybackStreamIdRef = useRef<string | null>(null);
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
      chain.analyser.disconnect();
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
      remoteDeafened: deafened,
      listenerDeafened,
    });
    
    // Skip if local participant (no audio playback needed)
    if (isLocal) {
      logger.debug('Skipping audio setup for local participant', { participantId });
      return;
    }
    
    // Prevent infinite recursion - check if we're already setting up
    if (isSettingUpRef.current) {
      logger.debug('Audio setup already in progress, skipping', { participantId });
      return;
    }
    
    // Check store for stream if not in prop (reactivity issue)
    let streamToUse = stream;
    if (!streamToUse) {
      const store = useWorkspaceStore.getState();
      streamToUse = store.voiceRemoteStreams[participantId] ?? null;
      if (streamToUse) {
        logger.debug('Stream not in prop but found in store', {
          participantId,
          streamId: streamToUse.id,
        });
      }
    }
    
    // Check if stream actually changed (by ID, not reference)
    const currentStreamId = streamToUse?.id ?? null;
    if (currentStreamId === lastStreamIdRef.current && playbackChainRef.current) {
      logger.debug('Stream ID unchanged, skipping audio setup', {
        participantId,
        streamId: currentStreamId,
      });
      return;
    }
    
    // Wait for audio element to be available in DOM
    let retryCount = 0;
    const maxRetries = 10;
    
    const checkAndSetup = () => {
      if (isSettingUpRef.current) {
        logger.debug('Setup already in progress, aborting retry', { participantId });
        return;
      }
      
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
      
      logger.debug('Audio element found, proceeding with setup', {
        participantId,
        retryCount,
        elementId: element.id,
        streamId: stream?.id,
      });
      
      isSettingUpRef.current = true;
      
      try {
        setupAudioPlaybackWithStream(element, streamToUse);
        if (streamToUse) {
          lastStreamIdRef.current = streamToUse.id;
        }
      } finally {
        isSettingUpRef.current = false;
      }
    };
    
    requestAnimationFrame(checkAndSetup);
    
    function setupAudioPlaybackWithStream(element: HTMLAudioElement, streamToUse: MediaStream | null) {
      if (!streamToUse) {
        const store = useWorkspaceStore.getState();
        const streamInStore = store.voiceRemoteStreams[participantId];
        
        if (streamInStore) {
          logger.debug('Stream not in prop but found in store, using store stream', {
            participantId,
            streamId: streamInStore.id,
          });
          streamToUse = streamInStore;
        } else {
          logger.debug('No stream available yet (first render)', { participantId });
          usingDirectPlaybackRef.current = false;
          directPlaybackStreamIdRef.current = null;
          lastStreamIdRef.current = null;
          return;
        }
      }
      
      if (
        usingDirectPlaybackRef.current &&
        directPlaybackStreamIdRef.current === streamToUse.id
      ) {
        logger.debug('Using existing direct audio playback path', {
          participantId,
          streamId: streamToUse.id,
          elementHasStream: element.srcObject ? 'set' : 'null',
        });
        if (element.srcObject !== streamToUse) {
          element.srcObject = streamToUse;
        }
        if (!listenerDeafened && element.paused) {
          const resumePromise = element.play();
          if (resumePromise) {
            void resumePromise.catch((error) => {
              logger.debug('Failed to resume direct playback', {
                participantId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
        lastStreamIdRef.current = streamToUse.id;
        return;
      }

      if (playbackChainRef.current && playbackChainRef.current.stream?.id === streamToUse.id) {
        logger.debug('Audio chain already exists for this stream ID', {
          participantId,
          streamId: streamToUse.id,
        });
        lastStreamIdRef.current = streamToUse.id;
        return;
      }
      
      lastStreamIdRef.current = streamToUse.id;
      usingDirectPlaybackRef.current = false;
      directPlaybackStreamIdRef.current = null;

      const previousChain = playbackChainRef.current;
      if (previousChain && previousChain.stream !== streamToUse) {
        logger.debug('Stream changed, disposing previous chain', {
          participantId,
          previousStreamId: previousChain.stream?.id,
          newStreamId: streamToUse.id,
        });
        disposePlaybackChain(previousChain);
        playbackChainRef.current = null;
      }
      
      const audioTracks = streamToUse.getAudioTracks();
      logger.warn('=== STREAM ANALYSIS ===', {
        participantId,
        streamId: streamToUse.id,
        audioTracksCount: audioTracks.length,
        videoTracksCount: streamToUse.getVideoTracks().length,
        totalTracksCount: streamToUse.getTracks().length,
      });
      
      if (audioTracks.length === 0) {
        const store = useWorkspaceStore.getState();
        const allStreams = store.voiceRemoteStreams;
        const streamInStore = allStreams[participantId];
        
        logger.warn('=== NO STREAM FOR PARTICIPANT ===', {
          participantId,
          isLocal,
          streamProp: stream ? 'provided' : 'null',
          streamInStore: streamInStore ? 'exists in store' : 'missing in store',
        });
        
        if (streamInStore && !stream) {
          logger.warn('Stream exists in store but not in prop - using store stream directly', {
            participantId,
            streamId: streamInStore.id,
            audioTracks: streamInStore.getAudioTracks().length,
          });
          if (!isSettingUpRef.current) {
            setupAudioPlaybackWithStream(element, streamInStore);
          }
          return;
        }
        
        if (previousChain) {
          disposePlaybackChain(previousChain);
          playbackChainRef.current = null;
        }
        if (element.srcObject) {
          element.srcObject = null;
        }
        return;
      }

      const AudioContextCtor: typeof AudioContext | undefined =
        typeof window !== 'undefined'
          ? window.AudioContext ||
            (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
          : undefined;

      if (!AudioContextCtor) {
        logger.debug('AudioContext not available, using direct audio element', { participantId });
        if (previousChain) {
          disposePlaybackChain(previousChain);
          playbackChainRef.current = null;
        }
        element.srcObject = streamToUse;
        element.volume = Math.min(Math.max(volumeRef.current, 0), 1);
        const playPromise = element.play();
        if (playPromise !== undefined) {
          void playPromise.catch((error) => {
            logger.debug('Failed to play audio element', { participantId, error: error instanceof Error ? error.message : String(error) });
          });
        }
        return () => {
          if (element.srcObject === streamToUse) {
            element.srcObject = null;
          }
        };
      }

      if (previousChain && previousChain.stream === streamToUse) {
        logger.debug('Reusing existing audio chain for participant', { participantId });
        if (element.srcObject !== previousChain.destination.stream) {
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
              element.srcObject = previousChain.destination.stream;
              if (element.paused) {
                playPromiseRef.current = element.play() ?? null;
                if (playPromiseRef.current) {
                  void playPromiseRef.current.catch(() => {});
                }
              }
            });
          } else {
            element.srcObject = previousChain.destination.stream;
            if (element.paused) {
              playPromiseRef.current = element.play() ?? null;
              if (playPromiseRef.current) {
                void playPromiseRef.current.catch(() => {});
              }
            }
          }
        } else {
          previousChain.gain.gain.setTargetAtTime(volumeRef.current, previousChain.context.currentTime, 0.05);
          void previousChain.context.resume().catch(() => {});
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

      logger.debug('=== CREATING NEW AUDIO CHAIN ===', {
        participantId,
        streamId: streamToUse.id,
        audioTracksInStream: streamToUse.getAudioTracks().length,
      });
      
      const context = new AudioContextCtor();
      logger.debug('AudioContext created', {
        participantId,
        contextState: context.state,
        sampleRate: context.sampleRate,
      });
      
      const audioTracksBeforeSource = streamToUse.getAudioTracks();
      const unmutedTracks = audioTracksBeforeSource.filter(t => !t.muted && t.enabled && t.readyState === 'live');
      
      let source: MediaStreamAudioSourceNode;
      try {
        source = context.createMediaStreamSource(streamToUse);
        logger.warn('MediaStreamSource created', {
          participantId,
          sourceChannelCount: source.channelCount,
          unmutedTracksCount: unmutedTracks.length,
          totalTracksCount: audioTracksBeforeSource.length,
        });
      } catch (error) {
        logger.error('Failed to create MediaStreamSource', error instanceof Error ? error : new Error(String(error)), {
          participantId,
          streamId: streamToUse.id,
          audioTracks: streamToUse.getAudioTracks().length,
        });
        return;
      }
    
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
    
      const sourceAnalyser = context.createAnalyser();
      sourceAnalyser.fftSize = 256;
      source.connect(sourceAnalyser);
      
      const gainAnalyser = context.createAnalyser();
      gainAnalyser.fftSize = 256;
      
      sourceAnalyser.connect(gain);
      gain.connect(gainAnalyser);
      gainAnalyser.connect(destination);

      const analyser = gainAnalyser;

      const trackListeners: Array<() => void> = [];
      let fallbackTriggered = false;
      const fallbackToDirectPlayback = (reason: string) => {
        if (fallbackTriggered || !streamToUse) {
          return;
        }
        if (listenerDeafened) {
          logger.debug('Skipping direct playback fallback because listener is deafened', {
            participantId,
            reason,
          });
          return;
        }
        fallbackTriggered = true;
        usingDirectPlaybackRef.current = true;
        directPlaybackStreamIdRef.current = streamToUse.id;
        lastStreamIdRef.current = streamToUse.id;

        logger.warn('Falling back to direct audio element playback', {
          participantId,
          streamId: streamToUse.id,
          reason,
        });

        trackListeners.forEach((cleanup) => cleanup());
        trackListeners.length = 0;

        const activeChain = playbackChainRef.current;
        if (activeChain && activeChain.stream === streamToUse) {
          disposePlaybackChain(activeChain);
        } else {
          disposePlaybackChain({ context, source, gain, analyser, destination, stream: streamToUse });
        }
        playbackChainRef.current = null;
        playPromiseRef.current = null;

        element.srcObject = streamToUse;
        const fallbackVolume = Math.min(Math.max(volumeRef.current, 0), 1);
        element.volume = fallbackVolume;
        if (listenerDeafened || isLocal) {
          element.muted = true;
          return;
        }
        const fallbackPlayPromise = element.play();
        if (fallbackPlayPromise) {
          void fallbackPlayPromise.catch((error) => {
            logger.debug('Failed to start direct playback fallback', {
              participantId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      };

      const initialGain = (listenerDeafened || isLocal) ? 0 : volumeRef.current;
      const clampedGain = initialGain > 0 && initialGain < 0.02 ? 0.02 : initialGain;
      gain.gain.setValueAtTime(clampedGain, context.currentTime);
      
      const checkAudioData = () => {
        const sourceDataArray = new Uint8Array(sourceAnalyser.frequencyBinCount);
        sourceAnalyser.getByteFrequencyData(sourceDataArray);
        const sourceMaxValue = Math.max(...sourceDataArray);
        const sourceHasAudio = sourceMaxValue > 0;
        
        const gainDataArray = new Uint8Array(gainAnalyser.frequencyBinCount);
        gainAnalyser.getByteFrequencyData(gainDataArray);
        const gainMaxValue = Math.max(...gainDataArray);
        const gainHasAudio = gainMaxValue > 0;
        
        logger.debug('Audio data check', {
          participantId,
          sourceHasAudio,
          sourceMaxFrequencyValue: sourceMaxValue,
          gainHasAudio,
          gainMaxFrequencyValue: gainMaxValue,
        });
        
        if (!sourceHasAudio) {
          const sourceTracks = streamToUse.getAudioTracks();
          const liveUnmutedTracks = sourceTracks.filter(t => t.readyState === 'live' && !t.muted && t.enabled);
          if (!fallbackTriggered && liveUnmutedTracks.length > 0 && !listenerDeafened) {
            fallbackToDirectPlayback('no-audio-data-from-source');
          }
        }
      };
      
      setTimeout(checkAudioData, 2000);
      
      logger.debug('Audio chain connected and gain set', {
        participantId,
        initialGain,
        clampedGain,
        listenerDeafened,
        isLocal,
        volumeRef: volumeRef.current,
        actualGainValue: gain.gain.value,
      });

      playbackChainRef.current = { context, source, gain, analyser, destination, stream: streamToUse };
      
      logger.debug('Playback chain stored', {
        participantId,
        chainStreamId: playbackChainRef.current.stream.id,
        destinationStreamId: destination.stream.id,
      });

      let playAfterSet = true;
      if (element.srcObject && element.srcObject !== destination.stream) {
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
          element.srcObject = destination.stream;
          element.volume = 1.0;
        }
      } else {
        element.srcObject = destination.stream;
        element.volume = 1.0;
      }
      
      const allTracks = streamToUse.getTracks();
      
      allTracks.forEach((track) => {
        if (track.kind !== 'audio') {
          return;
        }
        
        const handleUnmute = () => {
          logger.debug('Audio track unmuted for participant', { participantId, trackId: track.id });
          if (!track.enabled) {
            track.enabled = true;
          }
          void context.resume().then(() => {
            if (element.paused && !playPromiseRef.current) {
              playPromiseRef.current = element.play() ?? null;
              if (playPromiseRef.current) {
                void playPromiseRef.current.finally(() => {
                  playPromiseRef.current = null;
                }).catch((error) => {
                  playPromiseRef.current = null;
                  if (error.name !== 'AbortError') {
                    logger.debug('Failed to play after unmute', { participantId, error: error instanceof Error ? error.message : String(error) });
                  }
                });
              }
            }
          }).catch(() => {});
        };
        
        const handleMute = () => {
          logger.debug('Audio track muted for participant', { participantId, trackId: track.id });
          if (!track.enabled) {
            track.enabled = true;
          }
        };
        
        const handleStarted = () => {
          logger.debug('Audio track started for participant', { participantId, trackId: track.id });
          if (!track.enabled) {
            track.enabled = true;
          }
          void context.resume().catch(() => {});
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
      
      const handleAddTrack = (event: MediaStreamTrackEvent) => {
        logger.debug('Track added to stream for participant', { participantId, trackId: event.track.id, kind: event.track.kind });
        if (event.track.kind === 'audio' && !event.track.enabled) {
          event.track.enabled = true;
        }
      };
      
      const handleRemoveTrack = (event: MediaStreamTrackEvent) => {
        logger.debug('Track removed from stream for participant', { participantId, trackId: event.track.id, kind: event.track.kind });
      };
      
      streamToUse.addEventListener('addtrack', handleAddTrack);
      streamToUse.addEventListener('removetrack', handleRemoveTrack);
      
      trackListeners.push(() => {
        streamToUse.removeEventListener('addtrack', handleAddTrack);
        streamToUse.removeEventListener('removetrack', handleRemoveTrack);
      });
      
      const startPlayback = async () => {
        logger.warn('=== STARTING PLAYBACK ===', {
          participantId,
          contextState: context.state,
          elementSrcObject: element.srcObject ? 'set' : 'null',
          expectedSrcObject: destination.stream.id,
          srcObjectMatches: element.srcObject === destination.stream,
          elementPaused: element.paused,
          hasPendingPlay: Boolean(playPromiseRef.current),
        });
        
        try {
          const beforeResume = context.state;
          await context.resume();
          logger.debug('Audio context resumed', {
            participantId,
            beforeState: beforeResume,
            afterState: context.state,
          });
        } catch (error) {
          logger.error('Failed to resume audio context', error instanceof Error ? error : new Error(String(error)), {
            participantId,
            contextState: context.state,
          });
          return;
        }
        
        if (element.srcObject !== destination.stream) {
          logger.warn('srcObject mismatch before play', {
            participantId,
            currentSrcObject: element.srcObject ? 'different stream' : 'null',
            expectedStreamId: destination.stream.id,
          });
          element.srcObject = destination.stream;
          element.volume = 1.0;
        }
        
        const canPlay = element.srcObject === destination.stream && element.paused && !playPromiseRef.current;
        logger.warn('Playback readiness check', {
          participantId,
          canPlay,
          srcObjectMatches: element.srcObject === destination.stream,
          elementPaused: element.paused,
          hasPendingPlay: Boolean(playPromiseRef.current),
        });
        
        if (canPlay) {
          try {
            logger.warn('Calling element.play()', {
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
              
              logger.warn('Audio playback started successfully', {
                participantId,
                elementPaused: element.paused,
                elementReadyState: element.readyState,
                contextState: context.state,
              });
            } else {
              logger.warn('element.play() returned undefined', { participantId });
            }
          } catch (error) {
            playPromiseRef.current = null;
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
            });
            setTimeout(() => {
              if (element.srcObject === destination.stream && element.paused && !playPromiseRef.current) {
                logger.debug('Retrying play after error', { participantId });
                playPromiseRef.current = element.play() ?? null;
                if (playPromiseRef.current) {
                  void playPromiseRef.current.finally(() => {
                    playPromiseRef.current = null;
                  }).catch((retryError) => {
                    playPromiseRef.current = null;
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
      
      void startPlayback();

      return () => {
        logger.debug('Cleaning up audio chain for participant', { participantId });
        trackListeners.forEach(cleanup => cleanup());
        playPromiseRef.current = null;
        const activeChain = playbackChainRef.current;
        if (activeChain && activeChain.stream === streamToUse) {
          disposePlaybackChain(activeChain);
          playbackChainRef.current = null;
        }
        if (
          usingDirectPlaybackRef.current &&
          streamToUse &&
          directPlaybackStreamIdRef.current === streamToUse.id
        ) {
          usingDirectPlaybackRef.current = false;
          directPlaybackStreamIdRef.current = null;
          if (element.srcObject === streamToUse) {
            element.srcObject = null;
          }
        }
      };
    }
    
    return () => {
      isSettingUpRef.current = false;
    };
  }, [disposePlaybackChain, stream, participantId, deafened, listenerDeafened, isLocal, speaking]);

  useEffect(() => {
    const element = audioRef.current;
    const chain = playbackChainRef.current;
    const desiredVolume = listenerDeafened ? 0 : volumeRef.current;
    if (chain) {
      chain.gain.gain.setTargetAtTime(desiredVolume, chain.context.currentTime, 0.05);
    } else if (element) {
      element.volume = Math.min(Math.max(desiredVolume, 0), 1);
    }
  }, [combinedVolume, listenerDeafened]);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) {
      return;
    }
    const shouldMute = listenerDeafened || isLocal;
    element.muted = shouldMute;
    if (!shouldMute) {
      const playPromise = element.play();
      if (playPromise !== undefined) {
        void playPromise.catch(() => {});
      }
      const chain = playbackChainRef.current;
      if (chain) {
        void chain.context.resume().catch(() => {});
      }
    }
  }, [listenerDeafened, isLocal]);

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
  const volumePercent = useMemo(() => Math.round(safeVolume * 100), [safeVolume]);
  const isOutputMuted = listenerDeafened;

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
        {!isLocal && (
          <div className="voice-participant__volume-bar">
            <div className="voice-participant__volume-bar-container">
              <div 
                className="voice-participant__volume-bar-fill" 
                style={{ width: `${volumePercent}%` } as CSSProperties}
              />
            </div>
            <span className="voice-participant__volume-bar-text">{volumePercent}%</span>
          </div>
        )}
      </div>
      <div className="voice-participant__status">
        <div className="voice-participant__indicators" role="group" aria-label="Media state">
          <span
            className={clsx('voice-indicator', 'voice-indicator--mic', { 'is-off': muted })}
            aria-hidden="true"
            title={muted ? 'Microphone muted' : 'Microphone active'}
          >
            {muted ? <MicOffIcon size={16} strokeWidth={2} /> : <MicIcon size={16} strokeWidth={2} />}
          </span>
          <span
            className={clsx('voice-indicator', 'voice-indicator--deaf', { 'is-off': !deafened })}
            aria-hidden="true"
            title={deafened ? 'Deafened' : 'Listening'}
          >
            {deafened ? (
              <HeadphonesOffIcon size={16} strokeWidth={2} />
            ) : (
              <HeadphonesIcon size={16} strokeWidth={2} />
            )}
          </span>
          {!isLocal && (
            <span
              className={clsx('voice-indicator', 'voice-indicator--speaker', { 'is-off': isOutputMuted })}
              aria-hidden="true"
              title={isOutputMuted ? 'Output muted' : 'Output active'}
            >
              {isOutputMuted ? (
                <VolumeXIcon size={16} strokeWidth={2} />
              ) : (
                <Volume2Icon size={16} strokeWidth={2} />
              )}
            </span>
          )}
          <span
            className={clsx('voice-indicator', 'voice-indicator--video', { 'is-off': !videoEnabled })}
            aria-hidden="true"
            title={videoEnabled ? 'Video enabled' : 'Video disabled'}
          >
            {videoEnabled ? <VideoIcon size={16} strokeWidth={2} /> : <VideoOffIcon size={16} strokeWidth={2} />}
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

export function VoiceParticipantsPanel(): JSX.Element {
  const { t } = useTranslation();
  const roomSlug = useWorkspaceStore((state) => state.selectedRoomSlug);
  const participants = useWorkspaceStore((state) =>
    state.selectedRoomSlug ? state.voiceParticipantsByRoom[state.selectedRoomSlug] ?? [] : [],
  );
  const connectionStatus = useWorkspaceStore((state) => state.voiceConnectionStatus);
  const deafened = useWorkspaceStore((state) => state.deafened);
  const voicePlaybackVolume = useWorkspaceStore((state) => state.voicePlaybackVolume);
  const voiceParticipantVolumes = useWorkspaceStore((state) => state.voiceParticipantVolumes);
  const setVoiceParticipantVolume = useWorkspaceStore((state) => state.setVoiceParticipantVolume);
  const voiceActivity = useWorkspaceStore((state) => state.voiceActivity);
  const remoteStreams = useWorkspaceStore((state) => state.voiceRemoteStreams);
  const localParticipantId = useWorkspaceStore((state) => state.voiceLocalParticipantId);
  const selectedSpeakerId = useWorkspaceStore((state) => state.selectedSpeakerId);

  const sectionTitles = useMemo(
    () => ({
      participants: t('voice.sections.participants', { defaultValue: 'Participants' }),
    }),
    [t],
  );

  const handleParticipantVolumeChange = useCallback(
    (participantId: number, value: number) => {
      setVoiceParticipantVolume(participantId, value);
    },
    [setVoiceParticipantVolume],
  );

  return (
    <section className="voice-participants-panel" aria-labelledby="voice-participants-title">
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
                const roleLabel = t(`voice.role.${participant.role}`, { defaultValue: participant.role });
                return (
                  <VoiceParticipantRow
                    key={participant.id}
                    participantId={participant.id}
                    name={participant.displayName}
                    role={roleLabel}
                    isLocal={isLocal}
                    muted={participant.muted}
                    deafened={participant.deafened}
                    listenerDeafened={deafened}
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
    </section>
  );
}

