import { afterEach, describe, expect, it } from 'vitest';
import { isPageFocus } from './pageFocus';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isPageFocus', () => {
  it('is the page: the body, the root element, the document and the main landmark', () => {
    document.body.innerHTML =
      '<main id="main-content"><p id="words">Words</p><button id="b">B</button></main>';
    expect(isPageFocus(document.body)).toBe(true);
    expect(isPageFocus(document.documentElement)).toBe(true);
    expect(isPageFocus(document)).toBe(true);
    expect(isPageFocus(document.getElementById('main-content'))).toBe(true);
  });

  it('is not a control, an element inside main, or nothing', () => {
    document.body.innerHTML =
      '<main id="main-content"><p id="words">Words</p><button id="b">B</button></main>';
    expect(isPageFocus(document.getElementById('b'))).toBe(false);
    expect(isPageFocus(document.getElementById('words'))).toBe(false);
    expect(isPageFocus(null)).toBe(false);
    expect(isPageFocus(window)).toBe(false);
  });
});
