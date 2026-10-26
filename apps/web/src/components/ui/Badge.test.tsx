import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Badge, type BadgeVariant } from './Badge';

afterEach(cleanup);

// The colour each variant is drawn in: a token named by what it means, not by its hue.
const COLOUR: Record<BadgeVariant, string> = {
  measured: 'text-prov-measured',
  sourced: 'text-prov-sourced',
  inferred: 'text-prov-inferred',
  warning: 'text-status-warning',
  error: 'text-status-error',
  neutral: 'text-text-chip',
};

const badge = (variant?: BadgeVariant, glow = false) => {
  const { container } = render(
    <Badge variant={variant} glow={glow}>
      Words
    </Badge>,
  );
  return container.firstElementChild as HTMLElement;
};

describe('Badge', () => {
  it('names its variants by what they mean, each drawn in the token of that meaning', () => {
    for (const [variant, colour] of Object.entries(COLOUR) as [BadgeVariant, string][]) {
      const element = badge(variant);
      expect(element.dataset.variant).toBe(variant);
      expect(element.className.split(' ')).toContain(colour);
      cleanup();
    }
  });

  it('is neutral unless it says otherwise', () => {
    expect(badge().dataset.variant).toBe('neutral');
  });

  it('draws no variant in a hue with no meaning here (pink, green, purple, indigo)', () => {
    for (const variant of Object.keys(COLOUR) as BadgeVariant[]) {
      expect(badge(variant, true).className).not.toMatch(/pink|green|purple|indigo/);
      cleanup();
    }
  });

  it('glows only for measured and sourced values, in their own colour', () => {
    expect(badge('measured', true).className).toContain('shadow-glow-cyber-subtle');
    cleanup();
    expect(badge('sourced', true).className).toContain('shadow-glow-analog-subtle');
    cleanup();
    expect(badge('inferred', true).className).not.toContain('shadow-glow');
  });
});
