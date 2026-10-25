#!/usr/bin/env node
// Checks the WCAG contrast of a token sheet's colours (scripts/contrast.mjs runs this too):
//
//   node config/contrast.mjs src/styles/tokens.css
//
// - Text colours (--color-text-*, --color-prov-*, --color-status-*, --color-cyber and
//   --color-analog) reach 4.5:1 (AA for body text) on every surface.
// - Data-visualisation colours (--color-viz-*) reach 3:1 (AA for graphics) on every surface.
//
// Surfaces are --color-void (the page) and the other --color-void-* and --color-surface-* tokens;
// a translucent surface is measured as drawn on the page, and translucent text as drawn on the
// surface. Prints one line per colour with its lowest ratio; exits 1 when any colour falls short,
// 2 when the sheet cannot be read.

import { readFileSync } from 'node:fs';
import { parseColor, readTokens, resolveToken } from './tokens.mjs';

export const PAGE = '--color-void';
export const TEXT_MINIMUM = 4.5;
export const GRAPHIC_MINIMUM = 3;

const isSurface = (name) => /^--color-(void|surface)(-|$)/.test(name);
const isText = (name) =>
  /^--color-(text|prov|status)-/.test(name) ||
  name === '--color-cyber' ||
  name === '--color-analog';
const isGraphic = (name) => name.startsWith('--color-viz-');

const channel = (value) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an opaque colour. */
export const luminance = ({ r, g, b }) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** A colour drawn over an opaque one. */
export const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

/** WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function color(tokens, name) {
  const value = resolveToken(tokens, name);
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`${name}: "${value}" is not a hex or rgb() colour`);
  return parsed;
}

/**
 * Every checked colour with its ratio on each surface:
 * [{ name, minimum, results: [{ surface, ratio }], lowest, passes }].
 */
export function contrastReport(css) {
  const tokens = readTokens(css);
  if (!tokens.has(PAGE)) throw new Error(`${PAGE} (the page colour) is not defined`);
  const page = color(tokens, PAGE);
  if (page.a !== 1) throw new Error(`${PAGE} must be opaque`);
  const names = [...tokens.keys()];
  const surfaces = names
    .filter(isSurface)
    .map((name) => ({ name, color: over(color(tokens, name), page) }));
  return names
    .filter((name) => isText(name) || isGraphic(name))
    .map((name) => {
      const minimum = isGraphic(name) ? GRAPHIC_MINIMUM : TEXT_MINIMUM;
      const foreground = color(tokens, name);
      const results = surfaces.map((surface) => ({
        surface: surface.name,
        ratio: contrastRatio(over(foreground, surface.color), surface.color),
      }));
      const lowest = results.reduce((low, result) => (result.ratio < low.ratio ? result : low));
      return { name, minimum, results, lowest, passes: lowest.ratio >= minimum };
    });
}

const ratio = (value) => `${(Math.floor(value * 100) / 100).toFixed(2)}:1`;

/** Runs the check on a file; returns the exit code. */
export function main(args, log = console.log, error = console.error) {
  if (args.length !== 1) {
    error('usage: contrast.mjs <tokens.css>');
    return 2;
  }
  let report;
  try {
    report = contrastReport(readFileSync(args[0], 'utf8'));
  } catch (problem) {
    error(`contrast: ${problem.message}`);
    return 2;
  }
  if (report.length === 0) {
    error(`contrast: ${args[0]} has no text or data-visualisation colour tokens`);
    return 2;
  }
  const width = Math.max(...report.map((entry) => entry.name.length));
  for (const entry of report) {
    const failing = entry.results.filter((result) => result.ratio < entry.minimum);
    const status = entry.passes ? 'ok  ' : 'FAIL';
    const detail = entry.passes
      ? `lowest ${ratio(entry.lowest.ratio)} on ${entry.lowest.surface}`
      : failing.map((result) => `${ratio(result.ratio)} on ${result.surface}`).join(', ');
    log(`${status} ${entry.name.padEnd(width)}  needs ${entry.minimum}:1  ${detail}`);
  }
  const failures = report.filter((entry) => !entry.passes).length;
  if (failures > 0) {
    error(`contrast: ${failures} of ${report.length} colours fall short on some surface`);
    return 1;
  }
  log(`contrast: all ${report.length} colours pass on every surface`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
