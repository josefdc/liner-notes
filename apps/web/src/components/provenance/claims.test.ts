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
  scopeText,
  sourceTier,
  sourceTierText,
  withoutHiddenRelations,
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

  it('read a scope they do not know as no scope, as the contract does', () => {
    const [read] = readClaims([{ ...claim({ id: 'newer' }), scope: 'song' }]);
    expect(read?.id).toBe('newer');
    expect(read?.scope).toBeUndefined();
    expect(readClaims([claim({ id: 'work', scope: 'work' })])[0]?.scope).toBe('work');
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

  it('never links a preview clip, a signed address or one that carries a credential', () => {
    for (const url of [
      // Azure SAS, S3 session tokens, CloudFront signed URLs, tokens in the fragment.
      'https://acct.blob.core.windows.net/c/a.mp3?sv=2022-11-02&se=2026-01-01&sig=abc',
      'https://acct.blob.core.windows.net/c/a.mp3?sig=abc',
      'https://acct.blob.core.windows.net/c/a.mp3?se=2026-01-01',
      'https://bucket.s3.amazonaws.com/a.mp3?X-Amz-Security-Token=abc',
      'https://d1.cloudfront.net/a.mp3?Policy=abc&Signature=def&Key-Pair-Id=K1',
      'https://d1.cloudfront.net/a.mp3?Key-Pair-Id=K1',
      'https://example.org/callback#access_token=abc&token_type=bearer',
      'https://example.org/callback#id_token=abc',
      'https://p.scdn.co/mp3-preview/abc?cid=1',
      'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=exp=1~acl=/*~hmac=x',
      'https://e-cdns-preview-a.dzcdn.net/stream/c-1.mp3',
      'https://bucket.s3.amazonaws.com/a.mp3?X-Amz-Signature=abc',
      'https://user:pass@evil.example/',
      'https://user@evil.example/',
      'https://example.org/a?token=abc',
      'https://example.org/a?access_token=abc',
      'https://example.org/a?API_KEY=abc',
    ]) {
      expect(safeHref(url), url).toBeNull();
    }
    // Images on Deezer's CDN and ordinary query strings stay links.
    expect(safeHref('https://e-cdns-images.dzcdn.net/images/cover/1.jpg')).not.toBeNull();
    expect(safeHref('https://www.discogs.com/search?q=Paper+Lanterns&type=all')).not.toBeNull();
  });

  it.each([
    'key',
    'api_key',
    'api-key',
    'apikey',
    'client_secret',
    'password',
    'passwd',
    'pwd',
    'auth',
    'code',
    'jsessionid',
    'sig',
    'signature',
    'session',
    'sessionid',
    'refresh_token',
    'oauth_token',
    'oauth_signature',
    'auth_token',
    'secret',
    'x-api-key',
    'phpsessid',
    'jwt',
    'access-token',
    'accessToken',
    'refreshToken',
    'client-secret',
    'session_id',
    'sessionId',
    'private_key',
    'privateKey',
    'api_token',
    'x_auth_token',
    'X-Auth-Token',
    'sessid',
    'bearer',
  ])('never links a URL whose query or fragment names %s, in any case', (name) => {
    for (const url of [
      `https://example.org/a?q=1&${name}=abc`,
      `https://example.org/a?${name.toUpperCase()}=abc`,
      `https://example.org/a#${name}=abc`,
    ]) {
      expect(safeHref(url), url).toBeNull();
    }
  });

  it.each([
    'https://example.org/a?q=1;key=abc',
    'https://example.org/a?q=1;token=abc',
    'https://example.org/a?q=1&amp;key=abc',
    'https://example.org/a#/route?code=abc',
    'https://example.org/a#!key=abc',
    'https://example.org/a#!/x?token=abc',
    'https://example.org/a#/access_token=abc',
    'https://example.org/a?q=1;%6Bey=abc',
    'https://example.org/a?redirect=https://app.example/cb/?code=abc',
  ])('never links a credential behind another separator: %s', (url) => {
    expect(safeHref(url), url).toBeNull();
  });

  it.each(['jsessionid', 'JSESSIONID', 'phpsessid', 'sid', 'token'])(
    'never links a URL that carries ;%s= as a path parameter',
    (name) => {
      expect(safeHref(`https://example.org/a;${name}=ABC123?q=1`)).toBeNull();
      expect(safeHref(`https://example.org/a;${name}=ABC123`)).toBeNull();
    },
  );

  it.each([
    ['localhost', 'http://localhost/'],
    ['localhost with a port', 'http://localhost:3001/api'],
    ['localhost with a trailing dot', 'http://localhost./'],
    ['a localhost subdomain', 'https://app.localhost/'],
    ['loopback', 'http://127.0.0.1/'],
    ['loopback elsewhere in 127/8', 'http://127.1.2.3:8080/x'],
    ['loopback as a decimal number', 'http://2130706433/'],
    ['loopback in hex', 'http://0x7f.1/'],
    ['loopback in octal', 'http://017700000001/'],
    ['10/8', 'http://10.0.0.5/'],
    ['172.16/12, low end', 'http://172.16.0.1/'],
    ['172.16/12, high end', 'http://172.31.255.255/'],
    ['192.168/16', 'http://192.168.1.1/'],
    ['link-local (cloud metadata)', 'http://169.254.169.254/latest/meta-data/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['unspecified as a number', 'http://0/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 unspecified', 'http://[::]/'],
    ['IPv6 unique local (fc)', 'http://[fc00::1]/'],
    ['IPv6 unique local (fd)', 'http://[FD12:3456::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 link-local, high end', 'http://[febf::1]/'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
    ['IPv4-mapped private, in hex', 'http://[::ffff:c0a8:101]/'],
    ['IPv4-mapped link-local', 'http://[::ffff:169.254.169.254]/'],
    ['IPv4-compatible loopback', 'http://[::127.0.0.1]/'],
    ['IPv4-compatible link-local', 'http://[::169.254.169.254]/'],
    ['NAT64 loopback', 'http://[64:ff9b::127.0.0.1]/'],
    ['NAT64 link-local', 'http://[64:ff9b::a9fe:a9fe]/'],
    ['SIIT loopback', 'http://[::ffff:0:127.0.0.1]/'],
    ['6to4 loopback', 'http://[2002:7f00:1::]/'],
    ['6to4 private', 'http://[2002:c0a8:101::1]/'],
    ['IPv6 site-local', 'http://[fec0::1]/'],
    ['IPv6 site-local, high end', 'http://[feff::1]/'],
    ['IPv6 multicast, link scope', 'http://[ff02::1]/'],
    ['IPv6 multicast, site scope', 'http://[FF05::FB]/'],
    ['IPv6 multicast, global scope', 'http://[ff0e::1]/'],
    ['IPv6 unique local, uncompressed', 'http://[fd00:1:2:3:4:5:6:7]/'],
    ['shared address space, low end', 'http://100.64.0.1/'],
    ['shared address space, high end', 'http://100.127.255.255/'],
    ['shared address space (cloud metadata)', 'http://100.100.100.200/'],
    ['multicast', 'http://224.0.0.1/'],
    ['multicast, high end', 'http://239.255.255.250/'],
    ['reserved', 'http://240.0.0.1/'],
    ['broadcast', 'http://255.255.255.255/'],
    ['localhost with two trailing dots', 'http://localhost../'],
    ['localhost with three trailing dots', 'http://app.localhost.../'],
    ['localhost.localdomain', 'http://localhost.localdomain/'],
    ['localhost.localdomain with a trailing dot', 'http://LOCALHOST.localdomain./'],
  ])('never links a private host: %s', (_name, url) => {
    expect(safeHref(url), url).toBeNull();
  });

  it('links public hosts, and these words in a path, an anchor or a value', () => {
    for (const url of [
      'https://example.com/',
      'https://en.wikipedia.org/wiki/Amen_break',
      'https://example.com/key-points',
      'https://example.com/password/reset-guide',
      'https://example.com/docs#auth',
      'https://example.com/a#code-samples',
      'https://example.com/search?q=session+musicians',
      'https://example.com/search?keyword=auth',
      'http://8.8.8.8/',
      'http://11.0.0.1/',
      'http://172.15.0.1/',
      'http://172.32.0.1/',
      'http://192.169.0.1/',
      'http://169.255.0.1/',
      'http://[2001:db8::1]/',
      'http://[fe00::1]/',
      'http://[::ffff:8.8.8.8]/',
      'https://localhost.example.com/',
      'http://100.63.255.255/',
      'http://100.128.0.1/',
      'http://223.255.255.255/',
      'http://[64:ff9b::808:808]/',
      'http://[2002:808:808::1]/',
      'http://[fe7f::1]/',
      'https://www.youtube.com/watch?v=abc&t=42',
      'https://en.wikipedia.org/wiki/Key_(music)#Usage',
      'https://example.com/search?q=1;keyword=x',
      'https://example.com/#!/search?q=key',
      'https://example.com/a?next=/session/new&x=1',
      'https://example.com/a;v=1/keys',
      'https://slashdot.org/article.pl?sid=03/05/12/1234',
      'https://web.archive.org/web/2004/http://slashdot.org/article.pl?sid=03/05/12/1234',
      'https://example.org/a?%E0%A4%A=1',
      'http://[2001:db8:1:2:3:4:5:6]/',
      'http://[fe7f:ffff::1]/',
    ]) {
      expect(safeHref(url), url).toBe(new URL(url).href);
    }
  });

  it.each([
    ['dots in the middle of the host', `http://a${'.'.repeat(200_000)}b/`],
    ['dots at the end of the host', `http://a${'.'.repeat(200_000)}/`],
    ['signed-looking parameters before a space', `http://x/${'~hdnea='.repeat(30_000)} b`],
  ])('answers quickly on a long run of %s', (_name, url) => {
    const start = performance.now();
    safeHref(url);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('never throws, whatever the input', () => {
    for (const url of [
      '%',
      '\uD800',
      'http://[',
      'http:///',
      'http://./',
      'http://.../',
      'http://4294967296/',
      'http://[1:2:3:4:5:6:7::]/',
      'http://[1::]/',
      'http://[::]/',
      'http://example\uFF0Ecom/',
      'http://127\u30020\u30020\u30021/',
      'http://x/\uD800',
      'http://x/?\uD800=1',
      'http://x/?q=1;\uDC00=1',
      'http://x/\u0000',
      'http://x/?\u0000=1',
      'http://x/?%',
      'http://x/?%=',
      'http://x/?q=1;%=',
      'http://x/?q=1;%E0%A4%A=1',
      'http://x/#!%E0%A4%A=1',
      'http://x/;%=',
      `http://x/?${'&'.repeat(1000)}`,
      `http://x/#=${'%'.repeat(1000)}`,
    ]) {
      expect(() => safeHref(url), JSON.stringify(url)).not.toThrow();
    }
  });
});

describe('sourceTier', () => {
  it('names each tier', () => {
    expect(sourceTierText(evidence())).toBe('primary record');
    expect(sourceTierText(evidence({ sourceTier: 'editorial' }))).toBe('editorial');
    expect(sourceTierText(evidence({ sourceTier: 'web' }))).toBe('web page');
  });

  it('never shows an item as a primary record against the evidence rules', () => {
    // A web search result is never a primary record (evidenceIssues).
    const search = evidence({ source: 'tavily', sourceTier: 'primary-record', recordRef: null });
    expect(sourceTier(search)).toBe('web');
    expect(sourceTier({ ...search, recordRef: 'track/recording/1' })).toBe('web');
    // A primary record names its record with a scope.
    expect(sourceTier(evidence({ recordRef: null }))).toBe('web');
    expect(sourceTier(evidence({ recordRef: 'recording/1' }))).toBe('web');
    for (const recordRef of ['track/recording/1', 'work/9', 'release/3/credit/1']) {
      expect(sourceTier(evidence({ recordRef }))).toBe('primary-record');
    }
    // A stated lower tier is never raised.
    expect(sourceTier(evidence({ sourceTier: 'web' }))).toBe('web');
    expect(sourceTier(evidence({ sourceTier: 'editorial' }))).toBe('editorial');
  });

  it('says what a record is about when it is not this recording', () => {
    expect(scopeText(evidence({ recordRef: 'track/recording/1' }))).toBeNull();
    expect(scopeText(evidence({ recordRef: 'work/9' }))).toBe('about the song, not this recording');
    expect(scopeText(evidence({ recordRef: 'release/3/credit/1' }))).toBe('about a whole release');
    expect(scopeText(evidence({ recordRef: null }))).toBeNull();
  });
});

describe('resultClaims on the provenance fixture', () => {
  const claims = resultClaims(provenanceTrack());
  const kinds = claims.all.map((shown) => [shown.claim.id, shown.kind]);

  it('reads each claim with how it is shown, and drops the claims it cannot read', () => {
    expect(kinds).toEqual([
      ['c-tempo', 'measured'],
      ['c-key', 'inferred'],
      ['c-writers', 'sourced'],
      ['c-producer', 'sourced'],
      ['c-two-days', 'sourced'],
      ['c-club', 'inferred'],
      ['c-gone', 'inferred'],
      ['c-unsupported', 'inferred'],
      ['c-roughly', 'inferred'],
      ['c-sleeve-tempo', 'sourced'],
      ['c-half-time', 'inferred'],
      ['c-film', 'sourced'],
      ['c-1998', 'inferred'],
      ['c-mixed', 'sourced'],
      ['c-mastered', 'sourced'],
      ['c-blog', 'sourced'],
      ['c-sample-kept', 'inferred'],
      ['c-sample-rejected', 'inferred'],
      ['c-dup', 'inferred'],
      ['c-dup', 'inferred'],
      ['c-90', 'inferred'],
      ['c-128', 'inferred'],
      ['c-vocal', 'inferred'],
    ]);
    // Keys stay unique when ids repeat.
    expect(new Set(claims.all.map((shown) => shown.key)).size).toBe(claims.all.length);
  });

  it('puts the contradicted claims, whatever their kind, in the rejected list only', () => {
    expect(claims.rejected.map((shown) => shown.claim.text)).toEqual([
      'Paper Lanterns was first released in 1998.',
      'Mixed by Eve Example.',
      'A horn stab from a 1975 record plays at the bridge.',
      'The band toured Japan in 2009.',
      'The song runs at 90 BPM.',
    ]);
    expect(claims.unreadableRejected).toBe(1);
    const shownIds = claims.shown.map((shown) => shown.claim.id);
    for (const id of ['c-1998', 'c-mixed', 'c-sample-rejected', 'c-90']) {
      expect(shownIds).not.toContain(id);
    }
    // An id any claim was rejected under leaves the main view, whichever claim came first.
    expect(shownIds).not.toContain('c-dup');
    expect(claims.isHidden('c-dup')).toBe(true);
    expect(claims.shown).toHaveLength(17);
  });

  it('hides the ids only unreadable claims carry, and says which were rejected', () => {
    expect(claims.isHidden('c-future-rejected')).toBe(true);
    expect(claims.isRejected('c-future-rejected')).toBe(true);
    expect(claims.isHidden('c-future')).toBe(true);
    expect(claims.isUnreadable('c-future')).toBe(true);
    expect(claims.isRejected('c-future')).toBe(false);
    expect(claims.isHidden('c-club')).toBe(false);
    expect(claims.isHidden('no-such-claim')).toBe(false);
    expect(claims.isHidden(undefined)).toBe(false);
  });

  it('keeps the cited items in the pack, and counts the cited ids that are not', () => {
    const gone = claims.byId.get('c-gone');
    expect(gone?.cited).toEqual([]);
    expect(gone?.missingCitations).toBe(1);
    expect(claims.byId.get('c-writers')?.cited.map((item) => item.id)).toEqual(['ev-mb-work']);
  });
});

describe('resultClaims with the claims of more facts', () => {
  it("reads them after the result's own, against the result's evidence pack", () => {
    const track = withClaims([claim({ id: 'c-result' })]);
    const more = [
      claim({ id: 'fc-sourced', kind: 'sourced', evidenceIds: ['ev1'], verdict: 'supported' }),
      claim({ id: 'fc-elsewhere', kind: 'sourced', evidenceIds: ['ev9'], verdict: 'supported' }),
      { ...claim({ id: 'fc-unreadable' }), about: 'lyrics' },
    ];
    const claims = resultClaims(track, more);
    expect(claims.all.map((shown) => [shown.key, shown.kind])).toEqual([
      ['0:c-result', 'inferred'],
      ['1:fc-sourced', 'sourced'],
      // Cites an item this result does not hold: inference, with the citation counted missing.
      ['2:fc-elsewhere', 'inferred'],
    ]);
    expect(claims.byId.get('fc-sourced')?.cited.map((item) => item.id)).toEqual(['ev1']);
    expect(claims.byId.get('fc-elsewhere')?.missingCitations).toBe(1);
    expect(claims.isUnreadable('fc-unreadable')).toBe(true);
    // Without more facts, the result's claims alone.
    expect(resultClaims(track).all.map((shown) => shown.claim.id)).toEqual(['c-result']);
  });

  it("keeps the result's claim when a later one repeats its id, and hides one rejected", () => {
    const track = withClaims([claim({ id: 'c1', text: 'The result says so.' })]);
    const repeat = claim({ id: 'c1', text: 'A later fact says so.' });
    expect(resultClaims(track, [repeat]).byId.get('c1')?.claim.text).toBe('The result says so.');
    const rejected = claim({ id: 'fc-wrong', verdict: 'contradicted' });
    const claims = resultClaims(track, [rejected]);
    expect(claims.isHidden('fc-wrong')).toBe(true);
    expect(claims.rejected.map((shown) => shown.claim.id)).toEqual(['fc-wrong']);
  });
});

describe('withoutHiddenRelations', () => {
  it('drops the relations whose claim is hidden, and the nodes only they related', () => {
    const track = provenanceTrack();
    const claims = resultClaims(track);
    const genealogy = withoutHiddenRelations(track.genealogy, claims.isHidden);
    expect(genealogy.nodes.map((node) => node.id)).toEqual(['current', 'n-kept', 'n-free']);
    expect(genealogy.links.map((link) => link.source)).toEqual(['n-kept', 'n-free']);
  });

  it('keeps nodes no link named, and the same genealogy when nothing is hidden', () => {
    const genealogy = {
      nodes: [
        { id: 'current', group: 1, label: 'A', size: 40 },
        { id: 'lone', group: 4, label: 'B', size: 20 },
        { id: 'both', group: 4, label: 'C', size: 20 },
      ],
      links: [
        { source: 'both', target: 'current', value: 1, claimId: 'bad' },
        { source: 'both', target: 'current', value: 1, claimId: 'good' },
      ],
    } as unknown as TrackData['genealogy'];
    const hidden = withoutHiddenRelations(genealogy, (id) => id === 'bad');
    expect(hidden.nodes.map((node) => node.id)).toEqual(['current', 'lone', 'both']);
    expect(hidden.links).toHaveLength(1);
    expect(withoutHiddenRelations(genealogy, () => false)).toBe(genealogy);
  });
});
