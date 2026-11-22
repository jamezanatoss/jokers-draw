/**
 * Precomputed lookup tables for fast AI evaluation. Cards are bits in a 22-bit mask
 * (bit 20 = Joker, bit 21 = second Joker in 2-Joker mode).
 *
 *   score[mask5]   dense rank of the engine score of a 5-card hand (higher wins, never ties)
 *   pct[rank]      percentile of that rank among all legal hands of the deck (0..1)
 *   keep[mask]     for 0..5 kept cards: expected percentile after drawing the rest
 *                  uniformly from the other cards ("how good is keeping these?")
 *
 * One set of tables per Joker mode (the deck changes the percentiles). Built once (~0.2 s);
 * only the most recently used mode is kept in memory.
 */
import { type Card, HAND_SIZE, type JokerCount, JOKER, JOKER2, MAX_CARDS, deckSizeFor, evaluateHand } from '../engine';

export interface Tables {
  jokers: JokerCount;
  deckSize: number;
  score: Uint16Array;
  pct: Float32Array;
  keep: Float32Array;
  /** All legal 5-card masks. */
  hands: Int32Array;
}

const SPACE = 1 << MAX_CARDS;
export const JOKER_BITS = (1 << JOKER) | (1 << JOKER2);
export const hasJoker = (mask: number): boolean => (mask & JOKER_BITS) !== 0;

export function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function maskOf(cards: readonly Card[]): number {
  let m = 0;
  for (const c of cards) m |= 1 << c;
  return m;
}

export function cardsOf(mask: number): Card[] {
  const out: Card[] = [];
  for (let c = 0; c < MAX_CARDS; c++) if (mask & (1 << c)) out.push(c);
  return out;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

let cached: Tables | null = null;

export function getTables(jokers: JokerCount = 1): Tables {
  if (cached && cached.jokers === jokers) return cached;
  cached = null; // free the other mode's tables first
  const n = deckSizeFor(jokers);

  const handsList: number[] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const m = (1 << a) | (1 << b) | (1 << c) | (1 << d) | (1 << e);
            if ((m & JOKER_BITS) !== JOKER_BITS) handsList.push(m); // never both Jokers
          }
  const hands = Int32Array.from(handsList);

  // Raw engine scores → dense ranks (fit in 16 bits).
  const raw = new Int32Array(hands.length);
  hands.forEach((m, i) => (raw[i] = evaluateHand(cardsOf(m)).score));
  const distinct = Array.from(new Set(raw)).sort((x, y) => x - y);
  const rankOfScore = new Map<number, number>();
  distinct.forEach((sc, i) => rankOfScore.set(sc, i + 1));

  const score = new Uint16Array(SPACE);
  const countByRank = new Uint32Array(distinct.length + 1);
  hands.forEach((m, i) => {
    const r = rankOfScore.get(raw[i])!;
    score[m] = r;
    countByRank[r]++;
  });

  const pct = new Float32Array(distinct.length + 1);
  let below = 0;
  for (let r = 1; r <= distinct.length; r++) {
    pct[r] = (below + 0.5 * countByRank[r]) / hands.length;
    below += countByRank[r];
  }

  // Each legal 5-card hand is exactly one completion of each of its 32 subsets.
  const keep = new Float32Array(SPACE);
  for (const h of hands) {
    const p = pct[score[h]];
    for (let sub = h; ; sub = (sub - 1) & h) {
      keep[sub] += p;
      if (sub === 0) break;
    }
  }
  // Number of legal completions of a kept set (completions may not hold both Jokers).
  const completions = (m: number): number => {
    const j = popcount(m);
    const all = choose(n - j, HAND_SIZE - j);
    if (jokers === 1) return all;
    const held = popcount(m & JOKER_BITS);
    if (held === 0) return all - choose(n - j - 2, HAND_SIZE - j - 2);
    return all - choose(n - j - 1, HAND_SIZE - j - 1);
  };
  for (let m = 0; m < SPACE; m++) {
    if (keep[m] !== 0) keep[m] /= completions(m);
  }

  cached = { jokers, deckSize: n, score, pct, keep, hands };
  return cached;
}

/** Percentile (0..1) of a 5-card mask among all hands. */
export function pctOf(t: Tables, mask5: number): number {
  return t.pct[t.score[mask5]];
}

/** Best keep subset of a 5-card mask, optionally limited in how many cards may be discarded. */
export function bestKeep(t: Tables, mask5: number, maxDiscard = HAND_SIZE): { keep: number; value: number } {
  let best = mask5;
  let bestV = t.keep[mask5];
  for (let sub = (mask5 - 1) & mask5; ; sub = (sub - 1) & mask5) {
    if (HAND_SIZE - popcount(sub) <= maxDiscard) {
      const v = t.keep[sub];
      if (v > bestV) {
        bestV = v;
        best = sub;
      }
    }
    if (sub === 0) break;
  }
  return { keep: best, value: bestV };
}

/** Best keep of each size 0..5 (index = number of cards kept). */
export function bestKeepBySize(t: Tables, mask5: number, outMask: Int32Array, outVal: Float32Array): void {
  outVal.fill(-1);
  for (let sub = mask5; ; sub = (sub - 1) & mask5) {
    const k = popcount(sub);
    const v = t.keep[sub];
    if (v > outVal[k]) {
      outVal[k] = v;
      outMask[k] = sub;
    }
    if (sub === 0) break;
  }
}

/**
 * Draw `count` cards onto `mask` from `rest[base + start .. base + end)`, obeying the one-Joker
 * rule (a refused Joker is skipped and stays in the deck). Returns the new mask; `out[0]` gets
 * the scan position after the last card taken and `out[1]` the number of cards actually drawn.
 */
export function drawFromRest(
  mask: number,
  rest: Int8Array,
  base: number,
  start: number,
  end: number,
  count: number,
  out: Int32Array,
): number {
  let pos = start;
  let got = 0;
  let holds = (mask & JOKER_BITS) !== 0;
  while (got < count && pos < end) {
    const c = rest[base + pos++];
    if (c < 0) break;
    const joker = c >= JOKER;
    if (joker && holds) continue;
    mask |= 1 << c;
    if (joker) holds = true;
    got++;
  }
  out[0] = pos;
  out[1] = got;
  return mask;
}
