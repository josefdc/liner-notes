// Reads design tokens from a stylesheet: the custom properties declared directly inside its
// `@theme` blocks (nested rules such as @keyframes are skipped), with `var()` references resolved.
// Shared by theme.mjs (writes styles/theme.ts) and contrast.mjs (checks text contrast). It lives
// under apps/web/ because the web image's build context holds apps/web and not scripts/.

/**
 * The custom properties declared at the top level of every `@theme` block, in order. Comments,
 * quoted strings and parentheses (url(), var()) are read as such, so a `;`, `{` or `}` inside
 * them does not end a declaration or a block. Throws on an unclosed comment, string or block.
 */
export function readTokens(css) {
  const tokens = new Map();
  const stack = []; // 'theme' | 'nested' | 'other', one per open block
  let text = ''; // the prelude or declaration being read, whitespace collapsed outside strings
  let quote = null;
  let parens = 0;
  const flush = () => {
    if (stack.at(-1) === 'theme') addDeclaration(tokens, text);
    text = '';
  };
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    if (quote) {
      text += char;
      if (char === '\\') text += css[++i] ?? '';
      else if (char === quote) quote = null;
      else if (char === '\n') throw new Error(`unclosed string at offset ${i}`);
      continue;
    }
    if (char === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      if (close === -1) throw new Error(`unclosed comment at offset ${i}`);
      i = close + 1;
      if (!text.endsWith(' ')) text += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      text += char;
    } else if (char === '(') {
      parens += 1;
      text += char;
    } else if (char === ')') {
      parens = Math.max(0, parens - 1);
      text += char;
    } else if (parens > 0) {
      text += /\s/.test(char) ? (text.endsWith(' ') ? '' : ' ') : char;
    } else if (char === ';') {
      flush();
    } else if (char === '{') {
      const parent = stack.at(-1);
      const theme = /^\s*@theme\b/.test(text) && parent !== 'theme' && parent !== 'nested';
      stack.push(theme ? 'theme' : parent === 'theme' || parent === 'nested' ? 'nested' : 'other');
      text = '';
    } else if (char === '}') {
      if (stack.length === 0) throw new Error(`unmatched "}" at offset ${i}`);
      flush();
      stack.pop();
    } else {
      text += /\s/.test(char) ? (text.endsWith(' ') ? '' : ' ') : char;
    }
  }
  if (quote) throw new Error('unclosed string at the end of the sheet');
  if (stack.length > 0)
    throw new Error(`${stack.length} block(s) not closed at the end of the sheet`);
  return tokens;
}

function addDeclaration(tokens, statement) {
  const declaration = /^\s*(--[\w-]+)\s*:([\s\S]*)$/.exec(statement);
  if (!declaration) return;
  tokens.set(declaration[1], declaration[2].trim());
}

/** Throws, naming each one, when a token's var() points at a token that is not defined. */
export function validateTokens(tokens) {
  const problems = [];
  for (const name of tokens.keys()) {
    try {
      resolveToken(tokens, name);
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }
  if (problems.length > 0)
    throw new Error(`tokens that do not resolve:\n  ${problems.join('\n  ')}`);
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
