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

/** The id of the suggestion at `index` in the list of the box whose id is `boxId`. */
const optionIdFor = (boxId: string, index: number) => `${boxId}-suggestion-${index}`;

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
  const optionId = (index: number) => optionIdFor(id, index);

  const { suggestions, open, highlighted, isLoading, failed, settle, highlight, show } =
    useSuggestions(value, fetchSuggestions);
  const listShown = open && suggestions.length > 0;

  // Empty searches submitted since the text last changed: the box says what to type until it
  // changes. Each submit renders a new alert, so a repeat is announced again.
  const [emptySubmits, setEmptySubmits] = useState(0);
  const showEmptyHint = emptySubmits > 0 && !value.trim();

  const input = useRef<HTMLInputElement | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  // One ref function for the box's whole life: an inline one would be called again (null, then
  // the element) on every render.
  const setInput = useCallback(
    (element: HTMLInputElement | null) => {
      input.current = element;
      assignRef(inputRef, element);
    },
    [inputRef],
  );

  // A click outside the box and its list closes the list.
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popup.current?.contains(target) || input.current?.contains(target)) return;
      show(false);
    };
    document.addEventListener('mousedown', handleMouseDown, { passive: true });
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [show]);

  // The highlighted suggestion stays in view: the focus stays in the box, so the browser does
  // not scroll the list by itself.
  useEffect(() => {
    if (listShown && highlighted >= 0) {
      document.getElementById(optionIdFor(id, highlighted))?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [listShown, highlighted, id]);

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
    if (suggestions.length === 0) return;
    const count = suggestions.length;
    const current = suggestions[highlighted];
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const down = event.key === 'ArrowDown';
        if (!listShown) {
          // The list closed with Escape: the arrow opens it again.
          show(true);
          highlight(down ? 0 : count - 1);
          return;
        }
        if (down) highlight(highlighted < count - 1 ? highlighted + 1 : 0);
        else highlight(highlighted > 0 ? highlighted - 1 : count - 1);
        return;
      }
      case 'Enter':
        if (listShown && current) {
          event.preventDefault();
          pick(current);
        }
        return;
      case 'Escape':
        if (listShown) {
          event.preventDefault();
          show(false);
        }
        return;
      case 'Tab':
        if (listShown && current) {
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
      <div className="relative">
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
            onFocus={() => show(true)}
            placeholder={LABEL}
            maxLength={200}
            className={`${inputVisualStyles} pl-12 pr-10`}
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={listShown}
            aria-controls={listboxId}
            aria-activedescendant={
              listShown && highlighted >= 0 ? optionId(highlighted) : undefined
            }
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

        {/* The box's one live region: always in the page, so what appears in it is announced */}
        <div role="status" className="text-left">
          {failed && (
            <p className="mt-2 text-xs font-mono text-text-tertiary">{SUGGESTIONS_UNAVAILABLE}</p>
          )}
        </div>

        {/* Suggestions. Opaque, so nothing behind the list shows through it. */}
        {listShown && (
          <div
            ref={popup}
            className="absolute z-50 w-full mt-2 bg-void-light border border-border rounded-lg shadow-elevated-lg overflow-hidden animate-scale-in"
          >
            <div
              id={listboxId}
              role="listbox"
              aria-label="Suggestions"
              className="max-h-[320px] overflow-y-auto"
            >
              {suggestions.map((candidate, index) => (
                // Chosen with the keyboard from the box (the focus never moves here), or with a
                // click: a press does not take the focus from the box.
                // biome-ignore lint/a11y/useKeyWithClickEvents: the box's own keys choose it
                <div
                  key={candidate.id}
                  id={optionId(index)}
                  role="option"
                  // Reachable for assistive technology, never in the Tab order
                  tabIndex={-1}
                  aria-selected={index === highlighted}
                  onMouseDown={(event) => event.preventDefault()}
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
            <p className="px-3 py-2 text-xs text-text-tertiary border-t border-white/5 font-mono">
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
