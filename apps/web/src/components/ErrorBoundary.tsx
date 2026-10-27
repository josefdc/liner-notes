import { Component, createRef, type ErrorInfo, type ReactNode } from 'react';
import { errorName } from '../rootErrors';
import { Button } from './ui/Button';

interface ErrorBoundaryProps {
  /** What could not be shown, in words: the fallback says it and the console logs it. */
  message: string;
  /** The way back: what the button says and does. The boundary tries its children again after. */
  action: { label: string; onClick?: () => void };
  /** Classes for the fallback's box, so it fills the place of what failed. */
  className?: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
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
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };
  private actionRef = createRef<HTMLButtonElement>();

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    if (import.meta.env.DEV) console.error(this.props.message, error, info.componentStack);
    else console.error(`${this.props.message} (${errorName(error)})`);
  }

  componentDidMount() {
    if (this.state.failed) this.actionRef.current?.focus();
  }

  componentDidUpdate(_props: ErrorBoundaryProps, previous: ErrorBoundaryState) {
    if (this.state.failed && !previous.failed) this.actionRef.current?.focus();
  }

  private retry = () => {
    this.props.action.onClick?.();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
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
