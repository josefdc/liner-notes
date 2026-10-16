import { describe, expect, it } from 'vitest';
import { drawableLinks } from './GenealogyGraph';

describe('drawableLinks', () => {
  it('leaves out links to or from a node id that is not in the graph', () => {
    const genealogy = {
      nodes: [
        { id: 'current', group: 1, label: 'Song', size: 40 },
        { id: 'origin1', group: 2, label: 'Older Song', size: 30 },
      ],
      links: [
        { source: 'origin1', target: 'current', value: 3 },
        { source: 'ghost', target: 'current', value: 2 },
        { source: 'current', target: 'missing', value: 1 },
      ],
    };
    expect(drawableLinks(genealogy)).toEqual([{ source: 'origin1', target: 'current', value: 3 }]);
  });
});
