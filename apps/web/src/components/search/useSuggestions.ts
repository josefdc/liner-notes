import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { SearchCandidate } from '../../hooks/agent/types';

/**
 * Asks the API for suggestions (useAgent's `searchSuggest`). Rejects when the request fails, and
 * when `signal` aborts it.
 */
export type SuggestionFetcher = (
  query: string,
  limit?: number,
  signal?: AbortSignal,
) => Promise<SearchCandidate[]>;

/** How long typing pauses before suggestions are asked for. */
export const SUGGEST_DELAY_MS = 300;
/** How many suggestions are asked for. */
export const SUGGEST_LIMIT = 5;
/** Shorter text gets no suggestions: the API asks for at least two characters. */
const MIN_QUERY_LENGTH = 2;

const normalized = (text: string) =>
  text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * The suggestions with each song listed once. Two suggestions with the same title and artist
 * (case and spacing aside) are the same song for the person choosing, even when Spotify lists
 * it twice: an album track and its single, or a reissue. The first one is kept, in its place:
 * Spotify's own order ranks it as the closer match, and the suggestions carry nothing better to
 * choose by (Spotify no longer gives this app a popularity score, and the API sends no release
 * date with a suggestion). A title that differs ("Midnight City - Remix") is another song.
 */
export function mergeDuplicates(candidates: SearchCandidate[]): SearchCandidate[] {
  const songs = new Set<string>();
  const ids = new Set<string>();
  return candidates.filter((candidate) => {
    const song = `${normalized(candidate.title)}\u0000${normalized(candidate.artist)}`;
    if (songs.has(song) || ids.has(candidate.id)) return false;
    songs.add(song);
    ids.add(candidate.id);
    return true;
  });
}

interface SuggestionState {
  suggestions: SearchCandidate[];
  /** The list is shown. */
  open: boolean;
  /** The highlighted suggestion, or -1 for none. */
  highlighted: number;
  isLoading: boolean;
  /** The last request for suggestions failed. */
  failed: boolean;
}

type SuggestionAction =
  | { type: 'start' }
  | { type: 'loaded'; suggestions: SearchCandidate[] }
  | { type: 'failed' }
  | { type: 'clear' }
  | { type: 'highlight'; index: number }
  | { type: 'show'; open: boolean };

const initialState: SuggestionState = {
  suggestions: [],
  open: false,
  highlighted: -1,
  isLoading: false,
  failed: false,
};

function reducer(state: SuggestionState, action: SuggestionAction): SuggestionState {
  switch (action.type) {
    case 'start':
      return { ...state, isLoading: true };
    case 'loaded':
      return {
        suggestions: action.suggestions,
        open: action.suggestions.length > 0,
        highlighted: -1,
        isLoading: false,
        failed: false,
      };
    case 'failed':
      return { ...initialState, failed: true };
    case 'clear':
      return initialState;
    case 'highlight':
      return { ...state, highlighted: action.index };
    case 'show':
      return action.open
        ? { ...state, open: state.suggestions.length > 0 }
        : { ...state, open: false, highlighted: -1 };
  }
}

/**
 * Suggestions for the text in the search box, asked for once typing pauses. Each new request
 * aborts the one before it, and only the latest request's answer is shown: an answer that
 * arrives late, for older text, never replaces or reorders the list.
 *
 * Text the box was given rather than typed (the text at mount, a picked suggestion, a submitted
 * search: see `settle`) gets no suggestions until it is edited, so the list does not open again
 * by itself after a pick.
 */
export function useSuggestions(
  query: string,
  fetchSuggestions: SuggestionFetcher,
  { delay = SUGGEST_DELAY_MS, limit = SUGGEST_LIMIT }: { delay?: number; limit?: number } = {},
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // The text that needs no suggestions. The text at mount is not being typed: it is a search
  // the box comes back to (after "Search again"), and was already submitted.
  const settled = useRef<string | null>(query);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    request.current?.abort();
    request.current = null;
  }, []);

  useEffect(() => {
    if (query === settled.current) return;
    settled.current = null;
    // Any request under way is for older text: it is aborted now, not once typing pauses.
    stop();
    if (query.length < MIN_QUERY_LENGTH) {
      dispatch({ type: 'clear' });
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const controller = new AbortController();
      request.current = controller;
      dispatch({ type: 'start' });
      fetchSuggestions(query, limit, controller.signal).then(
        (results) => {
          if (request.current !== controller) return;
          request.current = null;
          dispatch({ type: 'loaded', suggestions: mergeDuplicates(results) });
        },
        () => {
          // An aborted request was replaced or dropped on purpose: it is not a failure.
          if (request.current !== controller) return;
          request.current = null;
          dispatch({ type: 'failed' });
        },
      );
    }, delay);
  }, [query, fetchSuggestions, limit, delay, stop]);

  useEffect(() => stop, [stop]);

  /**
   * The box now holds `text` without it being typed (a picked suggestion, a submitted search):
   * the list closes, any request under way is dropped, and `text` gets no suggestions.
   */
  const settle = useCallback(
    (text: string) => {
      settled.current = text;
      stop();
      dispatch({ type: 'clear' });
    },
    [stop],
  );
  const highlight = useCallback((index: number) => dispatch({ type: 'highlight', index }), []);
  /** Shows the list again (when it has suggestions), or hides it. */
  const show = useCallback((open: boolean) => dispatch({ type: 'show', open }), []);

  return { ...state, settle, highlight, show };
}
