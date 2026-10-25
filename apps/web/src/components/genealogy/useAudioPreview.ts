import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook to manage audio preview playback for genealogy graph nodes.
 * Separates audio playback concern from graph rendering.
 *
 * `hasPreviewSupport` is false only while the browser refuses to play (autoplay blocked); it
 * comes back with the next clip that plays. A clip that cannot be loaded (preview links are
 * signed and expire within minutes) sets `unavailableNodeId` instead, until the next preview or
 * stop, so the node can be hovered again.
 */
export function useAudioPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingNodeIdRef = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playingNodeId, setPlayingNodeId] = useState<string | null>(null);
  const [hasPreviewSupport, setHasPreviewSupport] = useState(true);
  const [unavailableNodeId, setUnavailableNodeId] = useState<string | null>(null);

  // Initialize audio element once
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.volume = 0.4; // Subtle preview volume

    // Track play state for UI feedback
    audioRef.current.onplay = () => setIsPlaying(true);
    audioRef.current.onpause = () => setIsPlaying(false);
    audioRef.current.onended = () => {
      setIsPlaying(false);
      playingNodeIdRef.current = null;
      setPlayingNodeId(null);
    };
    audioRef.current.onerror = () => {
      setIsPlaying(false);
      // The clip could not be loaded: it has expired or is gone.
      if (playingNodeIdRef.current) setUnavailableNodeId(playingNodeIdRef.current);
      playingNodeIdRef.current = null;
      setPlayingNodeId(null);
    };

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const playPreview = useCallback((url: string, nodeId: string) => {
    if (!audioRef.current) return;

    // If same node, toggle pause/play
    if (playingNodeIdRef.current === nodeId && !audioRef.current.paused) {
      audioRef.current.pause();
      playingNodeIdRef.current = null;
      setPlayingNodeId(null);
      return;
    }

    audioRef.current.src = url;
    playingNodeIdRef.current = nodeId;
    setPlayingNodeId(nodeId);
    setUnavailableNodeId(null);

    const playPromise = audioRef.current.play();
    if (playPromise !== undefined) {
      playPromise
        .then(() => setHasPreviewSupport(true))
        .catch((error: unknown) => {
          const name = error instanceof Error ? error.name : '';
          // Another preview or a stop interrupted this one: nothing went wrong.
          if (name === 'AbortError') return;
          if (name === 'NotAllowedError') {
            console.log('Audio preview blocked by the browser');
            setHasPreviewSupport(false);
            return;
          }
          // Any other failure is this clip's (an expired link): only it is unavailable.
          if (playingNodeIdRef.current === nodeId) {
            playingNodeIdRef.current = null;
            setPlayingNodeId(null);
          }
          setUnavailableNodeId(nodeId);
        });
    }
  }, []);

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    playingNodeIdRef.current = null;
    setPlayingNodeId(null);
    setIsPlaying(false);
    setUnavailableNodeId(null);
  }, []);

  return {
    isPlaying,
    playingNodeId,
    hasPreviewSupport,
    unavailableNodeId,
    playPreview,
    stopPreview,
  };
}
