// Reads design tokens from a stylesheet: the custom properties declared directly inside its
// `@theme` blocks (nested rules such as @keyframes are skipped), with `var()` references resolved.
// Shared by theme.mjs (writes styles/theme.ts) and contrast.mjs (checks text contrast). It lives
// under apps/web/ because the web image's build context holds apps/web and not scripts/.

/** The custom properties declared at the top level of every `@theme` block, in order. */
export function readTokens(css) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Map();
  const theme = /@theme\b[^{;]*\{/g;
  for (let match = theme.exec(source); match; match = theme.exec(source)) {
    let depth = 0;
    let statement = '';
    let i = match.index + match[0].length;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === '{') {
        depth += 1;
        statement = '';
      } else if (char === '}') {
        if (depth === 0) break;
        depth -= 1;
        statement = '';
      } else if (depth > 0) {
        // inside a nested rule
      } else if (char === ';') {
        addDeclaration(tokens, statement);
        statement = '';
      } else {
        statement += char;
      }
    }
    addDeclaration(tokens, statement);
    theme.lastIndex = i;
  }
  return tokens;
}

function addDeclaration(tokens, statement) {
  const declaration = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(statement);
  if (!declaration) return;
  tokens.set(declaration[1], declaration[2].trim().replace(/\s+/g, ' '));
}

/** A token's value with every `var(--x)` / `var(--x, fallback)` replaced by what it points at. */
export function resolveToken(tokens, name, seen = []) {
  if (seen.includes(name)) throw new Error(`${[...seen, name].join(' -> ')}: circular reference`);
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`${name} is not defined`);
  return resolveValue(tokens, value, [...seen, name]);
}

function resolveValue(tokens, value, seen) {
  let out = '';
  let rest = value;
  for (let start = rest.search(/var\(/); start !== -1; start = rest.search(/var\(/)) {
    // The arguments of this var(), up to its closing parenthesis.
    let depth = 0;
    let end = start + 4;
    let comma = -1;
    for (; end < rest.length; end += 1) {
      if (rest[end] === '(') depth += 1;
      else if (rest[end] === ')' && depth === 0) break;
      else if (rest[end] === ')') depth -= 1;
      else if (rest[end] === ',' && depth === 0 && comma === -1) comma = end;
    }
    if (end === rest.length) throw new Error(`"${value}": unclosed var()`);
    const name = rest.slice(start + 4, comma === -1 ? end : comma).trim();
    const fallback = comma === -1 ? undefined : rest.slice(comma + 1, end).trim();
    out += rest.slice(0, start);
    out +=
      !tokens.has(name) && fallback !== undefined
        ? resolveValue(tokens, fallback, seen)
        : resolveToken(tokens, name, seen);
    rest = rest.slice(end + 1);
  }
  return out + rest;
}

/** An sRGB colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`), else null. */
export function parseColor(value) {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
    const channels = digits.match(/../g).map((pair) => Number.parseInt(pair, 16));
    return { r: channels[0], g: channels[1], b: channels[2], a: (channels[3] ?? 255) / 255 };
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(text);
  if (!fn) return null;
  const parts = fn[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const number = (part, scale) => {
    if (!/^\d*\.?\d+%?$/.test(part)) return Number.NaN;
    return part.endsWith('%') ? (Number.parseFloat(part) / 100) * scale : Number.parseFloat(part);
  };
  const [r, g, b] = parts.slice(0, 3).map((part) => number(part, 255));
  const a = parts[3] === undefined ? 1 : number(parts[3], 1);
  if (![r, g, b, a].every(Number.isFinite) || r > 255 || g > 255 || b > 255 || a > 1) return null;
  return { r, g, b, a };
}
