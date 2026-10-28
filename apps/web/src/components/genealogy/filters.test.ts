import { describe, expect, it } from 'vitest';
import { filterCounts, filterGenealogy, filterKindOf, hiddenText, NO_FILTER } from './filters';
import { readGenealogy } from './links';
import { contextOf, link, node } from './testing';

const sourced = { kind: 'sourced' as const, origin: 'code' as const, evidenceIds: ['ev-mb-1'] };
const nodes = [
  node('current', 1, 'Bright Lines - Test Artist (2011)'),
  node('older', 2, 'Older - Someone (1984)'),
  node('guess', 2, 'Guess - Someone (1990)'),
  node('cover', 3, 'Cover - Band (2016)'),
  node('peer', 4, 'Peer - Someone (1988)'),
  node('alone', 4, 'Alone - Nobody (2000)'),
];
const links = readGenealogy(
  {
    nodes,
    links: [
      link('older', 'current', { type: 'sample', ...sourced }),
      link('guess', 'current', { type: 'sample', kind: 'inferred', evidenceIds: [] }),
      link('current', 'cover', { type: 'cover', ...sourced }),
      link('older', 'peer', { type: 'sample', ...sourced }),
    ],
  },
  contextOf(),
).links;

describe('the map filters', () => {
  it('file a link under the relation it is named as, or as a second hop', () => {
    expect(links.map((l) => filterKindOf(l, 'current'))).toEqual([
      'sample',
      'sample',
      'cover',
      'second-hop',
    ]);
    // With no analysed track there is no second hop.
    expect(filterKindOf(links[3], null)).toBe('sample');
    expect(filterCounts(links, 'current')).toEqual([
      { kind: 'sample', count: 2 },
      { kind: 'cover', count: 1 },
      { kind: 'second-hop', count: 1 },
    ]);
  });

  it('without a filter keep every track and link, as given', () => {
    const kept = filterGenealogy(nodes, links, 'current', NO_FILTER);
    expect(kept.nodes).toBe(nodes);
    expect(kept.links).toBe(links);
  });

  it('hide the tracks only hidden links joined, never the analysed track', () => {
    const kept = filterGenealogy(nodes, links, 'current', {
      off: new Set(['sample', 'cover', 'second-hop']),
      sourcedOnly: false,
    });
    expect(kept.links).toEqual([]);
    expect(kept.nodes.map((n) => n.id)).toEqual(['current']);
    const samples = filterGenealogy(nodes, links, 'current', {
      off: new Set(['sample']),
      sourcedOnly: false,
    });
    // Older's second hop goes with its sample: nothing on the map joins Peer to this track.
    expect(samples.nodes.map((n) => n.id)).toEqual(['current', 'cover']);
    expect(samples.links.map((l) => filterKindOf(l, 'current'))).toEqual(['cover']);
    // Older, Guess and Peer had links and lost them; Alone had none, so no filter hid it.
    expect(samples.hiddenTracks).toBe(3);
    expect(filterGenealogy(nodes, links, 'current', NO_FILTER).hiddenTracks).toBe(0);
  });

  it('keep a second hop while the track it hangs from has a shown link to this track', () => {
    // Older's sample is sourced: "Sourced only" keeps it, and its second hop with it.
    const sourcedOnly = filterGenealogy(nodes, links, 'current', {
      off: new Set(),
      sourcedOnly: true,
    });
    expect(sourcedOnly.nodes.map((n) => n.id)).toEqual(['current', 'older', 'cover', 'peer']);
    expect(sourcedOnly.hiddenTracks).toBe(1);
    // A chain of second hops (Older, Peer, Far) goes as one when Older's link to this track does.
    const chain = readGenealogy(
      {
        nodes: [...nodes, node('far', 4, 'Far - Someone (1975)')],
        links: [
          link('older', 'current', { type: 'sample', ...sourced }),
          link('current', 'cover', { type: 'cover', ...sourced }),
          link('older', 'peer', { type: 'sample', ...sourced }),
          link('far', 'peer', { type: 'sample', ...sourced }),
        ],
      },
      contextOf(),
    ).links;
    const covers = { off: new Set(['sample' as const]), sourcedOnly: false };
    const kept = filterGenealogy([...nodes, node('far', 4, 'Far')], chain, 'current', covers);
    expect(kept.links.map((l) => filterKindOf(l, 'current'))).toEqual(['cover']);
    expect(kept.nodes.map((n) => n.id)).toEqual(['current', 'cover']);
    expect(filterCounts(kept.links, 'current')).toEqual([{ kind: 'cover', count: 1 }]);
    // With the samples on, the whole chain is kept.
    const all = filterGenealogy(nodes, chain, 'current', { off: new Set(), sourcedOnly: true });
    expect(filterCounts(all.links, 'current')).toEqual([
      { kind: 'sample', count: 1 },
      { kind: 'cover', count: 1 },
      { kind: 'second-hop', count: 2 },
    ]);
  });

  it('"sourced only" keeps only sourced links', () => {
    const kept = filterGenealogy(nodes, links, 'current', { off: new Set(), sourcedOnly: true });
    expect(kept.links.every((l) => l.kind === 'sourced')).toBe(true);
    expect(kept.links).toHaveLength(3);
    expect(kept.nodes.map((n) => n.id)).not.toContain('guess');
  });

  it('say what they hide', () => {
    expect(hiddenText({ off: new Set(['cover']), sourcedOnly: false })).toBe('Cover links');
    expect(hiddenText({ off: new Set(['second-hop', 'sample']), sourcedOnly: true })).toBe(
      'Sample and Second hop links, and links that are not sourced',
    );
  });
});
