import { describe, expect, it } from 'vitest';
import { LOG_TONES, logStyle } from './logCodes';

describe('logStyle', () => {
  it.each([
    ['NET-200', 'Network'],
    ['AUDIO-INIT', 'Audio'],
    ['AUDIO-COMPLETE', 'Audio'],
    ['SPOTIFY-SEARCH', 'Spotify'],
    ['RESEARCH-START', 'Sources'],
    ['GRAPH-ENRICH', 'Graph'],
    ['SYS-INIT', 'System'],
    ['SYS-READY', 'System'],
  ])('draws %s in the neutral grey, labelled %s', (code, label) => {
    expect(logStyle(code)).toMatchObject({ label, tone: LOG_TONES.neutral });
  });

  it.each(['LLM-CONNECT', 'LLM-RESPONSE', 'GEMINI-CONNECT', 'GEMINI-THOUGHT'])(
    'draws the model step %s in the inferred violet, labelled as a model step',
    (code) => {
      expect(logStyle(code)).toMatchObject({ label: 'Model', tone: 'text-prov-inferred' });
    },
  );

  it.each([
    ['SYS-WARN', 'System warning'],
    ['AUDIO-WARN', 'Audio warning'],
  ])('draws %s in the warning colour, with the word', (code, label) => {
    expect(logStyle(code)).toMatchObject({ label, tone: 'text-status-warning' });
  });

  it.each([
    ['SYS-ERROR', 'System error'],
    ['AUDIO-ERROR', 'Audio error'],
    // A failed model call wrote nothing: it is an error, not something inferred.
    ['LLM-ERROR', 'Model error'],
    ['GEMINI-ERROR', 'Model error'],
  ])('draws %s in the error colour, with the word', (code, label) => {
    expect(logStyle(code)).toMatchObject({ label, tone: 'text-status-error' });
  });

  it('gives each family its own icon', () => {
    const families = ['NET-200', 'AUDIO-INIT', 'LLM-CONNECT', 'SPOTIFY-SEARCH', 'RESEARCH-START'];
    const icons = new Set([...families, 'GRAPH-BUILD', 'SYS-INIT'].map((c) => logStyle(c).Icon));
    expect(icons.size).toBe(7);
    // The model codes old and new share one.
    expect(logStyle('GEMINI-CONNECT').Icon).toBe(logStyle('LLM-CONNECT').Icon);
  });

  it('labels a line without a code as a system line, and an unknown code as other', () => {
    expect(logStyle(undefined)).toMatchObject({ label: 'System', tone: LOG_TONES.neutral });
    expect(logStyle('NEW-CODE-1')).toMatchObject({ label: 'Other', tone: LOG_TONES.neutral });
  });

  it("labels the verifier's model lines as a check, and its other lines by their code", () => {
    expect(logStyle('SYS-INIT', 'verifier')).toMatchObject({
      label: 'System',
      tone: LOG_TONES.neutral,
    });
    expect(logStyle('LLM-RESPONSE', 'verifier')).toMatchObject({
      label: 'Model check',
      tone: LOG_TONES.model,
    });
    expect(logStyle('LLM-RESPONSE', 'verifier').Icon).not.toBe(logStyle('LLM-RESPONSE').Icon);
  });

  it('never uses the measured cyan or the sourced amber', () => {
    for (const tone of Object.values(LOG_TONES)) expect(tone).not.toMatch(/cyber|analog|amber/);
  });
  it.each([
    ['research_manager', 'Sources'],
    ['research_tool', 'Sources'],
    ['scout', 'Spotify'],
    ['engineer', 'Audio'],
    ['composer', 'Model'],
  ])('labels a line without a code from %s by its node: %s', (node, label) => {
    expect(logStyle(undefined, node).label).toBe(label);
  });

  it("labels the app's own lines without a code or a node as system lines", () => {
    expect(logStyle(undefined, undefined)).toMatchObject({
      label: 'System',
      tone: 'text-text-tertiary',
    });
  });

  it('reads a legacy line without a code that starts with a warning sign as a warning', () => {
    expect(logStyle(undefined, 'research_tool', '⚠️ MusicBrainz could not be read')).toMatchObject({
      label: 'Sources warning',
      tone: LOG_TONES.warning,
    });
    expect(logStyle(undefined, 'research_tool', 'Searching musicbrainz').tone).toBe(
      LOG_TONES.neutral,
    );
  });

  it("keeps the family of the verifier's lines that are not checks", () => {
    expect(logStyle('GRAPH-ENRICH', 'verifier')).toMatchObject({
      label: 'Graph',
      tone: LOG_TONES.neutral,
    });
    expect(logStyle('GRAPH-ENRICH', 'verifier').Icon).toBe(logStyle('GRAPH-ENRICH').Icon);
  });

  it('labels the VERIFY codes as checks, whichever node sent them', () => {
    expect(logStyle('VERIFY-START')).toMatchObject({ label: 'Check', tone: LOG_TONES.neutral });
    expect(logStyle('VERIFY-COMPLETE').Icon).toBe(logStyle('LLM-RESPONSE', 'verifier').Icon);
  });

  it.each(['NET-400', 'NET-500'])('draws the failed request %s as a network error', (code) => {
    expect(logStyle(code)).toMatchObject({ label: 'Network error', tone: LOG_TONES.error });
  });
});
