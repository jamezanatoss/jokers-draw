import { describe, expect, it } from 'vitest';
import { LOOP_SEC, SCORE, STEP_SEC, TOTAL_STEPS, chordAt, eventsAt, sectionOf } from '../src/ui/musicScore';

const all = () => Array.from({ length: TOTAL_STEPS }, (_, s) => eventsAt(s).map((e) => ({ ...e, s }))).flat();

describe('original music loop', () => {
  it('is mid tempo and 60–90 s long, with A and B sections', () => {
    expect(SCORE.bpm).toBeGreaterThanOrEqual(100);
    expect(SCORE.bpm).toBeLessThanOrEqual(115);
    expect(LOOP_SEC).toBeGreaterThanOrEqual(60);
    expect(LOOP_SEC).toBeLessThanOrEqual(90);
    expect(SCORE.sections.map((s) => s.name)).toEqual(['A1', 'A2', 'B1', 'B2']);
    expect(SCORE.sections.at(-1)!.to).toBe(SCORE.bars);
    // A and B use different harmony.
    const a = Array.from({ length: 8 }, (_, i) => chordAt(i).name);
    const b = Array.from({ length: 8 }, (_, i) => chordAt(16 + i).name);
    expect(a).not.toEqual(b);
    expect(sectionOf(0)).toBe('A1');
    expect(sectionOf(31)).toBe('B2');
  });

  it('loops seamlessly: deterministic, wraps around, nothing rings past the loop end', () => {
    expect(eventsAt(TOTAL_STEPS + 5)).toEqual(eventsAt(5));
    expect(eventsAt(-1)).toEqual(eventsAt(TOTAL_STEPS - 1));
    for (const e of all()) expect(e.s + e.len, `${e.inst} at ${e.s}`).toBeLessThanOrEqual(TOTAL_STEPS);
    // The last bar leads back into bar 1: the bass approaches D from a half step.
    const lastBass = all().filter((e) => e.inst === 'bass' && e.s >= TOTAL_STEPS - 16).at(-1)!;
    expect(Math.abs(((lastBass.midi - chordAt(0).root) % 12 + 12) % 12)).toSatisfy((d: number) => d === 1 || d === 11);
  });

  it('has a groovy bass, light percussion, jazzy chords and a lead only after the intro', () => {
    const ev = all();
    const count = (inst: string, from = 0, to = TOTAL_STEPS) => ev.filter((e) => e.inst === inst && e.s >= from && e.s < to).length;
    expect(count('bass')).toBeGreaterThan(150);
    // Syncopation: some bass notes start off the beat.
    expect(ev.filter((e) => e.inst === 'bass' && e.s % 4 !== 0).length).toBeGreaterThan(60);
    expect(count('kick')).toBeGreaterThan(40);
    expect(count('snare')).toBeGreaterThan(40);
    expect(count('hat')).toBeGreaterThan(150);
    // Four-note (or three-note) jazz voicings.
    const firstKeys = ev.filter((e) => e.inst === 'keys' && e.s === ev.find((x) => x.inst === 'keys')!.s);
    expect(firstKeys.length).toBeGreaterThanOrEqual(3);
    expect(count('lead', 0, 128)).toBe(0); // A1: groove only
    expect(count('lead', 128, 256)).toBeGreaterThan(30); // A2: the motif
    expect(count('lead', 256, 384)).toBeGreaterThan(20); // B1: answers (dark)
    expect(ev.filter((e) => e.inst === 'lead' && e.s >= 256 && e.s < 384).every((e) => e.dark)).toBe(true);
  });

  it('keeps every part in its register and in time', () => {
    for (const e of all()) {
      if (e.inst === 'bass') expect(e.midi).toBeGreaterThanOrEqual(28), expect(e.midi).toBeLessThanOrEqual(58);
      if (e.inst === 'lead') expect(e.midi).toBeGreaterThanOrEqual(52), expect(e.midi).toBeLessThanOrEqual(84);
      expect(e.vel).toBeGreaterThan(0);
      expect(e.vel).toBeLessThanOrEqual(1);
      expect(e.len).toBeGreaterThan(0);
    }
    expect(STEP_SEC * 4).toBeCloseTo(60 / SCORE.bpm);
  });
});
