import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentLog } from '../types';
import { Terminal, LoaderCircle, CircleCheck } from 'lucide-react';
import { logStyle } from './console/logCodes';
import { droppedLines, writtenLines } from '../hooks/agent/runLog';

// How close to its end, in pixels, the log counts as read to the end: new lines keep it there.
const AT_END_PX = 24;

interface SystemConsoleProps {
  logs: AgentLog[];
  isComplete: boolean;
  /** The run is paused at the track picker, waiting for the user's pick. */
  isWaiting?: boolean;
  /** The run replays a recorded run: nothing runs live. */
  isReplay?: boolean;
}

/** How far below the top of the log's view `row` starts, in pixels. */
function topInView(box: HTMLElement, row: HTMLElement): number {
  return row.getBoundingClientRect().top - box.getBoundingClientRect().top;
}

/** The log line with this id. */
function lineById(box: HTMLElement, id: string): HTMLElement | null {
  for (const row of box.querySelectorAll<HTMLElement>('[data-log-id]')) {
    if (row.dataset.logId === id) return row;
  }
  return null;
}

/** The first line whose bottom is inside the log's view, and where it starts in it. */
function lineAtTop(box: HTMLElement): { id: string; offset: number } | null {
  const top = box.getBoundingClientRect().top;
  for (const row of box.querySelectorAll<HTMLElement>('[data-log-id]')) {
    if (row.getBoundingClientRect().bottom > top && row.dataset.logId) {
      return { id: row.dataset.logId, offset: row.getBoundingClientRect().top - top };
    }
  }
  return null;
}

// One log line: the time, the step in words (with its icon), and the message.
const LogLine: React.FC<{ log: AgentLog; isLatest: boolean }> = React.memo(({ log, isLatest }) => {
  const { label, Icon, tone } = logStyle(log.code, log.node, log.message);
  const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });

  return (
    <div
      data-log-id={log.id}
      data-log-code={log.code}
      className={`flex items-start font-mono text-xs leading-relaxed py-0.5 ${isLatest ? 'animate-fade-in-right' : ''}`}
    >
      <span className="text-text-tertiary mr-3 shrink-0 w-16 tabular-nums">{time}</span>
      <span
        data-log-label
        className={`${tone} mr-2 shrink-0 inline-flex items-center gap-1 font-bold sm:w-32`}
      >
        <Icon size={12} aria-hidden="true" className="shrink-0" />
        {label}
      </span>
      <span className="text-text-secondary tracking-tight">{log.message}</span>
    </div>
  );
});

const SystemConsole: React.FC<SystemConsoleProps> = ({
  logs,
  isComplete,
  isWaiting = false,
  isReplay = false,
}) => {
  // What the run is doing, in words: the header and the line under the log say it.
  const state = isComplete
    ? 'Finished'
    : isWaiting
      ? 'Waiting for your pick'
      : isReplay
        ? 'Replaying the recorded run'
        : 'Running';

  const consoleRef = useRef<HTMLDivElement>(null);
  // The reader is at the end of the log (or has not scrolled it): new lines keep them there.
  const atEndRef = useRef(true);
  const linesRef = useRef<HTMLDivElement>(null);
  // The line a reader who has scrolled up is on (the first one at the top of the view), and how
  // far below the view's top it starts, in pixels; null at the end.
  const anchorRef = useRef<{ id: string; offset: number } | null>(null);
  // The scroll position the log set itself last: its own scrolls do not move the anchor.
  const ownScrollRef = useRef<number | null>(null);

  // P3:26 — Track elapsed time from first log
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (logs.length > 0 && !startTimeRef.current) {
      startTimeRef.current = Date.now();
    }
    if (isComplete) return; // Stop updating on complete

    const interval = setInterval(() => {
      if (startTimeRef.current) {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [logs.length, isComplete]);

  // Keep the newest line in view by scrolling the log itself, at once: never the page or the
  // views around it. A reader who has scrolled up to an earlier line stays on it: when older
  // lines are dropped above it (or the note about them appears), the log is scrolled so that
  // line is where it was. The log does this itself rather than leave it to the browser's scroll
  // anchoring, which not every browser has (overflow-anchor is off on the log, so the two never
  // both move it).
  // biome-ignore lint/correctness/useExhaustiveDependencies: logs is the trigger, not a value read in the effect
  useLayoutEffect(() => {
    const box = consoleRef.current;
    if (!box) return;
    const anchor = anchorRef.current;
    const row = anchor ? lineById(box, anchor.id) : null;
    if (atEndRef.current) {
      box.scrollTop = box.scrollHeight;
    } else if (anchor && row) {
      box.scrollTop += topInView(box, row) - anchor.offset;
    } else {
      // The reader's line was dropped: they stay on the first line at the top of the view.
      anchorRef.current = lineAtTop(box);
    }
    ownScrollRef.current = box.scrollTop;
  }, [logs, isComplete]);

  // Lines can change height after they are drawn (a font loads, the window narrows and they
  // wrap): a reader at the end stays there.
  useEffect(() => {
    const box = consoleRef.current;
    const lines = linesRef.current;
    if (!box || !lines || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atEndRef.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(lines);
    return () => observer.disconnect();
  }, []);

  const handleScroll = () => {
    const box = consoleRef.current;
    if (!box) return;
    atEndRef.current = box.scrollHeight - box.scrollTop - box.clientHeight <= AT_END_PX;
    // The reader's own scroll: the line now at the top is theirs.
    if (box.scrollTop !== ownScrollRef.current) {
      ownScrollRef.current = null;
      anchorRef.current = atEndRef.current ? null : lineAtTop(box);
    }
  };

  const dropped = droppedLines(logs);
  const written = writtenLines(logs);

  return (
    <section className="relative w-full max-w-3xl mx-auto" aria-label="Analysis log">
      <div className="relative rounded-md overflow-hidden border border-border bg-black/90 shadow-2xl backdrop-blur-xl">
        {/* Header: what the log is, and whether the analysis is still running */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-white/5 border-b border-white/5">
          <div className="flex items-center gap-3 min-w-0">
            <Terminal size={14} aria-hidden="true" className="text-text-tertiary shrink-0" />
            <span className="text-chrome font-mono text-text-tertiary truncate">Analysis log</span>
          </div>
          <span className="text-chrome font-mono text-text-tertiary whitespace-nowrap shrink-0">
            {state}
          </span>
        </div>

        {/* Log body */}
        <div
          ref={consoleRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          onScroll={handleScroll}
          className="relative h-72 overflow-y-auto scrollbar-hide p-4 font-mono overscroll-contain [overflow-anchor:none]"
        >
          {/* Empty state */}
          {logs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <span className="text-xs font-mono">No events yet</span>
            </div>
          )}

          {/* Log entries */}
          <div ref={linesRef} className="space-y-0.5 relative z-0">
            {/* The log keeps the latest lines only */}
            {dropped > 0 && (
              <p data-log-dropped className="text-xs font-mono text-text-tertiary pb-1">
                {dropped} earlier {dropped === 1 ? 'line' : 'lines'} not shown
              </p>
            )}
            {logs.map((log, idx) => (
              <LogLine key={log.id} log={log} isLatest={idx === logs.length - 1 && !isComplete} />
            ))}

            {/* Still running */}
            {!isComplete && logs.length > 0 && (
              <div className="pt-3 flex items-center text-text-tertiary text-xs border-t border-white/5 mt-3">
                {!isWaiting && (
                  <span className="mr-2 animate-spin-slow">
                    <LoaderCircle size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="font-mono">{state === 'Running' ? 'Run in progress' : state}</span>
              </div>
            )}

            {/* Finished */}
            {isComplete && (
              <div className="pt-4 pb-2">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-status-success/10 border border-status-success/30 rounded-sm text-status-success text-xs font-mono">
                  <CircleCheck size={14} aria-hidden="true" />
                  <span>Run finished</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer: how many events and how long since the first one */}
        <div className="bg-white/5 border-t border-white/5 px-4 py-1.5 flex justify-between items-center text-chrome font-mono text-text-tertiary">
          <span>
            {written} {written === 1 ? 'event' : 'events'}
          </span>
          <span>{elapsedSeconds} s since you started</span>
        </div>
      </div>
    </section>
  );
};

export default SystemConsole;
