import React from 'react';

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

      {/* Global Grain/Noise Overlay for Cinematic Feel */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03] z-[2] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`,
        }}
      ></div>

      {children}
    </div>
  );
};

export default Layout;
