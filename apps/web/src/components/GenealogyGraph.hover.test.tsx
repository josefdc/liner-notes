import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pointing at a node with a clip: no hint names a preview, and nothing plays. The audio hook is
// stubbed with stable callbacks (as the real one's are); a test says when the clip could not be
// loaded.
const audio = vi.hoisted(() => ({
  played: [] as string[],
  setUnavailable: null as null | ((id: string | null) => void),
  playPreview: (_url: string, id: string) => {
    audio.played.push(id);
  },
  stopPreview: () => {},
}));
vi.mock('./genealogy/useAudioPreview', async () => {
  const { useState } = await import('react');
  return {
    useAudioPreview: () => {
      const [unavailableNodeId, setUnavailable] = useState<string | null>(null);
      audio.setUnavailable = setUnavailable;
      return {
        isPlaying: false,
        playingNodeId: null,
        hasPreviewSupport: true,
        unavailableNodeId,
        playPreview: audio.playPreview,
        stopPreview: audio.stopPreview,
      };
    },
  };
});

import GenealogyGraph from './GenealogyGraph';

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

const data = {
  nodes: [
    { id: 'current', group: 1, label: 'Song', size: 40 },
    {
      id: 'n1',
      group: 4,
      label: 'Under Pressure - Queen (1981)',
      size: 22,
      previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/n.mp3?hdnea=exp=1~hmac=y',
    },
  ],
  links: [{ source: 'n1', target: 'current', value: 1, type: 'influence' as const }],
};

/** The drawn node for `id`: the group whose label text is the node's. */
function nodeGroup(container: HTMLElement, label: string): Element {
  const group = [...container.querySelectorAll('g.nodes > g')].find((g) =>
    g.textContent?.includes(label.slice(0, 10)),
  );
  if (!group) throw new Error(`no drawn node for ${label}`);
  return group;
}

beforeEach(() => {
  audio.played = [];
  vi.stubGlobal('ResizeObserver', SizedObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GenealogyGraph hover on a node with a clip', () => {
  it('shows no hint of a preview or a sample, and does not play it', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const node = nodeGroup(container, 'Under Pressure');

    await act(async () => {
      node.dispatchEvent(new MouseEvent('mouseenter'));
    });

    // The preview plays from its button only (GenealogyGraph.robust.test.tsx).
    expect(audio.played).toEqual([]);
    expect(container.querySelector('.preview-indicator')).toBeNull();
    expect(container.querySelector('svg')?.textContent).not.toMatch(/PREVIEW|SAMPL/);
  });

  it('says when the clip cannot be loaded', async () => {
    const view = render(<GenealogyGraph data={data} />);

    await act(async () => audio.setUnavailable?.('n1'));

    expect(view.getByRole('status').textContent).toContain('PREVIEW UNAVAILABLE');
  });
});
