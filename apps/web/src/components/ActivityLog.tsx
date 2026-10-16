import type React from 'react';
import { useState, useMemo } from 'react';
import {
  Database,
  Search,
  Activity,
  Zap,
  CheckCircle2,
  Cpu,
  Wifi,
  Music,
  Globe,
  Brain,
  ChevronDown,
} from 'lucide-react';
import type { AgentLog, LogCode } from '../types';

interface ActivityLogProps {
  logs: AgentLog[];
  isComplete: boolean;
}

// Map log codes to icons
function getIconForCode(code?: LogCode): React.FC<{ size: number; className?: string }> {
  if (!code) return Zap;

  const prefix = code.split('-')[0];
  const iconMap: Record<string, React.FC<{ size: number; className?: string }>> = {
    NET: Wifi,
    AUDIO: Music,
    GEMINI: Brain,
    SPOTIFY: Search,
    RESEARCH: Globe,
    GRAPH: Database,
    SYS: Cpu,
  };

  return iconMap[prefix] || Activity;
}

// Map log codes to colors
function getColorForCode(code?: LogCode): { text: string; border: string; bg: string } {
  if (!code) return { text: 'text-cyber', border: 'border-cyber/20', bg: 'bg-cyber/5' };

  const prefix = code.split('-')[0];
  const colorMap: Record<string, { text: string; border: string; bg: string }> = {
    NET: { text: 'text-cyber', border: 'border-cyber/20', bg: 'bg-cyber/5' },
    AUDIO: { text: 'text-analog', border: 'border-analog/20', bg: 'bg-analog/5' },
    GEMINI: {
      text: 'text-accent-purple',
      border: 'border-accent-purple/20',
      bg: 'bg-accent-purple/5',
    },
    SPOTIFY: {
      text: 'text-accent-green',
      border: 'border-accent-green/20',
      bg: 'bg-accent-green/5',
    },
    RESEARCH: { text: 'text-cyber', border: 'border-cyber/20', bg: 'bg-cyber/5' },
    GRAPH: { text: 'text-analog', border: 'border-analog/20', bg: 'bg-analog/5' },
    SYS: {
      text: 'text-text-tertiary',
      border: 'border-text-tertiary/20',
      bg: 'bg-text-tertiary/5',
    },
  };

  return (
    colorMap[prefix] || {
      text: 'text-text-tertiary',
      border: 'border-text-tertiary/20',
      bg: 'bg-text-tertiary/5',
    }
  );
}

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

  // Get last 6 logs for display (most recent first for visual)
  const displayLogs = useMemo(() => [...logs].slice(-6).reverse(), [logs]);
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;

  return (
    <div className="relative bg-surface border border-border rounded-[--radius-md] overflow-hidden group hover:border-cyber/30 transition-colors ease-[--ease-out-expo]">
      {/* Glow effect on hover */}
      <div className="absolute -inset-0.5 bg-gradient-to-b from-cyber/10 to-transparent rounded-[--radius-md] blur opacity-0 group-hover:opacity-30 transition duration-[--duration-slow] pointer-events-none"></div>

      {/* Collapsible Header - Always visible */}
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls="activity-log-content"
        aria-label={
          isExpanded
            ? 'Collapse activity log'
            : `Expand activity log${lastLog ? `, last event: ${lastLog.message}` : ''}`
        }
        className="relative z-10 w-full px-4 py-3 flex justify-between items-center bg-surface-subtle hover:bg-surface transition-colors duration-[--duration-fast] cursor-pointer focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:outline-none"
      >
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-xs font-mono text-text-tertiary uppercase tracking-[--tracking-widest] flex items-center gap-2 flex-shrink-0">
            <Activity size={12} className="text-cyber" />
            Agent Activity Log
            <span className="text-[10px] text-text-muted">({logs.length})</span>
          </h3>
          {/* P3:27 — Collapsed preview snippet */}
          {!isExpanded && logs.length > 0 && (
            <span className="text-[10px] font-mono text-text-muted truncate ml-2 hidden sm:inline">
              {logs[logs.length - 1]?.message}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!isComplete && (
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyber animate-pulse shadow-[0_0_6px_#00F0FF]"></span>
              <span className="text-[10px] text-cyber font-mono tracking-wider">LIVE</span>
            </span>
          )}
          {isComplete && (
            <span className="flex items-center gap-1.5">
              <CheckCircle2 size={10} className="text-status-success" />
              <span className="text-[10px] text-status-success font-mono tracking-wider">DONE</span>
            </span>
          )}
          <ChevronDown
            size={14}
            className={`text-text-tertiary transition-transform duration-[--duration-normal] ${isExpanded ? 'rotate-180' : ''}`}
          />
        </div>
      </button>

      {/* Collapsible Content */}
      <div
        id="activity-log-content"
        role="region"
        aria-label="Agent activity log entries"
        className={`relative z-10 overflow-hidden transition-all duration-[--duration-normal] ease-in-out ${isExpanded ? 'max-h-[280px]' : 'max-h-0'}`}
      >
        <div className="border-t border-white/5">
          {/* Log List */}
          <div className="relative overflow-y-auto p-3 space-y-0 scrollbar-hide max-h-[240px] overscroll-contain">
            {/* Timeline Line */}
            <div className="absolute left-6 top-3 bottom-3 w-px bg-gradient-to-b from-cyber/50 via-white/10 to-transparent"></div>

            {/* Empty State */}
            {logs.length === 0 && (
              <div className="flex flex-col items-center justify-center py-6 text-text-muted space-y-2">
                <Wifi className="animate-pulse" size={18} />
                <span className="text-[10px] tracking-widest font-mono">AWAITING DATA...</span>
              </div>
            )}

            {displayLogs.map((log, idx) => {
              const Icon = getIconForCode(log.code);
              const colors = getColorForCode(log.code);
              const isFirst = idx === 0;
              const codeLabel = log.code?.split('-')[0] || 'SYS';

              return (
                <div key={log.id} className="relative pl-7 pb-3 last:pb-0 group/item">
                  {/* Timeline Dot */}
                  <div
                    className={`
                    absolute left-[9px] top-1 w-2 h-2 rounded-full border-2 transition-all duration-[--duration-normal] z-10 box-border
                    ${
                      isFirst && !isComplete
                        ? 'bg-cyber border-cyber shadow-[0_0_6px_#00F0FF] animate-pulse ring-2 ring-cyber/20'
                        : 'bg-gray-900 border-gray-600 group-hover/item:border-gray-400 group-hover/item:shadow-[0_0_4px_rgba(255,255,255,0.15)]'
                    }
                  `}
                  ></div>

                  {/* Card Content */}
                  <div
                    className={`
                    relative p-2 rounded-[--radius-md] border transition-all duration-[--duration-normal]
                    ${
                      isFirst && !isComplete
                        ? `${colors.bg} ${colors.border}`
                        : 'bg-transparent border-transparent hover:bg-white/5'
                    }
                  `}
                  >
                    <div className="flex justify-between items-start mb-0.5">
                      <span
                        className={`text-[9px] font-bold font-mono ${isFirst && !isComplete ? colors.text : 'text-text-tertiary'} tracking-wider`}
                      >
                        {codeLabel}
                      </span>
                      <span className="text-[9px] text-text-muted font-mono">
                        {formatRelativeTime(log.timestamp)}
                      </span>
                    </div>

                    <div className="flex items-start gap-1.5 text-xs text-text-secondary">
                      {isFirst && !isComplete && <Icon size={12} className={colors.text} />}
                      <span className="leading-relaxed line-clamp-2">{log.message}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Footer Status */}
          <div className="relative z-10 bg-white/[0.02] border-t border-white/5 px-3 py-1.5 flex justify-between items-center text-[8px] font-mono text-text-tertiary uppercase">
            <span>{logs.length} EVENTS RECORDED</span>
            <span className={isComplete ? 'text-status-success' : 'text-cyber animate-pulse'}>
              {isComplete ? '● IDLE' : '◉ ACTIVE'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ActivityLog;
