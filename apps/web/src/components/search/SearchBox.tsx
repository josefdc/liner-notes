import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { SearchCandidate } from '../../hooks/agent/types';
import { CoverThumb } from '../AlbumCover';
import { Button } from '../ui/Button';
import { inputVisualStyles } from '../ui/Input';
import { type SuggestionFetcher, useSuggestions } from './useSuggestions';

/** The box's name: the words its placeholder shows, so a spoken command can name it. */
const LABEL = 'Song title and artist';
const SUGGESTIONS_UNAVAILABLE = 'Suggestions are unavailable right now. You can still search.';

/** The text a suggestion puts in the box. */
const suggestionText = (candidate: SearchCandidate) => `${candidate.title} ${candidate.artist}`;

/**
 * The id of a track's option in the list of the box whose id is `boxId`: the same for as long as
 * the track is listed. A character an id cannot hold is written as its code, so two track ids
 * never give one option id.
 */
const optionIdFor = (boxId: string, trackId: string) =>
  `${boxId}-suggestion-${trackId.replace(/[^A-Za-z0-9-]/g, (character) => `_${character.codePointAt(0)?.toString(16)}_`)}`;

/** Gives `element` to a ref of either kind. */
function assignRef<T>(ref: React.Ref<T> | undefined, element: T | null) {
  if (typeof ref === 'function') ref(element);
  else if (ref) ref.current = element;
}

interface SearchBoxProps {
  /** The text in the box. The caller keeps it, so it outlives the box (the progress screen). */
  value: string;
  onValueChange: (value: string) => void;
  /** A typed search, trimmed. */
  onSearch: (query: string) => void;
  /** A suggestion chosen with Enter or a click: that very track is analysed. */
  onPick: (candidate: SearchCandidate) => void;
  fetchSuggestions: SuggestionFetcher;
  /** An analysis is starting: the Analyze button shows it. */
  isBusy?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
}

/**
 * The search box: a combobox (WAI-ARIA 1.2) whose suggestions are a listbox the arrow keys move
 * through while the focus stays in the box (aria-activedescendant), and the Analyze button.
 */
export function SearchBox({
  value,
  onValueChange,
  onSearch,
  onPick,
  fetchSuggestions,
  isBusy = false,
  inputRef,
}: SearchBoxProps) {
  const id = useId();
  const inputId = `${id}-input`;
  const listboxId = `${id}-suggestions`;
  const hintId = `${id}-hint`;

  const {
    suggestions,
    open,
    highlighted,
    isLoading,
    failed,
    settle,
    dismiss,
    leave,
    reopen,
    highlight,
  } = useSuggestions(value, fetchSuggestions);
  const listShown = open && suggestions.length > 0;
  const highlightedId =
    listShown && suggestions[highlighted]
      ? optionIdFor(id, suggestions[highlighted].id)
      : undefined;

  // Empty searches submitted since the text last changed: the box says what to type until it
  // changes. Each submit renders a new alert, so a repeat is announced again.
  const [emptySubmits, setEmptySubmits] = useState(0);
  const showEmptyHint = emptySubmits > 0 && !value.trim();

  const input = useRef<HTMLInputElement | null>(null);
  // One ref function for the box's whole life: an inline one would be called again (null, then
  // the element) on every render.
  const setInput = useCallback(
    (element: HTMLInputElement | null) => {
      input.current = element;
      assignRef(inputRef, element);
    },
    [inputRef],
  );

  // The highlighted suggestion stays in view: the focus stays in the box, so the browser does
  // not scroll the list by itself.
  useEffect(() => {
    if (highlightedId)
      document.getElementById(highlightedId)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlightedId]);

  /** Tab: the suggestion's text goes in the box, to edit or to search. */
  const fill = (candidate: SearchCandidate) => {
    const text = suggestionText(candidate);
    settle(text);
    onValueChange(text);
    input.current?.focus();
  };

  /** Enter or a click: the suggestion's own track is analysed. */
  const pick = (candidate: SearchCandidate) => {
    const text = suggestionText(candidate);
    settle(text);
    onValueChange(text);
    onPick(candidate);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Keys that choose or commit an input method's candidate (Japanese, Chinese, Korean…) belong
    // to the input method while it composes.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const count = suggestions.length;
    const current = listShown ? suggestions[highlighted] : undefined;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const down = event.key === 'ArrowDown';
        if (!listShown) {
          // The list was closed (Escape): the arrow opens it again, asking for the text when
          // the list holds no answer for it.
          if (reopen()) highlight(down ? 0 : count - 1);
          return;
        }
        if (down) highlight(highlighted < count - 1 ? highlighted + 1 : 0);
        else highlight(highlighted > 0 ? highlighted - 1 : count - 1);
        return;
      }
      case 'Enter':
        // With nothing highlighted, Enter submits the typed text.
        if (current) {
          event.preventDefault();
          pick(current);
        }
        return;
      case 'Escape':
        // Also drops the suggestions asked for while typing, so none opens the list later.
        if (listShown) event.preventDefault();
        dismiss();
        return;
      case 'Tab':
        // With nothing highlighted, Tab leaves the box, which closes the list (see the box's onBlur).
        if (current) {
          event.preventDefault();
          fill(current);
        }
        return;
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const query = value.trim();
    if (query) {
      setEmptySubmits(0);
      // The suggestions and their note are for the search being typed: once it is submitted,
      // the run says how it went.
      settle(value);
      onSearch(query);
    } else {
      setEmptySubmits((count) => count + 1);
      input.current?.focus();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* The list belongs to the box: it closes when the focus leaves the box and its list.
          Focus moved onto an option (as some screen readers do) stays inside, and pressing the
          list does not take the focus (onMouseDown below), so a click still picks. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: only watches the focus leave */}
      <div
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) leave();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          {LABEL}
        </label>
        <div className="relative group">
          <Search
            aria-hidden="true"
            className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary group-focus-within:text-cyber transition-colors z-10"
            size={20}
          />
          {isLoading && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 z-10">
              <div className="w-4 h-4 border-2 border-cyber/30 border-t-cyber rounded-full animate-spin" />
            </div>
          )}
          <input
            ref={setInput}
            id={inputId}
            type="text"
            value={value}
            onChange={(event) => {
              onValueChange(event.target.value);
              setEmptySubmits(0);
            }}
            onKeyDown={handleKeyDown}
            onFocus={reopen}
            placeholder={LABEL}
            maxLength={200}
            className={`${inputVisualStyles} pl-12 pr-10`}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listShown}
            aria-controls={listboxId}
            aria-activedescendant={highlightedId}
            aria-describedby={listShown ? hintId : undefined}
            aria-invalid={showEmptyHint || undefined}
          />
        </div>

        {showEmptyHint && (
          // The alert speaks the sentence; the field does not also take it as its description,
          // which would read it twice once focus lands there.
          <p
            key={emptySubmits}
            role="alert"
            className="mt-2 text-xs font-mono text-text-secondary text-left"
          >
            Type a song title and its artist first, for example: Midnight City M83.
          </p>
        )}

        {/* The box's one live region: always in the page, so what appears in it is announced.
            The count is one string, unchanged while typing keeps the same number of
            suggestions, so it is announced again only when the number changes. */}
        <div role="status" className="text-left">
          {failed ? (
            <p className="mt-2 text-xs font-mono text-text-tertiary">{SUGGESTIONS_UNAVAILABLE}</p>
          ) : (
            listShown && (
              <span className="sr-only">
                {suggestions.length === 1 ? '1 suggestion' : `${suggestions.length} suggestions`}
              </span>
            )
          )}
        </div>

        {/* Suggestions. Opaque, so nothing behind the list shows through it. */}
        {listShown && (
          // biome-ignore lint/a11y/noStaticElementInteractions: keeps the focus in the box
          <div
            onMouseDown={(event) => event.preventDefault()}
            className="absolute z-50 w-full mt-2 bg-void-light border border-border rounded-lg shadow-elevated-lg overflow-hidden animate-scale-in"
          >
            <div
              id={listboxId}
              role="listbox"
              aria-label="Suggestions"
              // A list taller than its box scrolls; a scroller is otherwise a Tab stop in
              // Chrome, and the focus belongs in the box.
              tabIndex={-1}
              className="max-h-[320px] overflow-y-auto"
            >
              {suggestions.map((candidate, index) => (
                // Chosen with the keyboard from the box (the focus never moves here), or with a
                // click: a press does not take the focus from the box.
                // biome-ignore lint/a11y/useKeyWithClickEvents: the box's own keys choose it
                <div
                  key={candidate.id}
                  id={optionIdFor(id, candidate.id)}
                  role="option"
                  // Focusable (a screen reader may move the focus here), never in the Tab order
                  tabIndex={-1}
                  aria-selected={index === highlighted}
                  onClick={() => pick(candidate)}
                  className={`w-full flex items-center gap-3 p-3 text-left cursor-pointer transition-all animate-fade-in-up opacity-0 ${
                    index === highlighted
                      ? 'bg-cyber/20 border-l-2 border-cyber'
                      : 'hover:bg-white/5 border-l-2 border-transparent'
                  }`}
                  style={{ animationDelay: `${index * 50}ms`, animationFillMode: 'forwards' }}
                >
                  <CoverThumb url={candidate.coverUrl} className="w-10 h-10 rounded" />
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-mono text-sm truncate">{candidate.title}</div>
                    <div className="text-text-tertiary text-xs truncate">
                      {candidate.artist} • {candidate.album}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {/* How to use the list: beside it, not one of its options */}
            <p
              id={hintId}
              className="px-3 py-2 text-xs text-text-tertiary border-t border-white/5 font-mono"
            >
              Arrow keys to move, Enter to analyze, Esc to close
            </p>
          </div>
        )}
      </div>

      <Button type="submit" variant="cyber" size="lg" isLoading={isBusy} className="w-full">
        Analyze
      </Button>
    </form>
  );
}
