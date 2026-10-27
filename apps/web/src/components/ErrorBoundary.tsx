import { Component, type ErrorInfo, type ReactNode } from 'react';
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
 * it says what failed and offers a way back. The console gets what failed and the error's name,
 * never its message or the data the part was given.
 *
 * Like any React error boundary it catches throws while its children render and in their
 * effects, not in callbacks that run later outside React: event handlers, timers, d3's ticks
 * and zoom handlers, a ResizeObserver's callback.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    console.error(`${this.props.message} (${errorName(error)})`);
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
        <Button variant="neutral" size="sm" onClick={this.retry}>
          {this.props.action.label}
        </Button>
      </div>
    );
  }
}
