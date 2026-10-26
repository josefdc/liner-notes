// Reads the class strings a script can put on an element, with the TypeScript parser: every
// string literal and template part outside comments, a JSX attribute over several lines, a
// quoted class inside a template's ${…}, and the classes a conditional or a class-joining call
// (cn, clsx, …) adds to the same element. Used by contrast.mjs to find the colours text is
// drawn with.

import ts from 'typescript';

/** Calls whose arguments are joined into one class string. */
const CLASS_FUNCTIONS = new Set(['cn', 'clsx', 'classNames', 'cx', 'twMerge', 'twJoin']);
/** Past this many combinations, the parts of an expression are read one at a time. */
const MAX_VARIANTS = 256;

const scriptKind = (path) => {
  if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
};

const isString = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const isClassCall = (node) =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  CLASS_FUNCTIONS.has(node.expression.text);

/** Whether `node` is joined into the class string its parent builds. */
function joinsParent(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    ts.isParenthesizedExpression(parent) ||
    ts.isTemplateSpan(parent) ||
    ts.isTemplateExpression(parent) ||
    ts.isJsxExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isSatisfiesExpression(parent) ||
    ts.isArrayLiteralExpression(parent)
  ) {
    return !ts.isJsxExpression(parent) || ts.isJsxAttribute(parent.parent);
  }
  if (ts.isConditionalExpression(parent)) return node !== parent.condition;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return node === parent.right;
    return (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.PlusToken
    );
  }
  return isClassCall(parent) && parent.arguments.includes(node);
}

const product = (left, right) => {
  const out = [];
  for (const a of left) for (const b of right) out.push(`${a} ${b}`);
  return out;
};

/** The class strings an expression can produce; '' for a part it cannot read (a variable). */
function variants(node) {
  if (isString(node)) return [node.text];
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) {
      out = product(product(out, variants(span.expression)), [span.literal.text]);
    }
    return out;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isJsxExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return node.expression ? variants(node.expression) : [''];
  }
  if (ts.isConditionalExpression(node)) {
    return [...variants(node.whenTrue), ...variants(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return [...variants(node.right), ''];
    if (
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.QuestionQuestionToken
    ) {
      return [...variants(node.left), ...variants(node.right)];
    }
    if (operator === ts.SyntaxKind.PlusToken) {
      return product(variants(node.left), variants(node.right));
    }
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.reduce((out, element) => product(out, variants(element)), ['']);
  }
  if (isClassCall(node)) {
    return node.arguments.reduce((out, argument) => product(out, variants(argument)), ['']);
  }
  return [''];
}

/** Every string literal and template part under a node. */
function pieces(node, out = []) {
  if (isString(node)) out.push(node.text);
  else if (ts.isTemplateExpression(node)) {
    out.push(node.head.text);
    for (const span of node.templateSpans) out.push(span.literal.text);
  }
  ts.forEachChild(node, (child) => pieces(child, out));
  return out;
}

/**
 * The class strings of a script: [{ text, line }], one per way each expression can come out
 * (a conditional's branches apart, a class-joining call's arguments together), with the line it
 * starts on.
 */
export function classStrings(source, path = 'file.tsx') {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind(path));
  const roots = new Set();
  const visit = (node) => {
    if (isString(node) || ts.isTemplateExpression(node)) {
      let root = node;
      while (joinsParent(root)) root = root.parent;
      roots.add(root);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const out = [];
  for (const root of roots) {
    const line = file.getLineAndCharacterOfPosition(root.getStart(file)).line + 1;
    let texts = variants(root);
    if (texts.length > MAX_VARIANTS) texts = pieces(root);
    for (const text of new Set(texts)) if (text.trim()) out.push({ text, line });
  }
  return out;
}
