import { TrackData } from './types';

// Placeholder images (internal only)
const IMAGES = {
  ALBUM_1: 'https://picsum.photos/seed/sonic1/600/600',
  ALBUM_2: 'https://picsum.photos/seed/sonic2/600/600',
  ALBUM_3: 'https://picsum.photos/seed/sonic3/600/600',
  ALBUM_4: 'https://picsum.photos/seed/sonic4/600/600',
};

export const CURRENT_TRACK: TrackData = {
  id: 't1',
  title: 'Midnight City',
  artist: 'M83',
  album: 'Hurry Up, We\'re Dreaming',
  coverUrl: IMAGES.ALBUM_1,
  bpm: 105,
  segments: [
    { label: 'Intro', start: 0, end: 10, color: '#374151' },
    { label: 'Verse 1', start: 10, end: 30, color: '#1F2937' },
    { label: 'Chorus', start: 30, end: 50, color: '#00F0FF' },
    { label: 'Verse 2', start: 50, end: 70, color: '#1F2937' },
    { label: 'Bridge', start: 70, end: 85, color: '#FFB000' },
    { label: 'Outro', start: 85, end: 100, color: '#374151' },
  ],
  samples: [
    { time: 75, description: 'Vocal chop from "Downtown" (1984)' }
  ],
  factoids: [
    {
      id: 'f1',
      title: 'Production Insight',
      content: 'The famous saxophone solo at the end was almost cut from the final mix. The producer felt it was "too 80s" until the very last listening session.',
      type: 'production'
    },
    {
      id: 'f2',
      title: 'Lyrical Analysis',
      content: 'The phrase "waiting in the car" is a metaphor for liminal spaces—the state of being between two destinations, much like the band\'s transition between genres.',
      type: 'lyrics'
    },
    {
      id: 'f3',
      title: 'Sample Trivia',
      content: 'The iconic vocal riff isn\'t a synth; it is a human voice heavily processed through a bitcrusher and reverb.',
      type: 'trivia'
    }
  ],
  genealogy: {
    nodes: [
      { id: 'current', group: 1, label: 'Midnight City', img: IMAGES.ALBUM_1, size: 40 },
      { id: 'origin', group: 2, label: 'Downtown (1984)', img: IMAGES.ALBUM_2, size: 30 },
      { id: 'sib1', group: 3, label: 'City Lights', img: IMAGES.ALBUM_3, size: 20 },
      { id: 'sib2', group: 3, label: 'Neon drive', img: IMAGES.ALBUM_4, size: 20 },
      { id: 'child1', group: 4, label: 'Remix 2023', img: IMAGES.ALBUM_1, size: 15 },
    ],
    links: [
      { source: 'origin', target: 'current', value: 5 },
      { source: 'origin', target: 'sib1', value: 3 },
      { source: 'origin', target: 'sib2', value: 3 },
      { source: 'current', target: 'child1', value: 2 },
    ]
  }
};

// Fallback radar data when no genre profile is available
export const RADAR_DATA = [
  { subject: 'Electronic', A: 50, fullMark: 100 },
  { subject: 'Rock', A: 50, fullMark: 100 },
  { subject: 'Hip Hop', A: 50, fullMark: 100 },
  { subject: 'Jazz', A: 50, fullMark: 100 },
  { subject: 'Pop', A: 50, fullMark: 100 },
  { subject: 'R&B', A: 50, fullMark: 100 },
];

export const RECOMMENDATIONS = [
  { id: 'r1', title: 'Plastic Love', artist: 'Mariya Takeuchi', reason: 'City Pop aesthetic match', img: 'https://picsum.photos/seed/rec1/300/300' },
  { id: 'r2', title: 'Nightcall', artist: 'Kavinsky', reason: 'High BPM + Synth texture', img: 'https://picsum.photos/seed/rec2/300/300' },
  { id: 'r3', title: 'Space Song', artist: 'Beach House', reason: 'Melancholic progression', img: 'https://picsum.photos/seed/rec3/300/300' },
  { id: 'r4', title: 'After Dark', artist: 'Mr. Kitty', reason: 'Lo-fi atmosphere affinity', img: 'https://picsum.photos/seed/rec4/300/300' },
];