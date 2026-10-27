import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { SearchCandidate } from '@liner-notes/contract';
import { oneRowPerRecording } from '@liner-notes/contract/picker';

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
/**
 * How many suggestions are asked for: the API's most (its `limit` is 1-10), so that merging
 * duplicates still leaves a full list.
 */
export const SUGGEST_LIMIT = 10;
/** How many suggestions are shown. */
export const SUGGESTIONS_SHOWN = 5;
/** Shorter text gets no suggestions: the API asks for at least two characters. */
const MIN_QUERY_LENGTH = 2;

/**
 * The suggestions with each recording listed once, by the rule the API applies to the track
 * picker's rows (the contract's `oneRowPerRecording`): Spotify often lists one recording twice
 * (the album track and its single, a reissue, a compilation), and the rows would look the same.
 * Rows are one recording when they share an ISRC and an explicit value and their lengths are
 * within 2 s of the kept row's; the earliest known release is kept, in the place of the first
 * listed. Rows without an ISRC or a length are never merged, so the search box and the picker
 * offer the same rows for the same results.
 */
export function mergeDuplicates(candidates: SearchCandidate[]): SearchCandidate[] {
  return oneRowPerRecording(candidates);
}

interface SuggestionState {
  suggestions: SearchCandidate[];
  /** The text the suggestions answer, or whose request failed. */
  answeredFor: string | null;
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
  | { type: 'loaded'; query: string; suggestions: SearchCandidate[]; open: boolean }
  | { type: 'failed'; query: string }
  | { type: 'clear' }
  | { type: 'edited' }
  | { type: 'highlight'; index: number }
  | { type: 'show'; open: true }
  /** `stopped`: the request under way was dropped too. */
  | { type: 'show'; open: false; stopped: boolean };

const initialState: SuggestionState = {
  suggestions: [],
  answeredFor: null,
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
        answeredFor: action.query,
        open: action.open && action.suggestions.length > 0,
        highlighted: -1,
        isLoading: false,
        failed: false,
      };
    case 'failed':
      // The text counts as answered (with nothing), so it is not asked for again until edited.
      return { ...initialState, failed: true, answeredFor: action.query };
    case 'clear':
      return initialState;
    case 'edited':
      // The highlighted suggestion was for the text before the edit. Nothing to change is no
      // new state, so no render.
      return state.highlighted === -1 ? state : { ...state, highlighted: -1 };
    case 'highlight':
      return { ...state, highlighted: action.index };
    case 'show':
      return action.open
        ? { ...state, open: state.suggestions.length > 0 }
        : {
            ...state,
            open: false,
            highlighted: -1,
            isLoading: action.stopped ? false : state.isLoading,
          };
  }
}

/**
 * Suggestions for the text in the search box, asked for once typing pauses. Each new request
 * aborts the one before it, and only the latest request's answer is shown: an answer that
 * arrives late, for older text, never replaces or reorders the list.
 *
 * Text the box was given rather than typed (the text at mount, a picked suggestion, a submitted
 * search: see `settle`) gets no suggestions until it is edited, so the list does not open again
 * by itself after a pick. A list the user closed (`dismiss`: Escape; `leave`: the focus left)
 * stays closed until the text is edited or the list is asked for again (`reopen`).
 *
 * `fetchSuggestions` must keep one identity (useAgent's `searchSuggest` does): a new one asks
 * for the current text again.
 */
export function useSuggestions(
  query: string,
  fetchSuggestions: SuggestionFetcher,
  {
    delay = SUGGEST_DELAY_MS,
    limit = SUGGEST_LIMIT,
    shown = SUGGESTIONS_SHOWN,
  }: { delay?: number; limit?: number; shown?: number } = {},
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // The text that needs no suggestions. The text at mount is not being typed: it is a search
  // the box comes back to (after "Search again"), and was already submitted.
  const settled = useRef<string | null>(query);
  // The user closed the list: an answer that comes now does not open it.
  const closed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    request.current?.abort();
    request.current = null;
  }, []);

  /** Asks for suggestions for `text` now. */
  const ask = useCallback(
    (text: string) => {
      const controller = new AbortController();
      request.current = controller;
      dispatch({ type: 'start' });
      let answer: Promise<SearchCandidate[]>;
      try {
        answer = fetchSuggestions(text, limit, controller.signal);
      } catch (error) {
        // A fetcher that throws instead of rejecting fails the same way.
        answer = Promise.reject(error);
      }
      answer.then(
        (results) => {
          if (request.current !== controller) return;
          request.current = null;
          dispatch({
            type: 'loaded',
            query: text,
            suggestions: mergeDuplicates(results).slice(0, shown),
            open: !closed.current,
          });
        },
        () => {
          // An aborted request was replaced or dropped on purpose: it is not a failure.
          if (request.current !== controller) return;
          request.current = null;
          dispatch({ type: 'failed', query: text });
        },
      );
    },
    [fetchSuggestions, limit, shown],
  );

  useEffect(() => {
    if (query === settled.current) return;
    settled.current = null;
    closed.current = false;
    // Any request under way is for older text: it is aborted now, not once typing pauses.
    stop();
    if (query.length < MIN_QUERY_LENGTH) {
      dispatch({ type: 'clear' });
      return;
    }
    dispatch({ type: 'edited' });
    timer.current = setTimeout(() => {
      timer.current = undefined;
      ask(query);
    }, delay);
  }, [query, ask, delay, stop]);

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

  /**
   * The user closes the list (Escape): it stays closed, and the suggestions asked for while
   * typing are dropped, so no answer opens it again.
   */
  const dismiss = useCallback(() => {
    closed.current = true;
    stop();
    dispatch({ type: 'show', open: false, stopped: true });
  }, [stop]);

  /**
   * The focus leaves the box: the list closes, and nothing more is asked for. A request under
   * way finishes, but its answer is only kept, to show when the focus comes back (`reopen`).
   */
  const leave = useCallback(() => {
    closed.current = true;
    clearTimeout(timer.current);
    timer.current = undefined;
    dispatch({ type: 'show', open: false, stopped: false });
  }, []);

  /**
   * The user wants the list (an arrow key, the focus back in the box). It opens at once when it
   * holds the answer for the current text, and true is returned. Text answered with no
   * suggestions, or whose request failed, is not asked for again: only an edit asks again.
   * Otherwise the current text is asked for now (unless it is settled, too short or already
   * being asked for), and the list opens with the answer.
   */
  const reopen = () => {
    closed.current = false;
    if (state.answeredFor === query) {
      if (state.suggestions.length === 0) return false;
      dispatch({ type: 'show', open: true });
      return true;
    }
    const pending = timer.current !== undefined || request.current !== null;
    if (!pending && query !== settled.current && query.length >= MIN_QUERY_LENGTH) ask(query);
    return false;
  };

  const highlight = useCallback((index: number) => dispatch({ type: 'highlight', index }), []);

  return { ...state, settle, dismiss, leave, reopen, highlight };
}
