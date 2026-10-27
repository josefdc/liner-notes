import { act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './components/ErrorBoundary';
import { rootErrorOptions } from './rootErrors';

// What React logs when a part of the page throws: in production its default logs the whole
// error, whose message can carry the data the part was given (here, a signed preview link).

const SECRET = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/n.mp3?hdnea=exp=1~hmac=y';

function Broken(): never {
  throw new TypeError(`cannot read ${SECRET}`);
}

/** Everything written to the console's error log, as text. */
const errorLog = () =>
  vi
    .mocked(console.error)
    .mock.calls.map((args) =>
      args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))),
    )
    .join('\n');

let container: HTMLElement;
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

describe("the page's root error logging", () => {
  it('logs a part caught by a boundary by the error name only', async () => {
    const root = createRoot(container, rootErrorOptions);
    await act(async () =>
      root.render(
        <ErrorBoundary message="This part could not be shown" action={{ label: 'Try again' }}>
          <Broken />
        </ErrorBoundary>,
      ),
    );
    expect(container.textContent).toContain('This part could not be shown');
    expect(errorLog()).toContain('TypeError');
    expect(errorLog()).not.toContain('hdnea');
    expect(errorLog()).not.toContain('cannot read');
    await act(async () => root.unmount());
  });

  it('logs an error no boundary caught by its name only', async () => {
    // Outside act, as on the page: act would hand the error back instead of reporting it.
    const scope = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const actEnvironment = scope.IS_REACT_ACT_ENVIRONMENT;
    scope.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      const root = createRoot(container, rootErrorOptions);
      root.render(<Broken />);
      await vi.waitFor(() => expect(errorLog()).toContain('TypeError'));
      expect(errorLog()).not.toContain('hdnea');
      root.unmount();
    } finally {
      scope.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
    }
  });

  it('is what the page mounts with', async () => {
    const created: { options?: unknown } = {};
    vi.doMock('react-dom/client', () => ({
      default: {
        createRoot: (_element: Element, options: unknown) => {
          created.options = options;
          return { render: () => {} };
        },
      },
    }));
    vi.doMock('./App', () => ({ default: () => null }));
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    await import('./main');
    root.remove();
    expect(created.options).toBe(rootErrorOptions);
  });
});
