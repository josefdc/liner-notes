// Shared visual styles for text inputs (used by the search box, search/SearchBox.tsx).
export const inputVisualStyles = [
  'w-full py-4 bg-black/40 border border-border rounded-sm',
  'text-white placeholder-text-muted font-mono text-sm tracking-wide',
  'focus-visible:outline-hidden focus:border-cyber/50 focus:bg-black/60 focus:shadow-[var(--shadow-input-focus)]',
  'transition-[color,background-color,border-color,box-shadow] duration-(--duration-normal) ease-out-expo',
].join(' ');
