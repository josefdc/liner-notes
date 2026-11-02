/** The id of the page's main landmark, the skip link's target. */
export const MAIN_CONTENT_ID = 'main-content';

/**
 * Whether the focus at `target` is on the page as a whole rather than on a control: the body,
 * the root element, the document, or the main landmark. The skip link makes the main landmark
 * focusable while it is followed, and a click on words inside it keeps the focus there, so to
 * the keys that act when nothing is focused (Escape) it counts as the page.
 */
export function isPageFocus(target: EventTarget | null | undefined): boolean {
  if (!target) return false;
  // By node type, not `instanceof`: a node of another window (a frame) counts the same.
  const node = target as Partial<Node>;
  if (node.nodeType === 9) return true;
  if (node.nodeType !== 1) return false;
  const element = target as Element;
  const doc = element.ownerDocument;
  return element === doc.body || element === doc.documentElement || element.id === MAIN_CONTENT_ID;
}
