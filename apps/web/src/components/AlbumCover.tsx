import type React from 'react';
import { useCallback, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { archiveReleaseOf, archiveReleasePage } from '../utils/image';

/** A result's cover as the page shows it: the image to draw, or none. */
export interface CoverImage {
  /** The cover's URL while it can be shown; null when there is none or it failed to load. */
  src: string | null;
  /** Called when the image fails to load: the cover is then not available. */
  onError: () => void;
}

/**
 * The cover of a result, shared by the cover and the blurred background behind it: a cover that
 * fails to load (a release the Cover Art Archive holds no image for answers 404) is not shown
 * anywhere. A new URL is tried again.
 */
export function useAlbumCover(url: string | null | undefined): CoverImage {
  const [failed, setFailed] = useState<string | null>(null);
  const current = typeof url === 'string' ? url.trim() : '';
  const onError = useCallback(() => setFailed(current), [current]);
  return { src: current && current !== failed ? current : null, onError };
}

interface AlbumCoverProps {
  cover: CoverImage;
  alt: string;
  /** Classes of the square that holds the image or the notice (its size and position). */
  frameClassName: string;
  /** Classes the image and the notice share (corners, shadow, state). */
  surfaceClassName?: string;
  iconSize?: number;
  /** Drawn inside the frame, behind the image (a glow). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A result's album cover. Without a cover, or when it fails to load, the frame says "Cover not
 * available" instead of showing a stand-in image. A cover from the Cover Art Archive is credited
 * under the frame, linked to the release's page at the archive.
 */
export function AlbumCover({
  cover,
  alt,
  frameClassName,
  surfaceClassName = '',
  iconSize = 32,
  children,
  className = '',
}: AlbumCoverProps) {
  const release = cover.src ? archiveReleaseOf(cover.src) : null;
  return (
    <figure
      className={`flex flex-col items-center gap-(--space-sm) ${className}`}
      data-cover={cover.src ? 'shown' : 'not-available'}
    >
      <div className={frameClassName}>
        {children}
        {cover.src ? (
          <img
            src={cover.src}
            alt={alt}
            onError={cover.onError}
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
      {release && (
        <figcaption className="text-chrome font-mono">
          <a
            href={archiveReleasePage(release)}
            target="_blank"
            rel="noopener noreferrer"
            data-cover-text
            className="text-text-secondary underline underline-offset-2 decoration-border-hover hover:text-text-primary hover:decoration-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber focus-visible:ring-offset-2 focus-visible:ring-offset-void rounded-sm"
          >
            Cover: Cover Art Archive
          </a>
        </figcaption>
      )}
    </figure>
  );
}
