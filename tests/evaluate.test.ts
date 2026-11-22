import { describe, expect, it } from 'vitest';
import {
  Category,
  type Card,
  JOKER,
  JOKER2,
  compareEvaluations,
  compareHands,
  describeHand,
  describeJoker,
  evaluateHand,
  makeCard,
  parseCards,
  rankOf,
  suitOf,
} from '../src/engine';

const ev = (s: string) => evaluateHand(parseCards(s));
const cmp = (a: string, b: string) => compareHands(parseCards(a), parseCards(b));

/** All legal hands for a deck of `n` cards (21: C(21,5) = 20349; 22: no hand holds both Jokers). */
function allHands(n = 21): Card[][] {
  const out: Card[][] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) if (!(d === JOKER && e === JOKER2)) out.push([a, b, c, d, e]);
  return out;
}
const ALL = allHands();
const ALL_EVALS = ALL.map((h) => evaluateHand(h));
const ALL22 = allHands(22);
const ALL22_EVALS = ALL22.map((h) => evaluateHand(h));

describe('categories without the Joker', () => {
  it.each([
    ['10S JS QS KS AS', Category.RoyalStraightFlush],
    ['10C JC QC KC AC', Category.RoyalStraightFlush],
    ['AS AH AD AC KS', Category.FourOfAKind],
    ['10S JH QS KD AC', Category.RoyalStraight],
    ['KS KH KD QC QS', Category.FullHouse],
    ['QS QH QD AC 10S', Category.ThreeOfAKind],
    ['AS AH KD KC 10S', Category.TwoPair],
    ['JS JH AD KC 10S', Category.OnePair],
  ])('%s', (hand, cat) => {
    expect(ev(hand).category).toBe(cat);
  });

  it('every 5 distinct ranks form a Royal Straight (there are only 5 ranks)', () => {
    for (const e of ALL_EVALS) {
      if (e.usesJoker) continue;
      const ranks = new Set(e.cards.map(rankOf));
      if (ranks.size === 5) {
        const flush = new Set(e.cards.map(suitOf)).size === 1;
        expect(e.category).toBe(flush ? Category.RoyalStraightFlush : Category.RoyalStraight);
      }
    }
  });

  it('High Card can never occur with this deck', () => {
    expect(ALL_EVALS.filter((e) => e.category === Category.HighCard)).toHaveLength(0);
  });

  it('Five of a Kind is only possible with the Joker', () => {
    for (const e of ALL_EVALS) {
      if (e.category === Category.FiveOfAKind) expect(e.usesJoker).toBe(true);
    }
    expect(ALL_EVALS.filter((e) => e.category === Category.FiveOfAKind)).toHaveLength(5);
  });

  it('category counts over all 20349 hands match combinatorics', () => {
    const counts = new Array(9).fill(0);
    for (const e of ALL_EVALS) counts[e.category]++;
    expect(counts).toEqual([
      0, // High Card
      5 * 6 * 4 * 64, // One Pair: pair rank, suits, 3 of 4 other ranks, 4^3 suits = 7680
      10 * 36 * 12, // Two Pair = 4320
      5 * 4 * 6 * 16 + 5 * 6 * 6 * 16, // Trips natural 1920 + pair+Joker 2880
      5 * 4 * 4 * 6 + 10 * 36, // Full House natural 480 + two pair+Joker 360
      (1024 - 4) + (5 * 256 - 20), // Royal Straight natural 1020 + Joker 1260
      5 * 16 + 5 * 4 * 16, // Four of a Kind natural 80 + trips+Joker 320
      4 + 20, // Royal Straight Flush natural 4 + Joker 20
      5, // Five of a Kind
    ]);
  });
});

describe('Joker', () => {
  it('makes Five of a Kind with four of a kind', () => {
    for (let r = 0; r < 5; r++) {
      const e = evaluateHand([makeCard(r, 0), makeCard(r, 1), makeCard(r, 2), makeCard(r, 3), JOKER]);
      expect(e.category).toBe(Category.FiveOfAKind);
      expect(e.groups[0].rank).toBe(r);
      expect(e.usesJoker).toBe(true);
      // Highest card is the real ♠ (a real card is preferred over the identical Joker).
      expect(e.topCard).toBe(makeCard(r, 3));
      expect(e.topCardIsJoker).toBe(false);
    }
  });

  it('completes a Royal Straight Flush for every missing rank and suit', () => {
    for (let suit = 0; suit < 4; suit++) {
      for (let missing = 0; missing < 5; missing++) {
        const cards: Card[] = [];
        for (let r = 0; r < 5; r++) if (r !== missing) cards.push(makeCard(r, suit));
        cards.push(JOKER);
        const e = evaluateHand(cards);
        expect(e.category).toBe(Category.RoyalStraightFlush);
        expect(e.jokerAs).toBe(makeCard(missing, suit));
      }
    }
  });

  it('completes a Royal Straight for every missing rank (mixed suits)', () => {
    for (let missing = 0; missing < 5; missing++) {
      const cards: Card[] = [];
      let i = 0;
      for (let r = 0; r < 5; r++) if (r !== missing) cards.push(makeCard(r, i++ % 2 === 0 ? 0 : 2));
      cards.push(JOKER);
      const e = evaluateHand(cards);
      expect(e.category).toBe(Category.RoyalStraight);
      expect(rankOf(e.jokerAs!)).toBe(missing);
    }
  });

  it('Joker as the Ace of a Royal Straight counts as A♠ for the tiebreak', () => {
    const e = ev('10C JH QD KS JK');
    expect(e.category).toBe(Category.RoyalStraight);
    expect(e.topCard).toBe(makeCard(4, 3));
    expect(e.topCardIsJoker).toBe(true);
    expect(describeJoker(e)).toBe('Joker as A♠');
  });

  it('makes Four of a Kind with three of a kind', () => {
    const e = ev('KS KH KD 10C JK');
    expect(e.category).toBe(Category.FourOfAKind);
    expect(e.groups[0].rank).toBe(3);
  });

  it('makes a Full House from two pair, tripling the higher pair', () => {
    const e = ev('AS AH KD KC JK');
    expect(e.category).toBe(Category.FullHouse);
    expect(describeHand(e)).toBe('Full House, Aces over Kings');
    expect(describeHand(ev('10S 10H KD KC JK'))).toBe('Full House, Kings over Tens');
  });

  it('makes Three of a Kind from one pair (prefers trips over a higher pair)', () => {
    const e = ev('10S 10H AD KC JK');
    // 10-10-A-K-Joker: trips of Tens beat any pair; a straight is impossible (needs J and Q).
    expect(e.category).toBe(Category.ThreeOfAKind);
    expect(e.groups[0].rank).toBe(0);
  });

  it('prefers a Royal Straight over Three of a Kind when both are possible', () => {
    // A-K-Q-J + Joker: Joker as 10 => Royal Straight
    const e = ev('AS KH QD JC JK');
    expect(e.category).toBe(Category.RoyalStraight);
    expect(rankOf(e.jokerAs!)).toBe(0);
  });

  it('never produces less than Three of a Kind (exhaustive)', () => {
    for (const e of ALL_EVALS) {
      if (e.usesJoker) expect(e.category).toBeGreaterThanOrEqual(Category.ThreeOfAKind);
    }
  });

  it('always picks the best category (exhaustive vs. every real substitute)', () => {
    for (const e of ALL_EVALS) {
      if (!e.usesJoker) continue;
      const rest = e.cards.filter((c) => c !== JOKER);
      for (let sub = 0; sub < 20; sub++) {
        if (rest.includes(sub)) continue;
        const real = evaluateHand([...rest, sub]);
        expect(e.category).toBeGreaterThanOrEqual(real.category);
      }
    }
  });

  it('Joker rule: same category, exactly one Joker → the Joker hand loses (every category)', () => {
    const cases: [string, string][] = [
      // [Joker hand, natural hand of the same category with lower ranks / suits]
      ['AS KS QH JD JK', 'AC KC QC JC 10D'], // Royal Straight (Joker hand even holds A♠)
      ['10S JH QD KS JK', 'AC KC QC JC 10D'], // Royal Straight, Joker as A♠
      ['10S JS QS KS JK', '10C JC QC KC AC'], // Royal Straight Flush
      ['AS AH AD QC JK', '10S 10H 10D 10C KS'], // Four of a Kind: Aces (Joker) vs natural Tens
      ['AS AH KD KC JK', '10S 10H 10D JC JS'], // Full House: Aces (Joker) vs Tens over Jacks
      ['AS AH KD QC JK', '10S 10H 10D JC QS'], // Three of a Kind: Aces (Joker) vs Tens
    ];
    for (const [joker, natural] of cases) {
      const a = cmp(joker, natural);
      expect(a, `${joker} vs ${natural}`).toMatchObject({ winner: 1, reason: 'jokerRule' });
      expect(cmp(natural, joker)).toMatchObject({ winner: 0, reason: 'jokerRule' });
      expect(a.explanation).toContain('Joker loses');
    }
  });

  it('Joker rule works the same with the second Joker', () => {
    expect(cmp('AS AH KD QC JK2', '10S 10H 10D JC QS')).toMatchObject({ winner: 1, reason: 'jokerRule' });
  });

  it('Joker rule only applies within the same category', () => {
    expect(cmp('10S JS QS KS JK', 'AC KH QC JC 10D').winner).toBe(0); // RSF(Joker) > RS
    expect(cmp('AS KH QD JC JK', 'KS KH KD QC QS').winner).toBe(0); // RS(Joker) > Full House
    expect(cmp('AS AH AD AC JK', '10S JS QS KS AS').winner).toBe(0); // 5K > RSF
    expect(cmp('10S 10H JD QC JK', 'AS AH KD KC QS').winner).toBe(0); // 3K(Joker) > Two Pair
  });

  it('every Joker hand loses to every natural hand of the same category (exhaustive)', () => {
    const byCat = new Map<number, { jokerMax: number; naturalMin: number }>();
    for (const e of ALL_EVALS) {
      const x = byCat.get(e.category) ?? { jokerMax: -1, naturalMin: Infinity };
      if (e.usesJoker) x.jokerMax = Math.max(x.jokerMax, e.score);
      else x.naturalMin = Math.min(x.naturalMin, e.score);
      byCat.set(e.category, x);
    }
    for (const [cat, x] of byCat) {
      if (x.jokerMax >= 0 && x.naturalMin < Infinity) expect(x.jokerMax, `category ${cat}`).toBeLessThan(x.naturalMin);
    }
  });
});

describe('two Jokers (2-Joker mode)', () => {
  it('both hands with a Joker: normal tiebreak by rank', () => {
    // Three Aces (Joker) vs three Kings (Joker 2)
    expect(cmp('AS AH QD JC JK', 'KS KH QC JD JK2')).toMatchObject({ winner: 0, reason: 'rank' });
    // Full House: Aces over Kings vs Queens over Jacks
    expect(cmp('QS QH JD JC JK', 'AS AH KD KC JK2')).toMatchObject({ winner: 1, reason: 'rank' });
  });

  it('both hands with a Joker: suit of the highest card, the Joker counting as ♠', () => {
    // Royal Straights: Joker as A (= A♠) vs a real A♥ (other Joker plays the 10)
    expect(cmp('10C JD QH KC JK', 'JS QS KH AH JK2')).toMatchObject({ winner: 0, reason: 'suit' });
  });

  it('both hands with a Joker: a real card beats an identical Joker card', () => {
    // Trips: A♥ A♦ + Joker (top = Joker-as-A♠) vs A♠ A♣ + Joker 2 (top = real A♠)
    const r = cmp('AH AD KC QC JK', 'AS AC KD QD JK2');
    expect(r).toMatchObject({ winner: 1, reason: 'realCard' });
    expect(r.explanation).toContain('real card wins');
  });

  it('both top cards are Jokers as the same card: the highest real card decides', () => {
    // Both Royal Straights with the Joker as the Ace (A♠); K♠ beats K♥.
    const r = cmp('10C JC QD KH JK', '10S JS QH KS JK2');
    expect(r).toMatchObject({ winner: 1, reason: 'highestReal' });
    expect(r.explanation).toContain('K♠ beats K♥');
    // Royal Straight Flushes: Joker as A♥ vs Joker as A♣, both count as A♠ → K♥ beats K♣.
    expect(cmp('10H JH QH KH JK', '10C JC QC KC JK2')).toMatchObject({ winner: 0, reason: 'highestReal' });
  });

  it('a hand can never hold both Jokers', () => {
    expect(() => evaluateHand([JOKER, JOKER2, 0, 1, 2])).toThrow(/two Jokers/);
  });

  it('there are 25194 legal hands; none holds both Jokers; categories are consistent', () => {
    expect(ALL22).toHaveLength(26334 - 1140);
    const counts = new Array(9).fill(0);
    for (const e of ALL22_EVALS) counts[e.category]++;
    // Every hand with the second Joker mirrors a hand with the first.
    const withJ2 = ALL22_EVALS.filter((e) => e.cards.includes(JOKER2)).length;
    const withJ1 = ALL22_EVALS.filter((e) => e.cards.includes(JOKER)).length;
    expect(withJ2).toBe(withJ1);
    expect(counts[Category.HighCard]).toBe(0);
    expect(counts[Category.FiveOfAKind]).toBe(10);
  });
});

describe('tiebreaks', () => {
  it('category order: 5K > RSF > 4K > RS > FH > 3K > 2P > 1P', () => {
    const ladder = [
      'KS KH KD KC JK',
      '10H JH QH KH AH',
      'QS QH QD QC 10S',
      '10C JD QC KC AD',
      'JS JH JD 10C 10S',
      'AS AH AD KC QC',
      'AC AD KS KD 10H',
      'AH AS QD JC 10S',
    ];
    for (let i = 0; i < ladder.length - 1; i++) {
      const r = cmp(ladder[i], ladder[i + 1]);
      expect(r.winner, `${ladder[i]} vs ${ladder[i + 1]}`).toBe(0);
      expect(r.reason).toBe('category');
    }
  });

  it('pair of Aces beats pair of Kings', () => {
    const r = cmp('AS AH QD JC 10S', 'KS KH QC JD 10D');
    expect(r).toMatchObject({ winner: 0, reason: 'rank' });
  });

  it('pair A♠A♣ beats A♥A♦ (suit of highest card)', () => {
    const r = cmp('AH AD KS QS JS', 'AS AC KH QH JH');
    expect(r).toMatchObject({ winner: 1, reason: 'suit' });
  });

  it('kickers are ignored: same pair rank is decided by suit, not kickers', () => {
    // Left has higher kickers (K) but the right pair holds the A♠.
    const r = cmp('AH AD KS QS JC', 'AS AC QH JH 10H');
    expect(r).toMatchObject({ winner: 1, reason: 'suit' });
  });

  it('two pair: higher pair first', () => {
    expect(cmp('KS KH QS QH AD', 'AS AH 10S 10H JD')).toMatchObject({ winner: 1, reason: 'rank' });
  });

  it('two pair: then second pair', () => {
    const r = cmp('AS AH KS KH 10D', 'AD AC QS QH JD');
    expect(r).toMatchObject({ winner: 0, reason: 'rank' });
    expect(r.explanation).toContain('Second pair');
  });

  it('two pair: then suit of the highest card of the higher pair', () => {
    expect(cmp('AH AD KS KC 10D', 'AS AC KH KD JD')).toMatchObject({ winner: 1, reason: 'suit' });
  });

  it('full house compares the triple', () => {
    expect(cmp('KS KH KD 10C 10S', 'QS QH QD AC AS')).toMatchObject({ winner: 0, reason: 'rank' });
  });

  it('three / four of a kind compare rank', () => {
    expect(cmp('JS JH JD AC KS', '10S 10H 10D AH KH')).toMatchObject({ winner: 0, reason: 'rank' });
    expect(cmp('JS JH JD JC KS', 'QS QH QD QC KH')).toMatchObject({ winner: 1, reason: 'rank' });
  });

  it('royal straights compare the suit of the Ace', () => {
    expect(cmp('10C JC QC KC AS', '10S JS QS KS AH')).toMatchObject({ winner: 0, reason: 'suit' });
  });

  it('royal straight flushes: ♠ > ♥ > ♦ > ♣', () => {
    const suits = ['S', 'H', 'D', 'C'];
    const rsf = (s: string) => ['10', 'J', 'Q', 'K', 'A'].map((r) => r + s).join(' ');
    for (let i = 0; i < 3; i++) {
      expect(cmp(rsf(suits[i]), rsf(suits[i + 1]))).toMatchObject({ winner: 0, reason: 'suit' });
    }
  });
});

describe('total order / no ties', () => {
  it.each([
    ['1 Joker', ALL, ALL_EVALS],
    ['2 Jokers', ALL22, ALL22_EVALS],
  ] as const)('two hands from the same deck never share a score (exhaustive, %s)', (_, hands, evals) => {
    const byScore = new Map<number, number[]>();
    evals.forEach((e, i) => {
      const masks = byScore.get(e.score) ?? [];
      masks.push(i);
      byScore.set(e.score, masks);
    });
    const masks = hands.map((h) => h.reduce((m, c) => m | (1 << c), 0));
    // Two hands that each hold a Joker are both possible in 2-Joker mode — they are disjoint
    // whenever their real cards are.
    let checkedPairs = 0;
    const disjoint: string[] = [];
    for (const idxs of byScore.values()) {
      for (let i = 0; i < idxs.length; i++) {
        const mi = masks[idxs[i]];
        for (let j = i + 1; j < idxs.length; j++) {
          checkedPairs++;
          const both = mi & masks[idxs[j]];
          if (both === 0) disjoint.push(`${hands[idxs[i]]} / ${hands[idxs[j]]}`);
        }
      }
    }
    expect(checkedPairs).toBeGreaterThan(0);
    expect(disjoint.slice(0, 5)).toEqual([]);
  });

  it('compareEvaluations agrees with score on random disjoint hands', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let n = 0; n < 20000; n++) {
      // Alternate 1- and 2-Joker decks; a player never holds both Jokers.
      const size = n % 2 === 0 ? 21 : 22;
      const deck = Array.from({ length: size }, (_, i) => i).sort(() => rnd() - 0.5);
      const take = (pool: number[]) => {
        const h: number[] = [];
        while (h.length < 5) {
          const c = pool.shift()!;
          if (c >= JOKER && h.some((x) => x >= JOKER)) pool.push(c);
          else h.push(c);
        }
        return h;
      };
      const a = evaluateHand(take(deck));
      const b = evaluateHand(take(deck));
      const r = compareEvaluations(a, b);
      expect(a.score).not.toBe(b.score);
      expect(r.winner).toBe(a.score > b.score ? 0 : 1);
    }
  });

  it('compareEvaluations agrees with score for every hand vs. a fixed set (exhaustive-ish)', () => {
    const probes = [
      'AS AH AD AC JK', '10S JS QS KS JK', '10C JC QC KC AC', '10S JH QS KD AC',
      'AC KC QC JC 10D', 'KS KH KD QC QS', 'AS AH KD KC 10S', 'JS JH AD KC 10S', 'AH AD KS QS JS',
    ].map((s) => ev(s));
    for (const e of ALL_EVALS) {
      for (const p of probes) {
        if (e.score === p.score) continue; // identical / overlapping hands
        expect(compareEvaluations(e, p).winner).toBe(e.score > p.score ? 0 : 1);
      }
    }
  });
});

describe('descriptions', () => {
  it.each([
    ['AS AH AD AC JK', 'Five of a Kind, Aces'],
    ['10H JH QH KH AH', 'Royal Straight Flush (♥)'],
    ['QS QH QD QC 10S', 'Four of a Kind, Queens'],
    ['10C JD QC KC AD', 'Royal Straight'],
    ['JS JH JD 10C 10S', 'Full House, Jacks over Tens'],
    ['AS AH AD KC QC', 'Three of a Kind, Aces'],
    ['AC AD KS KD 10H', 'Two Pair, Aces and Kings'],
    ['AH AS QD JC 10S', 'Pair of Aces'],
  ])('%s → %s', (hand, name) => {
    expect(describeHand(ev(hand))).toBe(name);
  });

  it('rejects malformed hands', () => {
    expect(() => evaluateHand([0, 1, 2, 3])).toThrow();
    expect(() => evaluateHand([0, 0, 1, 2, 3])).toThrow();
    expect(() => evaluateHand([0, 1, 2, JOKER, JOKER2])).toThrow();
  });
});
