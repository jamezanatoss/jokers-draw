import { describe, expect, it } from 'vitest';
import {
  type Card,
  type HandState,
  applyAction,
  fullDeck,
  makeView,
  matchAct,
  mulberry32,
  newHand,
  newMatch,
  shuffle,
  startHand,
} from '../src/engine';
import { AIPlayer } from '../src/ai/ai';
import { OpponentModel, sampleRange } from '../src/ai/opponentModel';
import { HeuristicBot, playMatch } from '../src/ai/sim';
import { getTables, maskOf } from '../src/ai/tables';

const t = getTables();
const OPTS = {
  samples: 1500,
  useBetting: true,
  useExchange: true,
  exchangeTemp: 0.05,
  exchangeFloor: 0.12,
  keepNoise: 0.15,
  tendencies: new OpponentModel().tendencies(),
};

/** Player 0 bets and throws `k` cards (twice if `rounds` = 2); AI is player 1. */
function afterPlayerExchanges(faceUp: boolean, seed: number, k = 3, rounds = 1): HandState {
  let s = newHand([12, 12], 0, mulberry32(seed), undefined, 1, faceUp);
  for (let r = 0; r < rounds; r++) {
    s = applyAction(s, r === 0 ? { type: 'raise', to: 2 } : { type: 'bet' });
    s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, k) });
    if (r < rounds - 1) {
      s = applyAction(s, { type: 'bet' });
      s = applyAction(s, { type: 'exchange', cards: [] });
    }
  }
  return s;
}

describe('discard visibility (views)', () => {
  it('engine default is face down', () => {
    expect(newHand([12, 12], 0, mulberry32(1)).discardsFaceUp).toBe(false);
  });

  it('face up: each player sees the other player’s discarded cards, in discard order', () => {
    const s = afterPlayerExchanges(true, 1, 3, 2);
    const ai = makeView(s, 1);
    expect(ai.discardsFaceUp).toBe(true);
    expect(ai.oppDiscards).toEqual(s.discards[0]);
    expect(ai.oppDiscards).toHaveLength(6);
    const exchanges = ai.history.filter((e) => e.player === 0 && e.type === 'exchange');
    expect(exchanges.map((e) => e.cards)).toEqual([s.discards[0].slice(0, 3), s.discards[0].slice(3)]);
    // ...and symmetrically the player sees the AI's.
    let s2 = applyAction(s, { type: 'bet' });
    s2 = applyAction(s2, { type: 'exchange', cards: s2.hands[1].slice(0, 2) });
    expect(makeView(s2, 0).oppDiscards).toEqual(s2.discards[1]);
  });

  it('face down: only the counts are visible', () => {
    const s = afterPlayerExchanges(false, 1);
    const ai = makeView(s, 1);
    expect(ai.discardsFaceUp).toBe(false);
    expect(ai.oppDiscards).toBeUndefined();
    expect(ai.oppDiscardCount).toBe(3);
    const ex = ai.history.find((e) => e.player === 0 && e.type === 'exchange')!;
    expect(ex.count).toBe(3);
    expect(ex.cards).toBeUndefined();
    expect(JSON.stringify(ai.history)).not.toContain(JSON.stringify(s.discards[0]));
  });

  it('the match carries the mode into every hand', () => {
    let m = startHand(newMatch(0, 12, 2, true), mulberry32(2));
    expect(m.hand!.discardsFaceUp).toBe(true);
    m = matchAct(m, { type: 'drop' });
    m = startHand(m, mulberry32(3));
    expect(m.hand!.discardsFaceUp).toBe(true);
    expect(startHand(newMatch(0), mulberry32(2)).hand!.discardsFaceUp).toBe(false);
  });
});

describe('AI use of discards', () => {
  it('face up: the AI never places the player’s visible discards in their hand or in the deck', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const s = afterPlayerExchanges(true, seed, 3, 2);
      const view = makeView(s, 1);
      const thrown = maskOf(view.oppDiscards!);
      const r = sampleRange(view, t, mulberry32(seed), OPTS);
      expect(r.restLen).toBe(view.deckCount);
      for (let i = 0; i < r.n; i++) {
        expect(r.opp[i] & thrown).toBe(0);
        const deck = Array.from(r.rest.subarray(i * r.stride, i * r.stride + r.restLen));
        expect(deck.every((c) => c >= 0 && !(thrown & (1 << c)) && !(r.opp[i] & (1 << c)))).toBe(true);
        expect(new Set(deck).size).toBe(deck.length);
      }
    }
  });

  it('face down: the same cards are still considered possible (the AI cannot see them)', () => {
    const s = afterPlayerExchanges(false, 1, 3);
    const thrown = maskOf(s.discards[0]);
    const r = sampleRange(makeView(s, 1), t, mulberry32(1), OPTS);
    let touching = 0;
    for (let i = 0; i < r.n; i++) {
      const deck = maskOf(Array.from(r.rest.subarray(i * r.stride, i * r.stride + r.restLen)));
      if ((r.opp[i] | deck) & thrown) touching++;
    }
    expect(touching).toBeGreaterThan(r.n * 0.9);
  });

  it('face down: AI decisions do not depend on which cards the player threw', () => {
    // Same AI hand, same counts; the player's actual hand and discards differ between variants.
    for (let n = 0; n < 8; n++) {
      const base = shuffle(fullDeck(), mulberry32(n));
      const ai5 = base.slice(0, 5);
      const others = base.slice(5);
      const decisions = [0, 1].map((variant) => {
        const pool = variant === 0 ? others : [...others].reverse();
        const deal: Card[] = [];
        for (let i = 0; i < 5; i++) deal.push(pool[i], ai5[i]);
        const deck = [...deal, ...pool.slice(5)];
        let s = newHand([12, 12], 0, mulberry32(0), deck, 1, false);
        s = applyAction(s, { type: 'raise', to: 2 });
        s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, 2) });
        const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(50 + n), me: 1 });
        return ai.decide(makeView(s, 1)).action;
      });
      expect(decisions[0]).toEqual(decisions[1]);
    }
  });

  it('face up: the sampled range reflects the visible discards', () => {
    // A player who visibly threw away the four Aces cannot hold an Ace (only the Joker as one).
    const aces = [16, 17, 18, 19];
    const pHand = [...aces, 0];
    const aiHand = [1, 2, 3, 4, 5];
    const deal: Card[] = [];
    for (let i = 0; i < 5; i++) deal.push(pHand[i], aiHand[i]);
    const rest = fullDeck().filter((c) => !deal.includes(c));
    let s = newHand([12, 12], 0, mulberry32(0), [...deal, ...rest], 1, true);
    s = applyAction(s, { type: 'raise', to: 2 });
    s = applyAction(s, { type: 'exchange', cards: aces });
    const r = sampleRange(makeView(s, 1), t, mulberry32(4), OPTS);
    const aceMask = maskOf(aces);
    for (let i = 0; i < r.n; i++) expect(r.opp[i] & aceMask).toBe(0);
    // Face down, Aces stay possible.
    let s2 = newHand([12, 12], 0, mulberry32(0), [...deal, ...rest], 1, false);
    s2 = applyAction(s2, { type: 'raise', to: 2 });
    s2 = applyAction(s2, { type: 'exchange', cards: aces });
    const r2 = sampleRange(makeView(s2, 1), t, mulberry32(4), OPTS);
    let withAce = 0;
    for (let i = 0; i < r2.n; i++) if (r2.opp[i] & aceMask) withAce++;
    expect(withAce).toBeGreaterThan(0);
  });

  it('AI plays legal, complete matches in both modes (and both Joker counts)', () => {
    for (const faceUp of [true, false]) {
      for (const jokers of [1, 2] as const) {
        const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(7), me: 1, jokers });
        const res = playMatch([new HeuristicBot(mulberry32(8)), ai], mulberry32(9), { jokers, discardsFaceUp: faceUp });
        expect(res.hands).toBeGreaterThan(0);
        expect(res.coins[0] + res.coins[1]).toBe(24);
      }
    }
    getTables(1);
  });
});
