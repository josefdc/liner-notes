/**
 * The event streams of a run: opening the analysis and resume streams, the inactivity watchdog
 * fed by the server's heartbeats, and the signals that close them.
 *
 * Events are handled only while their stream is the run's current stream and the run is the
 * latest one, so a stale stream can never close or overwrite a newer one. A broken stream ends
 * the run with an error the user can retry; it never starts the analysis again by itself.
 */

import {
  type AnalysisEvent,
  eventSchemasLoaded,
  loadEventSchemas,
  parseAnalysisEvent,
  type RunEvents,
  streamGuard,
} from './events';
import { CLIENT_ERROR_CODES } from './failure';

/**
 * How long a stream may stay silent once its server has sent a heartbeat (every 15 s). A
 * heartbeat arrives either as a data message `{"type":"heartbeat","runId":…}` (what the API
 * sends) or as a named `heartbeat` event; both count. The watchdog arms only on the first heartbeat:
 * a server that sends none is never timed out, so a slow step is not cut off.
 */
export const STREAM_INACTIVITY_TIMEOUT_MS = 45_000;

/**
 * A signal that aborts once `a` or `b` does: AbortSignal.any where the browser has it, else one
 * controller listening to both (Safari before 17.4, Chrome before 116, Firefox before 124).
 */
export function eitherSignal(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (a.aborted || b.aborted) {
    abort();
  } else {
    a.addEventListener('abort', abort, { once: true });
    b.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

/** EventSource.CLOSED: the browser has given the stream up and will not reconnect. */
const EVENT_SOURCE_CLOSED = 2;

/** Loads the code that reads the streams, unless it is loaded already. */
export function readersReady(): Promise<void> | null {
  return eventSchemasLoaded() ? null : loadEventSchemas();
}

/** Calls `onTimeout` after a silence, but only once a heartbeat has armed it. */
export function inactivityWatchdog(onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let armed = false;
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(onTimeout, STREAM_INACTIVITY_TIMEOUT_MS);
  };
  return {
    heartbeat() {
      armed = true;
      restart();
    },
    activity() {
      if (armed) restart();
    },
    stop() {
      armed = false;
      clearTimeout(timer);
    },
  };
}

export function abortError(): Error {
  return new DOMException('The stream was aborted', 'AbortError');
}

/** The run's open stream and the function that closes it (and stops its watchdog). */
export interface OpenStream {
  source: EventSource;
  close: () => void;
}

export interface RunStreamOptions {
  /** The run's id and result, shared by its streams. */
  events: RunEvents;
  /** The run's signal: the stream closes when the run is replaced, reset or unmounted. */
  signal: AbortSignal;
  /** Where the run's current stream is kept: this one, until another replaces it. */
  slot: { current: OpenStream | null };
  /** True while the run is the latest one. */
  isLatest: () => boolean;
  /** The stream opened, while it is current. */
  onOpen?: () => void;
  /** An event of the current stream, read and accepted; `close` closes the stream. */
  onEvent: (data: AnalysisEvent, close: () => void) => void;
  /** The server answered the request with an error status: its run token is not sent again. */
  onRefused: () => void;
  /** The current stream is gone (closed already): an error unless the run has what it needs. */
  onLost: (message: string, code: string) => void;
}

/** Opens a stream at `url` and makes it the run's current stream. */
export function openRunStream(url: string, options: RunStreamOptions): void {
  const { events, signal, slot, isLatest, onOpen, onEvent, onRefused, onLost } = options;
  const source = new EventSource(url);
  const isCurrent = () => isLatest() && slot.current?.source === source;
  // `seq` restarts on each stream; the run's id and result are shared by its streams.
  const accept = streamGuard(events);

  const close = () => {
    watchdog.stop();
    source.close();
    signal.removeEventListener('abort', close);
    if (slot.current?.source === source) slot.current = null;
  };
  // The connection is gone: an error unless the run already has what it needs.
  const lose = (message: string, code: string) => {
    const current = isCurrent();
    close();
    if (current) onLost(message, code);
  };
  const watchdog = inactivityWatchdog(() =>
    lose('The analysis stopped responding.', CLIENT_ERROR_CODES.streamStalled),
  );

  signal.addEventListener('abort', close, { once: true });
  slot.current = { source, close };

  let opened = false;
  source.onopen = () => {
    opened = true;
    if (isCurrent()) onOpen?.();
  };
  // A named `heartbeat` event; the data-message form is handled in onmessage.
  source.addEventListener('heartbeat', () => {
    if (isCurrent()) watchdog.heartbeat();
    else close();
  });
  source.onmessage = (event) => {
    if (!isCurrent()) {
      close();
      return;
    }
    watchdog.activity();
    const data = parseAnalysisEvent(event.data);
    if (!data || !accept(data)) return;
    if (data.type === 'heartbeat') {
      watchdog.heartbeat();
      return;
    }
    onEvent(data, close);
  };
  // EventSource reconnects by itself, which would start the analysis again on the
  // server: close instead and let the user retry. A stream closed before it opened was
  // answered with an error status (the browser gives up at once): the API refused the
  // request, most often its run token, which is not sent again.
  source.onerror = () => {
    if (!opened && source.readyState === EVENT_SOURCE_CLOSED) {
      onRefused();
      lose('The analysis server did not accept the request.', CLIENT_ERROR_CODES.streamRefused);
      return;
    }
    lose('Lost the connection to the analysis.', CLIENT_ERROR_CODES.connectionLost);
  };
}
