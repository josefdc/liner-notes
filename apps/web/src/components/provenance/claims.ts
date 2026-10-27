import {
  type Claim,
  type ClaimKind,
  claimIsRejected,
  type Evidence,
  type SourceId,
  type SourceTier,
} from '@liner-notes/contract';
import { measuredAudioOf } from '../../constants';
import type { TrackData } from '../../types';
import type { MeasuredAudio } from '../measured/audio';

// Reading the claims and the evidence pack of a result, and deciding how each claim is shown.
//
// The result reaches the app as the server wrote it (only its `audio` block is read by the
// contract on the way, hooks/agent/events.ts), so the claims and evidence are read here, as the
// contract reads them: a list keeps the items its schema accepts and drops the others (a
// tolerant list), and a result without them has none. No schema is run for this: the checks
// below mirror the contract's `Claim` and `Evidence`, and claims.property.test.ts checks them
// against the schemas themselves, as audio.property.test.ts does for the measurement. (This
// module still imports the contract, for `claimIsRejected`, so the contract's chunk, zod with
// it, loads with it.)
//
// How a claim is shown is the contract's rule (`claimDisplayKind`, checks.ts), taken here over
// the page's reading of the measurement. A claim the verifier contradicted, or whose number the
// measurement contradicts, leaves the main view whatever its kind: it is listed with the
// rejected claims only (the contract's `claimIsRejected`, re-exported here).

export { claimIsRejected };

// The contract's enums, mirrored so the checks run no schema; claims.property.test.ts checks
// that each equals the contract's own.
export const SOURCE_IDS: ReadonlySet<string> = new Set([
  'spotify',
  'deezer',
  'musicbrainz',
  'discogs',
  'secondhandsongs',
  'listenbrainz',
  'lastfm',
  'genius',
  'tavily',
]);
export const SOURCE_TIERS: ReadonlySet<string> = new Set(['primary-record', 'editorial', 'web']);
export const CLAIM_KINDS: ReadonlySet<string> = new Set(['measured', 'sourced', 'inferred']);
export const CLAIM_ABOUTS: ReadonlySet<string> = new Set([
  'track',
  'credit',
  'sample',
  'cover',
  'history',
  'sound',
  'production',
  'connection',
  'trivia',
]);
export const VERDICTS: ReadonlySet<string> = new Set([
  'supported',
  'partial',
  'unsupported',
  'contradicted',
]);
export const NUMERIC_CHECKS: ReadonlySet<string> = new Set([
  'consistent',
  'conflict',
  'contradicted',
  'n/a',
]);
export const CLAIM_ORIGINS: ReadonlySet<string> = new Set(['code', 'model']);
export const CLAIM_FIELDS: ReadonlySet<string> = new Set(['tempo', 'key']);
export const CLAIM_SCOPES: ReadonlySet<string> = new Set(['recording', 'work', 'release']);
export const FACTOID_TYPES: ReadonlySet<string> = new Set([
  'production',
  'trivia',
  'credits',
  'sample',
  'curiosity',
  'connection',
]);
export const FACTOID_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'synth',
  'producer',
  'sample',
  'technique',
  'artist',
  'album',
  'year',
]);

/** The contract's `Timestamp`: an RFC 3339 date-time in UTC ending in Z (common.ts). */
export const UTC_DATE_TIME =
  /^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z))$/;

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isId = (value: unknown) => isString(value) && value.length > 0;
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const oneOf = (values: ReadonlySet<string>) => (value: unknown) =>
  isString(value) && values.has(value);

/** True when the contract's `Evidence` schema accepts the item. */
export function isEvidence(value: unknown): value is Evidence {
  if (!isObject(value)) return false;
  return (
    isId(value.id) &&
    oneOf(SOURCE_IDS)(value.source) &&
    oneOf(SOURCE_TIERS)(value.sourceTier) &&
    (value.url === null || isString(value.url)) &&
    isString(value.title) &&
    isString(value.retrievedAt) &&
    UTC_DATE_TIME.test(value.retrievedAt) &&
    isString(value.excerpt) &&
    (value.recordRef === null || isString(value.recordRef))
  );
}

const isComparisonValue = (value: unknown) => isNumber(value) || isString(value);

function isNumericComparison(value: unknown): boolean {
  return (
    isObject(value) &&
    isComparisonValue(value.claimed) &&
    isComparisonValue(value.measured) &&
    isString(value.method)
  );
}

const isPresentationEntity = (value: unknown) =>
  isObject(value) && isString(value.text) && oneOf(FACTOID_ENTITY_TYPES)(value.type);

function isFactoidPresentation(value: unknown): boolean {
  // Its entities are a tolerant list: entries it cannot read are dropped, never fatal.
  return (
    isObject(value) &&
    isString(value.title) &&
    oneOf(FACTOID_TYPES)(value.type) &&
    Array.isArray(value.entities)
  );
}

/** True when the contract's `Claim` schema accepts the claim. */
export function isClaim(value: unknown): value is Claim {
  if (!isObject(value)) return false;
  const { numericReason, numericComparison, field, factoid } = value;
  return (
    isId(value.id) &&
    isString(value.text) &&
    oneOf(CLAIM_ABOUTS)(value.about) &&
    oneOf(CLAIM_KINDS)(value.kind) &&
    oneOf(CLAIM_ORIGINS)(value.origin) &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every(isString) &&
    (value.verdict === null || oneOf(VERDICTS)(value.verdict)) &&
    (value.verdictReason === null || isString(value.verdictReason)) &&
    oneOf(NUMERIC_CHECKS)(value.numericCheck) &&
    (numericReason === undefined || numericReason === null || isString(numericReason)) &&
    (numericComparison === undefined ||
      numericComparison === null ||
      isNumericComparison(numericComparison)) &&
    (field === undefined || oneOf(CLAIM_FIELDS)(field)) &&
    (factoid === undefined || isFactoidPresentation(factoid))
  );
}

/**
 * The claim as the contract reads it: a scope it does not know as none (a claim about this
 * recording), and its factoid's unreadable entities dropped.
 */
function readClaim(value: Claim): Claim {
  let claim = value;
  if (claim.scope !== undefined && !CLAIM_SCOPES.has(claim.scope)) {
    const { scope: _unread, ...rest } = claim;
    claim = rest;
  }
  if (!claim.factoid) return claim;
  const entities = (claim.factoid.entities as unknown[]).filter(isPresentationEntity);
  return { ...claim, factoid: { ...claim.factoid, entities } as Claim['factoid'] };
}

/** A result's claims (a tolerant list): those the contract can read, in their order. */
export function readClaims(value: unknown): Claim[] {
  return Array.isArray(value) ? value.filter(isClaim).map(readClaim) : [];
}

/** A result's evidence pack (a tolerant list): the items the contract can read. */
export function readEvidence(value: unknown): Evidence[] {
  return Array.isArray(value) ? value.filter(isEvidence) : [];
}

// =============================================================================
// How a claim is shown
// =============================================================================

/** What a claim is shown against: the ids of the evidence pack and the measurement. */
export interface ClaimContext {
  evidenceIds: ReadonlySet<string>;
  /** The page's reading of the result's measurement (null when it has none to read). */
  audio: MeasuredAudio | null;
}

/** The measured block a claim field points at, or null when that was not measured. */
function measuredBlock(audio: MeasuredAudio | null, field: Claim['field']) {
  if (!audio?.gate.passed || field === undefined) return null;
  return audio[field];
}

const citesOnlyKnown = (ids: readonly string[], context: ClaimContext) =>
  ids.length > 0 && ids.every((id) => context.evidenceIds.has(id));

/**
 * The contract's `claimDisplayKind` (checks.ts): a measured claim reads as measured only when
 * code wrote it and its field was measured; a sourced claim that cites nothing, cites evidence
 * missing from the pack, or is a model claim the judge did not support, reads as model
 * inference. Everything else keeps its kind.
 */
export function claimDisplayKind(claim: Claim, context: ClaimContext): ClaimKind {
  if (claim.kind === 'measured') {
    const measured = claim.origin === 'code' && measuredBlock(context.audio, claim.field) !== null;
    return measured ? 'measured' : 'inferred';
  }
  if (claim.kind !== 'sourced') return claim.kind;
  const judged =
    claim.origin === 'code' || claim.verdict === 'supported' || claim.verdict === 'partial';
  return citesOnlyKnown(claim.evidenceIds, context) && judged ? 'sourced' : 'inferred';
}

// =============================================================================
// Sources
// =============================================================================

export const SOURCE_NAMES: Record<SourceId, string> = {
  spotify: 'Spotify',
  deezer: 'Deezer',
  musicbrainz: 'MusicBrainz',
  discogs: 'Discogs',
  secondhandsongs: 'SecondHandSongs',
  listenbrainz: 'ListenBrainz',
  lastfm: 'Last.fm',
  genius: 'Genius',
  tavily: 'Web search',
};

/** How authoritative a source is, in words (the contract's `SourceTier`). */
export const SOURCE_TIER_TEXT: Record<SourceTier, string> = {
  'primary-record': 'primary record',
  editorial: 'editorial',
  web: 'web page',
};

/** What a primary record states a fact about: the first segment of its recordRef. */
export type RecordScope = 'recording' | 'song' | 'release';
const SCOPES: Record<string, RecordScope> = {
  track: 'recording',
  work: 'song',
  release: 'release',
};

/** The scope of an item's record, or null when its recordRef names none the contract knows. */
export function recordScope(evidence: Pick<Evidence, 'recordRef'>): RecordScope | null {
  const prefix = evidence.recordRef?.split('/')[0] ?? '';
  return Object.hasOwn(SCOPES, prefix) ? (SCOPES[prefix] as RecordScope) : null;
}

/**
 * An item's tier as the contract's evidence rules allow it, never above what it states: a web
 * search result is never a primary record (`evidenceIssues`), and a primary record names its
 * record with a scoped recordRef (evidence.ts). A primary record that breaks either rule is
 * shown as a web page; "editorial" and "web" are shown as stated.
 */
export function sourceTier(evidence: Pick<Evidence, 'source' | 'sourceTier' | 'recordRef'>) {
  if (evidence.sourceTier !== 'primary-record') return evidence.sourceTier;
  return evidence.source !== 'tavily' && recordScope(evidence) !== null
    ? 'primary-record'
    : ('web' as const);
}

/** An evidence item's tier, in words (see sourceTier). */
export const sourceTierText = (
  evidence: Pick<Evidence, 'source' | 'sourceTier' | 'recordRef'>,
): string => SOURCE_TIER_TEXT[sourceTier(evidence)];

/** What a record is about when that is not this recording, in words; null for this recording. */
export function scopeText(evidence: Pick<Evidence, 'recordRef'>): string | null {
  const scope = recordScope(evidence);
  if (scope === 'song') return 'about the song, not this recording';
  if (scope === 'release') return 'about a whole release';
  return null;
}

// Preview clips and signed links (the API's isPreviewUrl, apps/api/src/store/runs.ts): Deezer's
// and Spotify's preview hosts, and URLs signed with an expiring token. Producers keep them out
// of results; a link to one would expire, or carry a credential.
const PREVIEW_HOST =
  /^https?:\/\/(?:[^/?#@\s]*\.)?(?:(?:e-)?cdn[st]-preview(?:-[a-z0-9]+)?\.dzcdn\.net|p\.scdn\.co)(?::\d+)?(?:[/?#]\S*)?$/i;
const SIGNED_URL = /^https?:\/\/\S*[?&;~](?:hdnea|hdnts|x-amz-signature)=\S*$/i;
// Query (or fragment) parameters that carry a credential or sign a URL: tokens and keys, S3
// (X-Amz-*), Google Cloud Storage, Azure SAS (sig, se), CloudFront (Policy, Signature,
// Key-Pair-Id) and Akamai (hdnea, hdnts).
const CREDENTIAL_PARAMS = new Set([
  'access_token',
  'id_token',
  'api_key',
  'apikey',
  'token',
  'signature',
  'sig',
  'se',
  'policy',
  'key-pair-id',
  'x-amz-credential',
  'x-amz-signature',
  'x-amz-security-token',
  'x-goog-credential',
  'x-goog-signature',
  'hdnea',
  'hdnts',
]);

/** True when a query or fragment (`?a=1&b=2`, `#access_token=…`) names a credential parameter. */
function carriesCredential(params: string): boolean {
  const keys = [...new URLSearchParams(params.replace(/^[?#]/, '')).keys()];
  return keys.some((key) => CREDENTIAL_PARAMS.has(key.toLowerCase()));
}

/**
 * A link that may be opened: an absolute http or https URL, as the browser resolves it; null for
 * anything else (javascript:, data:, a relative path, text that is not a URL), and for a URL that
 * carries a credential (a user name or password, a signed or token query) or is a preview clip.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (carriesCredential(parsed.search) || carriesCredential(parsed.hash)) return null;
  const href = parsed.href;
  for (const value of [url.trim(), href]) {
    if (PREVIEW_HOST.test(value) || SIGNED_URL.test(value)) return null;
  }
  return href;
}

// =============================================================================
// A result's claims, ready to show
// =============================================================================

/** A claim with how it is shown and the evidence it cites. */
export interface ShownClaim {
  claim: Claim;
  /** A key unique within the result (claim ids may repeat): its position and id. */
  key: string;
  /** How it is shown (`claimDisplayKind`). */
  kind: ClaimKind;
  /** The cited items found in the evidence pack, in the claim's order. */
  cited: Evidence[];
  /** How many cited ids are not in the evidence pack. */
  missingCitations: number;
  /** The claim itself was rejected (`claimIsRejected`). */
  rejected: boolean;
}

export interface ResultClaims {
  /** Every claim the page can read, in the result's order. */
  all: ShownClaim[];
  /** The first claim the page can read with each id. */
  byId: ReadonlyMap<string, ShownClaim>;
  /**
   * The claims of the main view: the first readable claim with each id, unless that id is
   * hidden (see `isHidden`).
   */
  shown: ShownClaim[];
  /** Every readable claim the verifier rejected. */
  rejected: ShownClaim[];
  /** Rejected claims this page cannot read (listed by count only). */
  unreadableRejected: number;
  /**
   * True for an id the main view must not show anything for: an id any claim with it was
   * rejected under, read or not, or an id only unreadable claims carry. Cards, samples and
   * genealogy links that state such a claim are left out.
   */
  isHidden: (id: unknown) => boolean;
  /** True for an id only claims this page cannot read carry. */
  isUnreadable: (id: unknown) => boolean;
  /** True for an id any claim with it was rejected under, read or not. */
  isRejected: (id: unknown) => boolean;
  /** The ids any claim was rejected under, read or not (as `isRejected`). */
  rejectedIds: ReadonlySet<string>;
  /** The page's reading of the measurement, for the conflict lines. */
  audio: MeasuredAudio | null;
}

/** The claim context of a result: its evidence pack's ids and its measurement. */
export function claimContextOf(track: TrackData, evidence = readEvidence(track.evidence)) {
  return {
    evidenceIds: new Set(evidence.map((item) => item.id)),
    audio: measuredAudioOf(track),
  } satisfies ClaimContext;
}

const idOf = (item: unknown): string | null =>
  isObject(item) && isId(item.id) ? (item.id as string) : null;

/**
 * A result's claims, each with how it is shown, split into shown and rejected. `more` are the
 * claims of the facts "more facts" added (MoreFacts.claims): read and shown as the result's own,
 * after them, against the result's evidence pack and measurement. A result claim and a later one
 * with the same id: the first readable one is shown, and a rejected one hides the id.
 */
export function resultClaims(track: TrackData, more: readonly unknown[] = []): ResultClaims {
  const evidence = readEvidence(track.evidence);
  const context = claimContextOf(track, evidence);
  const pack = new Map<string, Evidence>();
  for (const item of evidence) if (!pack.has(item.id)) pack.set(item.id, item);
  const raw: unknown[] = [...(Array.isArray(track.claims) ? track.claims : []), ...more];

  const all: ShownClaim[] = [];
  const rejectedIds = new Set<string>();
  const readableIds = new Set<string>();
  const unreadableIds = new Set<string>();
  let unreadableRejected = 0;
  raw.forEach((item, index) => {
    const id = idOf(item);
    const rejected = isObject(item) && claimIsRejected(item);
    if (id !== null && rejected) rejectedIds.add(id);
    if (!isClaim(item)) {
      if (id !== null) unreadableIds.add(id);
      if (rejected) unreadableRejected += 1;
      return;
    }
    const claim = readClaim(item);
    readableIds.add(claim.id);
    const ids = [...new Set(claim.evidenceIds)];
    const cited = ids.flatMap((citedId) => pack.get(citedId) ?? []);
    all.push({
      claim,
      key: `${index}:${claim.id}`,
      kind: claimDisplayKind(claim, context),
      cited,
      missingCitations: ids.length - cited.length,
      rejected,
    });
  });

  const byId = new Map<string, ShownClaim>();
  for (const shown of all) if (!byId.has(shown.claim.id)) byId.set(shown.claim.id, shown);
  const isUnreadable = (id: unknown) =>
    typeof id === 'string' && unreadableIds.has(id) && !readableIds.has(id);
  const isRejected = (id: unknown) => typeof id === 'string' && rejectedIds.has(id);
  const isHidden = (id: unknown) => isRejected(id) || isUnreadable(id);
  return {
    all,
    byId,
    shown: [...byId.values()].filter((shown) => !isHidden(shown.claim.id)),
    rejected: all.filter((shown) => shown.rejected),
    unreadableRejected,
    isHidden,
    isUnreadable,
    isRejected,
    rejectedIds,
    audio: context.audio,
  };
}

/**
 * A genealogy without the relations the main view must not show: links whose claim is hidden
 * (rejected, or unreadable), and the nodes those links alone related to this track. The current
 * track, and nodes no link named, stay as they were.
 */
export function withoutHiddenRelations(
  genealogy: TrackData['genealogy'],
  isHidden: (id: unknown) => boolean,
): TrackData['genealogy'] {
  // A link that is not an object (null, from a tolerant payload) relates nothing: it is skipped.
  const claimOf = (link: unknown) => (isObject(link) ? link.claimId : undefined);
  const links = genealogy.links.filter((link) => isObject(link) && !isHidden(claimOf(link)));
  if (links.length === genealogy.links.length) return genealogy;
  const ends = (list: TrackData['genealogy']['links']) =>
    new Set(list.flatMap((link) => [link.source, link.target]));
  const linkedBefore = ends(genealogy.links.filter(isObject) as TrackData['genealogy']['links']);
  const linkedAfter = ends(links);
  const nodes = genealogy.nodes.filter(
    (node) =>
      !isObject(node) || node.group === 1 || linkedAfter.has(node.id) || !linkedBefore.has(node.id),
  );
  return { nodes, links };
}
