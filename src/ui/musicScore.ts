/**
 * "Joker's Gambit" — the game's own background loop, written for this project and rendered live
 * by the synth in music.ts. Pure data + a pure event function (unit-tested), no audio here.
 *
 * Mood: a tense, sly showdown at a card table in a late-90s console game. 108 BPM, swung 16ths,
 * D minor with dorian / chromatic colour. 32 bars ≈ 71 s, looping seamlessly:
 *
 *   A1  bars  0– 7  groove: bass, drums, electric-piano comping, a quiet mallet riff
 *   A2  bars  8–15  the lead enters with the main motif (sly chromatic slides, b5 bends)
 *   B1  bars 16–23  new harmony, half-time drums, the lead answers low and muted
 *   B2  bars 24–31  full groove again, lead an octave up, fill into the top of the loop
 *
 * Harmony (one chord per bar):
 *   A: Dm9 | Dm9 | Gm9 | Ebmaj7#11 | Dm9 | Bb13 | Em7b5 | A7b9
 *   B: Bbmaj7 | Am7 | Abmaj7#11 | Gm9 | Ebmaj7#11 | Cm9 | Bbm6 | A7alt
 */

export type Instrument = 'bass' | 'keys' | 'lead' | 'mallet' | 'kick' | 'snare' | 'hat' | 'openhat' | 'shaker';

export interface NoteEvent {
  inst: Instrument;
  /** MIDI note (drums: ignored, 0). */
  midi: number;
  /** Length in 16th steps. */
  len: number;
  /** 0..1 */
  vel: number;
  /** Lead only: muted/low B1 colour. */
  dark?: boolean;
}

interface Chord {
  name: string;
  /** Bass root (MIDI, around octave 1–2). */
  root: number;
  /** Rootless keyboard voicing (MIDI). */
  tones: number[];
  /** Semitones from the root to the chord's fifth and seventh (for the bass line). */
  fifth: number;
  seventh: number;
}

const C = (name: string, root: number, tones: number[], fifth = 7, seventh = 10): Chord => ({ name, root, tones, fifth, seventh });

const A_CHORDS: Chord[] = [
  C('Dm9', 38, [53, 57, 60, 64]),
  C('Dm9', 38, [53, 57, 60, 64]),
  C('Gm9', 43, [58, 62, 65, 69]),
  C('Ebmaj7#11', 39, [55, 58, 62, 69], 7, 11),
  C('Dm9', 38, [53, 57, 60, 64]),
  C('Bb13', 34, [56, 62, 67]),
  C('Em7b5', 40, [55, 58, 62], 6),
  C('A7b9', 33, [55, 58, 61, 64]),
];
const B_CHORDS: Chord[] = [
  C('Bbmaj7', 34, [57, 62, 65], 7, 11),
  C('Am7', 33, [55, 60, 64]),
  C('Abmaj7#11', 32, [55, 60, 62], 7, 11),
  C('Gm9', 43, [53, 58, 62, 69]),
  C('Ebmaj7#11', 39, [55, 58, 62, 69], 7, 11),
  C('Cm9', 36, [51, 55, 58, 62]),
  C('Bbm6', 34, [61, 65, 67], 7, 9),
  C('A7alt', 33, [55, 61, 65, 70], 8),
];

/** Lead phrases: [step, midi, len] per bar. */
type Phrase = [number, number, number][];
const LEAD_A: Phrase[] = [
  [[0, 74, 3], [3, 77, 1], [4, 76, 2], [6, 74, 2], [8, 69, 4], [12, 68, 1], [13, 67, 3]],
  [[4, 65, 2], [6, 67, 1], [7, 68, 1], [8, 69, 6], [14, 72, 2]],
  [[0, 70, 3], [3, 69, 1], [4, 67, 4], [10, 74, 2], [12, 72, 4]],
  [[0, 69, 8], [8, 70, 2], [10, 74, 6]],
  [[0, 74, 3], [3, 77, 1], [4, 76, 2], [6, 72, 2], [8, 69, 6], [14, 74, 2]],
  [[0, 68, 4], [4, 67, 2], [6, 65, 2], [8, 74, 4], [12, 68, 4]],
  [[0, 67, 2], [2, 70, 2], [4, 74, 4], [8, 76, 2], [10, 74, 2], [12, 70, 4]],
  [[0, 73, 6], [6, 70, 2], [8, 69, 4], [12, 67, 2], [14, 64, 2]],
];
const LEAD_B: Phrase[] = [
  [[0, 77, 6], [6, 81, 2], [8, 77, 8]],
  [[0, 76, 4], [4, 79, 2], [6, 76, 2], [8, 72, 8]],
  [[0, 74, 8], [8, 72, 2], [10, 75, 2], [12, 79, 4]],
  [[0, 77, 4], [4, 74, 4], [8, 70, 2], [10, 69, 6]],
  [[0, 79, 3], [3, 77, 1], [4, 74, 2], [6, 70, 2], [8, 81, 8]],
  [[0, 79, 2], [2, 75, 2], [4, 74, 4], [8, 70, 4], [12, 67, 4]],
  [[0, 73, 4], [4, 77, 2], [6, 79, 2], [8, 73, 2], [10, 72, 2], [12, 70, 4]],
  [[0, 70, 2], [2, 73, 2], [4, 77, 4], [8, 76, 4], [12, 73, 2], [14, 69, 2]],
];

export const SCORE = {
  title: "Joker's Gambit",
  bpm: 108,
  /** Share of a 16th pair taken by the first 16th (0.5 = straight). */
  swing: 0.57,
  stepsPerBar: 16,
  bars: 32,
  sections: [
    { name: 'A1', from: 0, to: 8 },
    { name: 'A2', from: 8, to: 16 },
    { name: 'B1', from: 16, to: 24 },
    { name: 'B2', from: 24, to: 32 },
  ],
} as const;

export const TOTAL_STEPS = SCORE.bars * SCORE.stepsPerBar;
/** Seconds per 16th step (before swing). */
export const STEP_SEC = 60 / SCORE.bpm / 4;
export const LOOP_SEC = TOTAL_STEPS * STEP_SEC;

export function sectionOf(bar: number): 'A1' | 'A2' | 'B1' | 'B2' {
  return SCORE.sections.find((s) => bar >= s.from && bar < s.to)!.name;
}

export function chordAt(bar: number): Chord {
  const b = ((bar % SCORE.bars) + SCORE.bars) % SCORE.bars;
  return (b < 16 ? A_CHORDS : B_CHORDS)[b % 8];
}

/** Time offset of a step inside its 16th pair (swing), in steps. */
export function swingOffset(step: number): number {
  return step % 2 === 1 ? (SCORE.swing - 0.5) * 2 : 0;
}

/** Every note that starts on this step of the loop. */
export function eventsAt(globalStep: number): NoteEvent[] {
  const step = ((globalStep % TOTAL_STEPS) + TOTAL_STEPS) % TOTAL_STEPS;
  const bar = Math.floor(step / SCORE.stepsPerBar);
  const s = step % SCORE.stepsPerBar;
  const sec = sectionOf(bar);
  const ch = chordAt(bar);
  const next = chordAt(bar + 1);
  const out: NoteEvent[] = [];
  const half = sec === 'B1';

  // ---- bass: syncopated, chromatic approach into the next bar's root
  const approach = bar % 2 === 0 ? next.root - 1 - ch.root : next.root + 1 - ch.root;
  const bassA: [number, number, number, number][] = [
    [0, 0, 3, 1],
    [3, 0, 1, 0.45],
    [6, 12, 2, 0.8],
    [8, ch.fifth, 2, 0.85],
    [10, ch.seventh, 1, 0.7],
    [11, 12, 1, 0.55],
    [14, approach, 2, 0.8],
  ];
  const bassB: [number, number, number, number][] = [
    [0, 0, 6, 1],
    [7, ch.fifth, 1, 0.6],
    [8, 12, 4, 0.85],
    [12, ch.seventh, 2, 0.7],
    [14, approach, 2, 0.8],
  ];
  for (const [st, off, len, vel] of half ? bassB : bassA) {
    if (st === s) out.push({ inst: 'bass', midi: ch.root + off, len, vel });
  }

  // ---- electric piano comping (rootless voicings)
  const compA = bar % 2 === 0 ? [[2, 2, 0.7], [7, 1, 0.5], [10, 4, 0.75]] : [[0, 3, 0.65], [6, 2, 0.6], [12, 3, 0.7]];
  const compB = [[0, 12, 0.45], [14, 2, 0.6]];
  for (const [st, len, vel] of half ? compB : compA) {
    if (st === s) for (const m of ch.tones) out.push({ inst: 'keys', midi: m, len, vel });
  }

  // ---- mallet riff (A1 only): a sly, quiet arpeggio over the chord tones, up an octave
  if (sec === 'A1') {
    const t = ch.tones;
    const riff: [number, number][] = [[0, t[t.length - 1]], [3, t[1]], [6, t[2]], [10, t[0]], [12, t[t.length - 1] - 1]];
    for (const [st, m] of riff) if (st === s) out.push({ inst: 'mallet', midi: m + 12, len: 1, vel: 0.35 });
  }

  // ---- lead
  if (sec === 'A2' || sec === 'B1' || sec === 'B2') {
    const phrase = sec === 'A2' ? LEAD_A[bar - 8] : LEAD_B[bar % 8];
    const shift = sec === 'B1' ? -12 : 0;
    for (const [st, m, len] of phrase) {
      if (st === s) out.push({ inst: 'lead', midi: m + shift, len, vel: sec === 'B1' ? 0.55 : 0.8, dark: sec === 'B1' });
    }
  }

  // ---- drums
  const lastBar = bar === SCORE.bars - 1;
  if (half) {
    if (s === 0 || s === 11) out.push({ inst: 'kick', midi: 0, len: 1, vel: 0.9 });
    if (s === 8) out.push({ inst: 'snare', midi: 0, len: 1, vel: 0.8 });
    if (s % 4 === 2) out.push({ inst: 'hat', midi: 0, len: 1, vel: 0.35 });
  } else {
    if (s === 0 || s === 10 || (sec === 'B2' && s === 14 && !lastBar)) out.push({ inst: 'kick', midi: 0, len: 1, vel: s === 0 ? 1 : 0.8 });
    if (s === 7 && bar % 4 === 3) out.push({ inst: 'kick', midi: 0, len: 1, vel: 0.5 });
    if (s === 4 || s === 12) out.push({ inst: 'snare', midi: 0, len: 1, vel: 0.85 });
    if (s === 15 && bar % 2 === 1) out.push({ inst: 'snare', midi: 0, len: 1, vel: 0.3 }); // ghost
    if (s % 2 === 0 && !(s === 14 && bar % 2 === 1)) out.push({ inst: 'hat', midi: 0, len: 1, vel: s % 4 === 0 ? 0.42 : 0.3 });
    if (s === 14 && bar % 2 === 1) out.push({ inst: 'openhat', midi: 0, len: 2, vel: 0.4 });
    if ((sec === 'A2' || sec === 'B2') && s % 2 === 1) out.push({ inst: 'shaker', midi: 0, len: 1, vel: 0.18 });
  }
  // Fill into the top of the loop.
  if (lastBar && s >= 12) out.push({ inst: 'snare', midi: 0, len: 1, vel: 0.45 + (s - 12) * 0.15 });
  return out;
}
