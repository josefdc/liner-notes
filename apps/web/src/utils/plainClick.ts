import type React from 'react';

/**
 * A click the page handles itself on one of its own links: the main button, without a key that
 * asks the browser for a new tab or window, a download or a bookmark. Any other click is left to
 * the browser, which follows the link's address.
 */
export function isPlainClick(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}
