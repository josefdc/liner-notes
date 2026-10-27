import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A screen that cannot be shown: the search screen throws.
vi.mock('./components/Onboarding', () => ({
  default: () => {
    throw new Error('the screen failed');
  },
}));

import App from './App';

beforeEach(() => {
  // React reports the caught error too.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the screen error boundary', () => {
  it('says the screen could not be shown and offers a way back', () => {
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('This screen could not be shown');
    expect(screen.getByRole('button', { name: /new search/i })).toBeTruthy();
  });
});
