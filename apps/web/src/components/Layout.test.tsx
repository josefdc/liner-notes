import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import Layout from './Layout';

afterEach(cleanup);

const page = () =>
  render(
    <Layout>
      <main id="main-content">
        <p>Words that are not a control</p>
        <button type="button">A control</button>
      </main>
    </Layout>,
  );

describe('the skip link', () => {
  it('moves the focus into main, which is focusable only until the focus leaves it', () => {
    page();
    const main = screen.getByRole('main');
    expect(main.hasAttribute('tabindex')).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute('tabindex')).toBe('-1');
    screen.getByRole('button', { name: 'A control' }).focus();
    expect(main.hasAttribute('tabindex')).toBe(false);
  });

  it('leaves a click with a modifier to the browser', () => {
    page();
    const main = screen.getByRole('main');
    const followed = fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }), {
      ctrlKey: true,
    });
    expect(followed).toBe(true);
    expect(main.hasAttribute('tabindex')).toBe(false);
    expect(document.activeElement).not.toBe(main);
  });
});
