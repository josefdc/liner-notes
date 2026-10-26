#!/usr/bin/env node
// Checks the WCAG contrast of the design tokens (scripts/contrast.mjs runs this too):
//
//   node config/contrast.mjs src/styles/tokens.css [--src <dir>]     (--src default: apps/web/src)
//
// Text colours reach 4.5:1 (AA for body text) on every surface. A colour is text when
// - its name says so: --color-text-*, --color-prov-*, --color-status-*, --color-accent-*,
//   cyber, analog, spotify and white; or
// - the app draws text with it: a text-*, placeholder-* or caret-* class in the source names it,
//   or a chart role that colours text (ROLES in theme.mjs with `text`). Classes are read with the
//   TypeScript parser (classes.mjs): every string and template part outside comments, a quoted
//   class inside ${…}, each branch of a conditional on its own, a class-joining call's arguments
//   together. A colour is checked at the class's opacity (text-cyber/60, /[0.6]) times the
//   element's own opacity-* class.
// A class string that also sets a background tint (`text-accent-pink hover:bg-accent-pink/20`)
// has its text checked on that tint too, over every surface. Dark text on a light fill
// (INVERSE) is checked on that fill instead. A text class naming Tailwind's default palette
// (text-red-900) fails: it is not a token. Data-visualisation colours (--color-viz-*) reach
// 3:1 (AA for graphics) on the page and on panels. KNOWN lists failures whose fix is planned.
//
// Not seen: opacity or a background set on an ancestor element, a colour inherited from one,
// inline styles, and classes built from variables (`text-${tone}`).
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
import { classStrings } from './classes.mjs';
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
/**
 * Text below 4.5:1 whose fix is planned elsewhere: { name (as reported), file (under src), issue }.
 * Only the app's own source is matched against it.
 */
export const KNOWN = [];
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

/** Tailwind's default palette, which the app's tokens replace: such a class is not checked. */
const DEFAULT_PALETTE =
  /^(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-(50|[1-9]00|950)$/;

/** An opacity modifier or value: 40, [0.4] or [40%] → 0.4; null when there is none. */
function amount(value) {
  if (value === undefined) return null;
  const arbitrary = /^\[(\d*\.?\d+)(%?)\]$/.exec(value);
  if (arbitrary) return Number(arbitrary[1]) / (arbitrary[2] ? 100 : 1);
  return /^\d+$/.test(value) ? Number(value) / 100 : Number.NaN;
}

/**
 * What one class string draws text with: { texts, tints, offPalette }. Each text colour is at its
 * class's opacity times the element's own `opacity-*` (at rest; for an element hidden at rest,
 * `opacity-0`, as shown by its state classes). `!` (important) is ignored.
 */
export function readClasses(text, tokens) {
  const texts = [];
  const tints = [];
  const offPalette = [];
  let rest = null;
  let shown = null;
  for (const raw of text.split(/\s+/)) {
    if (!raw) continue;
    const colon = raw.lastIndexOf(':');
    const prefix = colon === -1 ? '' : raw.slice(0, colon);
    const utility = raw.slice(colon + 1).replace(/^!|!$/g, '');
    const opacity = /^opacity-(\d+|\[[^\]]+\])$/.exec(utility);
    if (opacity) {
      const value = amount(opacity[1]);
      if (prefix) shown = Math.max(shown ?? 0, value);
      else rest = value;
      continue;
    }
    const match = /^(text|placeholder|caret|bg)-([a-z][\w-]*?)(?:\/(\d+|\[[^\]]+\]))?$/.exec(
      utility,
    );
    if (!match) continue;
    const token = `--color-${match[2]}`;
    if (!tokens.has(token)) {
      if (match[1] !== 'bg' && DEFAULT_PALETTE.test(match[2])) offPalette.push(raw);
      continue;
    }
    const alpha = amount(match[3]) ?? 1;
    (match[1] === 'bg' ? tints : texts).push({ token, alpha });
  }
  const element = rest === null ? 1 : rest === 0 ? (shown ?? 1) : rest;
  for (const use of texts) use.alpha = Math.round(use.alpha * element * 1000) / 1000;
  return { texts, tints, offPalette };
}

/**
 * What the source draws text with: { uses, offPalette }. uses: Map "<token>@<alpha>" → { token,
 * alpha, sites, tints }, where tints are the background colours set in the same class string.
 * offPalette: [{ cls, site }], text classes naming a colour of Tailwind's default palette instead
 * of a token.
 */
export function textUses(tokens, srcDir) {
  const uses = new Map();
  const offPalette = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(test|spec)\./.test(entry.name)) continue;
      for (const { text, line } of classStrings(readFileSync(path, 'utf8'), path)) {
        const site = `${relative(srcDir, path)}:${line}`;
        const read = readClasses(text, tokens);
        for (const cls of read.offPalette) offPalette.push({ cls, site });
        for (const use of read.texts) {
          const key = `${use.token}@${use.alpha}`;
          if (!uses.has(key)) uses.set(key, { ...use, sites: [], tints: new Map() });
          const found = uses.get(key);
          if (!found.sites.includes(site)) found.sites.push(site);
          for (const tint of read.tints) found.tints.set(`${tint.token}@${tint.alpha}`, tint);
        }
      }
    }
  };
  if (srcDir) visit(srcDir);
  return { uses, offPalette };
}

const label = ({ token, alpha }) => `${token}${alpha < 1 ? `/${Math.round(alpha * 100)}` : ''}`;

/**
 * Every checked colour with its ratio on each surface (and tint):
 * [{ name, minimum, sites, results: [{ surface, ratio }], lowest, passes }].
 */
export function contrastReport(css, srcDir = null, known = srcDir === SRC_DIR ? KNOWN : []) {
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
  const { uses, offPalette } = textUses(tokens, srcDir);
  for (const use of uses.values()) {
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
  // A default-palette colour is not a design token: nothing says which surfaces it was chosen for.
  for (const { cls, site } of offPalette) {
    report.push({
      name: cls,
      minimum: TEXT_MINIMUM,
      sites: [site],
      results: [{ surface: 'nothing: not a design token (use a --color-* token)', ratio: 0 }],
    });
  }
  for (const entry of report) {
    entry.lowest = entry.results.reduce((low, result) => (result.ratio < low.ratio ? result : low));
    entry.passes = entry.lowest.ratio >= entry.minimum;
  }
  // Known failures, each with the issue that fixes it: reported, not failed, as long as every
  // site of the colour is a listed one. A listed one that no longer fails fails, so the list
  // only shrinks.
  const matched = new Set();
  for (const entry of report) {
    if (entry.passes || entry.sites.length === 0) continue;
    const listed = entry.sites.map((site) =>
      known.find((item) => item.name === entry.name && site.startsWith(`${item.file}:`)),
    );
    if (listed.every(Boolean)) {
      entry.known = [...new Set(listed.map((item) => item.issue))].join('; ');
      for (const item of listed) matched.add(item);
    }
  }
  for (const item of known) {
    if (matched.has(item)) continue;
    report.push({
      name: item.name,
      minimum: TEXT_MINIMUM,
      sites: [item.file],
      results: [{ surface: 'nothing: listed as known but it no longer fails here', ratio: 0 }],
      lowest: { surface: 'nothing: listed as known but it no longer fails here', ratio: 0 },
      passes: false,
    });
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
    if (entry.known) detail += ` [known: ${entry.known}]`;
    const status = entry.passes ? 'ok  ' : entry.known ? 'KNOWN' : 'FAIL';
    log(`${status} ${entry.name.padEnd(width)}  needs ${entry.minimum}:1  ${detail}`);
  }
  const failures = report.filter((entry) => !entry.passes && !entry.known).length;
  const known = report.filter((entry) => entry.known).length;
  const also = known > 0 ? ` (${known} known, listed in KNOWN with the issue that fixes it)` : '';
  if (failures > 0) {
    error(`contrast: ${failures} of ${report.length} colours fall short on some surface${also}`);
    return 1;
  }
  log(`contrast: all ${report.length - known} other colours pass on every surface${also}`);
  return 0;
}

// Runs when executed directly, not when the tests import it. (import.meta.main is undefined
// before Node 24.2, which would turn the build step into a silent no-op there.)
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
