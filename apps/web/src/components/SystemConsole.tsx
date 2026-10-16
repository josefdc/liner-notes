import React, { useEffect, useRef, useState } from 'react';
import type { AgentLog, LogCode } from '../types';
import { Terminal, Cpu, Wifi, Activity } from 'lucide-react';

interface SystemConsoleProps {
  logs: AgentLog[];
  isComplete: boolean;
}

// Color mapping for log code prefixes
const LOG_CODE_COLORS: Record<string, string> = {
  NET: 'text-cyber',
  AUDIO: 'text-analog',
  GEMINI: 'text-accent-purple',
  SPOTIFY: 'text-accent-green',
  RESEARCH: 'text-cyber',
  GRAPH: 'text-analog',
  SYS: 'text-text-tertiary',
};

// Get color class for a log code
function getCodeColor(code?: LogCode): string {
  if (!code) return 'text-cyber';
  const prefix = code.split('-')[0];
  return LOG_CODE_COLORS[prefix] || 'text-text-tertiary';
}

// Hoisted static JSX element -- avoids re-creating a component instance each render
const cyberCursor = (
  <span className="inline-flex items-center ml-1">
    <span className="w-2 h-4 bg-cyber animate-pulse-glow rounded-sm text-shadow-glow-cyber"></span>
  </span>
);

// Log line component - instant render for better UX, keeps visual appeal
const LogLine: React.FC<{ log: AgentLog; isLatest: boolean }> = React.memo(({ log, isLatest }) => {
  const codePrefix = log.code ? `[${log.code}]` : '>';
  const colorClass = getCodeColor(log.code);
  const time = new Date(log.timestamp).toLocaleTimeString('en-US', { hour12: false });

  return (
    <div
      className={`flex items-start font-mono text-xs leading-relaxed py-0.5 content-auto ${isLatest ? 'animate-fade-in-right' : ''}`}
    >
      <span className="text-text-tertiary mr-3 shrink-0 w-16 tabular-nums opacity-60">{time}</span>
      <span className={`${colorClass} mr-2 shrink-0 font-bold tracking-wider`}>{codePrefix}</span>
      <span className="text-text-secondary tracking-tight">
        {log.message}
        {isLatest && cyberCursor}
      </span>
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

  // Auto-scroll forzado siempre al fondo usando anchor invisible
  useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  return (
    <div className="relative w-full max-w-3xl mx-auto group" aria-label="Analysis system console">
      {/* Glow Effect Background */}
      <div className="absolute -inset-0.5 bg-gradient-to-b from-cyber/15 to-accent-purple/10 rounded-[--radius-md] blur opacity-20 group-hover:opacity-40 transition duration-[--duration-dramatic] ease-[--ease-out-expo]"></div>

      <div className="relative rounded-[--radius-md] overflow-hidden border border-border bg-black/90 shadow-2xl backdrop-blur-xl">
        {/* Terminal Header */}
        <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/5">
          <div className="flex items-center gap-3">
            <Terminal size={14} className="text-cyber" />
            <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
              sonic-agent://analysis.log
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
              {isComplete ? '[ COMPLETE ]' : '[ ACTIVE ]'}
            </span>
            <div className="flex gap-1.5">
              <div
                className="w-2 h-2 rounded-full bg-status-error/50"
                title="Close (just kidding)"
              />
              <div className="w-2 h-2 rounded-full bg-accent-amber/50" title="Minimize (nope)" />
              <div
                className="w-2 h-2 rounded-full bg-status-success/50"
                title="Maximize (dreaming)"
              />
            </div>
          </div>
        </div>

        {/* Terminal Body */}
        <div
          ref={consoleRef}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          className="relative h-72 overflow-y-auto scrollbar-hide p-4 font-mono overscroll-contain"
        >
          {/* CRT Scanline Effect - Pronounced aesthetic */}
          <div className="absolute inset-0 pointer-events-none z-10 crt-scanlines opacity-30"></div>

          {/* Grid background pattern */}
          <div
            className="absolute inset-0 pointer-events-none opacity-[0.03]"
            style={{
              backgroundImage: 'linear-gradient(rgba(0,240,255,0.1) 1px, transparent 1px)',
              backgroundSize: '100% 20px',
            }}
          />

          {/* Empty State */}
          {logs.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-text-muted space-y-2">
              <Wifi className="animate-pulse" size={24} />
              <span className="text-xs tracking-widest font-mono">ESTABLISHING UPLINK...</span>
            </div>
          )}

          {/* Log Entries */}
          <div className="space-y-0.5 relative z-0">
            {logs.map((log, idx) => (
              <LogLine key={log.id} log={log} isLatest={idx === logs.length - 1 && !isComplete} />
            ))}

            {/* Processing Indicator "Mira" Animada */}
            {!isComplete && logs.length > 0 && (
              <div className="pt-3 flex items-center text-cyber text-xs border-t border-white/5 mt-3">
                <span className="mr-2 animate-spin-slow">
                  <Cpu size={14} />
                </span>
                <span className="tracking-widest font-mono">PROCESSING_DATA_STREAM</span>
                <span className="inline-flex ml-2">
                  <span className="animate-bounce" style={{ animationDelay: '0ms' }}>
                    .
                  </span>
                  <span className="animate-bounce" style={{ animationDelay: '150ms' }}>
                    .
                  </span>
                  <span className="animate-bounce" style={{ animationDelay: '300ms' }}>
                    .
                  </span>
                </span>
              </div>
            )}

            {/* Complete Indicator */}
            {isComplete && (
              <div className="pt-4 pb-2">
                <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-status-success/10 border border-status-success/30 rounded-[--radius-sm] text-status-success text-xs tracking-widest font-mono">
                  <Activity size={14} />
                  <span>PROCESS COMPLETE</span>
                </div>
              </div>
            )}

            {/* Elemento invisible para forzar scroll al fondo */}
            <div ref={bottomRef} className="h-1" />
          </div>
        </div>

        {/* Footer Status Bar — P3:26 real derived values */}
        <div className="bg-white/5 border-t border-white/5 px-4 py-1.5 flex justify-between items-center text-[9px] font-mono text-text-tertiary uppercase">
          <span>EVENTS: {logs.length}</span>
          <span>UPLINK: {elapsedSeconds}s</span>
          <span className={isComplete ? 'text-status-success' : 'text-cyber animate-pulse'}>
            {isComplete ? '● ONLINE' : '◉ BUSY'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default SystemConsole;
