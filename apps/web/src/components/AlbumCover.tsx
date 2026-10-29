import type React from 'react';
import { useCallback, useState } from 'react';
import { ImageOff, Music } from 'lucide-react';
import { coverLabels } from '../utils/image';

/** A result's cover as the page shows it: the image to draw, or none. */
export interface CoverImage {
  /** The cover's URL while it can be shown; null when there is none or it failed to load. */
  src: string | null;
  /** The image's error handler: the URL it failed to load is not shown again. */
  onError: (event: React.SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * The cover of a result, shared by the cover and the blurred background behind it: a cover that
 * fails to load (a release the Cover Art Archive holds no image for answers 404) is not shown
 * anywhere. Only the URL that failed is marked, so a new URL is tried again, and an error that
 * arrives late for an earlier URL hides nothing.
 */
export function useAlbumCover(url: string | null | undefined): CoverImage {
  const [failed, setFailed] = useState<string | null>(null);
  const current = typeof url === 'string' ? url.trim() : '';
  const onError = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) =>
      setFailed(event.currentTarget.getAttribute('src')),
    [],
  );
  return { src: current && current !== failed ? current : null, onError };
}

interface AlbumCoverProps {
  cover: CoverImage;
  /** The album the result shows next to the cover (Spotify's). */
  album: string | null | undefined;
  /** The result's evidence pack: it names the release a Cover Art Archive cover is of. */
  evidence?: unknown;
  /** Classes of the square that holds the image or the notice, as wide as the figure. */
  frameClassName?: string;
  /** Classes the image and the notice share (corners, shadow, state). */
  surfaceClassName?: string;
  iconSize?: number;
  /** Drawn inside the frame, behind the image (a glow). */
  children?: React.ReactNode;
  /** Classes of the figure: its width (the cover's) and position. The credit wraps within it. */
  className?: string;
}

/**
 * A result's album cover. Without a cover, or when it fails to load, the frame says "Cover not
 * available" instead of showing a stand-in image. A cover from the Cover Art Archive is credited
 * under the frame, linked to the release's page at the archive, and named as that release when
 * it is not the album shown (`coverLabels`).
 */
export function AlbumCover({
  cover,
  album,
  evidence,
  frameClassName = '',
  surfaceClassName = '',
  iconSize = 32,
  children,
  className = '',
}: AlbumCoverProps) {
  const labels = coverLabels(cover.src, album, evidence);
  return (
    <figure
      className={`flex flex-col items-center gap-(--space-sm) ${className}`}
      data-cover={cover.src ? 'shown' : 'not-available'}
    >
      <div className={`relative w-full aspect-square ${frameClassName}`}>
        {children}
        {cover.src ? (
          <img
            src={cover.src}
            alt={labels.alt}
            onError={cover.onError}
            referrerPolicy="no-referrer"
            className={`w-full h-full object-cover border border-border relative z-10 ${surfaceClassName}`}
          />
        ) : (
          <div
            className={`w-full h-full border border-border bg-void-lighter flex flex-col items-center justify-center gap-(--space-sm) p-(--space-sm) text-center relative z-10 ${surfaceClassName}`}
          >
            <ImageOff size={iconSize} className="text-text-tertiary" aria-hidden="true" />
            <span data-cover-text className="text-xs font-mono text-text-secondary">
              Cover not available
            </span>
          </div>
        )}
      </div>
      {cover.src && labels.credit && (
        <figcaption className="w-full text-chrome font-mono text-center">
          {/* At most three lines under the cover, whatever the release's title; the whole credit
              is in the link's text and title */}
          <a
            href={labels.credit.href}
            target="_blank"
            rel="noopener noreferrer"
            title={labels.credit.text}
            data-cover-text
            className="line-clamp-3 break-words text-text-secondary underline underline-offset-2 decoration-border-hover hover:text-text-primary hover:decoration-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber focus-visible:ring-offset-2 focus-visible:ring-offset-void rounded-sm"
          >
            {labels.credit.text}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </figcaption>
      )}
    </figure>
  );
}

interface CoverThumbProps {
  url: string | null | undefined;
  alt?: string;
  /** Size and corners, shared by the image and the placeholder. */
  className: string;
  iconSize?: number;
  /** Shown when there is no cover or it fails to load; the neutral placeholder by default. */
  fallback?: React.ReactNode;
}

/**
 * A small cover (a search suggestion, a candidate, the track being analysed). Without a cover,
 * or when it fails to load, a neutral placeholder takes its place: never a broken image.
 */
export function CoverThumb({ url, alt = '', className, iconSize = 16, fallback }: CoverThumbProps) {
  const cover = useAlbumCover(url);
  if (cover.src) {
    return (
      <img
        src={cover.src}
        alt={alt}
        onError={cover.onError}
        referrerPolicy="no-referrer"
        className={`object-cover flex-shrink-0 ${className}`}
      />
    );
  }
  if (fallback !== undefined) return <>{fallback}</>;
  return (
    <div
      data-cover-placeholder
      className={`bg-void-lighter border border-border flex items-center justify-center flex-shrink-0 ${className}`}
    >
      <Music size={iconSize} className="text-text-muted" aria-hidden="true" />
    </div>
  );
}
