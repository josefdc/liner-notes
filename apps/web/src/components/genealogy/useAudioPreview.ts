import { useState, useRef, useCallback, useMemo } from 'react';
import { type PreviewEvents, usePreviewAudio } from '../../hooks/usePreviewAudio';

/**
 * Hook to manage audio preview playback for genealogy graph nodes.
 * Separates audio playback concern from graph rendering.
 *
 * The clips play through the page's one preview element (`usePreviewAudio`): a preview started
 * here stops the Player's, and one started there stops this one (`playingNodeId` goes back to
 * null). A preview starts only from an explicit control, never on hover.
 *
 * `hasPreviewSupport` is false only while the browser refuses to play (autoplay blocked); it
 * comes back with the next clip that plays. A clip that cannot be loaded (preview links are
 * signed and expire within minutes) sets `unavailableNodeId` instead, until the next preview or
 * stop, so the preview can be tried again.
 */
export function useAudioPreview() {
  const playingNodeIdRef = useRef<string | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [playingNodeId, setPlayingNodeId] = useState<string | null>(null);
  const [hasPreviewSupport, setHasPreviewSupport] = useState(true);
  const [unavailableNodeId, setUnavailableNodeId] = useState<string | null>(null);

  // Track play state for UI feedback
  const events = useMemo<PreviewEvents>(() => {
    const ended = () => {
      setIsPlaying(false);
      playingNodeIdRef.current = null;
      setPlayingNodeId(null);
    };
    return {
      onPlay: () => setIsPlaying(true),
      onPause: () => setIsPlaying(false),
      onEnded: ended,
      onError: () => {
        setIsPlaying(false);
        // The clip could not be loaded: it has expired or is gone.
        if (playingNodeIdRef.current) setUnavailableNodeId(playingNodeIdRef.current);
        playingNodeIdRef.current = null;
        setPlayingNodeId(null);
      },
      // The Player's own preview took the element over.
      onStopped: ended,
    };
  }, []);
  const audio = usePreviewAudio(events);

  const playPreview = useCallback(
    (url: string, nodeId: string) => {
      // If same node, toggle pause/play
      if (playingNodeIdRef.current === nodeId && audio.playing()) {
        audio.pause();
        playingNodeIdRef.current = null;
        setPlayingNodeId(null);
        return;
      }

      playingNodeIdRef.current = nodeId;
      setPlayingNodeId(nodeId);
      setUnavailableNodeId(null);

      const playPromise = audio.play(url, 0.4); // Subtle preview volume
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
    },
    [audio],
  );

  const stopPreview = useCallback(() => {
    // Only a preview of the graph's: the Player's track preview is its own to stop.
    audio.stop();
    playingNodeIdRef.current = null;
    setPlayingNodeId(null);
    setIsPlaying(false);
    setUnavailableNodeId(null);
  }, [audio]);

  return {
    isPlaying,
    playingNodeId,
    hasPreviewSupport,
    unavailableNodeId,
    playPreview,
    stopPreview,
  };
}
