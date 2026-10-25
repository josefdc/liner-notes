import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { AlbumCover, CoverThumb, useAlbumCover } from './AlbumCover';

afterEach(cleanup);

const ARCHIVE =
  'https://coverartarchive.org/release/ae103b0a-b932-4009-acb6-388db1cf890b/front-250';
const OTHER = 'https://i.scdn.co/image/ab67616d0000b273';

/** The cover alone, without the blurred background a page draws behind it. */
function Cover({ url }: { url: string }) {
  const cover = useAlbumCover(url);
  return <AlbumCover cover={cover} album="Test Album" frameClassName="w-32 h-32" />;
}

/** An image error event as React passes it, for an image whose src is `src`. */
const errorFor = (src: string) =>
  ({
    currentTarget: { getAttribute: (name: string) => (name === 'src' ? src : null) },
  }) as unknown as React.SyntheticEvent<HTMLImageElement>;

describe('the album cover on its own', () => {
  it('says the cover is not available when its own image fails, with no background to tell it', () => {
    const { container } = render(<Cover url={ARCHIVE} />);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText('Cover not available')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('credits the archive only for an archive cover', () => {
    render(<Cover url={OTHER} />);
    expect(screen.queryByRole('link')).toBeNull();
    cleanup();
    render(<Cover url={ARCHIVE} />);
    expect(screen.getByRole('link').textContent).toBe(
      'Cover: Cover Art Archive (opens in a new tab)',
    );
  });

  it('hides only the URL that failed: a late error for an earlier cover hides nothing', () => {
    const { result, rerender } = renderHook(({ url }) => useAlbumCover(url), {
      initialProps: { url: ARCHIVE },
    });
    rerender({ url: OTHER });
    act(() => result.current.onError(errorFor(ARCHIVE)));
    expect(result.current.src).toBe(OTHER);
    act(() => result.current.onError(errorFor(OTHER)));
    expect(result.current.src).toBeNull();
    // A new URL is tried again.
    rerender({ url: ARCHIVE });
    expect(result.current.src).toBe(ARCHIVE);
  });
});

describe('the cover thumbnail', () => {
  it('shows a neutral placeholder, never a broken image, when the cover fails or is missing', () => {
    const { container } = render(<CoverThumb url={ARCHIVE} className="w-10 h-10" />);
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('[data-cover-placeholder]')).toBeTruthy();
    cleanup();
    const empty = render(<CoverThumb url="" className="w-10 h-10" />);
    expect(empty.container.querySelector('[data-cover-placeholder]')).toBeTruthy();
  });

  it('shows the given fallback instead, when there is one', () => {
    const { container } = render(
      <CoverThumb url={ARCHIVE} className="w-20 h-20" fallback={null} />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(container.innerHTML).toBe('');
  });
});
