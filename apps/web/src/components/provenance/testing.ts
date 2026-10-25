// Claims, evidence and results for the tests of the provenance components. The result with a
// claim in each state is the browser tests' contract fixture (tests/mock-sse/fixtures/
// provenance.json), so both kinds of test read the same payload. Used by tests only.

import type { Claim, Evidence } from '@liner-notes/contract';
import raw from '../../../../../tests/mock-sse/fixtures/provenance.json?raw';
import type { TrackData } from '../../types';

/** A model claim with no verdict and no citation; `overrides` change any field. */
export const claim = (overrides: Partial<Claim> = {}): Claim => ({
  id: 'c1',
  text: 'A statement.',
  about: 'trivia',
  kind: 'inferred',
  origin: 'model',
  evidenceIds: [],
  verdict: null,
  verdictReason: null,
  numericCheck: 'n/a',
  ...overrides,
});

/** A MusicBrainz record; `overrides` change any field. */
export const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({
  id: 'ev1',
  source: 'musicbrainz',
  sourceTier: 'primary-record',
  url: 'https://musicbrainz.org/recording/1',
  title: 'Some Recording',
  retrievedAt: '2026-10-20T12:00:00.000Z',
  excerpt: 'An excerpt.',
  recordRef: 'track/recording/1',
  ...overrides,
});

type Event = { type: string; data?: unknown };

/** The result of the provenance fixture: a claim in each state (see the fixture's claims). */
export function provenanceTrack(): TrackData {
  const fixture = JSON.parse(raw) as { streams: Record<string, Event[]> };
  const complete = fixture.streams['/api/analyze/stream'].find(
    (event) => event.type === 'complete',
  );
  return complete?.data as TrackData;
}
