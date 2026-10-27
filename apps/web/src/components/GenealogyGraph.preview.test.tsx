import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A preview is playing for a node the model proposed (a related influence, not a sample),
// unless a test sets another state.
const audio = vi.hoisted(() => ({
  state: {
    isPlaying: true,
    playingNodeId: 'n1' as string | null,
    hasPreviewSupport: true,
    unavailableNodeId: null as string | null,
    blockedNodeId: null as string | null,
  },
}));
vi.mock('./genealogy/useAudioPreview', () => ({
  useAudioPreview: () => ({ ...audio.state, playPreview: () => {}, stopPreview: () => {} }),
}));

import GenealogyGraph from './GenealogyGraph';

const data = {
  nodes: [
    { id: 'current', group: 1, label: 'Song', size: 40 },
    { id: 'n1', group: 4, label: 'Other - Artist', size: 22 },
  ],
  links: [{ source: 'n1', target: 'current', value: 1, type: 'influence' as const }],
};

describe('GenealogyGraph preview indicator', () => {
  beforeEach(() => {
    audio.state = {
      isPlaying: true,
      playingNodeId: 'n1',
      hasPreviewSupport: true,
      unavailableNodeId: null,
      blockedNodeId: null,
    };
  });
  afterEach(cleanup);

  it('says a clip that could not be loaded is unavailable, not that audio is blocked', () => {
    audio.state = {
      ...audio.state,
      isPlaying: false,
      playingNodeId: null,
      unavailableNodeId: 'n1',
    };
    render(<GenealogyGraph data={data} />);
    expect(screen.getByText('Preview unavailable')).toBeTruthy();
    expect(screen.queryByText('Audio blocked')).toBeNull();
  });

  it('says audio is blocked when the browser refuses to play', () => {
    audio.state = {
      ...audio.state,
      isPlaying: false,
      playingNodeId: null,
      hasPreviewSupport: false,
      blockedNodeId: 'n1',
    };
    render(<GenealogyGraph data={data} />);
    expect(screen.getByText('Audio blocked')).toBeTruthy();
    expect(screen.queryByText('Preview unavailable')).toBeNull();
    // Which track's preview, in the live region.
    expect(screen.getByRole('status').textContent).toBe(
      'Preview of Other - Artist was blocked by the browser.',
    );
  });

  it('says a track is previewing, without calling it a sample', () => {
    render(
      <GenealogyGraph
        data={{
          nodes: [
            { id: 'current', group: 1, label: 'Song', size: 40 },
            { id: 'n1', group: 4, label: 'Other - Artist', size: 22 },
          ],
          links: [{ source: 'n1', target: 'current', value: 1, type: 'influence' }],
        }}
      />,
    );
    expect(screen.getByText('Playing preview…')).toBeTruthy();
    expect(screen.queryByText(/SAMPLE/)).toBeNull();
    // A status, not a measured value: not in the measured hue.
    expect(screen.getByText('Playing preview…').parentElement?.className).not.toMatch(/cyber/);
  });
});
