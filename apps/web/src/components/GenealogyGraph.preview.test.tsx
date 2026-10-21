import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// A preview is playing for a node the model proposed (a related influence, not a sample).
vi.mock('./genealogy/useAudioPreview', () => ({
  useAudioPreview: () => ({
    isPlaying: true,
    playingNodeId: 'n1',
    hasPreviewSupport: true,
    playPreview: () => {},
    stopPreview: () => {},
  }),
}));

import GenealogyGraph from './GenealogyGraph';

describe('GenealogyGraph preview indicator', () => {
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
    expect(screen.getByText('PREVIEWING TRACK...')).toBeTruthy();
    expect(screen.queryByText(/SAMPLE/)).toBeNull();
  });
});
