import { useEffect, useState } from 'react';

/**
 * The milliseconds left until `until` (milliseconds since the epoch): 0 once it has passed, and
 * when it is null. Read from the clock at each update, never counted down, so it stays right when
 * the page's timers were held back (a tab in the background): it updates when the whole seconds
 * left change, and at once when the page is shown again. The first render for a new `until` reads
 * the clock itself, so what that render shows (and a screen reader reads, when the view it is in
 * takes the focus) is already right.
 */
export function useTimeLeft(until: number | null): number {
  // The clock as last read, and the `until` it was read for.
  const [reading, setReading] = useState(() => ({ until, now: Date.now() }));
  const now = reading.until === until ? reading.now : Date.now();

  useEffect(() => {
    if (until === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setReading({ until, now: current });
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

/** A wait in whole hours, minutes and seconds, rounded up as it is said. */
function waitParts(ms: number): { hours: number; minutes: number; seconds: number } | null {
  if (!Number.isFinite(ms)) return null;
  const total = Math.max(1, Math.ceil(ms / 1000));
  if (total < 3600) return { hours: 0, minutes: Math.floor(total / 60), seconds: total % 60 };
  // From an hour on, in whole minutes, rounded up.
  const minutes = Math.ceil(total / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60, seconds: 0 };
}

/**
 * A wait as the page shows it: "42 s", "2 min 5 s", "3 min", and from an hour on in hours and
 * whole minutes, rounded up: "1 h", "1 h 5 min". Never "0 s": less than a second is "1 s".
 */
export function waitText(ms: number): string {
  const parts = waitParts(ms);
  if (!parts) return 'a while';
  const { hours, minutes, seconds } = parts;
  return [hours > 0 && `${hours} h`, minutes > 0 && `${minutes} min`, seconds > 0 && `${seconds} s`]
    .filter(Boolean)
    .join(' ');
}

/** The same wait in words, as a screen reader reads it: "42 seconds", "1 hour 5 minutes". */
export function spokenWait(ms: number): string {
  const parts = waitParts(ms);
  if (!parts) return 'a while';
  const unit = (count: number, name: string) =>
    count > 0 && `${count} ${name}${count === 1 ? '' : 's'}`;
  return [unit(parts.hours, 'hour'), unit(parts.minutes, 'minute'), unit(parts.seconds, 'second')]
    .filter(Boolean)
    .join(' ');
}
