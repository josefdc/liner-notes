// The Player's keys: Escape, scoped to the Player, and the arrow, Home and End keys of its phone
// tabs (the WAI-ARIA tabs pattern).
//
// Escape first closes what is open in the Player (a disclosure such as a claim's sources or the
// rejected claims, a list over the graph), and leaves for the summary only when nothing is open.
// It does nothing while the focus is in a text field (Escape belongs to the field there), nor
// when the focus is outside the Player (the page footer, another part of the page), nor when
// something inside handled it already (`defaultPrevented`: the graph hiding its detail box).

/** The input types whose Escape is the browser's or the field's own: every text-like input. */
const NOT_TEXT_INPUTS: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** True for an element that takes typed text: a text input, a textarea, a select, or editable. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TEXT_INPUTS.has((target as HTMLInputElement).type);
  const editable = target.closest('[contenteditable]');
  return editable !== null && editable.getAttribute('contenteditable') !== 'false';
}

/** What is open in the Player and can be closed: expanded disclosures and open `<details>`. */
const OPEN = 'button[aria-expanded="true"], details[open]';

/** Whether an element is shown (not inside a closed phone tab, a hidden panel). */
function isShown(element: Element): boolean {
  return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true;
}

/** The disclosures open and shown in `root`, in the page's order. */
export function openDisclosures(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(OPEN)].filter(isShown);
}

/** The element a disclosure's toggle controls (aria-controls), if any. */
function controlled(toggle: HTMLElement): HTMLElement | null {
  const id = toggle.getAttribute('aria-controls');
  return id ? toggle.ownerDocument.getElementById(id) : null;
}

/** Whether the focus is on a disclosure, its toggle or inside what it shows. */
function holdsFocus(disclosure: HTMLElement, active: Element | null): boolean {
  if (!active) return false;
  if (disclosure.contains(active)) return true;
  return controlled(disclosure)?.contains(active) ?? false;
}

/** Closes one disclosure; the focus, when it was inside, goes to its toggle (never the page). */
function close(disclosure: HTMLElement, active: Element | null) {
  const hadFocus = holdsFocus(disclosure, active);
  if (disclosure instanceof HTMLDetailsElement) {
    disclosure.open = false;
    if (hadFocus) disclosure.querySelector<HTMLElement>(':scope > summary')?.focus();
    return;
  }
  if (hadFocus) disclosure.focus();
  disclosure.click();
}

/** A disclosure's toggle: the `<summary>` of a `<details>`, or the button itself. */
function toggleOf(disclosure: HTMLElement): HTMLElement | null {
  return disclosure instanceof HTMLDetailsElement
    ? disclosure.querySelector<HTMLElement>(':scope > summary')
    : disclosure;
}

/**
 * Closes what is open in `root`: the innermost disclosure that holds the focus, else every one
 * shown. In that second case what closed may be out of view (scrolled away): the focus goes to
 * the first one's toggle, brought into view, so the key's effect is seen and the reader is where
 * it happened. Returns false when nothing was open.
 */
export function closeOpen(root: Element, active: Element | null): boolean {
  const open = openDisclosures(root);
  if (open.length === 0) return false;
  const around = open.filter((disclosure) => holdsFocus(disclosure, active));
  // In the page's order an inner disclosure comes after the one it is in.
  if (around.length > 0) {
    close(around[around.length - 1], active);
    return true;
  }
  for (const disclosure of open) close(disclosure, active);
  const toggle = toggleOf(open[0]);
  if (toggle) {
    toggle.focus({ preventScroll: true });
    toggle.scrollIntoView?.({ block: 'nearest' });
  }
  return true;
}

export type EscapeAction = 'none' | 'close' | 'back';

/**
 * What Escape does in the Player, for a keydown whose target is `target`: nothing in a text
 * field or outside the Player (`root`); close what is open; else go back to the summary. With the
 * focus on no element (the page's body) the key is the Player's: it fills the page.
 */
export function escapeAction(
  event: Pick<KeyboardEvent, 'key' | 'defaultPrevented' | 'isComposing' | 'target'>,
  root: Element,
): EscapeAction {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return 'none';
  const { target } = event;
  if (isTextField(target)) return 'none';
  const doc = root.ownerDocument;
  const onPage = target === doc.body || target === doc.documentElement || target === doc;
  if (!onPage && !(target instanceof Node && root.contains(target))) return 'none';
  return openDisclosures(root).length > 0 ? 'close' : 'back';
}

/**
 * The tab a key moves to in a tab list of `count` tabs from tab `index`: the next or previous one
 * with the arrow keys (wrapping round), the first with Home and the last with End; null for any
 * other key.
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
