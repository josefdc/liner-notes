import { useCallback, useMemo, useRef, useState } from 'react';
import {
  type PreviewAudio,
  type PreviewEvents,
  usePreviewAudio,
} from '../../hooks/usePreviewAudio';
import type { ShownLink } from './links';

/**
 * A/B listening: two tracks' previews, one after the other, through the page's one preview
 * element (`usePreviewAudio`). Starting it stops any other preview on the page, and another
 * preview started meanwhile stops it.
 */

/** A track to hear: its node id, its name, and its preview clip (null when it has none). */
export interface ListenTrack {
  id: string;
  name: string;
  url: string | null;
}

/** One preview of the pair, ready to play. */
export interface ListenStep {
  id: string;
  name: string;
  url: string;
}

/** What the detail panel offers: the pair to hear, or why there is none. */
export type ListeningPlan =
  | { kind: 'replay' }
  | { kind: 'missing'; names: string[] }
  | { kind: 'ready'; label: 'Hear the sample' | 'Hear both'; steps: [ListenStep, ListenStep] };

/**
 * The pair a selected track is heard with: the earlier record first (the link's source, where
 * the link gives a direction), then the later one; the selected track first otherwise. "Hear the
 * sample" for a sample, "Hear both" for any other relation. A replay keeps no previews (preview
 * links are signed and expire), and a track without a clip cannot be heard: either is said.
 */
export function listeningPlan({
  selected,
  current,
  link,
  replay,
}: {
  selected: ListenTrack;
  current: ListenTrack;
  link: ShownLink | null;
  replay: boolean;
}): ListeningPlan {
  if (replay) return { kind: 'replay' };
  const missing = [selected, current].filter((track) => !track.url);
  if (missing.length > 0) return { kind: 'missing', names: missing.map((track) => track.name) };
  const directed = link?.directionKnown === true && link.type !== 'producer';
  const selectedFirst = !directed || link.source === selected.id;
  const [a, b] = (selectedFirst ? [selected, current] : [current, selected]) as [
    ListenTrack,
    ListenTrack,
  ];
  return {
    kind: 'ready',
    label: directed && link.named === 'sample' ? 'Hear the sample' : 'Hear both',
    steps: [
      { id: a.id, name: a.name, url: a.url as string },
      { id: b.id, name: b.name, url: b.url as string },
    ],
  };
}

/** What a plan that cannot play says. */
export function unavailableText(plan: ListeningPlan): string | null {
  if (plan.kind === 'replay') {
    return 'Previews play in a live analysis: a replay does not keep them.';
  }
  if (plan.kind === 'missing') {
    return plan.names.length > 1
      ? 'The previews are not available for these tracks.'
      : `No preview is available for ${plan.names[0]}.`;
  }
  return null;
}

/** What is playing: the pair and the step (0 or 1); null when nothing is. */
export interface Listening {
  steps: readonly ListenStep[];
  index: number;
}

/** The preview volume, as the graph's other previews play. */
const VOLUME = 0.4;

export function useABListening() {
  const [playing, setPlaying] = useState<Listening | null>(null);
  // What the last pair ended with, when it did not play through (a clip that failed, audio the
  // browser blocked); cleared by the next start or stop.
  const [message, setMessage] = useState<string | null>(null);
  const stepsRef = useRef<readonly ListenStep[] | null>(null);
  const indexRef = useRef(0);
  // Each start or stop: a play() that settles for an earlier one is not this one's.
  const runRef = useRef(0);
  const audioRef = useRef<PreviewAudio | null>(null);

  const finish = useCallback((said: string | null) => {
    runRef.current += 1;
    stepsRef.current = null;
    setPlaying(null);
    setMessage(said);
  }, []);

  const playStep = useCallback(
    (index: number) => {
      const steps = stepsRef.current;
      const step = steps?.[index];
      if (!steps || !step) return;
      indexRef.current = index;
      setPlaying({ steps, index });
      const run = runRef.current;
      const started = audioRef.current?.play(step.url, VOLUME);
      if (started === undefined) {
        finish('Previews cannot play here.');
        return;
      }
      started.catch((error: unknown) => {
        if (run !== runRef.current || stepsRef.current !== steps) return;
        const name = error instanceof Error ? error.name : '';
        // The next step, a stop or another preview replaced this clip: nothing went wrong.
        if (name === 'AbortError') return;
        finish(
          name === 'NotAllowedError'
            ? 'The browser blocked the preview.'
            : `The preview of ${step.name} could not be played.`,
        );
      });
    },
    [finish],
  );

  const events = useMemo<PreviewEvents>(
    () => ({
      // The step's clip played through: the next one, or the pair is done.
      onEnded: () => {
        const steps = stepsRef.current;
        if (!steps) return;
        const next = indexRef.current + 1;
        if (next < steps.length) playStep(next);
        else finish(null);
      },
      onError: () => {
        const step = stepsRef.current?.[indexRef.current];
        if (step) finish(`The preview of ${step.name} could not be played.`);
      },
      // Another preview took the element over.
      onStopped: () => {
        if (stepsRef.current) finish(null);
      },
    }),
    [playStep, finish],
  );
  const audio = usePreviewAudio(events);
  audioRef.current = audio;

  /** Plays the pair from its first step (a pair playing stops first). */
  const start = useCallback(
    (steps: readonly ListenStep[]) => {
      runRef.current += 1;
      stepsRef.current = steps;
      setMessage(null);
      playStep(0);
    },
    [playStep],
  );

  /** Stops the pair, if it is playing. */
  const stop = useCallback(() => {
    if (stepsRef.current) audio.stop();
    finish(null);
  }, [audio, finish]);

  return { playing, message, start, stop };
}
