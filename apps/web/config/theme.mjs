#!/usr/bin/env node
// Writes src/styles/theme.ts from the colour tokens in src/styles/tokens.css, so D3 and Recharts
// draw with the same colours as the CSS:
//
//   node config/theme.mjs                          (npm run theme -w apps/web; runs before build)
//   node config/theme.mjs <tokens.css> <theme.ts>
//
// Every --color-* token becomes a key of `colors`, its var() aliases resolved to the value:
// --color-void-light is colors.voidLight and --color-status-error is colors.error; the gray, viz,
// prov, text, accent and relation families are nested (colors.gray[400], colors.viz.pink,
// colors.prov.measured, colors.relation.cover), and each data-visualisation colour is also exported under its hue
// (colors.pink is colors.viz.pink), the names the charts and the graph use.
//
// It fails, and writes nothing, when a token's var() does not resolve, when a --color-* token is
// not a hex or rgb() colour, or when a stylesheet other than tokens.css declares a token in an
// @theme block (only @keyframes belong there). theme.ts is written only when it changes.
// scripts/check-theme-sync.mjs fails when theme.ts differs from what this writes.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseColor, readTokens, resolveToken, validateTokens } from './tokens.mjs';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = join(web, 'src');
export const TOKENS_PATH = join(SRC_DIR, 'styles', 'tokens.css');
export const THEME_PATH = join(SRC_DIR, 'styles', 'theme.ts');

const NESTED = new Set(['gray', 'viz', 'prov', 'text', 'accent', 'relation']);
const GROUPS = ['status-'];

/**
 * What each chart or graph role is drawn with, by token. `text`: the colour is also used for
 * text, so scripts/contrast.mjs holds it to 4.5:1.
 */
export const ROLES = {
  genealogyColors: {
    doc: 'Genealogy graph: node colours by group.',
    map: {
      current: '--color-cyber',
      origin: '--color-analog',
      default: '--color-gray-500',
    },
  },
  linkColors: {
    doc: 'Genealogy graph: link colours by type (the graph itself uses genealogy/linkStyle.ts).',
    map: {
      sample: '--color-relation-sample',
      interpolation: '--color-relation-interpolation',
      cover: '--color-relation-cover',
      remix: '--color-relation-remix',
      producer: '--color-relation-producer',
      influence: '--color-relation-influence',
      default: '--color-gray-600',
    },
  },
};

const camel = (name) => name.replace(/-(\w)/g, (_, char) => char.toUpperCase());
const property = (key) => (/^[A-Za-z_$][\w$]*$|^\d+$/.test(key) ? key : `'${key}'`);
const quote = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Where a --color-* token is in `colors`: ['voidLight'], ['viz', 'pink'], ['gray', '400']. */
export function colorPath(name) {
  let rest = name.slice('--color-'.length);
  const family = rest.split('-')[0];
  if (NESTED.has(family) && rest !== family) return [family, camel(rest.slice(family.length + 1))];
  const group = GROUPS.find((prefix) => rest.startsWith(prefix));
  if (group) rest = rest.slice(group.length);
  return [camel(rest)];
}

function place(colors, path, value, name) {
  const [key, inner] = path;
  if (inner === undefined) {
    if (Object.hasOwn(colors, key)) {
      throw new Error(`${name}: colors.${key} is already taken by another token`);
    }
    colors[key] = value;
    return;
  }
  if (Object.hasOwn(colors, key) && typeof colors[key] === 'string') {
    throw new Error(`${name}: colors.${key} is a colour, so it cannot also be a family`);
  }
  colors[key] ??= {};
  if (Object.hasOwn(colors[key], inner)) {
    throw new Error(`${name}: colors.${key}.${inner} is already taken by another token`);
  }
  colors[key][inner] = value;
}

/** The `colors` object of a token sheet: { key: value, family: { key: value } }. */
export function themeColors(css) {
  const tokens = readTokens(css);
  validateTokens(tokens);
  const colors = {};
  for (const name of tokens.keys()) {
    if (!name.startsWith('--color-')) continue;
    const value = resolveToken(tokens, name);
    if (!parseColor(value)) throw new Error(`${name}: "${value}" is not a hex or rgb() colour`);
    const path = colorPath(name);
    place(colors, path, value, name);
    if (path[0] === 'viz') place(colors, [path[1]], value, name);
  }
  return colors;
}

/**
 * Stylesheets under a source directory, other than its styles/tokens.css, that declare custom
 * properties in an @theme block, as "<file>: --a, --b". Tokens belong in tokens.css alone, where
 * the generator, the contrast check and the guard read them.
 */
export function strayThemeTokens(dir = SRC_DIR) {
  const tokensPath = join(dir, 'styles', 'tokens.css');
  const stray = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.css') && path !== tokensPath) {
        const names = [...readTokens(readFileSync(path, 'utf8')).keys()];
        if (names.length > 0) stray.push(`${relative(dir, path)}: ${names.join(', ')}`);
      }
    }
  };
  visit(dir);
  return stray;
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
  const tokens = readTokens(css);
  for (const [name, { doc, map }] of Object.entries(ROLES)) {
    lines.push('', `/** ${doc} */`, `export const ${name} = {`);
    for (const [role, token] of Object.entries(map)) {
      if (!tokens.has(token)) throw new Error(`${name}.${role}: ${token} is not a token`);
      const [key, inner] = colorPath(token);
      let expression = `colors.${key}`;
      if (inner !== undefined) expression += /^\d+$/.test(inner) ? `[${inner}]` : `.${inner}`;
      lines.push(`  ${property(role)}: ${expression},`);
    }
    lines.push('} as const;');
  }
  return `${lines.join('\n')}\n`;
}

// Runs when executed directly, not when the tests import it. (import.meta.main is undefined
// before Node 24.2, which would turn the build step into a silent no-op there.)
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const [tokensPath = TOKENS_PATH, themePath = THEME_PATH] = process.argv.slice(2);
  try {
    const stray = strayThemeTokens();
    if (stray.length > 0) {
      throw new Error(
        `tokens declared outside tokens.css (an @theme block elsewhere may hold @keyframes only):\n  ${stray.join('\n  ')}`,
      );
    }
    const theme = generateTheme(readFileSync(tokensPath, 'utf8'));
    const current = existsSync(themePath) ? readFileSync(themePath, 'utf8') : null;
    if (current !== theme) writeFileSync(themePath, theme);
  } catch (error) {
    console.error(`theme: ${error.message}`);
    process.exit(1);
  }
}
