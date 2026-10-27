import { useEffect, useMemo, useRef } from 'react';

/**
 * The page's one audio element for previews. The Player's track preview and the genealogy
 * graph's previews play through it, so starting one stops the other. It is made when the first
 * user mounts, and when the last one goes it is paused, emptied (no `src`, reloaded so the
 * browser drops the clip) and its handlers are removed.
 */

/** What a user hears about its own preview; it is never told about another user's. */
export interface PreviewEvents {
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onError?: () => void;
  /** Another user started a preview: this one's has stopped. */
  onStopped?: () => void;
}

export interface PreviewAudio {
  /**
   * Plays `url` at `volume`, taking the element over from another user (whose preview stops).
   * The same clip again resumes where it was paused. Undefined when there is no element.
   */
  play: (url: string, volume: number) => Promise<void> | undefined;
  /** Pauses this user's preview; another user's is left alone. */
  pause: () => void;
  /** Stops this user's preview and rewinds it; another user's is left alone. */
  stop: () => void;
  /** Whether this user's preview is playing. */
  playing: () => boolean;
}

interface User {
  readonly events: PreviewEvents;
}

let element: HTMLAudioElement | null = null;
let users = 0;
/** The user whose clip the element holds, and the clip. */
let owner: User | null = null;
let ownerUrl: string | null = null;

/** Empties the element: paused, no clip, nothing left loading. */
function empty(audio: HTMLAudioElement) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
}

function acquire() {
  users += 1;
  if (element) return;
  const audio = new Audio();
  audio.onplay = () => owner?.events.onPlay?.();
  audio.onpause = () => owner?.events.onPause?.();
  // An end or an error queued for a clip another user has since replaced is not the new
  // clip's: a new clip clears the element's `ended` and `error`.
  audio.onended = () => {
    if (audio.ended) owner?.events.onEnded?.();
  };
  audio.onerror = () => {
    if (audio.error) owner?.events.onError?.();
  };
  element = audio;
}

function release(user: User) {
  users -= 1;
  const audio = element;
  if (!audio) return;
  if (owner === user) {
    owner = null;
    ownerUrl = null;
    if (users > 0) empty(audio);
  }
  if (users > 0) return;
  element = null;
  owner = null;
  ownerUrl = null;
  audio.onplay = null;
  audio.onpause = null;
  audio.onended = null;
  audio.onerror = null;
  empty(audio);
}

function play(user: User, url: string, volume: number) {
  const audio = element;
  if (!audio) return undefined;
  if (owner !== user || ownerUrl !== url) {
    const previous = owner;
    owner = user;
    ownerUrl = url;
    audio.src = url;
    if (previous !== user) previous?.events.onStopped?.();
  }
  audio.volume = volume;
  return audio.play();
}

/** The shared preview element, as `events`' user. Its functions keep their identity. */
export function usePreviewAudio(events: PreviewEvents): PreviewAudio {
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);
  const user = useMemo<User>(
    () => ({
      get events() {
        return eventsRef.current;
      },
    }),
    [],
  );

  useEffect(() => {
    acquire();
    return () => release(user);
  }, [user]);

  return useMemo<PreviewAudio>(
    () => ({
      play: (url, volume) => play(user, url, volume),
      pause: () => {
        if (owner === user) element?.pause();
      },
      stop: () => {
        if (owner !== user || !element) return;
        element.pause();
        element.currentTime = 0;
      },
      playing: () => owner === user && element !== null && !element.paused,
    }),
    [user],
  );
}
