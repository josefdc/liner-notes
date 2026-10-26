import type React from 'react';
import { useState, useMemo } from 'react';
import { Activity, CircleCheck, ChevronDown, LoaderCircle } from 'lucide-react';
import type { AgentLog } from '../types';
import { logStyle } from './console/logCodes';

interface ActivityLogProps {
  logs: AgentLog[];
  isComplete: boolean;
}

// The number of latest entries the log shows.
const SHOWN = 6;

// Format relative time
function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = Math.floor((now - then) / 1000);

  if (diff < 5) return 'Just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

const ActivityLog: React.FC<ActivityLogProps> = ({ logs, isComplete }) => {
  const [isExpanded, setIsExpanded] = useState(false);

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
            <span className="text-chrome text-text-muted">({logs.length})</span>
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
                      <span className="text-chrome text-text-muted font-mono">
                        {formatRelativeTime(log.timestamp)}
                      </span>
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
              {logs.length > SHOWN
                ? `The latest ${SHOWN} of ${logs.length} events`
                : `${logs.length} ${logs.length === 1 ? 'event' : 'events'}`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActivityLog;
