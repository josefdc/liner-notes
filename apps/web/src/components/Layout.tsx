import type React from 'react';
import { SOURCE_URL } from '../sourceUrl';

interface LayoutProps {
  children: React.ReactNode;
  /**
   * The screen ends in a bar of its own below the md breakpoint (the Player's tab bar, which
   * keeps the bottom of a phone's screen): the footer shows from md up only.
   */
  footerFromMd?: boolean;
}

/**
 * The page: the screen (the search, the progress, a result) above a footer that links to the
 * app's source code. The screen fills the window above the footer and scrolls inside itself.
 */
const Layout: React.FC<LayoutProps> = ({ children, footerFromMd = false }) => {
  return (
    <div className="h-[100dvh] flex flex-col bg-void text-white font-sans antialiased overflow-hidden selection:bg-cyber/30 selection:text-cyber">
      {/* P0:8 Skip-to-content link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-cyber focus:text-void focus:font-mono focus:text-sm focus:tracking-widest focus:rounded"
      >
        Skip to content
      </a>

      {children}

      <footer
        className={`shrink-0 ${footerFromMd ? 'hidden md:flex' : 'flex'} justify-end border-t border-border px-(--space-md)`}
      >
        <a
          href={SOURCE_URL}
          className="inline-flex items-center min-h-6 px-(--space-xs) text-chrome font-mono text-text-tertiary hover:text-text-secondary hover:underline underline-offset-4 rounded-sm transition-colors focus-visible:text-text-secondary focus-visible:underline focus-visible:ring-1 focus-visible:ring-white/60 focus-visible:outline-none"
        >
          Source
        </a>
      </footer>
    </div>
  );
};

export default Layout;
