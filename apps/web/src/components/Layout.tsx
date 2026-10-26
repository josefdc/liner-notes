import type React from 'react';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  return (
    <div className="min-h-[100dvh] bg-void text-white font-sans antialiased overflow-x-hidden selection:bg-cyber/30 selection:text-cyber">
      {/* P0:8 Skip-to-content link */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-cyber focus:text-void focus:font-mono focus:text-sm focus:tracking-widest focus:rounded"
      >
        Skip to content
      </a>

      {children}
    </div>
  );
};

export default Layout;
