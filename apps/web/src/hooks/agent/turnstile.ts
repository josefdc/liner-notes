/**
 * Cloudflare Turnstile in the page: the check a visitor passes before POST /api/runs issues a run
 * token (runToken.ts). Cloudflare's script is loaded once, on the first check. Each check renders
 * a widget of its own (explicit rendering, `appearance: 'interaction-only'`), so most visitors see
 * nothing: the widget shows only when Cloudflare asks for an interaction, in a container this
 * module adds to the page once (fixed at the bottom of the window, over whatever view is up), and
 * is removed once the check ends.
 *
 * A check always ends: with Turnstile's token, or with a RunTokenError carrying one of
 * TURNSTILE_ERROR_CODES, or with an AbortError when its signal aborts. Nothing here tries again by
 * itself: a script that could not be loaded is asked for again by the next check only.
 *
 * Content-Security-Policy (the web image's, apps/web/Caddyfile): the widget needs
 * `script-src https://challenges.cloudflare.com` (this script) and
 * `frame-src https://challenges.cloudflare.com` (the challenge's iframe).
 */

import { RunTokenError } from './apiClient';

/** Cloudflare's script, for explicit rendering (no widget is rendered until a check asks). */
export const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** The app's own codes for a check that gave no token. */
export const TURNSTILE_ERROR_CODES = {
  // The script could not be loaded (blocked, offline, or not loaded in time).
  unavailable: 'verification_unavailable',
  // The widget reported an error.
  failed: 'verification_failed',
  // No answer in time, or the challenge or its token expired before the token was read.
  timeout: 'verification_timeout',
} as const;

/** How long each step of a check may take, in milliseconds. */
export interface TurnstileTimeouts {
  /** Loading Cloudflare's script. */
  scriptMs: number;
  /** From the widget's rendering to its token, while Cloudflare asks nothing of the visitor. */
  checkMs: number;
  /** Once Cloudflare asks for an interaction: the visitor's time to answer it. */
  interactionMs: number;
}

export const TURNSTILE_TIMEOUTS: TurnstileTimeouts = {
  scriptMs: 15_000,
  checkMs: 30_000,
  interactionMs: 180_000,
};

/** The options this page renders a widget with (Cloudflare's names). */
export interface TurnstileRenderOptions {
  sitekey: string;
  appearance: 'interaction-only';
  size: 'normal';
  theme: 'dark';
  /** The widget does not run a failed or timed-out challenge again, nor refresh its token. */
  retry: 'never';
  'refresh-expired': 'never';
  'refresh-timeout': 'never';
  callback: (token: string) => void;
  /** A true return marks the error handled, so the script does not report it again. */
  'error-callback': (code?: string) => boolean;
  'expired-callback': () => void;
  'timeout-callback': () => void;
  'before-interactive-callback': () => void;
  'after-interactive-callback': () => void;
}

/** What this page uses of `window.turnstile`. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | null | undefined;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const unavailable = () =>
  new RunTokenError(
    'The check that protects the analysis could not be loaded.',
    TURNSTILE_ERROR_CODES.unavailable,
  );
const failed = (code?: string) =>
  new RunTokenError(
    `The check that protects the analysis failed${code ? ` (${code})` : ''}.`,
    TURNSTILE_ERROR_CODES.failed,
  );
const timedOut = () =>
  new RunTokenError(
    'The check that protects the analysis did not finish in time.',
    TURNSTILE_ERROR_CODES.timeout,
  );
const abortError = () => new DOMException('The check was aborted', 'AbortError');

let loading: Promise<TurnstileApi> | null = null;
/**
 * The script element still loading, if any, and since when: kept past a check's timeout (the
 * browser may still fetch and run it), so a check soon after waits for it instead of adding a
 * second copy. One loading for longer than PENDING_TRUST_FACTOR times the script timeout is
 * taken as stalled: it is dropped, and the check asks for the script again.
 */
let pending: { script: HTMLScriptElement; since: number } | null = null;
const PENDING_TRUST_FACTOR = 2;
/** Stalled requests given up so far: each new request after one gets a URL of its own. */
let stalled = 0;

/** The script element to wait for: the one still loading, or a new one added to the page. */
function scriptElement(timeoutMs: number): HTMLScriptElement {
  if (pending && Date.now() - pending.since < PENDING_TRUST_FACTOR * timeoutMs) {
    return pending.script;
  }
  // Stalled (neither loaded nor failed in all that time): a fresh request may get through. The
  // browser would join a request for the same URL still in flight (Chromium does), so the new
  // one is asked for at a URL of its own.
  if (pending) {
    pending.script.remove();
    pending = null;
    stalled++;
  }
  const script = document.createElement('script');
  const settled = () => {
    if (pending?.script === script) pending = null;
  };
  script.addEventListener(
    'load',
    () => {
      settled();
      // Loaded without defining window.turnstile (a blocker's empty stand-in): the next check
      // asks again, and this copy does not stay in the page.
      if (!window.turnstile) script.remove();
    },
    { once: true },
  );
  script.addEventListener(
    'error',
    () => {
      settled();
      script.remove();
    },
    { once: true },
  );
  script.src = stalled === 0 ? TURNSTILE_SCRIPT_URL : `${TURNSTILE_SCRIPT_URL}&retry=${stalled}`;
  script.async = true;
  pending = { script, since: Date.now() };
  document.head.appendChild(script);
  return script;
}

/**
 * Cloudflare's script, loaded once (it sets window.turnstile); checks that start while it loads
 * wait for the same load. Rejects with `verification_unavailable` when it cannot be loaded, or
 * is not loaded within `timeoutMs`. Nothing asks for it again by itself: the next call waits
 * for a script still loading (unless it has stalled), or asks for a new one once the last one
 * failed.
 */
export function loadTurnstile(
  timeoutMs: number = TURNSTILE_TIMEOUTS.scriptMs,
): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = scriptElement(timeoutMs);
    const end = (api: TurnstileApi | undefined) => {
      clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
      if (api) resolve(api);
      else reject(unavailable());
    };
    const onLoad = () => end(window.turnstile);
    const onError = () => end(undefined);
    const timer = setTimeout(onError, timeoutMs);
    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
  }).finally(() => {
    // Loaded, it is window.turnstile from now on; not loaded, the next check asks again.
    loading = null;
  });
  return loading;
}

/** What a check is for: the caption asks the visitor for it in these words. */
export type CheckPurpose = 'analysis' | 'facts';

const CAPTIONS: Record<CheckPurpose, string> = {
  analysis: 'Confirm that you are a person to start the analysis.',
  facts: 'Confirm that you are a person to get more facts.',
};

const CONTAINER_ID = 'turnstile-check';
// The panel's look while Cloudflare asks for an interaction; without one it shows nothing.
const PANEL_SHOWN = [
  'bg-void-lighter',
  'border',
  'border-white/15',
  'rounded-md',
  'p-4',
  'shadow-lg',
];

/** Checks that Cloudflare is asking an interaction of: their slot, and what each is for. */
const interactive = new Map<HTMLElement, CheckPurpose>();

/** The container the widgets are rendered in, added to the page on the first check. */
function container(): { panel: HTMLElement; caption: HTMLElement; slots: HTMLElement } {
  let root = document.getElementById(CONTAINER_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = CONTAINER_ID;
    root.className =
      'fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-(--space-lg) pointer-events-none';
    const panel = document.createElement('div');
    panel.className = 'pointer-events-auto flex flex-col items-center gap-3 text-center';
    // A polite live region, in the page from the first check on: its words are read once, when
    // Cloudflare asks for an interaction. Empty (and of no size) otherwise.
    const caption = document.createElement('p');
    caption.id = `${CONTAINER_ID}-caption`;
    caption.className = 'text-text-secondary text-xs font-mono';
    caption.setAttribute('role', 'status');
    caption.setAttribute('aria-live', 'polite');
    const slots = document.createElement('div');
    panel.append(caption, slots);
    root.append(panel);
    document.body.append(root);
  }
  const panel = root.firstElementChild as HTMLElement;
  return {
    panel,
    caption: panel.firstElementChild as HTMLElement,
    slots: panel.lastElementChild as HTMLElement,
  };
}

/**
 * Shows the panel's caption and frame while any check waits for the visitor; the caption names
 * what the latest of them is for.
 */
function showInteraction(slot: HTMLElement, purpose: CheckPurpose | null) {
  if (purpose) interactive.set(slot, purpose);
  else interactive.delete(slot);
  const { panel, caption } = container();
  const latest = [...interactive.values()].pop();
  const text = latest ? CAPTIONS[latest] : '';
  if (caption.textContent !== text) caption.textContent = text;
  for (const name of PANEL_SHOWN) panel.classList.toggle(name, latest !== undefined);
}

/**
 * A Turnstile token for `siteKey`: renders a widget, waits for its token, then removes it.
 * Rejects with a RunTokenError carrying one of TURNSTILE_ERROR_CODES when the script cannot be
 * loaded, the widget reports an error, or no token comes in time; with an AbortError when
 * `signal` aborts. `purpose` words the caption shown if Cloudflare asks for an interaction. A
 * token is good for one POST /api/runs.
 */
export function turnstileToken(
  siteKey: string,
  signal?: AbortSignal,
  purpose: CheckPurpose = 'analysis',
  timeouts: TurnstileTimeouts = TURNSTILE_TIMEOUTS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let api: TurnstileApi | null = null;
    let widgetId: string | null | undefined;
    let slot: HTMLElement | null = null;

    const end = (error: Error | null, token = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (api && widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          // Already gone.
        }
      }
      if (slot) {
        showInteraction(slot, null);
        slot.remove();
      }
      if (error) reject(error);
      else resolve(token);
    };
    const onAbort = () => end(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const wait = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => end(timedOut()), ms);
    };

    loadTurnstile(timeouts.scriptMs).then(
      (loaded) => {
        if (settled) return;
        api = loaded;
        const own = document.createElement('div');
        slot = own;
        container().slots.append(own);
        wait(timeouts.checkMs);
        try {
          widgetId = loaded.render(own, {
            sitekey: siteKey,
            appearance: 'interaction-only',
            size: 'normal',
            theme: 'dark',
            retry: 'never',
            'refresh-expired': 'never',
            'refresh-timeout': 'never',
            callback: (token) => {
              if (typeof token === 'string' && token !== '') end(null, token);
              else end(failed());
            },
            'error-callback': (code) => {
              end(failed(code));
              return true;
            },
            'expired-callback': () => end(timedOut()),
            'timeout-callback': () => end(timedOut()),
            'before-interactive-callback': () => {
              if (settled) return;
              showInteraction(own, purpose);
              wait(timeouts.interactionMs);
            },
            'after-interactive-callback': () => {
              if (!settled) showInteraction(own, null);
            },
          });
          // The check ended while the widget was being rendered (an error reported at once).
          if (settled && widgetId) loaded.remove(widgetId);
        } catch (error) {
          console.warn('[turnstile] The widget could not be rendered:', error);
          end(failed());
        }
      },
      (error: unknown) => end(error instanceof Error ? error : unavailable()),
    );
  });
}
