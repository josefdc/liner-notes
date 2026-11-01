import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { colors } from '../styles/theme';
import type { TrackData } from '../types';
import Dashboard from './Dashboard';
import Player from './Player';

afterEach(cleanup);

// A complete result; each case below removes one list or object the views read.
const complete = (): Record<string, unknown> => ({
  id: 't1',
  title: 'Partial Song',
  artist: 'Test Artist',
  album: 'Test Album',
  coverUrl: '',
  bpm: 120,
  key: 'C Major',
  energy: 0.5,
  durationSeconds: 200,
  segments: [{ label: 'Main', start: 0, end: 100, color: colors.gray[800] }],
  segmentsSource: 'inferred',
  samples: [{ time: 30, description: 'A sample' }],
  keyMoments: [{ time: 5, type: 'onset', intensity: 0.5, description: 'Onset' }],
  factoids: [{ id: 'f1', title: 'Fact', content: 'Text', type: 'trivia' }],
  credits: { producers: ['P'], writers: ['W'] },
  genreProfile: [{ genre: 'Pop', value: 60 }],
  genealogy: {
    nodes: [
      { id: 'current', group: 1, label: 'Partial Song', size: 40 },
      { id: 'o1', group: 2, label: 'Older Song', size: 30 },
    ],
    links: [{ source: 'o1', target: 'current', value: 3 }],
  },
  audioSource: 'analyzed',
});

const without = (field: string, value: unknown): TrackData => {
  const track = complete();
  const [parent, child] = field.split('.');
  if (child) {
    const inner = { ...(track[parent] as Record<string, unknown>) };
    if (value === undefined) delete inner[child];
    else inner[child] = value;
    track[parent] = inner;
  } else if (value === undefined) {
    delete track[parent];
  } else {
    track[parent] = value;
  }
  return track as unknown as TrackData;
};

const fields = [
  'genealogy',
  'genealogy.nodes',
  'genealogy.links',
  'factoids',
  'segments',
  'keyMoments',
  'samples',
  'credits',
  'genreProfile',
];

describe.each(fields)('a result without %s', (field) => {
  it.each([
    ['missing', undefined],
    ['null', null],
  ])('renders the Dashboard and the Player when it is %s', (_case, value) => {
    const track = without(field, value);
    const dashboard = render(
      <Dashboard trackData={track} onNavigate={() => {}} isRestoredSession />,
    );
    expect(screen.getAllByText('Partial Song').length).toBeGreaterThan(0);
    dashboard.unmount();

    render(<Player trackData={track} onBack={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Partial Song' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Song structure' })).toBeTruthy();
  });
});
