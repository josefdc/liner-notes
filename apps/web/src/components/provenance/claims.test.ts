import { describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from '../measured/testing';
import {
  claimContextOf,
  claimDisplayKind,
  claimIsRejected,
  readClaims,
  readEvidence,
  resultClaims,
  safeHref,
  sourceTierText,
} from './claims';
import { claim, evidence, provenanceTrack } from './testing';

const withClaims = (claims: unknown, items: unknown = [evidence()], audio = audioBlock()) =>
  measuredTrack(audio, { claims, evidence: items } as Partial<TrackData>);

describe('readClaims and readEvidence', () => {
  it('keep what the contract reads and drop the rest, as a tolerant list does', () => {
    const claims = readClaims([
      claim({ id: 'ok' }),
      { ...claim({ id: 'new-subject' }), about: 'lyrics' },
      { ...claim({ id: 'no-verdict-key' }), verdict: undefined },
      claim({ id: 'bad-citation', evidenceIds: [1] as unknown as string[] }),
      null,
    ]);
    expect(claims.map((c) => c.id)).toEqual(['ok']);
    expect(readEvidence([evidence(), { ...evidence({ id: 'x' }), source: 'myspace' }])).toEqual([
      evidence(),
    ]);
  });

  it('read a result without claims or evidence as having none', () => {
    expect(readClaims(undefined)).toEqual([]);
    expect(readClaims({ claims: [] })).toEqual([]);
    expect(readEvidence(null)).toEqual([]);
  });
});

describe('claimDisplayKind', () => {
  const context = claimContextOf(withClaims([]));

  it('shows a code claim on a measured field as measured, and as inference otherwise', () => {
    const tempo = claim({ kind: 'measured', origin: 'code', field: 'tempo' });
    expect(claimDisplayKind(tempo, context)).toBe('measured');
    expect(claimDisplayKind({ ...tempo, origin: 'model' }, context)).toBe('inferred');
    const gated = claimContextOf(
      withClaims([], [], audioBlock({ gate: { passed: false, reason: 'silence' }, tempo: null })),
    );
    expect(claimDisplayKind(tempo, gated)).toBe('inferred');
    expect(claimDisplayKind({ ...tempo, field: undefined }, context)).toBe('inferred');
  });

  it('shows a sourced claim as sourced only with known citations and, from the model, a verdict', () => {
    const sourced = claim({ kind: 'sourced', origin: 'code', evidenceIds: ['ev1'] });
    expect(claimDisplayKind(sourced, context)).toBe('sourced');
    expect(claimDisplayKind({ ...sourced, evidenceIds: [] }, context)).toBe('inferred');
    expect(claimDisplayKind({ ...sourced, evidenceIds: ['ev1', 'gone'] }, context)).toBe(
      'inferred',
    );
    const model = { ...sourced, origin: 'model' as const };
    expect(claimDisplayKind(model, context)).toBe('inferred');
    expect(claimDisplayKind({ ...model, verdict: 'partial' }, context)).toBe('sourced');
    expect(claimDisplayKind({ ...model, verdict: 'unsupported' }, context)).toBe('inferred');
  });

  it('keeps an inferred claim inferred whatever its text says', () => {
    const measuredSounding = claim({ text: 'The preview analysis measured 123 BPM.' });
    expect(claimDisplayKind(measuredSounding, context)).toBe('inferred');
  });
});

describe('claimIsRejected', () => {
  it('rejects what the judge or the numeric check contradicted, and nothing else', () => {
    expect(claimIsRejected(claim({ verdict: 'contradicted' }))).toBe(true);
    expect(claimIsRejected(claim({ numericCheck: 'contradicted' }))).toBe(true);
    expect(
      claimIsRejected(claim({ kind: 'sourced', origin: 'code', verdict: 'contradicted' })),
    ).toBe(true);
    for (const verdict of ['supported', 'partial', 'unsupported', null] as const) {
      expect(claimIsRejected(claim({ verdict }))).toBe(false);
    }
    for (const numericCheck of ['consistent', 'conflict', 'n/a'] as const) {
      expect(claimIsRejected(claim({ numericCheck }))).toBe(false);
    }
  });
});

describe('safeHref', () => {
  it('allows absolute http and https addresses only', () => {
    expect(safeHref('https://musicbrainz.org/recording/1')).toBe(
      'https://musicbrainz.org/recording/1',
    );
    expect(safeHref('http://example.org/a b')).toBe('http://example.org/a%20b');
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.org/x',
      '/relative/path',
      'musicbrainz.org/recording/1',
      '',
      null,
      undefined,
    ]) {
      expect(safeHref(url), String(url)).toBeNull();
    }
  });
});

describe('sourceTierText', () => {
  it('names each tier', () => {
    expect(sourceTierText(evidence())).toBe('primary record');
    expect(sourceTierText(evidence({ sourceTier: 'editorial' }))).toBe('editorial');
    expect(sourceTierText(evidence({ sourceTier: 'web' }))).toBe('web page');
  });
});

describe('resultClaims on the provenance fixture', () => {
  const claims = resultClaims(provenanceTrack());
  const kinds = Object.fromEntries(claims.all.map((shown) => [shown.claim.id, shown.kind]));

  it('reads each claim with how it is shown', () => {
    expect(kinds).toEqual({
      'c-tempo': 'measured',
      'c-key': 'inferred',
      'c-writers': 'sourced',
      'c-producer': 'sourced',
      'c-two-days': 'sourced',
      'c-club': 'inferred',
      'c-gone': 'inferred',
      'c-unsupported': 'inferred',
      'c-roughly': 'inferred',
      'c-sleeve-tempo': 'sourced',
      'c-half-time': 'inferred',
      'c-film': 'sourced',
      'c-1998': 'inferred',
      'c-mixed': 'sourced',
      'c-90': 'inferred',
    });
  });

  it('puts the contradicted claims, whatever their kind, in the rejected list only', () => {
    expect(claims.rejected.map((shown) => shown.claim.id)).toEqual(['c-1998', 'c-mixed', 'c-90']);
    expect(claims.shown.map((shown) => shown.claim.id)).not.toContain('c-mixed');
    expect(claims.shown).toHaveLength(12);
  });

  it('keeps the cited items in the pack, and counts the cited ids that are not', () => {
    const gone = claims.byId.get('c-gone');
    expect(gone?.cited).toEqual([]);
    expect(gone?.missingCitations).toBe(1);
    expect(claims.byId.get('c-writers')?.cited.map((item) => item.id)).toEqual(['ev-mb-work']);
  });
});
