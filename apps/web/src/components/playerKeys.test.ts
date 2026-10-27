import { afterEach, describe, expect, it } from 'vitest';
import { closeOpen, escapeAction, isTextField, openDisclosures, tabKeyTarget } from './playerKeys';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A Player root with a disclosure button, a `<details>`, and a page part outside it. */
function page() {
  document.body.innerHTML = `
    <div id="player">
      <button id="toggle" aria-expanded="false" aria-controls="panel">Sources</button>
      <div id="panel"><a id="inside" href="#">A source</a></div>
      <details id="list"><summary id="summary">Links as a list</summary><a id="item" href="#">x</a></details>
      <input id="text" type="text" />
      <input id="box" type="checkbox" />
      <div id="editable" contenteditable="true"><span id="typed">text</span></div>
    </div>
    <footer><a id="outside" href="#">Source code</a></footer>`;
  const toggle = document.getElementById('toggle') as HTMLButtonElement;
  // The button toggles its own state, as a React disclosure does.
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open));
  });
  return {
    root: document.getElementById('player') as HTMLElement,
    toggle,
    details: document.getElementById('list') as HTMLDetailsElement,
    el: (id: string) => document.getElementById(id) as HTMLElement,
  };
}

/** Puts an element's box `top` px down the window (40 px tall, full width). */
function at(element: Element, top: number) {
  element.getBoundingClientRect = () =>
    ({ top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40 }) as DOMRect;
}

const escapeKey = (target: EventTarget | null, init: Partial<KeyboardEvent> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  isComposing: false,
  target,
  ...init,
});

describe('isTextField', () => {
  it('is true for a field that takes typed text, false for a button or a checkbox', () => {
    const { el } = page();
    expect(isTextField(el('text'))).toBe(true);
    expect(isTextField(el('typed'))).toBe(true);
    expect(isTextField(el('box'))).toBe(false);
    expect(isTextField(el('toggle'))).toBe(false);
    expect(isTextField(null)).toBe(false);
  });
});

describe('escapeAction', () => {
  it('goes back to the summary when nothing is open, from inside the Player or the page body', () => {
    const { root, el } = page();
    expect(escapeAction(escapeKey(el('toggle')), root)).toBe('back');
    expect(escapeAction(escapeKey(document.body), root)).toBe('back');
  });

  it('closes first when a disclosure is open', () => {
    const { root, toggle, details, el } = page();
    at(toggle, 100);
    at(details, 300);
    toggle.setAttribute('aria-expanded', 'true');
    expect(escapeAction(escapeKey(el('inside')), root)).toBe('close');
    toggle.setAttribute('aria-expanded', 'false');
    details.open = true;
    expect(escapeAction(escapeKey(el('item')), root)).toBe('close');
  });

  it('does nothing in a text field, outside the Player, once handled, while composing, or for another key', () => {
    const { root, toggle, el } = page();
    toggle.setAttribute('aria-expanded', 'true');
    expect(escapeAction(escapeKey(el('text')), root)).toBe('none');
    expect(escapeAction(escapeKey(el('typed')), root)).toBe('none');
    expect(escapeAction(escapeKey(el('outside')), root)).toBe('none');
    expect(escapeAction(escapeKey(el('toggle'), { defaultPrevented: true }), root)).toBe('none');
    expect(escapeAction(escapeKey(el('toggle'), { isComposing: true }), root)).toBe('none');
    expect(escapeAction(escapeKey(el('toggle'), { key: 'Enter' }), root)).toBe('none');
  });
});

describe('closeOpen', () => {
  it('closes the disclosure that holds the focus, and gives the focus to its toggle', () => {
    const { root, toggle, details, el } = page();
    toggle.setAttribute('aria-expanded', 'true');
    details.open = true;
    el('inside').focus();
    expect(closeOpen(root, document.activeElement)).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    // The other one stays open; the next Escape closes it.
    expect(details.open).toBe(true);
    el('item').focus();
    expect(closeOpen(root, document.activeElement)).toBe(true);
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(el('summary'));
    expect(closeOpen(root, document.activeElement)).toBe(false);
  });

  it('with the focus in none of them, closes those on screen and leaves the focus where it is', () => {
    const { root, toggle, details, el } = page();
    toggle.setAttribute('aria-expanded', 'true');
    details.open = true;
    at(toggle, 100);
    at(details, 300);
    el('box').focus();
    expect(openDisclosures(root)).toHaveLength(2);
    expect(escapeAction(escapeKey(el('box')), root)).toBe('close');
    expect(closeOpen(root, document.activeElement)).toBe(true);
    expect(openDisclosures(root)).toHaveLength(0);
    expect(document.activeElement).toBe(el('box'));
  });

  it('leaves open what is scrolled out of view, and goes back as when nothing is open', () => {
    const { root, toggle, details, el } = page();
    toggle.setAttribute('aria-expanded', 'true');
    details.open = true;
    // One on screen, one far below it (about 2000 px down).
    at(toggle, 100);
    at(details, 2000);
    expect(closeOpen(root, el('box'))).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(details.open).toBe(true);
    // Only the one out of view is left: Escape goes back, and nothing scrolls to it.
    let scrolled = false;
    details.scrollIntoView = () => {
      scrolled = true;
    };
    expect(escapeAction(escapeKey(el('box')), root)).toBe('back');
    expect(closeOpen(root, el('box'))).toBe(false);
    expect(details.open).toBe(true);
    expect(scrolled).toBe(false);
    // With the focus inside it, it is closed wherever it is.
    expect(escapeAction(escapeKey(el('item')), root)).toBe('close');
  });

  it('leaves alone what is open in a panel that is not shown', () => {
    const { root, toggle } = page();
    toggle.setAttribute('aria-expanded', 'true');
    // A closed phone tab: its panel is not displayed.
    toggle.style.display = 'none';
    expect(openDisclosures(root)).toHaveLength(0);
    expect(escapeAction(escapeKey(document.body), root)).toBe('back');
  });
});

describe('tabKeyTarget', () => {
  it('moves with the arrow keys, wrapping round, and to the ends with Home and End', () => {
    expect(tabKeyTarget('ArrowRight', 0, 3)).toBe(1);
    expect(tabKeyTarget('ArrowRight', 2, 3)).toBe(0);
    expect(tabKeyTarget('ArrowLeft', 0, 3)).toBe(2);
    expect(tabKeyTarget('ArrowLeft', 2, 3)).toBe(1);
    expect(tabKeyTarget('Home', 2, 3)).toBe(0);
    expect(tabKeyTarget('End', 0, 3)).toBe(2);
    expect(tabKeyTarget('Enter', 1, 3)).toBeNull();
    expect(tabKeyTarget('ArrowDown', 1, 3)).toBeNull();
    expect(tabKeyTarget('ArrowRight', 0, 0)).toBeNull();
  });
});
