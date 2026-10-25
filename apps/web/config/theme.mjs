#!/usr/bin/env node
// Writes src/styles/theme.ts from the colour tokens in src/styles/tokens.css, so D3 and Recharts
// draw with the same colours as the CSS:
//
//   node config/theme.mjs                          (npm run theme -w apps/web; runs before build)
//   node config/theme.mjs <tokens.css> <theme.ts>
//
// Every --color-* token becomes a key of `colors`, its var() aliases resolved to the value:
// --color-void-light is colors.voidLight, --color-accent-pink and --color-status-error drop their
// group (colors.pink, colors.error), and the gray, viz, prov and text families are nested
// (colors.gray[400], colors.viz.pink, colors.prov.measured, colors.text.tertiary).
// scripts/check-theme-sync.mjs fails when theme.ts differs from what this writes.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseColor, readTokens, resolveToken } from './tokens.mjs';

const styles = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles');
export const TOKENS_PATH = join(styles, 'tokens.css');
export const THEME_PATH = join(styles, 'theme.ts');

const NESTED = new Set(['gray', 'viz', 'prov', 'text']);
const GROUPS = ['accent-', 'status-'];

/** What each chart or graph role is drawn with, as a key of `colors` ("gray.500" for nested). */
const ROLES = {
  genealogyColors: {
    doc: 'Genealogy graph: node colours by group.',
    map: {
      current: 'cyber',
      origin: 'analog',
      sampler: 'purple',
      influence: 'green',
      default: 'gray.500',
    },
  },
  linkColors: {
    doc: 'Genealogy graph: link colours by type (the graph itself uses genealogy/linkStyle.ts).',
    map: {
      sample: 'analog',
      cover: 'purple',
      remix: 'pink',
      influence: 'gray.600',
      default: 'gray.600',
    },
  },
  keyMomentColors: {
    doc: 'SmartTimeline: key moment marker colours.',
    map: {
      energy_peak: 'cyber',
      energy_drop: 'pink',
      onset: 'indigo',
      harmonic_change: 'analog',
      silence: 'gray.500',
    },
  },
};

const camel = (name) => name.replace(/-(\w)/g, (_, char) => char.toUpperCase());
const property = (key) => (/^[A-Za-z_$][\w$]*$|^\d+$/.test(key) ? key : `'${key}'`);
const quote = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The `colors` object of a token sheet: { key: value, family: { key: value } }. */
export function themeColors(css) {
  const tokens = readTokens(css);
  const colors = {};
  for (const name of tokens.keys()) {
    if (!name.startsWith('--color-')) continue;
    const value = resolveToken(tokens, name);
    if (!parseColor(value)) throw new Error(`${name}: "${value}" is not a hex or rgb() colour`);
    let rest = name.slice('--color-'.length);
    const family = rest.split('-')[0];
    let target = colors;
    if (NESTED.has(family) && rest !== family) {
      colors[family] ??= {};
      target = colors[family];
      rest = rest.slice(family.length + 1);
    } else {
      const group = GROUPS.find((prefix) => rest.startsWith(prefix));
      if (group) rest = rest.slice(group.length);
    }
    const key = camel(rest);
    if (key in target) throw new Error(`${name}: colors key "${key}" is already taken`);
    target[key] = value;
  }
  return colors;
}

/** The text of theme.ts for a token sheet. */
export function generateTheme(css) {
  const colors = themeColors(css);
  const lines = [
    '// Generated from tokens.css by apps/web/config/theme.mjs. Do not edit: change tokens.css',
    '// and run `npm run theme -w apps/web` (every web build runs it too).',
    '//',
    '// The design tokens as values, for code that cannot use a CSS variable (D3, Recharts).',
    '',
    '/** Every --color-* token, aliases resolved (--color-void-light is colors.voidLight). */',
    'export const colors = {',
  ];
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      lines.push(`  ${property(key)}: ${quote(value)},`);
      continue;
    }
    lines.push(`  ${property(key)}: {`);
    for (const [inner, color] of Object.entries(value)) {
      lines.push(`    ${property(inner)}: ${quote(color)},`);
    }
    lines.push('  },');
  }
  lines.push('} as const;');
  for (const [name, { doc, map }] of Object.entries(ROLES)) {
    lines.push('', `/** ${doc} */`, `export const ${name} = {`);
    for (const [role, ref] of Object.entries(map)) {
      const [key, inner] = ref.split('.');
      const color = inner === undefined ? colors[key] : colors[key]?.[inner];
      if (typeof color !== 'string') throw new Error(`${name}.${role}: no colour colors.${ref}`);
      let expression = `colors.${key}`;
      if (inner !== undefined) expression += /^\d+$/.test(inner) ? `[${inner}]` : `.${inner}`;
      lines.push(`  ${property(role)}: ${expression},`);
    }
    lines.push('} as const;');
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  const [tokensPath = TOKENS_PATH, themePath = THEME_PATH] = process.argv.slice(2);
  try {
    writeFileSync(themePath, generateTheme(readFileSync(tokensPath, 'utf8')));
  } catch (error) {
    console.error(`theme: ${error.message}`);
    process.exit(1);
  }
}
