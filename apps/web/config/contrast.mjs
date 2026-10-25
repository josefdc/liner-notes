#!/usr/bin/env node
// Checks the WCAG contrast of the design tokens (scripts/contrast.mjs runs this too):
//
//   node config/contrast.mjs src/styles/tokens.css [--src <dir>]     (--src default: apps/web/src)
//
// Text colours reach 4.5:1 (AA for body text) on every surface. A colour is text when
// - its name says so: --color-text-*, --color-prov-*, --color-status-*, --color-accent-*,
//   cyber, analog, spotify and white; or
// - the app draws text with it: a text-*, placeholder-* or caret-* class in the source names it
//   (at the class's opacity, so text-cyber/60 is checked at 60 %), or a chart role that colours
//   text (ROLES in theme.mjs with `text`).
// A class string that also sets a background tint (`text-accent-pink hover:bg-accent-pink/20`)
// has its text checked on that tint too, over every surface. Dark text on a light fill
// (INVERSE) is checked on that fill instead. Data-visualisation colours (--color-viz-*) reach
// 3:1 (AA for graphics) on the page and on panels.
//
// Surfaces are the opaque --color-void* tokens, each translucent --color-surface* panel drawn on
// them, and each translucent state (--color-surface-hover, --color-surface-active) drawn on a
// base or on a panel over it: interactive elements sit on panels, panels sit on the page. A
// class string's own background tint is drawn where a state would be (on a base or a panel).
// Prints one line per colour with its lowest ratio; exits 1 when any colour falls short, 2 when
// the sheet cannot be read.

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, SRC_DIR } from './theme.mjs';
import { parseColor, readTokens, resolveToken } from './tokens.mjs';

export const PAGE = '--color-void';
export const TEXT_MINIMUM = 4.5;
export const GRAPHIC_MINIMUM = 3;

const TEXT_FAMILY = /^--color-(text|prov|status|accent)-/;
const TEXT_NAMED = new Set(['--color-cyber', '--color-analog', '--color-spotify', '--color-white']);
/** Dark text drawn on a light fill (the play button, the skip link), checked on that fill. */
export const INVERSE = {
  '--color-black': ['--color-white'],
  '--color-void': ['--color-cyber'],
};
const isBase = (name) => /^--color-void(-|$)/.test(name);
const isTranslucentSurface = (name) => /^--color-surface(-|$)/.test(name);
const isState = (name) => /^--color-surface-(hover|active)$/.test(name);
const isGraphic = (name) => name.startsWith('--color-viz-');
const short = (name) => name.replace(/^--color-/, '');

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

function color(tokens, name, alpha = 1) {
  const value = resolveToken(tokens, name);
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`${name}: "${value}" is not a hex or rgb() colour`);
  return { ...parsed, a: parsed.a * alpha };
}

/**
 * Every surface text can sit on: [{ name, color, layer }], each opaque. `layer`: a base or a
 * panel on it, on which an element's own background (a state or a tint) can be drawn.
 */
export function surfaceStacks(tokens) {
  if (!tokens.has(PAGE)) throw new Error(`${PAGE} (the page colour) is not defined`);
  const page = color(tokens, PAGE);
  if (page.a !== 1) throw new Error(`${PAGE} must be opaque`);
  const names = [...tokens.keys()];
  const bases = names
    .filter(isBase)
    .map((name) => ({ name: short(name), color: over(color(tokens, name), page) }));
  const translucent = names.filter(isTranslucentSurface);
  const panels = translucent.filter((name) => !isState(name));
  const states = translucent.filter(isState);
  const stacks = [];
  for (const base of bases) {
    const under = [base];
    for (const panel of panels) {
      under.push({
        name: `${short(panel)} on ${base.name}`,
        color: over(color(tokens, panel), base.color),
      });
    }
    for (const below of under) stacks.push({ ...below, layer: true });
    for (const state of states) {
      for (const below of under) {
        stacks.push({
          name: `${short(state)} on ${below.name}`,
          color: over(color(tokens, state), below.color),
          layer: false,
        });
      }
    }
  }
  return stacks;
}

/** The string literals of a script ('…', "…" and `…`, a template's ${} parts left out). */
function literals(source) {
  const found = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  return [...source.matchAll(found)].map((match) => ({
    text: (match[1] ?? match[2] ?? match[3]).replace(/\$\{[^}]*\}/g, ' '),
    line: source.slice(0, match.index).split('\n').length,
  }));
}

/**
 * The colour tokens the source draws text with: Map "<token>@<alpha>" → { token, alpha, sites,
 * tints }, where tints are the background colours set in the same class string.
 */
export function textUses(tokens, srcDir) {
  const uses = new Map();
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) continue;
      for (const { text, line } of literals(readFileSync(path, 'utf8'))) {
        const found = [];
        const tints = [];
        for (const candidate of text.split(/\s+/)) {
          const utility = candidate.slice(candidate.lastIndexOf(':') + 1);
          const match = /^(text|placeholder|caret|bg)-([a-z][\w-]*?)(?:\/(\d+))?$/.exec(utility);
          if (!match || !tokens.has(`--color-${match[2]}`)) continue;
          const alpha = match[3] ? Number(match[3]) / 100 : 1;
          (match[1] === 'bg' ? tints : found).push({ token: `--color-${match[2]}`, alpha });
        }
        for (const use of found) {
          const key = `${use.token}@${use.alpha}`;
          if (!uses.has(key)) uses.set(key, { ...use, sites: [], tints: new Map() });
          const entry = uses.get(key);
          entry.sites.push(`${relative(srcDir, path)}:${line}`);
          for (const tint of tints) entry.tints.set(`${tint.token}@${tint.alpha}`, tint);
        }
      }
    }
  };
  if (srcDir) visit(srcDir);
  return uses;
}

const label = ({ token, alpha }) => `${token}${alpha < 1 ? `/${Math.round(alpha * 100)}` : ''}`;

/**
 * Every checked colour with its ratio on each surface (and tint):
 * [{ name, minimum, sites, results: [{ surface, ratio }], lowest, passes }].
 */
export function contrastReport(css, srcDir = null) {
  const tokens = readTokens(css);
  const stacks = surfaceStacks(tokens);
  const checks = new Map();
  const add = (use, minimum, sites = []) => {
    const key = `${use.token}@${use.alpha}`;
    if (!checks.has(key)) {
      checks.set(key, { token: use.token, alpha: use.alpha, minimum, sites: [], tints: new Map() });
    }
    const check = checks.get(key);
    check.minimum = Math.max(check.minimum, minimum);
    check.sites.push(...sites);
    for (const [tintKey, tint] of use.tints ?? []) check.tints.set(tintKey, tint);
  };
  for (const name of tokens.keys()) {
    if (TEXT_FAMILY.test(name) || TEXT_NAMED.has(name))
      add({ token: name, alpha: 1 }, TEXT_MINIMUM);
    else if (isGraphic(name)) add({ token: name, alpha: 1 }, GRAPHIC_MINIMUM);
  }
  for (const use of textUses(tokens, srcDir).values()) {
    if (!(use.token in INVERSE)) add(use, TEXT_MINIMUM, use.sites);
  }
  for (const [role, { text, map }] of Object.entries(ROLES)) {
    if (!text) continue;
    for (const [key, token] of Object.entries(map)) {
      if (tokens.has(token)) add({ token, alpha: 1 }, TEXT_MINIMUM, [`theme.ts ${role}.${key}`]);
    }
  }
  const report = [...checks.values()].map((check) => {
    const foreground = color(tokens, check.token, check.alpha);
    const results = [];
    for (const stack of stacks) {
      // Charts and the graph are drawn on the page or a panel, not on a hover or active state.
      if (check.minimum === GRAPHIC_MINIMUM && !stack.layer) continue;
      results.push({
        surface: stack.name,
        ratio: contrastRatio(over(foreground, stack.color), stack.color),
      });
      if (!stack.layer) continue;
      // An element's own tint takes the place of a state surface: it is drawn on a panel or on
      // the page, not on a hover or active surface.
      for (const tint of check.tints.values()) {
        const behind = over(color(tokens, tint.token, tint.alpha), stack.color);
        results.push({
          surface: `${label(tint).replace(/^--color-/, 'bg-')} on ${stack.name}`,
          ratio: contrastRatio(over(foreground, behind), behind),
        });
      }
    }
    return {
      name: label(check),
      minimum: check.minimum,
      sites: [...new Set(check.sites)],
      results,
    };
  });
  for (const [token, fills] of Object.entries(INVERSE)) {
    const present = fills.filter((fill) => tokens.has(fill));
    if (!tokens.has(token) || present.length === 0) continue;
    const results = present.map((fill) => {
      const behind = color(tokens, fill);
      return {
        surface: short(fill),
        ratio: contrastRatio(over(color(tokens, token), behind), behind),
      };
    });
    report.push({ name: token, minimum: TEXT_MINIMUM, sites: [], results });
  }
  for (const entry of report) {
    entry.lowest = entry.results.reduce((low, result) => (result.ratio < low.ratio ? result : low));
    entry.passes = entry.lowest.ratio >= entry.minimum;
  }
  return report;
}

const ratio = (value) => `${(Math.floor(value * 100) / 100).toFixed(2)}:1`;

/** Runs the check; returns the exit code. */
export function main(args, log = console.log, error = console.error) {
  const files = [];
  let srcDir = SRC_DIR;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--src') {
      i += 1;
      srcDir = args[i] === 'none' ? null : args[i];
    } else files.push(args[i]);
  }
  if (files.length !== 1 || srcDir === undefined) {
    error('usage: contrast.mjs <tokens.css> [--src <dir>|none]');
    return 2;
  }
  let report;
  try {
    report = contrastReport(readFileSync(files[0], 'utf8'), srcDir);
  } catch (problem) {
    error(`contrast: ${problem.message}`);
    return 2;
  }
  if (report.length === 0) {
    error(`contrast: ${files[0]} has no text or data-visualisation colour tokens`);
    return 2;
  }
  const width = Math.max(...report.map((entry) => entry.name.length));
  for (const entry of report) {
    let detail = `lowest ${ratio(entry.lowest.ratio)} on ${entry.lowest.surface}`;
    if (!entry.passes) {
      const failing = entry.results
        .filter((result) => result.ratio < entry.minimum)
        .sort((a, b) => a.ratio - b.ratio);
      const shown = failing
        .slice(0, 3)
        .map((result) => `${ratio(result.ratio)} on ${result.surface}`);
      if (failing.length > 3) shown.push(`and ${failing.length - 3} more`);
      detail = shown.join(', ');
      if (entry.sites.length > 0) detail += `; text at ${entry.sites.slice(0, 3).join(', ')}`;
    }
    const status = entry.passes ? 'ok  ' : 'FAIL';
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

// Runs when executed directly, not when the tests import it. (import.meta.main is undefined
// before Node 24.2, which would turn the build step into a silent no-op there.)
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
