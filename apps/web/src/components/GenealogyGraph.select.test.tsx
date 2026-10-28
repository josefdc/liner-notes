import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GenealogyGraph from './GenealogyGraph';
import { claim, link, node, PACK } from './genealogy/testing';
import { resultClaims } from './provenance/claims';
import type { TrackData } from '../types';

// A track on the map is selected by a click, a tap or Enter, never analysed: its details open in
// the map's panel (its relations, their evidence, "Analyze this track" and A/B listening), and
// the filters choose which links the map shows.

/** A ResizeObserver that reports a size at once, so the graph is drawn. */
class SizedObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

/** The page's preview element: it records each clip asked to play, and a test ends the clip. */
let played: string[] = [];
let element: FakeAudio | null = null;
class FakeAudio {
  src = '';
  volume = 1;
  paused = true;
  ended = false;
  error = null;
  currentTime = 0;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    element = this;
  }
  play() {
    played.push(this.src);
    this.paused = false;
    this.ended = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
}
/** The clip playing now plays through. */
const finishClip = () =>
  act(async () => {
    if (!element) throw new Error('no preview element');
    element.paused = true;
    element.ended = true;
    element.onended?.();
  });

const OLDER_CLIP = 'https://previews.example.test/older.mp3';
const LATER_CLIP = 'https://previews.example.test/later.mp3';
const TRACK_CLIP = 'https://previews.example.test/track.mp3';

// Five links: the map is drawn (with two or fewer it is a compact row).
// - Older Record: a code-built sourced sample, and (a second hop) Peer samples it too;
// - Model Pick: the model's sample, sourced through a claim the verifier supported;
// - Guess: the model's sample, no evidence (inferred);
// - Later: a sourced remix of this track.
const data = {
  nodes: [
    {
      ...node('current', 1, 'Bright Lines - Test Artist (2011)'),
      trackTitle: 'Bright Lines',
      year: 2011,
    },
    { ...node('older', 2, 'Older Record - Someone (1984)'), year: 1984, previewUrl: OLDER_CLIP },
    { ...node('model', 2, 'Model Pick - Someone (1982)'), previewUrl: OLDER_CLIP },
    node('guess', 2, 'Guess - Someone (1990)'),
    { ...node('later', 3, 'Later - Someone (2015)'), year: 2015, previewUrl: LATER_CLIP },
    { ...node('peer', 4, 'Peer - Someone (1988)'), year: 1988 },
  ],
  links: [
    link('older', 'current', {
      type: 'sample',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
      value: 3,
    }),
    link('model', 'current', {
      type: 'sample',
      kind: 'sourced',
      origin: 'model',
      evidenceIds: ['ev-mb-1'],
      claimId: 'cl-ok',
    }),
    link('guess', 'current', {
      type: 'sample',
      kind: 'inferred',
      origin: 'model',
      evidenceIds: [],
    }),
    link('current', 'later', {
      type: 'remix',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
    }),
    link('older', 'peer', {
      type: 'sample',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
    }),
  ],
};
const claims = resultClaims({
  evidence: PACK,
  claims: [
    claim('cl-ok', {
      kind: 'sourced',
      evidenceIds: ['ev-mb-1'],
      verdict: 'supported',
      verdictReason: 'The record lists the sample.',
    }),
  ],
} as unknown as TrackData);

const Graph = (props: Partial<React.ComponentProps<typeof GenealogyGraph>>) => (
  <GenealogyGraph
    data={data}
    evidence={PACK}
    claims={claims}
    trackPreviewUrl={TRACK_CLIP}
    {...props}
  />
);

const card = (container: HTMLElement, id: string) => {
  const found = container.querySelector(`g.nodes > g[data-node-id="${id}"]`);
  if (!found) throw new Error(`no card ${id}`);
  return found as SVGGElement;
};
const cardIds = (container: HTMLElement) =>
  [...container.querySelectorAll('g.nodes > g')].map((g) => g.getAttribute('data-node-id'));
const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
const panel = () => screen.getByTestId('node-detail');

beforeEach(() => {
  played = [];
  element = null;
  vi.stubGlobal('ResizeObserver', SizedObserver);
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('selecting a track on the map', () => {
  it('a click selects the track and opens its details in the panel; it never analyses', async () => {
    const onNodeClick = vi.fn();
    const { container } = render(<Graph onNodeClick={onNodeClick} />);
    expect(card(container, 'older').getAttribute('aria-pressed')).toBe('false');
    // The analysed track is not a toggle.
    expect(card(container, 'current').hasAttribute('aria-pressed')).toBe(false);

    await click(card(container, 'older'));
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(card(container, 'older').getAttribute('aria-pressed')).toBe('true');
    expect(card(container, 'older').querySelector('.select-ring')?.getAttribute('opacity')).toBe(
      '1',
    );
    // The panel has the focus, named by its track.
    expect(document.activeElement).toBe(panel());
    expect(within(panel()).getByRole('heading').textContent).toBe('Older Record - Someone');
    expect(panel().textContent).toContain('1984');
    // While a track is selected, its panel replaces the hover box.
    expect(screen.queryByTestId('link-detail')).toBeNull();
  });

  it('says how a code link is sourced: the record, with its source and retrieval date', async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'older'));
    const relations = within(panel()).getAllByRole('listitem');
    // Best known first: the sample of this track, then the second hop.
    expect(relations[0].textContent).toContain(
      'Bright Lines (2011) samples Older Record - Someone (1984)',
    );
    expect(relations[1].textContent).toContain(
      'Peer - Someone (1988) samples Older Record - Someone (1984)',
    );
    const sourced = relations[0].querySelector('[data-sourced-from]');
    expect(sourced?.textContent).toMatch(/^Sourced from/);
    const evidence = within(relations[0]).getByRole('link');
    expect(evidence.getAttribute('href')).toBe('https://example.org/record/ev-mb-1');
    expect(evidence.textContent).toContain('MusicBrainz');
    expect(relations[0].querySelector('time')?.textContent).toBe('1 Oct 2026');
    expect(relations[0].textContent).toContain('retrieved 1 Oct 2026');
  });

  it("shows a model link's verifier verdict and its reason", async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'model'));
    expect(panel().querySelector('[data-verifier]')?.textContent).toBe(
      'Verifier: supported by its sources · The record lists the sample.',
    );
    // A model link with no claim: no verdict is made up.
    await click(card(container, 'guess'));
    expect(panel().querySelector('[data-verifier]')?.textContent).toBe(
      'Verifier: not checked; no claim is linked to this relation',
    );
    expect(panel().textContent).toContain('Why it is not sourced: no evidence cited');
  });

  it('another click moves the selection; a click on the selected track clears it', async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'older'));
    await click(card(container, 'later'));
    expect(card(container, 'older').getAttribute('aria-pressed')).toBe('false');
    expect(card(container, 'later').getAttribute('aria-pressed')).toBe('true');
    expect(within(panel()).getByRole('heading').textContent).toBe('Later - Someone');
    await click(card(container, 'later'));
    expect(screen.queryByTestId('node-detail')).toBeNull();
    expect(card(container, 'later').getAttribute('aria-pressed')).toBe('false');
  });

  it('Escape closes the panel and puts the focus back on the card', async () => {
    const { container } = render(<Graph />);
    await act(async () => card(container, 'older').focus());
    await act(async () => {
      fireEvent.keyDown(card(container, 'older'), { key: 'Enter' });
    });
    expect(document.activeElement).toBe(panel());
    await act(async () => {
      fireEvent.keyDown(panel(), { key: 'Escape' });
    });
    expect(screen.queryByTestId('node-detail')).toBeNull();
    expect(document.activeElement).toBe(card(container, 'older'));
    // The close button does the same.
    await click(card(container, 'later'));
    await act(async () =>
      fireEvent.click(within(panel()).getByRole('button', { name: 'Close details' })),
    );
    expect(screen.queryByTestId('node-detail')).toBeNull();
    expect(document.activeElement).toBe(card(container, 'later'));
  });

  it('"Analyze this track" analyses the selected track, with its node', async () => {
    const onNodeClick = vi.fn();
    const { container } = render(<Graph onNodeClick={onNodeClick} />);
    await click(card(container, 'older'));
    await act(async () =>
      fireEvent.click(within(panel()).getByRole('button', { name: 'Analyze this track' })),
    );
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onNodeClick).toHaveBeenCalledWith({
      id: 'older',
      group: 2,
      label: 'Older Record - Someone (1984)',
      size: 22,
      previewUrl: OLDER_CLIP,
    });
  });
});

describe('A/B listening in the panel', () => {
  it('plays the sample, then this track, saying which plays; then it is done', async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'older'));
    const status = () => panel().querySelector('[data-listening-status]')?.textContent;
    await act(async () =>
      fireEvent.click(within(panel()).getByRole('button', { name: 'Hear the sample' })),
    );
    expect(played).toEqual([OLDER_CLIP]);
    expect(status()).toBe('Playing: Older Record - Someone (1984) (1 of 2)');
    await finishClip();
    expect(played).toEqual([OLDER_CLIP, TRACK_CLIP]);
    expect(status()).toBe('Playing: Bright Lines (2011) (2 of 2)');
    await finishClip();
    expect(played).toEqual([OLDER_CLIP, TRACK_CLIP]);
    expect(status()).toBe('');
    expect(within(panel()).getByRole('button', { name: 'Hear the sample' })).toBeTruthy();
  });

  it('plays the earlier record first: this track before its remix ("Hear both")', async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'later'));
    await act(async () =>
      fireEvent.click(within(panel()).getByRole('button', { name: 'Hear both' })),
    );
    await finishClip();
    expect(played).toEqual([TRACK_CLIP, LATER_CLIP]);
  });

  it('stops on Stop and on Escape (which leaves the panel open)', async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'older'));
    const hear = () => within(panel()).getByRole('button', { name: /Hear the sample|Stop/ });
    await act(async () => fireEvent.click(hear()));
    expect(hear().textContent).toBe('Stop');
    await act(async () => fireEvent.click(hear()));
    expect(element?.paused).toBe(true);
    expect(hear().textContent).toBe('Hear the sample');
    await finishClip();
    expect(played).toEqual([OLDER_CLIP]);

    await act(async () => fireEvent.click(hear()));
    await act(async () => {
      fireEvent.keyDown(hear(), { key: 'Escape' });
    });
    expect(element?.paused).toBe(true);
    expect(hear().textContent).toBe('Hear the sample');
    await finishClip();
    expect(played).toEqual([OLDER_CLIP, OLDER_CLIP]);
    // The next Escape closes the panel.
    await act(async () => {
      fireEvent.keyDown(hear(), { key: 'Escape' });
    });
    expect(screen.queryByTestId('node-detail')).toBeNull();
  });

  it('says plainly when a preview is missing, and in a replay that previews play live', async () => {
    const { container, rerender } = render(<Graph />);
    await click(card(container, 'guess'));
    expect(within(panel()).queryByRole('button', { name: /Hear/ })).toBeNull();
    expect(panel().querySelector('[data-listening-unavailable]')?.textContent).toBe(
      'No preview is available for Guess - Someone (1990).',
    );
    rerender(<Graph trackPreviewUrl={null} />);
    await click(card(container, 'peer'));
    expect(panel().querySelector('[data-listening-unavailable]')?.textContent).toBe(
      'The previews are not available for these tracks.',
    );
    rerender(<Graph replay />);
    await click(card(container, 'older'));
    expect(within(panel()).queryByRole('button', { name: /Hear/ })).toBeNull();
    expect(panel().querySelector('[data-listening-unavailable]')?.textContent).toBe(
      'Previews play in a live analysis: a replay does not keep them.',
    );
    expect(played).toEqual([]);
  });
});

describe("the map's filters", () => {
  const openFilters = () =>
    act(async () => fireEvent.click(screen.getByRole('button', { name: 'Filter links' })));
  const toggle = (name: string | RegExp) =>
    act(async () => fireEvent.click(screen.getByRole('checkbox', { name })));
  const shownLinks = (container: HTMLElement) => container.querySelectorAll('g.links path').length;

  it('hide the links of a relation, and the tracks only they joined; never this track', async () => {
    const { container } = render(<Graph />);
    await openFilters();
    expect(screen.getAllByRole('checkbox').map((box) => box.parentElement?.textContent)).toEqual([
      'Sample (3/3)',
      'Remix (1/1)',
      'Second hop (1/1)',
      'Sourced only',
    ]);
    await toggle(/^Sample/);
    // Each box says how many of its links are shown.
    expect(screen.getByRole('checkbox', { name: /^Sample/ }).parentElement?.textContent).toBe(
      'Sample (0/3)',
    );
    expect(shownLinks(container)).toBe(2);
    // Older Record stays: the second hop still joins it.
    expect(cardIds(container)).toEqual(['current', 'older', 'later', 'peer']);
    expect(screen.getByTestId('filter-status').textContent).toBe('Showing 2 of 5 links');
    expect(screen.getByText('Links as a list (2)')).toBeTruthy();
    // Screen readers hear what the filters hide.
    expect(container.querySelector('.sr-only')?.textContent).toContain(
      'The filters hide 2 tracks and 3 links.',
    );

    await toggle(/^Remix/);
    await toggle(/^Second hop/);
    expect(shownLinks(container)).toBe(0);
    expect(cardIds(container)).toEqual(['current']);
    expect(screen.getByTestId('filters-empty').textContent).toContain(
      'No links match the filters: Sample, Remix and Second hop links are hidden.',
    );
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId('filters-empty')).getByRole('button', { name: 'Clear filters' }),
      ),
    );
    expect(shownLinks(container)).toBe(5);
    expect(screen.getByTestId('filter-status').textContent).toBe('Showing all 5 links');
  });

  it('"Sourced only" hides every link that is not sourced', async () => {
    const { container } = render(<Graph />);
    await openFilters();
    await toggle('Sourced only');
    const kinds = [...container.querySelectorAll('g.links path')].map((path) =>
      path.getAttribute('data-link-kind'),
    );
    expect(kinds).toEqual(['sourced', 'sourced', 'sourced', 'sourced']);
    expect(screen.getByRole('checkbox', { name: /^Sample/ }).parentElement?.textContent).toBe(
      'Sample (2/3)',
    );
    expect(cardIds(container)).not.toContain('guess');
    expect(cardIds(container)).toContain('current');
  });

  it('a filter that hides the selected track closes its panel', async () => {
    const { container } = render(<Graph />);
    await click(card(container, 'guess'));
    expect(panel()).toBeTruthy();
    await openFilters();
    await toggle('Sourced only');
    expect(screen.queryByTestId('node-detail')).toBeNull();
    // The status says so, with the count.
    expect(screen.getByTestId('filter-status').textContent).toBe(
      'Showing 4 of 5 links. The details of Guess - Someone (1990) closed: the filters hide that track',
    );
  });
});

describe('the panel, as the review asked', () => {
  it('offers "Hear both", not "Hear the sample", for a sample the model only proposed', async () => {
    const withClip = {
      ...data,
      nodes: data.nodes.map((n) => (n.id === 'guess' ? { ...n, previewUrl: OLDER_CLIP } : n)),
    };
    const { container } = render(<Graph data={withClip} />);
    await click(card(container, 'guess'));
    expect(within(panel()).getByRole('button', { name: 'Hear both' })).toBeTruthy();
    expect(within(panel()).queryByRole('button', { name: 'Hear the sample' })).toBeNull();
  });

  it('never says "Sourced from" for a link that does not say it was built from a record', async () => {
    // An older result: the link states no origin, and cites the record.
    const older = {
      ...data,
      links: data.links.map((l, i) => (i === 0 ? { ...l, origin: undefined } : l)),
    };
    const { container } = render(<Graph data={older} />);
    await click(card(container, 'older'));
    const first = within(panel())
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('Bright Lines (2011)'));
    if (!first) throw new Error('no relation to this track');
    expect(first.querySelector('[data-sourced-from]')).toBeNull();
    expect(first.querySelector('[data-verifier]')?.textContent).toBe(
      'Verifier: not checked; no claim is linked to this relation',
    );
    expect(first.textContent).toContain('Cites:');
  });

  it('a selected card says Enter closes its details', async () => {
    const { container } = render(<Graph />);
    expect(card(container, 'older').getAttribute('aria-label')).toMatch(
      /Press Enter for its details\.$/,
    );
    await click(card(container, 'older'));
    expect(card(container, 'older').getAttribute('aria-label')).toMatch(
      /Press Enter to close its details\.$/,
    );
  });

  it('Escape from the filters or the page closes the panel first, not the map', async () => {
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    try {
      const { container } = render(<Graph />);
      await click(card(container, 'older'));
      const filters = screen.getByRole('button', { name: 'Filter links' });
      await act(async () => {
        fireEvent.keyDown(filters, { key: 'Escape' });
      });
      expect(screen.queryByTestId('node-detail')).toBeNull();
      // Handled: the Player's own Escape (on the window) sees it taken.
      expect(outside.mock.calls[0][0].defaultPrevented).toBe(true);

      await click(card(container, 'older'));
      await act(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });
      expect(screen.queryByTestId('node-detail')).toBeNull();
      expect(outside.mock.calls[1][0].defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('keydown', outside);
    }
  });
});
