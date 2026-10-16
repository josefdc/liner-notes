import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Hook to manage audio preview playback for genealogy graph nodes.
 * Separates audio playback concern from graph rendering.
 */
export function useAudioPreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingNodeIdRef = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playingNodeId, setPlayingNodeId] = useState<string | null>(null);
  const [hasPreviewSupport, setHasPreviewSupport] = useState(true);

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

    const playPromise = audioRef.current.play();
    if (playPromise !== undefined) {
      playPromise.catch((error) => {
        console.log('Audio preview blocked:', error);
        setHasPreviewSupport(false);
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
  }, []);

  return {
    isPlaying,
    playingNodeId,
    hasPreviewSupport,
    playPreview,
    stopPreview,
  };
}
