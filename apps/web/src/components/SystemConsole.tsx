import React, { useEffect, useRef, useState } from 'react';
import type { AgentLog } from '../types';
import { Terminal, LoaderCircle, CircleCheck } from 'lucide-react';
import { logStyle } from './console/logCodes';

interface SystemConsoleProps {
  logs: AgentLog[];
  isComplete: boolean;
}

// One log line: the time, the step in words (with its icon), and the message.
const LogLine: React.FC<{ log: AgentLog; isLatest: boolean }> = React.memo(({ log, isLatest }) => {
  const { label, Icon, tone } = logStyle(log.code, log.node);
  const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });

  return (
    <div
      data-log-code={log.code}
      className={`flex items-start font-mono text-xs leading-relaxed py-0.5 content-auto ${isLatest ? 'animate-fade-in-right' : ''}`}
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

const SystemConsole: React.FC<SystemConsoleProps> = ({ logs, isComplete }) => {
  const consoleRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

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

  // Keep the newest log line in view
  // biome-ignore lint/correctness/useExhaustiveDependencies: logs is the trigger, not a value read in the effect
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

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
            {isComplete ? 'Finished' : 'Running'}
          </span>
        </div>

        {/* Log body */}
        <div
          ref={consoleRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          className="relative h-72 overflow-y-auto scrollbar-hide p-4 font-mono overscroll-contain"
        >
          {/* Empty state */}
          {logs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-text-muted">
              <span className="text-xs font-mono">No events yet</span>
            </div>
          )}

          {/* Log entries */}
          <div className="space-y-0.5 relative z-0">
            {logs.map((log, idx) => (
              <LogLine key={log.id} log={log} isLatest={idx === logs.length - 1 && !isComplete} />
            ))}

            {/* Still running */}
            {!isComplete && logs.length > 0 && (
              <div className="pt-3 flex items-center text-text-tertiary text-xs border-t border-white/5 mt-3">
                <span className="mr-2 animate-spin-slow">
                  <LoaderCircle size={14} aria-hidden="true" />
                </span>
                <span className="font-mono">Run in progress</span>
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

            {/* Scrolled into view to keep the newest line visible */}
            <div ref={bottomRef} className="h-1" />
          </div>
        </div>

        {/* Footer: how many events and how long since the first one */}
        <div className="bg-white/5 border-t border-white/5 px-4 py-1.5 flex justify-between items-center text-chrome font-mono text-text-tertiary">
          <span>
            {logs.length} {logs.length === 1 ? 'event' : 'events'}
          </span>
          <span>{elapsedSeconds} s elapsed</span>
        </div>
      </div>
    </section>
  );
};

export default SystemConsole;
