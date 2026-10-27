import { useEffect, useState } from 'react';

/**
 * The milliseconds left until `until` (milliseconds since the epoch): 0 once it has passed, and
 * when it is null. Read from the clock at each update, never counted down, so it stays right when
 * the page's timers were held back (a tab in the background): it updates when the whole seconds
 * left change, and at once when the page is shown again.
 */
export function useTimeLeft(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (until === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      const left = until - current;
      // The next change of the whole seconds left.
      if (left > 0) timer = setTimeout(update, left % 1000 || 1000);
    };
    update();
    const onVisible = () => {
      if (document.visibilityState === 'visible') update();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [until]);

  return until === null ? 0 : Math.max(0, until - now);
}

/** A wait as the page says it: "42 s", "2 min 5 s", "3 min" (whole seconds, rounded up). */
export function waitText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}
