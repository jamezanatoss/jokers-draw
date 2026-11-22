/**
 * AI benchmarks (not part of `npm test`):  npm run bench
 * Env:
 *   MATCHES   matches per pairing (default 200)
 *   JOKERS    "1,2" (default)       DISCARDS  "down,up" (default "down")
 *   PAIRS     comma list, e.g. "hard-heuristic,hard-normal" (default: all)
 * Reports win rates with 95% Wilson intervals, match length, slowest decision, and — for Hard —
 * CALLs per hand, mean win equity at its CALLs and the share of cheap (+1, equity < 0.60) CALLs.
 * "hard-before" is Hard with the discipline layer switched off (the previous decision model).
 */
import { it } from 'vitest';
import { mulberry32 } from '../src/engine';
import { AIPlayer, type Difficulty } from '../src/ai/ai';
import { type Bot, HeuristicBot, RandomBot, playMatch } from '../src/ai/sim';
import { getTables } from '../src/ai/tables';
import { Logged } from './diagLib';

const N = Number(process.env.MATCHES ?? 200);
const MODES = (process.env.JOKERS ?? '1,2').split(',').map(Number) as (1 | 2)[];
const DISCARDS = (process.env.DISCARDS ?? 'down').split(',');
const ONLY = process.env.PAIRS?.split(',');

type Maker = (seed: number, me: 0 | 1) => Bot;
const ai =
  (d: Difficulty, overrides?: Record<string, unknown>): Maker =>
  (seed, me) =>
    new AIPlayer({ difficulty: d, rng: mulberry32(seed), me, overrides } as never);
const hard: Maker = (seed, me) => new Logged(new AIPlayer({ difficulty: 'hard', rng: mulberry32(seed), me }));
const hardBefore: Maker = (seed, me) =>
  new Logged(new AIPlayer({ difficulty: 'hard', rng: mulberry32(seed), me, overrides: { disciplined: false } } as never));

const PAIRS: [string, Maker, string, Maker][] = [
  ['hard', hard, 'random', (s) => new RandomBot(mulberry32(s))],
  ['hard', hard, 'heuristic', (s) => new HeuristicBot(mulberry32(s))],
  ['hard-before', hardBefore, 'heuristic', (s) => new HeuristicBot(mulberry32(s))],
  ['normal', ai('normal'), 'heuristic', (s) => new HeuristicBot(mulberry32(s))],
  ['hard', hard, 'normal', ai('normal')],
  ['hard-before', hardBefore, 'normal', ai('normal')],
  ['cheater', ai('cheater'), 'hard', ai('hard')],
];

/** Wilson score interval for k wins out of n. */
function wilson(k: number, n: number): [number, number] {
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

it('bench', () => {
  for (const jokers of MODES) {
    getTables(jokers);
    for (const discards of DISCARDS) {
      const faceUp = discards === 'up';
      console.log(`--- ${jokers} Joker${jokers === 2 ? 's' : ''}, discards face ${discards} ---`);
      for (const [an, a, bn, b] of PAIRS) {
        if (ONLY && !ONLY.includes(`${an}-${bn}`)) continue;
        let wins = 0;
        let hands = 0;
        let maxMs = 0;
        let calls = 0;
        let eqSum = 0;
        let cheap = 0;
        for (let i = 0; i < N; i++) {
          const rng = mulberry32(1000 + i);
          const swap = i % 2 === 1; // alternate seats
          const A = a(i * 7 + 2, swap ? 1 : 0);
          const B = b(i * 7 + 1, swap ? 0 : 1);
          const r = playMatch(swap ? [B, A] : [A, B], rng, { jokers, discardsFaceUp: faceUp });
          if ((r.winner === 1) === swap) wins++;
          hands += r.hands;
          maxMs = Math.max(maxMs, r.maxDecisionMs);
          if (A instanceof Logged) {
            calls += A.calls.length;
            eqSum += A.calls.reduce((s, c) => s + c.eq, 0);
            cheap += A.calls.filter((c) => c.extra === 1 && c.eq < 0.6).length;
          }
        }
        const [lo, hi] = wilson(wins, N);
        const callInfo = calls
          ? ` | CALLs ${(calls / hands).toFixed(2)}/hand, mean eq ${(eqSum / calls).toFixed(2)}, cheap ${((100 * cheap) / calls).toFixed(0)}%`
          : '';
        console.log(
          `${an} vs ${bn}: ${wins}/${N} = ${((100 * wins) / N).toFixed(1)}% [95% CI ${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}%], ` +
            `avg hands ${(hands / N).toFixed(1)}, max decision ${maxMs.toFixed(0)} ms${callInfo}`,
        );
      }
    }
  }
});
