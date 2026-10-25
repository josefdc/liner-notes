import { useEffect, useState } from 'react';

type Reader = typeof import('./links');

let loaded: Reader | null = null;
let loading: Promise<Reader> | null = null;

/**
 * Loads the link reader, which validates links with the contract's schemas (and so brings zod):
 * a view that does not draw the graph loads it only when it has links to read.
 */
export function loadLinkReader(): Promise<Reader> {
  loading ??= import('./links').then(
    (module) => {
      loaded = module;
      return module;
    },
    (error: unknown) => {
      // A later call tries again.
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** The link reader once it is loaded (null before), and whether loading it failed. */
export function useLinkReader(wanted = true): { reader: Reader | null; failed: boolean } {
  const [reader, setReader] = useState<Reader | null>(loaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (reader || !wanted) return;
    let live = true;
    loadLinkReader().then(
      (module) => live && setReader(module),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [reader, wanted]);
  return { reader, failed };
}
