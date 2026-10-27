import type React from 'react';
import { useEffect, useState, useMemo } from 'react';
import { Activity, CircleCheck, ChevronDown, LoaderCircle } from 'lucide-react';
import type { AgentLog } from '../types';
import { formatElapsed } from './console/elapsed';
import { logStyle } from './console/logCodes';
import { writtenLines } from '../hooks/agent/runLog';

interface ActivityLogProps {
  logs: AgentLog[];
  isComplete: boolean;
  /**
   * The run is a recording played again: each entry shows the time since the recorded run
   * started that it was sent with, or no time; never how long ago the replay showed it.
   */
  recorded?: boolean;
}

// The number of latest entries the log shows.
const SHOWN = 6;

/** How often the times are brought up to date while an entry is under a minute old. */
export const FRESH_TICK_MS = 10_000;
/** How often they are brought up to date once every entry is a minute old or more. */
export const SETTLED_TICK_MS = 30_000;

/**
 * How long before `now` an entry was logged, in words, in steps no finer than the clock that
 * updates them: "Just now" under 10 s, then tens of seconds, minutes and hours.
 */
export function formatRelativeTime(timestamp: string, now: number): string {
  const diff = Math.floor((now - new Date(timestamp).getTime()) / 1000);
  // A time this page cannot read, or one ahead of its clock, reads as just now too.
  if (!Number.isFinite(diff) || diff < 10) return 'Just now';
  if (diff < 60) return `${Math.floor(diff / 10) * 10} s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  return `${Math.floor(diff / 3600)} h ago`;
}

/**
 * The time the entries are measured from: read when the log opens, then on one timer while it
 * stays open, every FRESH_TICK_MS while the newest entry (logged at `newest`) is under a minute
 * old and every SETTLED_TICK_MS after that. None per entry.
 */
function useClock(running: boolean, newest: number): number {
  const [now, setNow] = useState(() => Date.now());
  const fresh = now - newest < 60_000;
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), fresh ? FRESH_TICK_MS : SETTLED_TICK_MS);
    return () => clearInterval(timer);
  }, [running, fresh]);
  return now;
}

const ActivityLog: React.FC<ActivityLogProps> = ({ logs, isComplete, recorded = false }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const newest = logs.length > 0 ? new Date(logs[logs.length - 1].timestamp).getTime() : 0;
  // A live run's entries say how long ago they came, on a clock; a recorded run's say when they
  // were sent in the recorded run, which no clock changes. The time the replay showed an entry
  // says nothing about the recorded run, so an entry recorded without a time shows none.
  const now = useClock(isExpanded && !recorded, newest);
  const timeOf = (log: AgentLog): string | null => {
    if (!recorded) return formatRelativeTime(log.timestamp, now);
    return log.elapsedMs === undefined ? null : formatElapsed(log.elapsedMs);
  };
  // The run's lines, those the log no longer keeps included.
  const written = writtenLines(logs);

  // The latest entries, newest first
  const displayLogs = useMemo(() => [...logs].slice(-SHOWN).reverse(), [logs]);
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  // The toggle's name says what its face shows: the run's state and the last event, with its label.
  const lastEvent = lastLog
    ? `, last event: ${logStyle(lastLog.code, lastLog.node, lastLog.message).label}: ${lastLog.message}`
    : '';

  return (
    <div className="relative bg-surface border border-border rounded-md overflow-hidden hover:border-white/20 transition-colors ease-out-expo">
      {/* Collapsible header, always visible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls="activity-log-content"
        aria-label={
          isExpanded
            ? 'Collapse activity log'
            : `Expand activity log, ${isComplete ? 'done' : 'running'}${lastEvent}`
        }
        className="relative z-10 w-full px-4 py-3 flex justify-between items-center bg-surface-subtle hover:bg-surface transition-colors duration-(--duration-fast) cursor-pointer focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-mono text-text-tertiary flex items-center gap-2 flex-shrink-0">
            <Activity size={12} aria-hidden="true" className="text-text-tertiary" />
            Activity log
            <span className="text-chrome text-text-muted">({written})</span>
          </h3>
          {/* P3:27 — Collapsed preview snippet */}
          {!isExpanded && logs.length > 0 && (
            <span className="text-chrome font-mono text-text-muted truncate ml-2 hidden sm:inline">
              {logs[logs.length - 1]?.message}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!isComplete && (
            <span className="flex items-center gap-1.5 text-text-secondary">
              <LoaderCircle size={10} aria-hidden="true" className="animate-spin-slow" />
              <span className="text-chrome font-mono">Running</span>
            </span>
          )}
          {isComplete && (
            <span className="flex items-center gap-1.5">
              <CircleCheck size={10} aria-hidden="true" className="text-status-success" />
              <span className="text-chrome text-status-success font-mono">Done</span>
            </span>
          )}
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={`text-text-tertiary transition-transform duration-(--duration-normal) ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Collapsible content */}
      <div
        id="activity-log-content"
        role="region"
        aria-label="Activity log entries"
        className={`relative z-10 overflow-hidden transition-all duration-(--duration-normal) ease-in-out ${isExpanded ? 'max-h-[280px]' : 'max-h-0'}`}
      >
        <div className="border-t border-white/5">
          {/* Log list */}
          <div className="relative overflow-y-auto p-3 space-y-0 scrollbar-hide max-h-[240px] overscroll-contain">
            {/* Timeline line */}
            <div className="absolute left-6 top-3 bottom-3 w-px bg-gradient-to-b from-white/30 via-white/10 to-transparent"></div>

            {/* Empty state */}
            {logs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-6 text-text-muted">
                <span className="text-chrome font-mono">No events yet</span>
              </div>
            )}

            {displayLogs.map((log, idx) => {
              const { label, Icon, tone } = logStyle(log.code, log.node, log.message);
              const isLive = idx === 0 && !isComplete;
              const time = timeOf(log);

              return (
                <div
                  key={log.id}
                  data-log-code={log.code}
                  className="relative pl-7 pb-3 last:pb-0 group/item"
                >
                  {/* Timeline dot */}
                  <div
                    className={`
                    absolute left-[9px] top-1 w-2 h-2 rounded-full border-2 transition-all duration-(--duration-normal) z-10 box-border
                    ${
                      isLive
                        ? 'bg-text-secondary border-text-secondary animate-pulse'
                        : 'bg-void-lighter border-white/30 group-hover/item:border-white/55'
                    }
                  `}
                  ></div>

                  {/* Entry */}
                  <div
                    className={`
                    relative p-2 rounded-md border transition-all duration-(--duration-normal)
                    ${isLive ? 'bg-white/5 border-white/10' : 'bg-transparent border-transparent hover:bg-white/5'}
                  `}
                  >
                    <div className="flex justify-between items-start mb-0.5">
                      <span
                        data-log-label
                        className={`text-chrome font-bold font-mono inline-flex items-center gap-1 ${tone}`}
                      >
                        <Icon size={12} aria-hidden="true" className="shrink-0" />
                        {label}
                      </span>
                      {time !== null && (
                        <span data-log-time className="text-chrome text-text-muted font-mono">
                          {time}
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-text-secondary">
                      <span className="leading-relaxed line-clamp-2">{log.message}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer: how much of the log is shown */}
          <div className="relative z-10 bg-white/[0.02] border-t border-white/5 px-3 py-1.5 flex justify-between items-center text-chrome font-mono text-text-tertiary">
            <span>
              {written > SHOWN
                ? `The latest ${SHOWN} of ${written} events`
                : `${written} ${written === 1 ? 'event' : 'events'}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActivityLog;
