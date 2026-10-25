import type { Claim, ClaimKind, Evidence, SourceId, SourceTier } from '@liner-notes/contract';
import { measuredAudioOf } from '../../constants';
import type { TrackData } from '../../types';
import type { MeasuredAudio } from '../measured/audio';

// Reading the claims and the evidence pack of a result, and deciding how each claim is shown.
//
// The result reaches the app as the server wrote it (only its `audio` block is read by the
// contract on the way, hooks/agent/events.ts), so the claims and evidence are read here, as the
// contract reads them: a list keeps the items its schema accepts and drops the others (a
// tolerant list), and a result without them has none. The page loads no schema for this: the
// checks below mirror the contract's `Claim` and `Evidence`, and claims.property.test.ts checks
// them against the schemas themselves, as audio.property.test.ts does for the measurement.
//
// How a claim is shown is the contract's rule (`claimDisplayKind`, checks.ts), taken here over
// the page's reading of the measurement. A claim the verifier contradicted, or whose number the
// measurement contradicts, leaves the main view whatever its kind: it is listed with the
// rejected claims only (`claimIsRejected`).

// The contract's enums, mirrored so the page loads no schema; claims.property.test.ts checks
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

/** The claim as the contract reads it: its factoid's unreadable entities dropped. */
function readClaim(claim: Claim): Claim {
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

/**
 * A claim rejected by the verifier: its judge found it contradicted by its cited excerpts, or
 * the numeric check found its number contradicted by the measurement. Whatever its kind, it is
 * shown only in the rejected claims, with why.
 */
export function claimIsRejected(claim: Claim): boolean {
  return claim.verdict === 'contradicted' || claim.numericCheck === 'contradicted';
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

/** An evidence item's tier, in words. */
export const sourceTierText = (evidence: Pick<Evidence, 'sourceTier'>): string =>
  SOURCE_TIER_TEXT[evidence.sourceTier];

/**
 * A link that may be opened: an absolute http or https URL, as the browser resolves it; null for
 * anything else (javascript:, data:, a relative path, text that is not a URL).
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// =============================================================================
// A result's claims, ready to show
// =============================================================================

/** A claim with how it is shown and the evidence it cites. */
export interface ShownClaim {
  claim: Claim;
  /** How it is shown (`claimDisplayKind`). */
  kind: ClaimKind;
  /** The cited items found in the evidence pack, in the claim's order. */
  cited: Evidence[];
  /** How many cited ids are not in the evidence pack. */
  missingCitations: number;
  rejected: boolean;
}

export interface ResultClaims {
  /** Every claim the page can read, in the result's order. */
  all: ShownClaim[];
  byId: ReadonlyMap<string, ShownClaim>;
  /** The claims of the main view: every claim not rejected. */
  shown: ShownClaim[];
  rejected: ShownClaim[];
}

/** The claim context of a result: its evidence pack's ids and its measurement. */
export function claimContextOf(track: TrackData, evidence = readEvidence(track.evidence)) {
  return {
    evidenceIds: new Set(evidence.map((item) => item.id)),
    audio: measuredAudioOf(track),
  } satisfies ClaimContext;
}

/** A result's claims, each with how it is shown, split into shown and rejected. */
export function resultClaims(track: TrackData): ResultClaims {
  const evidence = readEvidence(track.evidence);
  const context = claimContextOf(track, evidence);
  const pack = new Map<string, Evidence>();
  for (const item of evidence) if (!pack.has(item.id)) pack.set(item.id, item);
  const all = readClaims(track.claims).map((claim): ShownClaim => {
    const ids = [...new Set(claim.evidenceIds)];
    const cited = ids.flatMap((id) => pack.get(id) ?? []);
    return {
      claim,
      kind: claimDisplayKind(claim, context),
      cited,
      missingCitations: ids.length - cited.length,
      rejected: claimIsRejected(claim),
    };
  });
  const byId = new Map<string, ShownClaim>();
  for (const shown of all) if (!byId.has(shown.claim.id)) byId.set(shown.claim.id, shown);
  return {
    all,
    byId,
    shown: all.filter((shown) => !shown.rejected),
    rejected: all.filter((shown) => shown.rejected),
  };
}
