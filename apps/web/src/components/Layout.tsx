import type React from 'react';
import { SOURCE_URL } from '../sourceUrl';

interface LayoutProps {
  children: React.ReactNode;
  /**
   * The screen ends in a bar of its own below the md breakpoint (the Player's tab bar, which
   * keeps the bottom of a phone's screen): the footer shows from md up only.
   */
  footerFromMd?: boolean;
  /** Whether the page ends in the footer at all (the full-size map leaves it out). */
  footer?: boolean;
}

/**
 * Follows the skip link: the main landmark takes the focus, so the next Tab goes on from inside
 * it. It is focusable (tabindex -1) only until the focus leaves it: kept focusable, a click on
 * words that are not a control would put the focus on it instead of on the page's body, and the
 * keys that act when nothing is focused (Escape) would no longer see "nothing focused".
 */
function followSkipLink(event: React.MouseEvent<HTMLAnchorElement>) {
  // A click with a modifier (a new tab or window) is left to the browser.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  const main = document.getElementById('main-content');
  if (!main) return;
  event.preventDefault();
  main.setAttribute('tabindex', '-1');
  main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  main.focus();
}

/**
 * The page: the screen (the search, the progress, a result) above a footer that links to the
 * app's source code. The screen fills the window above the footer and scrolls inside itself.
 */
const Layout: React.FC<LayoutProps> = ({ children, footerFromMd = false, footer = true }) => {
  return (
    <div className="h-[100dvh] flex flex-col bg-void text-white font-sans antialiased overflow-hidden selection:bg-cyber/30 selection:text-cyber">
      {/* P0:8 Skip-to-content link */}
      {/* biome-ignore lint/a11y/useValidAnchor: an in-page link, and it stays one: the click only makes its target focusable while it is followed (followSkipLink) */}
      <a
        href="#main-content"
        onClick={followSkipLink}
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-cyber focus:text-void focus:font-mono focus:text-sm focus:tracking-widest focus:rounded"
      >
        Skip to content
      </a>

      {children}

      {footer && (
        <footer
          className={`shrink-0 ${footerFromMd ? 'hidden md:flex' : 'flex'} justify-end border-t border-border px-(--space-md)`}
        >
          {/* In a new tab: following it never unloads the page, and a run under way with it */}
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center min-h-6 px-(--space-xs) text-chrome font-mono text-text-tertiary hover:text-text-secondary hover:underline underline-offset-4 rounded-sm transition-colors focus-visible:text-text-secondary focus-visible:underline focus-visible:ring-1 focus-visible:ring-white/60 focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2"
          >
            Source<span className="sr-only"> (opens in a new tab)</span>
          </a>
        </footer>
      )}
    </div>
  );
};

export default Layout;
