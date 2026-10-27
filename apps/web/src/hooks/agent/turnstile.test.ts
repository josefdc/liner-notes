import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunTokenError } from './apiClient';
import {
  TURNSTILE_SCRIPT_URL,
  TURNSTILE_TIMEOUTS,
  type TurnstileApi,
  type TurnstileRenderOptions,
  turnstileToken,
} from './turnstile';

interface Widget {
  id: string;
  container: HTMLElement;
  options: TurnstileRenderOptions;
  removed: boolean;
}

/** A stand-in for Cloudflare's window.turnstile: it records each widget, and the test answers. */
function fakeTurnstile() {
  const widgets: Widget[] = [];
  const api: TurnstileApi = {
    render: vi.fn((container: HTMLElement, options: TurnstileRenderOptions) => {
      const id = `widget-${widgets.length + 1}`;
      widgets.push({ id, container, options, removed: false });
      return id;
    }),
    remove: vi.fn((id: string) => {
      const widget = widgets.find((candidate) => candidate.id === id);
      if (widget) widget.removed = true;
    }),
  };
  return { api, widgets, last: () => widgets[widgets.length - 1] };
}

// Scripts the page asked for: kept out of the document, so nothing is fetched.
let scripts: HTMLScriptElement[];
beforeEach(() => {
  scripts = [];
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    scripts.push(node as unknown as HTMLScriptElement);
    return node;
  });
});
afterEach(() => {
  // A script a test left loading would be waited for by the next test's checks.
  for (const script of scripts) script.dispatchEvent(new Event('error'));
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete window.turnstile;
});

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const caption = () => document.getElementById('turnstile-check-caption') as HTMLElement;

describe('the Turnstile check', () => {
  it('renders an interaction-only widget for the site key and gives its token', async () => {
    const { api, last } = fakeTurnstile();
    window.turnstile = api;
    const pending = turnstileToken('site-key-1');
    await settle();
    expect(scripts).toHaveLength(0);
    expect(last().options).toMatchObject({
      sitekey: 'site-key-1',
      appearance: 'interaction-only',
      size: 'normal',
      retry: 'never',
    });
    // Rendered in the page's own container, at the bottom of the window.
    expect(last().container.closest('#turnstile-check')).not.toBeNull();
    last().options.callback('tt-1');
    await expect(pending).resolves.toBe('tt-1');
    expect(last().removed).toBe(true);
    expect(last().container.isConnected).toBe(false);
  });

  it("loads Cloudflare's script once, on the first check, and waits for it", async () => {
    const { api, last } = fakeTurnstile();
    const first = turnstileToken('k');
    const second = turnstileToken('k');
    await settle();
    expect(scripts.map((script) => script.src)).toEqual([TURNSTILE_SCRIPT_URL]);
    expect(TURNSTILE_SCRIPT_URL).toContain('render=explicit');
    window.turnstile = api;
    scripts[0].dispatchEvent(new Event('load'));
    await settle();
    expect(api.render).toHaveBeenCalledTimes(2);
    last().options.callback('tt-2');
    await expect(second).resolves.toBe('tt-2');
    expect(first).not.toBe(second);
  });

  it('says the check is unavailable when the script cannot load, and never asks again by itself', async () => {
    vi.useFakeTimers();
    const pending = turnstileToken('k');
    pending.catch(() => {});
    await settle();
    scripts[0].dispatchEvent(new Event('error'));
    await expect(pending).rejects.toBeInstanceOf(RunTokenError);
    await expect(pending).rejects.toMatchObject({ code: 'verification_unavailable' });
    // Nothing more is asked for, however long the page waits.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(scripts).toHaveLength(1);

    // The next check (the user's next action) asks for the script again.
    const next = turnstileToken('k');
    next.catch(() => {});
    await settle();
    expect(scripts).toHaveLength(2);
    scripts[1].dispatchEvent(new Event('error'));
    await expect(next).rejects.toMatchObject({ code: 'verification_unavailable' });
  });

  it('gives up on a script that does not load in time', async () => {
    vi.useFakeTimers();
    const pending = turnstileToken('k');
    pending.catch(() => {});
    await vi.advanceTimersByTimeAsync(TURNSTILE_TIMEOUTS.scriptMs - 1);
    let done = false;
    pending.then(
      () => {},
      () => {
        done = true;
      },
    );
    await settle();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toMatchObject({ code: 'verification_unavailable' });
    expect(scripts).toHaveLength(1);
  });

  it('waits for a script that loads after a timeout instead of adding a second copy', async () => {
    vi.useFakeTimers();
    const { api, last } = fakeTurnstile();
    const late = turnstileToken('k');
    late.catch(() => {});
    await vi.advanceTimersByTimeAsync(TURNSTILE_TIMEOUTS.scriptMs);
    await expect(late).rejects.toMatchObject({ code: 'verification_unavailable' });

    // The next check (the user's next action) waits for the same script, which then arrives.
    const next = turnstileToken('k');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scripts).toHaveLength(1);
    window.turnstile = api;
    scripts[0].dispatchEvent(new Event('load'));
    await settle();
    last().options.callback('tt-late');
    await expect(next).resolves.toBe('tt-late');
    expect(scripts).toHaveLength(1);
  });

  it('fails on a widget error, and removes the widget', async () => {
    const { api, last } = fakeTurnstile();
    window.turnstile = api;
    const pending = turnstileToken('k');
    await settle();
    // Handled: Cloudflare's script does not report it again.
    expect(last().options['error-callback']('110200')).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: 'verification_failed' });
    expect(last().removed).toBe(true);
  });

  it('removes a widget that reports its error while it is being rendered', async () => {
    const { api, last } = fakeTurnstile();
    const render = api.render;
    api.render = vi.fn((container: HTMLElement, options: TurnstileRenderOptions) => {
      options['error-callback']('400020');
      return render(container, options);
    });
    window.turnstile = api;
    await expect(turnstileToken('k')).rejects.toMatchObject({ code: 'verification_failed' });
    expect(last().removed).toBe(true);
  });

  it('times out when the challenge or its token expires before the token is read', async () => {
    const { api, last } = fakeTurnstile();
    window.turnstile = api;
    const expired = turnstileToken('k');
    await settle();
    last().options['expired-callback']();
    await expect(expired).rejects.toMatchObject({ code: 'verification_timeout' });
    expect(last().removed).toBe(true);

    const challengeTimedOut = turnstileToken('k');
    await settle();
    last().options['timeout-callback']();
    await expect(challengeTimedOut).rejects.toMatchObject({ code: 'verification_timeout' });
    expect(last().removed).toBe(true);
  });

  it('never hangs: no token in time is a timeout, longer once the visitor is asked', async () => {
    vi.useFakeTimers();
    const { api, last } = fakeTurnstile();
    window.turnstile = api;
    const silent = turnstileToken('k');
    silent.catch(() => {});
    await vi.advanceTimersByTimeAsync(TURNSTILE_TIMEOUTS.checkMs);
    await expect(silent).rejects.toMatchObject({ code: 'verification_timeout' });
    expect(last().removed).toBe(true);

    // Cloudflare asks for an interaction: the caption shows, and the visitor gets longer.
    const asked = turnstileToken('k');
    asked.catch(() => {});
    await settle();
    expect(caption().textContent).toBe('');
    last().options['before-interactive-callback']();
    expect(caption().textContent).toBe('Confirm that you are a person to start the analysis.');
    await vi.advanceTimersByTimeAsync(TURNSTILE_TIMEOUTS.checkMs);
    let done = false;
    asked.then(
      () => {},
      () => {
        done = true;
      },
    );
    await settle();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(
      TURNSTILE_TIMEOUTS.interactionMs - TURNSTILE_TIMEOUTS.checkMs,
    );
    await expect(asked).rejects.toMatchObject({ code: 'verification_timeout' });
    expect(caption().textContent).toBe('');
  });

  it('says what the check is for in a polite live region, once Cloudflare asks', async () => {
    const { api, last } = fakeTurnstile();
    window.turnstile = api;
    const facts = turnstileToken('k', undefined, 'facts');
    await settle();
    expect(caption().getAttribute('role')).toBe('status');
    expect(caption().getAttribute('aria-live')).toBe('polite');
    expect(caption().hidden).toBe(false);
    expect(caption().textContent).toBe('');
    last().options['before-interactive-callback']();
    expect(caption().textContent).toBe('Confirm that you are a person to get more facts.');
    last().options.callback('tt-facts');
    await expect(facts).resolves.toBe('tt-facts');
    expect(caption().textContent).toBe('');
  });

  it('hides the caption once the interaction is over, and stops when its signal aborts', async () => {
    const { api, last } = fakeTurnstile();
    window.turnstile = api;
    const controller = new AbortController();
    const pending = turnstileToken('k', controller.signal);
    await settle();
    last().options['before-interactive-callback']();
    last().options['after-interactive-callback']();
    expect(caption().textContent).toBe('');
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(last().removed).toBe(true);
    // A token that comes after the abort changes nothing.
    last().options.callback('late');
  });
});
