import type { ClaimAbout } from '@liner-notes/contract';
import React, { useMemo } from 'react';
import {
  Info,
  ExternalLink,
  MicVocal,
  Music,
  Users,
  Lightbulb,
  Link2,
  type LucideIcon,
  KeyboardMusic,
  SlidersHorizontal,
  Disc3,
  Wrench,
  User,
  Disc,
  CalendarDays,
  History,
  AudioWaveform,
  Repeat2,
} from 'lucide-react';
import type { Reading } from '../constants';
import type { Factoid, FactoidEntity } from '../types';
import { safeHref, type ShownClaim } from './provenance/claims';
import { ProvenanceChip } from './provenance/ProvenanceChip';
import type { MeasuredAudio } from './measured/audio';
import { ClaimChip } from './provenance/ClaimChip';

interface InteractiveFactoidProps {
  factoid: Factoid;
  /**
   * The claim this card states (its `claimId`), shown with its kind, sources and verifier
   * status. A card without one is labelled by its section instead.
   */
  claim?: ShownClaim;
  /**
   * Where a card without a claim comes from (written by the model, or taken from source data),
   * when the cards beside it carry claims of their own.
   */
  origin?: 'inferred' | 'record';
  /**
   * The card was taken from source data by code (a result built without the model), not written
   * by the model. Only then does a card without a claim name a sample or a cover as such.
   */
  fromSourceData?: boolean;
  /** The result's signal readings, for a claim about a measured value. */
  readings?: readonly Reading[];
  /** The result's measurement, for the measured side of a conflict. */
  audio?: MeasuredAudio | null;
}

// Entity links (to the card's cited source, not provenance) are neutral: the cyan, amber and
// violet that say how a statement is known belong to its provenance chip alone. An icon and a
// word say the type.
const ENTITY_CHROME = 'text-text-secondary hover:bg-white/10 border-white/30';
const ENTITY_TYPES: Record<FactoidEntity['type'], { word: string; Icon: LucideIcon }> = {
  synth: { word: 'synth', Icon: KeyboardMusic },
  producer: { word: 'producer', Icon: SlidersHorizontal },
  sample: { word: 'sample', Icon: Disc3 },
  technique: { word: 'technique', Icon: Wrench },
  artist: { word: 'artist', Icon: User },
  album: { word: 'album', Icon: Disc },
  year: { word: 'year', Icon: CalendarDays },
};

// A card's category (production, credits, sample...) is drawn in neutral greys: the colours
// that say how a statement is known (cyan measured, amber sourced, violet inferred) belong to its
// provenance chip alone, and a category says nothing about that.
const CATEGORY_CHROME = 'text-text-secondary';

interface Category {
  /** What the badge says, as its data-factoid-type ("possible-sample" for a possible sample). */
  key: string;
  icon: React.ReactNode;
  label: string;
}

// A card's own label, for a card without a claim.
const FACTOID_CATEGORIES: Record<Factoid['type'], { Icon: LucideIcon; label: string }> = {
  production: { Icon: MicVocal, label: 'PRODUCTION' },
  credits: { Icon: Users, label: 'CREDITS' },
  sample: { Icon: Music, label: 'SAMPLE' },
  curiosity: { Icon: Lightbulb, label: 'CURIOSITY' },
  connection: { Icon: Link2, label: 'CONNECTION' },
  trivia: { Icon: Info, label: 'TRIVIA' },
};

// What a claim is about (the contract's ClaimAbout), for a card that states one.
const CLAIM_CATEGORIES: Record<ClaimAbout, { Icon: LucideIcon; label: string }> = {
  track: { Icon: Disc, label: 'TRACK' },
  credit: { Icon: Users, label: 'CREDITS' },
  sample: { Icon: Music, label: 'SAMPLE' },
  cover: { Icon: Repeat2, label: 'COVER' },
  history: { Icon: History, label: 'HISTORY' },
  sound: { Icon: AudioWaveform, label: 'SOUND' },
  production: { Icon: MicVocal, label: 'PRODUCTION' },
  connection: { Icon: Link2, label: 'CONNECTION' },
  trivia: { Icon: Info, label: 'TRIVIA' },
};

// A relation to another record (a sample, a cover) the card names as such only when it is known:
// its claim is shown as sourced or measured and was not found only partly supported, or, without
// a claim, the card was taken from source data. A relation is stated whole, as the verifier
// reads every claim about one, a card's or a link's: a source that supports only part of it does
// not confirm it (results stored before it did so may still hold a partly supported relation
// read as sourced). A model's guess reads as possible.
const RELATIONS: ReadonlySet<string> = new Set(['sample', 'cover']);

/**
 * The badge of a card: what its claim is about when it states one (the card's own type is the
 * model's label), else the card's type. A sample or a cover that is not known reads as possible.
 */
export function factoidCategory(
  factoid: Factoid,
  claim: ShownClaim | undefined,
  fromSourceData = false,
): Category {
  const type = claim ? claim.claim.about : factoid.type;
  const category =
    (claim ? CLAIM_CATEGORIES[claim.claim.about] : FACTOID_CATEGORIES[factoid.type]) ??
    FACTOID_CATEGORIES.trivia;
  const known = claim
    ? (claim.kind === 'sourced' || claim.kind === 'measured') && claim.claim.verdict !== 'partial'
    : fromSourceData;
  const possible = RELATIONS.has(type) && !known;
  return {
    key: possible ? `possible-${type}` : type,
    icon: <category.Icon size={14} />,
    label: possible ? `POSSIBLE ${category.label}` : category.label,
  };
}

/**
 * Where a card's entities link: the first source its claim cites that can be opened, when the
 * claim is shown as sourced; null otherwise (its entities are plain text).
 */
export function entityHref(claim: ShownClaim | undefined): string | null {
  if (claim?.kind !== 'sourced') return null;
  for (const item of claim.cited) {
    const href = safeHref(item.url);
    if (href) return href;
  }
  return null;
}

const InteractiveFactoid: React.FC<InteractiveFactoidProps> = ({
  factoid,
  claim,
  origin,
  fromSourceData = false,
  readings,
  audio,
}) => {
  // The card's entities link to the source its claim cites, when it is shown as sourced.
  const href = entityHref(claim);
  // Memoized content with the linked entities highlighted, and how many links it draws (an
  // entity whose text is not in the content as written is not drawn).
  const { renderedContent, linked } = useMemo(() => {
    if (!factoid.entities?.length) {
      return { renderedContent: <span>{factoid.content}</span>, linked: 0 };
    }

    const content = factoid.content;
    const elements: React.ReactNode[] = [];
    let lastIndex = 0;
    let links = 0;

    // Sort entities by their position in content to process in order
    const sortedEntities = [...factoid.entities].sort((a, b) => {
      const posA = content.indexOf(a.text);
      const posB = content.indexOf(b.text);
      return posA - posB;
    });

    sortedEntities.forEach((entity) => {
      const entityIndex = content.indexOf(entity.text, lastIndex);
      if (entityIndex === -1) return;

      // Add text before entity
      if (entityIndex > lastIndex) {
        elements.push(
          <span key={`text-before-${entity.id}`}>{content.slice(lastIndex, entityIndex)}</span>,
        );
      }

      // An entity links to the cited source: its type as an icon on screen and as a word in its
      // name. Without a source to open it is plain text.
      const kind = ENTITY_TYPES[entity.type] as
        | (typeof ENTITY_TYPES)[FactoidEntity['type']]
        | undefined;
      const name = kind ? `${entity.text} (${kind.word})` : entity.text;
      if (href) links += 1;
      elements.push(
        href ? (
          <a
            key={entity.id}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            data-entity-type={entity.type}
            aria-label={`${name}, opens the cited source in a new tab`}
            className={`
              inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-sm
              border transition-all
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white
              ${ENTITY_CHROME}
            `}
          >
            {kind && (
              <kind.Icon size={12} aria-hidden="true" className="mr-1 opacity-70 shrink-0" />
            )}
            {entity.text}
            <ExternalLink size={12} aria-hidden="true" className="ml-1 opacity-60 shrink-0" />
          </a>
        ) : (
          <span key={entity.id} data-entity-type={entity.type}>
            {entity.text}
          </span>
        ),
      );

      lastIndex = entityIndex + entity.text.length;
    });

    // Add remaining text
    if (lastIndex < content.length) {
      elements.push(<span key="text-end">{content.slice(lastIndex)}</span>);
    }

    return { renderedContent: <>{elements}</>, linked: links };
  }, [factoid.content, factoid.entities, href]);

  const style = factoidCategory(factoid, claim, fromSourceData);

  return (
    <div
      data-factoid-category={factoid.type}
      className="relative bg-surface/80 backdrop-blur-sm border border-border border-l-2 border-l-white/25 p-(--space-md) md:p-(--space-lg) rounded-md group hover:border-white/20 hover:bg-surface transition-all duration-(--duration-normal) ease-out-expo animate-fade-in-up overflow-hidden"
    >
      {/* Subtle glow on hover, neutral like the rest of the category chrome */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-(--duration-slow) pointer-events-none bg-gradient-to-br from-transparent via-transparent to-white/[0.03]" />

      {/* Header: in a narrow column the type chip moves below the title, and a title still
          wider than the column wraps, so neither is cut */}
      <div
        data-factoid-header
        className="relative flex flex-wrap items-center gap-x-2 gap-y-1 mb-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`${CATEGORY_CHROME} flex shrink-0 items-center justify-center w-6 h-6 rounded-full bg-white/5`}
          >
            {style.icon}
          </span>
          <span
            data-factoid-title
            className="min-w-0 break-words text-xs font-semibold text-text-secondary uppercase font-mono tracking-wider"
          >
            {factoid.title}
          </span>
        </div>
        <span
          data-factoid-type={style.key}
          className={`ml-auto max-w-full truncate text-chrome font-mono px-2 py-0.5 rounded-full ${CATEGORY_CHROME} bg-white/5`}
        >
          {style.label}
        </span>
      </div>

      {/* Content */}
      <p className="relative text-sm text-text-secondary leading-relaxed font-sans group-hover:text-text-primary transition-colors duration-(--duration-fast)">
        {renderedContent}
      </p>

      {/* Where the statement comes from: its claim's kind, sources and verifier status */}
      {claim ? (
        <ClaimChip shown={claim} readings={readings} audio={audio} className="relative mt-3" />
      ) : (
        origin && <ProvenanceChip kind={origin} className="relative mt-3" />
      )}

      {/* Linked entities count indicator */}
      {linked > 0 && (
        <div
          data-entity-count
          className="relative mt-3 pt-2 border-t border-white/5 text-chrome font-mono text-text-tertiary flex items-center gap-1.5"
        >
          <span className="inline-block w-1 h-1 rounded-full bg-white/30" />
          {linked} CLICKABLE {linked === 1 ? 'ENTITY' : 'ENTITIES'}
        </div>
      )}
    </div>
  );
};

export default React.memo(InteractiveFactoid);
