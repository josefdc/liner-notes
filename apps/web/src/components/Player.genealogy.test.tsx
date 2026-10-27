import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenealogyLink, TrackData } from '../types';
import Player from './Player';
import { provenanceTrack } from './provenance/testing';

afterEach(cleanup);

// The genealogy panel's label says "model inference" only when no shown link is sourced; with
// sourced links it says the panel holds both kinds (each link says its own in the graph).

/** The provenance result with a small genealogy of its own. */
function withLinks(links: GenealogyLink[]): TrackData {
  const track = provenanceTrack();
  const evidenceId = (track.evidence as Array<{ id: string }>)[0].id;
  return {
    ...track,
    genealogy: {
      nodes: [
        { id: 'current', group: 1, label: 'Paper Lanterns - Test Artist (2011)', size: 40 },
        { id: 'old', group: 2, label: 'Old Record - Someone (1984)', size: 22 },
        { id: 'peer', group: 4, label: 'Peer - Someone (2001)', size: 22 },
      ],
      links: links.map((link) =>
        link.kind === 'sourced' ? { ...link, evidenceIds: [evidenceId] } : link,
      ),
    },
  } as TrackData;
}

const sourced: GenealogyLink = {
  source: 'old',
  target: 'current',
  value: 3,
  type: 'sample',
  kind: 'sourced',
  origin: 'code',
};
const inferred: GenealogyLink = {
  source: 'peer',
  target: 'current',
  value: 1,
  type: 'influence',
  kind: 'inferred',
  origin: 'model',
};

/** The label beside the panel's heading. */
const panelLabel = () =>
  document.querySelector('#panel-genealogy > div:first-child')?.textContent ?? '';

describe('the genealogy panel label', () => {
  it('says model inference when no shown link is sourced', () => {
    render(<Player trackData={withLinks([inferred])} onBack={() => {}} />);
    expect(panelLabel()).toBe('ConnectionsModel inference');
  });

  it('says the panel holds sourced and not sourced links when both are shown', () => {
    render(<Player trackData={withLinks([sourced, inferred])} onBack={() => {}} />);
    expect(panelLabel()).toBe('ConnectionsSourced and not sourced links');
  });

  it('says sourced links when every shown link is sourced, with the sourced chip', () => {
    render(<Player trackData={withLinks([sourced])} onBack={() => {}} />);
    expect(panelLabel()).toBe('ConnectionsSourced links');
    expect(
      document
        .querySelector('[data-testid="genealogy-kinds"] [data-provenance]')
        ?.getAttribute('data-provenance'),
    ).toBe('sourced');
  });

  it('labels the panel with the chip of the links kind: violet only for the model', () => {
    const kind = () =>
      document
        .querySelector('[data-testid="genealogy-kinds"] [data-provenance]')
        ?.getAttribute('data-provenance');
    render(<Player trackData={withLinks([inferred])} onBack={() => {}} />);
    expect(kind()).toBe('inferred');
    cleanup();
    // A result built without the model: its links are its source data, not the model's.
    render(
      <Player trackData={{ ...withLinks([inferred]), modelUnavailable: true }} onBack={() => {}} />,
    );
    expect(kind()).toBe('record');
    cleanup();
    const track = withLinks([]);
    track.genealogy.links = [{ ...sourced, evidenceIds: ['ev-not-in-pack'] }];
    render(<Player trackData={track} onBack={() => {}} />);
    expect(kind()).toBe('unconfirmed');
  });

  it('says not sourced, not model inference, for a code-built link whose evidence is not in the pack', () => {
    const track = withLinks([]);
    track.genealogy.links = [{ ...sourced, evidenceIds: ['ev-not-in-pack'] }];
    render(<Player trackData={track} onBack={() => {}} />);
    expect(panelLabel()).toBe('ConnectionsNot sourced');
  });

  it('does not count entries that are not links as links with a hidden claim', () => {
    const track = withLinks([inferred]);
    track.claims = [];
    track.genealogy.links = [null, ...track.genealogy.links] as unknown as GenealogyLink[];
    render(<Player trackData={track} onBack={() => {}} />);
    expect(document.querySelector('[data-testid="links-hidden"]')).toBeNull();
  });
});
