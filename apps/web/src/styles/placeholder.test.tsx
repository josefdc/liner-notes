import { Music } from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_GRADIENT,
  PLACEHOLDER_NOTE,
  placeholderBackground,
  placeholderImage,
} from './placeholder';
import { colors } from './theme';

const svgOf = (markup: string) =>
  new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;

/** The shapes of an icon: each path's d and each circle's centre and radius. */
function shapes(root: Element) {
  return {
    paths: [...root.querySelectorAll('path')].map((path) => path.getAttribute('d')),
    circles: [...root.querySelectorAll('circle')]
      .filter((circle) => !circle.getAttribute('fill')?.startsWith('url('))
      .map((circle) => ['cx', 'cy', 'r'].map((name) => Number(circle.getAttribute(name)))),
  };
}

describe('the genealogy placeholder', () => {
  it('is drawn with design tokens only', () => {
    expect(PLACEHOLDER_GRADIENT).toEqual({ from: colors.gray[600], to: colors.voidLighter });
    expect(PLACEHOLDER_NOTE.color).toBe(colors.text.tertiary);
    expect(placeholderBackground).toBe(
      `linear-gradient(135deg, ${colors.gray[600]}, ${colors.voidLighter})`,
    );
  });

  it("draws the graph's disc with the gradient and the note in the note colour", () => {
    const url = placeholderImage(20);
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    const svg = svgOf(decodeURIComponent(url.slice('data:image/svg+xml,'.length)));
    expect(svg.getAttribute('width')).toBe('40');
    const stops = [...svg.querySelectorAll('stop')].map((stop) => stop.getAttribute('stop-color'));
    expect(stops).toEqual([PLACEHOLDER_GRADIENT.from, PLACEHOLDER_GRADIENT.to]);
    const note = svg.querySelector('g');
    expect(note?.getAttribute('stroke')).toBe(PLACEHOLDER_NOTE.color);
    expect(note?.getAttribute('fill')).toBe('none');
    expect(note?.getAttribute('stroke-opacity')).toBeNull();
  });

  it("draws lucide's music note, the icon the Dashboard's card shows", () => {
    const lucide = svgOf(renderToStaticMarkup(<Music />));
    const url = placeholderImage(20);
    const graph = svgOf(decodeURIComponent(url.slice('data:image/svg+xml,'.length)));
    expect(shapes(graph.querySelector('g') as Element)).toEqual(shapes(lucide));
    // lucide's stroke, which the graph's copy keeps
    expect(lucide.getAttribute('stroke-width')).toBe('2');
    expect(lucide.getAttribute('stroke-linecap')).toBe('round');
  });
});
