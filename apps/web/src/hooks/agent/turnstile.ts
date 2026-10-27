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
 * Content-Security-Policy, for the proxy that will send one: the widget needs
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
 * Cloudflare's script, loaded once (it sets window.turnstile); checks that start while it loads
 * wait for the same load. Rejects with `verification_unavailable` when it cannot be loaded
 * within `timeoutMs`; only the next call then asks for it again.
 */
export function loadTurnstile(
  timeoutMs: number = TURNSTILE_TIMEOUTS.scriptMs,
): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    const end = (api: TurnstileApi | undefined) => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (api) {
        resolve(api);
      } else {
        script.remove();
        reject(unavailable());
      }
    };
    const timer = setTimeout(() => end(undefined), timeoutMs);
    script.onload = () => end(window.turnstile);
    script.onerror = () => end(undefined);
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    document.head.appendChild(script);
  }).finally(() => {
    // Loaded, it is window.turnstile from now on; not loaded, the next check asks again.
    loading = null;
  });
  return loading;
}

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

/** Checks that Cloudflare is asking an interaction of, by their slot. */
const interactive = new Set<HTMLElement>();

/** The container the widgets are rendered in, added to the page on the first check. */
function container(): { panel: HTMLElement; caption: HTMLElement; slots: HTMLElement } {
  let root = document.getElementById(CONTAINER_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = CONTAINER_ID;
    root.className =
      'fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-(--space-lg) pointer-events-none';
    const panel = document.createElement('section');
    panel.setAttribute('aria-labelledby', `${CONTAINER_ID}-caption`);
    panel.className = 'pointer-events-auto flex flex-col items-center gap-3 text-center';
    const caption = document.createElement('p');
    caption.id = `${CONTAINER_ID}-caption`;
    caption.className = 'text-text-secondary text-xs font-mono';
    caption.textContent = 'Confirm that you are a person to start the analysis.';
    caption.hidden = true;
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

/** Shows the panel's caption and frame while any check waits for the visitor. */
function showInteraction(slot: HTMLElement, asking: boolean) {
  if (asking) interactive.add(slot);
  else interactive.delete(slot);
  const { panel, caption } = container();
  const shown = interactive.size > 0;
  caption.hidden = !shown;
  for (const name of PANEL_SHOWN) panel.classList.toggle(name, shown);
}

/**
 * A Turnstile token for `siteKey`: renders a widget, waits for its token, then removes it.
 * Rejects with a RunTokenError carrying one of TURNSTILE_ERROR_CODES when the script cannot be
 * loaded, the widget reports an error, or no token comes in time; with an AbortError when
 * `signal` aborts. A token is good for one POST /api/runs.
 */
export function turnstileToken(
  siteKey: string,
  signal?: AbortSignal,
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
        showInteraction(slot, false);
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
              showInteraction(own, true);
              wait(timeouts.interactionMs);
            },
            'after-interactive-callback': () => {
              if (!settled) showInteraction(own, false);
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
