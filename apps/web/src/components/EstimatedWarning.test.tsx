import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import EstimatedWarning from './EstimatedWarning';

afterEach(cleanup);

describe('EstimatedWarning', () => {
  it('labels estimated values', () => {
    render(<EstimatedWarning show />);
    expect(screen.getByText('ESTIMATED')).toBeTruthy();
  });

  it('renders nothing when the values are not estimated', () => {
    const { container } = render(<EstimatedWarning show={false} />);
    expect(container.textContent).toBe('');
  });
});
