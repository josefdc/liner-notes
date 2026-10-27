import { Component, type ContextType, createRef, type ErrorInfo, type ReactNode } from 'react';
import { errorName } from '../rootErrors';
import { isChunkLoadError, LoadAttempt } from '../utils/lazyWithRetry';
import { Button } from './ui/Button';

interface ErrorBoundaryProps {
  /** What could not be shown, in words: the fallback says it and the console logs it. */
  message: string;
  /**
   * The way back: what the button says and does. The boundary tries its children again after.
   * One with `onClick` (a way elsewhere) is offered after a chunk-load error too, besides "Try
   * again" and "Reload the page".
   */
  action: { label: string; onClick?: () => void };
  /** Classes for the fallback's box, so it fills the place of what failed. */
  className?: string;
  /**
   * What is shown: when it changes, a failed boundary tries its children again. Its children are
   * not mounted afresh for it, so what keeps the focus (a heading) keeps it.
   */
  resetKey?: string;
  /**
   * What the fallback says when the part's code could not be loaded (a chunk-load error), in
   * words: "This part of the page could not be loaded" by default.
   */
  loadFailedMessage?: string;
  /**
   * Called once "Try again" after a chunk-load error has put the part back (or the loading view
   * that stands in for it while its code loads), to move the focus there.
   */
  onRetried?: () => void;
  /**
   * Whether the fallback's first button takes the focus when the part fails (true by default):
   * false for a piece inside a view whose own heading has the focus.
   */
  focusOnFail?: boolean;
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
  /** Whether what failed is a load of the part's code (lazyWithRetry.ts), not its rendering. */
  chunk: boolean;
  /** The `resetKey` the state is for. */
  resetKey?: string;
  /** The load attempt of the lazy components inside (`LoadAttempt`): new on each reset. */
  attempt: object;
}

/**
 * Keeps a part of the page that throws while it renders from taking the rest down: in its place
 * it says what failed and offers a way back, and the way back takes the focus (what had it may
 * be gone). In the production build the console gets what failed and the error's name, never
 * its message or the data the part was given; in development, the whole error and where it was
 * thrown.
 *
 * Like any React error boundary it catches throws while its children render and in their
 * effects, not in callbacks that run later outside React: event handlers, timers, d3's ticks
 * and zoom handlers, a ResizeObserver's callback.
 *
 * When the part's code could not be loaded (a dropped connection, a deploy that replaced the
 * hashed files), the fallback says so and offers "Try again", which loads the code again (the
 * lazy components made by `lazyWithRetry` start a new attempt on each reset), "Reload the
 * page", for a chunk that is gone from the server, and the way elsewhere if there is one.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  static contextType = LoadAttempt;
  state: ErrorBoundaryState;

  constructor(props: ErrorBoundaryProps, attempt: ContextType<typeof LoadAttempt>) {
    super(props);
    // A new boundary goes on with the load attempt of the one around it, not a new one: React
    // makes a boundary afresh each time it renders it before its first commit (while a part
    // beside it still loads), and a new attempt each time would import a failed chunk again
    // and again. Only a reset (below) starts a new attempt.
    this.state = { failed: false, chunk: false, resetKey: props.resetKey, attempt };
  }

  private actionRef = createRef<HTMLButtonElement>();
  /** "Try again" after a chunk-load error put the part back: `onRetried` is due. */
  private retried = false;

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failed: true, chunk: isChunkLoadError(error) };
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    return props.resetKey === state.resetKey
      ? null
      : { failed: false, chunk: false, resetKey: props.resetKey, attempt: {} };
  }

  private get loadFailedMessage() {
    return this.props.loadFailedMessage ?? 'This part of the page could not be loaded';
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The line the fallback shows.
    const message = isChunkLoadError(error) ? this.loadFailedMessage : this.props.message;
    if (import.meta.env.DEV) console.error(message, error, info.componentStack);
    else console.error(`${message} (${errorName(error)})`);
  }

  componentDidMount() {
    if (this.state.failed && this.props.focusOnFail !== false) this.actionRef.current?.focus();
  }

  componentDidUpdate(_props: ErrorBoundaryProps, previous: ErrorBoundaryState) {
    if (this.state.failed && !previous.failed && this.props.focusOnFail !== false) {
      this.actionRef.current?.focus();
    }
    if (this.retried && !this.state.failed) {
      this.retried = false;
      this.props.onRetried?.();
    }
  }

  private retry = () => {
    this.props.action.onClick?.();
    this.setState({ failed: false, chunk: false, attempt: {} });
  };

  /** Loads the part's code again: the lazy components inside start a new attempt. */
  private retryLoad = () => {
    this.retried = true;
    this.setState({ failed: false, chunk: false, attempt: {} });
  };

  render() {
    if (!this.state.failed) {
      return (
        <LoadAttempt.Provider value={this.state.attempt}>
          {this.props.children}
        </LoadAttempt.Provider>
      );
    }
    if (this.state.chunk) {
      return (
        <div
          role="alert"
          className={`flex flex-col items-center justify-center gap-3 p-6 text-center ${this.props.className ?? ''}`}
        >
          <p className="text-sm text-text-primary">{this.loadFailedMessage}.</p>
          <p className="text-xs text-text-secondary">
            The connection may have dropped, or the site was updated since this page was opened.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Button ref={this.actionRef} variant="neutral" size="sm" onClick={this.retryLoad}>
              Try again
            </Button>
            <Button variant="neutral" size="sm" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
            {this.props.action.onClick && (
              <Button variant="neutral" size="sm" onClick={this.retry}>
                {this.props.action.label}
              </Button>
            )}
          </div>
        </div>
      );
    }
    return (
      <div
        role="alert"
        className={`flex flex-col items-center justify-center gap-3 p-6 text-center ${this.props.className ?? ''}`}
      >
        <p className="text-sm text-text-primary">{this.props.message}.</p>
        <Button ref={this.actionRef} variant="neutral" size="sm" onClick={this.retry}>
          {this.props.action.label}
        </Button>
      </div>
    );
  }
}
