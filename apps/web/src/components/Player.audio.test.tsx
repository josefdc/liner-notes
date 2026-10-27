import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackData } from '../types';
import Player from './Player';
import { provenanceTrack } from './provenance/testing';

// The Player's track preview and the genealogy graph's previews share one audio element.

const TRACK_CLIP = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/track.mp3';
const NODE_CLIP = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/older.mp3';

/** Every audio element made, as an element that plays at once. */
let made: FakeAudio[] = [];
class FakeAudio {
  src = '';
  volume = 1;
  paused = true;
  currentTime = 0;
  loads = 0;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    made.push(this);
  }
  play() {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.onpause?.();
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {
    this.loads += 1;
  }
}

/** The provenance result with a preview of its own and a related track that has one too. */
function withPreviews(): TrackData {
  const track = provenanceTrack();
  return {
    ...track,
    previewUrl: TRACK_CLIP,
    genealogy: {
      nodes: [
        { id: 'current', group: 1, label: 'Paper Lanterns - Test Artist (2011)', size: 40 },
        {
          id: 'older',
          group: 2,
          label: 'Old Record - Someone (1984)',
          size: 22,
          previewUrl: NODE_CLIP,
        },
      ],
      links: [{ source: 'older', target: 'current', value: 1, type: 'influence' }],
    },
  } as TrackData;
}

beforeEach(() => {
  made = [];
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Player's previews", () => {
  it('makes one audio element for the track and the genealogy graph', () => {
    render(<Player trackData={withPreviews()} onBack={() => {}} />);
    expect(document.querySelector('#panel-genealogy svg')).not.toBeNull();
    expect(made).toHaveLength(1);
  });

  it("stops the track's preview when a related track's preview starts", async () => {
    render(<Player trackData={withPreviews()} onBack={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play preview' })));
    expect(screen.getByRole('button', { name: 'Pause preview' })).toBeTruthy();
    const audio = made.at(-1);
    expect(audio?.src).toBe(TRACK_CLIP);

    const node = screen.getByRole('button', {
      name: 'Play preview of Old Record - Someone (1984)',
      hidden: true,
    });
    await act(async () => fireEvent.click(node));

    expect(made).toHaveLength(1);
    expect(audio?.src).toBe(NODE_CLIP);
    expect(audio?.paused).toBe(false);
    expect(screen.getByRole('button', { name: 'Play preview' })).toBeTruthy();
    expect(node.getAttribute('aria-pressed')).toBe('true');
  });

  it('stops, empties and lets go of the element when the Player goes', async () => {
    const view = render(<Player trackData={withPreviews()} onBack={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Play preview' })));
    const audio = made.at(-1);
    expect(audio?.paused).toBe(false);

    view.unmount();

    expect(audio?.paused).toBe(true);
    expect(audio?.src).toBe('');
    expect(audio?.loads).toBeGreaterThan(0);
    expect([audio?.onplay, audio?.onpause, audio?.onended, audio?.onerror]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
