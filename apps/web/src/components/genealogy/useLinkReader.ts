import { useCallback, useEffect, useState } from 'react';

type Reader = typeof import('./links');

let loaded: Reader | null = null;
let loading: Promise<Reader> | null = null;
/** How the reader is loaded: its own chunk (replaced in tests). */
let importReader: () => Promise<Reader> = () => import('./links');

/** Replaces how the reader is loaded, and forgets a loaded one (tests only). */
export function setReaderImport(load: () => Promise<Reader>): void {
  importReader = load;
  loaded = null;
  loading = null;
}

/**
 * Loads the link reader, which validates links with the contract's schemas: a view that does
 * not draw the graph loads it only when it has links to read. Only the reader's own code waits;
 * the contract (and zod) is already loaded with the claims module.
 */
export function loadLinkReader(): Promise<Reader> {
  loading ??= importReader().then(
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

/**
 * The link reader once it is loaded (null before), whether loading it failed, and `retry`, which
 * tries again after a failure.
 */
export function useLinkReader(wanted = true): {
  reader: Reader | null;
  failed: boolean;
  retry: () => void;
} {
  const [reader, setReader] = useState<Reader | null>(loaded);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (reader || !wanted || failed) return;
    let live = true;
    loadLinkReader().then(
      (module) => live && setReader(module),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
    // A failure stops the tries until `retry` clears it.
  }, [reader, wanted, failed]);
  const retry = useCallback(() => setFailed(false), []);
  return { reader, failed, retry };
}
