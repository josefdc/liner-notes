import type React from 'react';
import { useId } from 'react';
import { Square, Volume2, X } from 'lucide-react';
import type { GenealogyNode } from '../../types';
import { Button } from '../ui/Button';
import { LINE, statusText, verdictReasonText } from '../provenance/ClaimChip';
import type { ResultClaims } from '../provenance/claims';
import { ProvenanceChip } from '../provenance/ProvenanceChip';
import { SourceNote } from '../provenance/SourceNote';
import { cardWords } from './cardWords';
import {
  kindLabel,
  LABEL_YEAR,
  linkProvenanceKind,
  relationSentence,
  type ShownLink,
} from './links';
import { type Listening, type ListeningPlan, unavailableText } from './useABListening';

/**
 * The selected track's details, in the map's panel: the track, each shown relation it has (as a
 * sentence, how it is known, and its evidence), "Analyze this track" (the one way the map starts
 * an analysis) and A/B listening. Over the bottom of the canvas, or under the compact row.
 */

/**
 * What the verifier said of a link that is not code-built (the model's, or one an older result
 * does not say the origin of), in words; never a verdict the result lacks.
 */
export function verifierText(link: ShownLink, claims: ResultClaims | null | undefined): string {
  const claim = link.claim;
  if (!claim) return 'Verifier: not checked; no claim is linked to this relation';
  const shown = claims?.byId.get(claim.id);
  const said =
    verdictReasonText(claim) ?? (shown ? statusText(shown) : null) ?? 'not checked by the verifier';
  const reason = claim.verdict === 'supported' ? claim.verdictReason?.trim() : '';
  return `Verifier: ${said.charAt(0).toLowerCase()}${said.slice(1)}${reason ? ` · ${reason}` : ''}`;
}

/** One relation of the selected track: the sentence, its kind, and where it comes from. */
const RelationEvidence: React.FC<{
  link: ShownLink;
  nameOf: (id: string) => string;
  claims: ResultClaims | null | undefined;
}> = ({ link, nameOf, claims }) => {
  const cited = link.citations.flatMap((citation) =>
    citation.evidence ? [citation.evidence] : [],
  );
  const sourced = link.kind === 'sourced';
  const notes = cited.map((evidence) => (
    <SourceNote key={evidence.id} evidence={evidence} showTier={sourced} />
  ));
  const code = link.origin === 'code';
  // Each source link at least 24 px tall: a touch target.
  const citing = `${LINE} flex flex-wrap items-center gap-x-2 gap-y-1 [&_a]:inline-block [&_a]:py-1`;
  return (
    <li data-link-kind={link.kind} className="flex flex-col items-start gap-1">
      <p className="text-text-secondary">{relationSentence(link, nameOf)}</p>
      <ProvenanceChip kind={linkProvenanceKind(link)}>{kindLabel(link)}</ProvenanceChip>
      {/* What the verifier said: for any link not built from a record, and any with a claim */}
      {(!code || link.claim) && (
        <p className={LINE} data-verifier>
          {verifierText(link, claims)}
        </p>
      )}
      {notes.length > 0 &&
        (code ? (
          // A link built from a record: the record it is built from.
          <p className={citing} data-sourced-from>
            <span>{sourced ? 'Sourced from' : 'Cites'}</span>
            {notes}
          </p>
        ) : (
          <p className={citing}>
            <span>{link.origin === 'model' ? 'Cited by the model:' : 'Cites:'}</span>
            {notes}
          </p>
        ))}
      {!sourced && link.reasons.length > 0 && (
        <p className={LINE}>Why it is not sourced: {link.reasons.join('; ')}</p>
      )}
    </li>
  );
};

export const DetailPanel: React.FC<{
  node: GenealogyNode;
  /** Its year as a record dates it (null: undated). */
  year: number | null;
  /** Its shown links, best known first. */
  links: readonly ShownLink[];
  nameOf: (id: string) => string;
  claims: ResultClaims | null | undefined;
  /** A/B listening with the analysed track, or why it cannot play; null when there is none. */
  plan: ListeningPlan | null;
  listening: Listening | null;
  /** Why the last pair stopped short, if it did. */
  listeningMessage: string | null;
  onListen: () => void;
  onStopListening: () => void;
  onAnalyse: () => void;
  onClose: () => void;
  /**
   * Over the bottom of the canvas ('overlay'), over its top under the heading ('top': the
   * analysed track's card lies below the selected one), or in the flow ('inline').
   */
  layout: 'overlay' | 'top' | 'inline';
  /** Where the top of the map's free room is (px), for 'top'. */
  topOffset?: number;
  /** How far over the canvas's bottom it sits (px), for 'overlay': above the edge cues there. */
  bottomOffset?: number;
  /** How much less than 60% of the canvas it may take (px), on the canvas. */
  shorterBy?: number;
  panelRef?: React.Ref<HTMLElement>;
}> = ({
  node,
  year,
  links,
  nameOf,
  claims,
  plan,
  listening,
  listeningMessage,
  onListen,
  onStopListening,
  onAnalyse,
  onClose,
  layout,
  topOffset = 0,
  bottomOffset = 8,
  shorterBy = 0,
  panelRef,
}) => {
  const headingId = useId();
  // The title without a year its label ends with: the panel gives the record's year (or
  // "undated") beside it, never a second one from the label.
  const words = cardWords(node, year);
  const title = words.title.replace(LABEL_YEAR, '').trim() || words.title;
  const artist = words.artist;
  const step = listening ? listening.steps[listening.index] : null;
  const status = step
    ? `Playing: ${step.name} (${(listening?.index ?? 0) + 1} of ${listening?.steps.length ?? 2})`
    : (listeningMessage ?? '');
  const place =
    layout === 'inline'
      ? 'mx-4 mb-3'
      : 'absolute left-2 right-2 z-30 max-h-[60%] md:left-auto md:w-[28rem] md:max-w-[calc(100%-1rem)]';
  return (
    <section
      ref={panelRef}
      aria-labelledby={headingId}
      tabIndex={-1}
      data-testid="node-detail"
      data-at={layout}
      style={
        layout === 'top'
          ? { top: topOffset, maxHeight: `calc(60% - ${shorterBy}px)` }
          : layout === 'overlay'
            ? { bottom: bottomOffset, maxHeight: `calc(60% - ${shorterBy}px)` }
            : undefined
      }
      className={`${place} flex flex-col gap-2 overflow-y-auto overscroll-contain cursor-auto rounded-sm border border-white/20 bg-void p-3 font-mono text-chrome text-text-chip wrap-anywhere focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber/70`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={headingId} className="text-text-primary">
            {title}
          </h3>
          <p className="text-text-tertiary">
            {artist ? `${artist} · ` : ''}
            {year ?? 'undated'}
          </p>
        </div>
        <button
          type="button"
          aria-label="Close details"
          onClick={onClose}
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-text-tertiary hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber/70"
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {/* The actions first: on a phone they are in view without scrolling the panel */}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="neutral" size="sm" onClick={onAnalyse}>
          Analyze this track
        </Button>
        {plan?.kind === 'ready' && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={listening ? onStopListening : onListen}
            leftIcon={
              listening ? (
                <Square size={12} aria-hidden="true" />
              ) : (
                <Volume2 size={12} aria-hidden="true" />
              )
            }
          >
            {listening ? 'Stop' : plan.label}
          </Button>
        )}
      </div>
      {plan && plan.kind !== 'ready' && <p data-listening-unavailable>{unavailableText(plan)}</p>}
      {/* What plays, step by step, or why the pair stopped short: announced as it changes */}
      <p
        aria-live="polite"
        aria-atomic="true"
        data-listening-status
        className={status ? '' : 'sr-only'}
      >
        {status}
      </p>
      {links.length > 0 ? (
        <ul aria-label="Its relations" className="flex flex-col gap-2">
          {links.map((link, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: two tracks may share links
            <RelationEvidence key={index} link={link} nameOf={nameOf} claims={claims} />
          ))}
        </ul>
      ) : (
        <p>No link to this track is shown.</p>
      )}
    </section>
  );
};
