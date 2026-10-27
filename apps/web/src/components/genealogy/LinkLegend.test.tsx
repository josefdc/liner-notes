import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkLegend } from './LinkLegend';
import { LINK_TYPES } from './links';
import { LINK_COLOR } from './linkStyle';

afterEach(cleanup);

describe('LinkLegend', () => {
  it('says in words what solid and dashed lines mean', () => {
    render(<LinkLegend types={['influence']} />);
    const kinds = screen.getByRole('list', { name: 'How a link is known' });
    const items = within(kinds).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Solid: Sourced — cites evidence in this result',
      'Dashed: Not sourced — unchecked or not fully supported; grey for any relation but a shared producer',
    ]);
    // The swatches draw what the words say: a solid line, then a dashed one.
    const dashes = items.map((item) =>
      item.querySelector('line')?.getAttribute('stroke-dasharray'),
    );
    expect(dashes).toEqual([null, '6 4']);
  });

  it('names each relation the graph shows next to its colour, in a fixed order', () => {
    render(<LinkLegend types={['influence', 'sample', 'influence', 'producer']} />);
    const relations = within(screen.getByRole('list', { name: 'Relations' })).getAllByRole(
      'listitem',
    );
    expect(relations.map((item) => item.textContent)).toEqual([
      'Sample',
      'Shared producer',
      'Influence',
    ]);
    expect(relations.map((item) => item.querySelector('line')?.getAttribute('stroke'))).toEqual([
      LINK_COLOR.sample,
      LINK_COLOR.producer,
      LINK_COLOR.influence,
    ]);
  });

  it('has an entry for every relation', () => {
    render(<LinkLegend types={LINK_TYPES} />);
    const relations = within(screen.getByRole('list', { name: 'Relations' })).getAllByRole(
      'listitem',
    );
    expect(relations.map((item) => item.getAttribute('data-link-type'))).toEqual([...LINK_TYPES]);
    for (const item of relations) expect(item.textContent?.trim()).not.toBe('');
  });

  it('is not shown for a graph without links', () => {
    const { container } = render(<LinkLegend types={[]} />);
    expect(container.textContent).toBe('');
  });

  it('uses the text tokens that meet 4.5:1, never the dimmer tertiary or muted ones', () => {
    const { container } = render(<LinkLegend types={LINK_TYPES} />);
    const group = screen.getByRole('group', { name: 'Link legend' });
    expect(group.className).toContain('text-text-chip');
    expect(container.innerHTML).not.toMatch(/text-text-(tertiary|muted)/);
  });
});
