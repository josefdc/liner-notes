import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { type ProvenanceKind, PROVENANCE_TEXT, ProvenanceChip } from './ProvenanceChip';
import { SourceNote } from './SourceNote';
import { evidence } from './testing';

afterEach(cleanup);

const chip = (kind: ProvenanceKind, words?: string) => {
  const { container } = render(<ProvenanceChip kind={kind}>{words}</ProvenanceChip>);
  return container.firstElementChild as HTMLElement;
};

describe('ProvenanceChip', () => {
  it('says each kind in words with an icon, never by colour alone', () => {
    const shown = (Object.keys(PROVENANCE_TEXT) as ProvenanceKind[]).map((kind) => {
      const element = chip(kind);
      const icon = element.querySelector('svg');
      const result = {
        kind: element.dataset.provenance,
        text: element.textContent,
        icon: icon?.closest('[aria-hidden="true"]') !== null,
        variant: element.dataset.variant,
      };
      cleanup();
      return result;
    });
    expect(shown).toEqual([
      { kind: 'measured', text: 'Measured', icon: true, variant: 'measured' },
      { kind: 'sourced', text: 'Sourced', icon: true, variant: 'sourced' },
      { kind: 'inferred', text: 'Model inference', icon: true, variant: 'inferred' },
      { kind: 'unconfirmed', text: 'Not confirmed', icon: true, variant: 'neutral' },
      { kind: 'missing', text: 'Missing', icon: true, variant: 'neutral' },
    ]);
  });

  it('gives each kind its own icon', () => {
    const icons = (Object.keys(PROVENANCE_TEXT) as ProvenanceKind[]).map((kind) => {
      const name = chip(kind).querySelector('svg')?.getAttribute('class');
      cleanup();
      return name;
    });
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('takes words of its own, keeping the colour and icon of its kind', () => {
    const element = chip('inferred', 'Model estimate');
    expect(element.textContent).toBe('Model estimate');
    expect(element.className).toContain('text-prov-inferred');
  });

  it('opens and closes what it summarises when it is a disclosure', () => {
    const Disclosure = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ProvenanceChip
            kind="measured"
            disclosure={{
              expanded: open,
              controls: 'lines',
              onToggle: () => setOpen((value) => !value),
              label: 'Measured: how BPM was obtained',
            }}
          />
          <p id="lines" hidden={!open}>
            the lines
          </p>
        </>
      );
    };
    render(<Disclosure />);
    const button = screen.getByRole('button', { name: 'Measured: how BPM was obtained' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('lines');
    expect(button.getAttribute('type')).toBe('button');
    // A focus ring the keyboard can see: solid white, offset from the chip.
    expect(button.className).toContain('focus-visible:ring-white');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById('lines')?.hidden).toBe(false);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('SourceNote', () => {
  it('names the source, links it, and says the day it was retrieved', () => {
    const { container } = render(<SourceNote evidence={evidence()} />);
    expect(container.textContent).toBe(
      'MusicBrainz · primary record — Some Recording, opens in a new tab· retrieved 20 Oct 2026',
    );
    expect(screen.getByRole('link').getAttribute('href')).toBe(
      'https://musicbrainz.org/recording/1',
    );
    expect(container.querySelector('time')?.getAttribute('dateTime')).toBe(
      '2026-10-20T12:00:00.000Z',
    );
  });

  it('leaves out a retrieval time it cannot read, instead of guessing one', () => {
    const { container } = render(<SourceNote evidence={evidence({ retrievedAt: 'soon' })} />);
    expect(container.textContent).not.toContain('retrieved');
  });
});
