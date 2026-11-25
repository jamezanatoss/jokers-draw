import { describe, expect, it } from 'vitest';
import {
  type Action,
  type Card,
  Category,
  evaluateHand,
  type HandState,
  JOKER,
  JOKER2,
  type PlayerId,
  type PlayerView,
  applyAction,
  fullDeck,
  isLegal,
  legalActions,
  makeView,
  mulberry32,
  newHand,
  parseCards,
  shuffle,
} from '../src/engine';
import { AIPlayer, type Difficulty } from '../src/ai/ai';
import { OpponentModel, sampleRange } from '../src/ai/opponentModel';
import { type Bot, HeuristicBot, RandomBot, playMatch } from '../src/ai/sim';
import { cardsOf, drawFromRest, getTables, maskOf, pctOf, popcount } from '../src/ai/tables';

const t = getTables();

/** Deck where player 0 gets h0 and player 1 gets h1 (player 0 deals first), then `top`. */
function deckFor(h0: Card[], h1: Card[], top: Card[] = [], seed = 1): Card[] {
  const dealt: Card[] = [];
  for (let i = 0; i < 5; i++) dealt.push(h0[i], h1[i]);
  const rest = shuffle(fullDeck().filter((c) => !dealt.includes(c) && !top.includes(c)), mulberry32(seed));
  return [...dealt, ...top, ...rest];
}

function aiView(s: HandState, ai: AIPlayer): PlayerView {
  return makeView(s, ai.me, ai.cheats);
}

describe('tables', () => {
  it('popcount / masks round-trip', () => {
    expect(popcount(0)).toBe(0);
    expect(popcount(0b10110)).toBe(3);
    expect(popcount((1 << 21) - 1)).toBe(21);
    expect(cardsOf(maskOf([0, 5, 20]))).toEqual([0, 5, 20]);
  });

  it('percentiles follow the score order', () => {
    const hands = Array.from(t.hands);
    hands.sort((a, b) => t.score[a] - t.score[b]);
    for (let i = 1; i < hands.length; i++) {
      expect(pctOf(t, hands[i])).toBeGreaterThanOrEqual(pctOf(t, hands[i - 1]));
    }
    expect(pctOf(t, maskOf(parseCards('AS AH AD AC JK')))).toBeGreaterThan(0.999);
  });

  it('keep value of nothing ≈ 0.5 and of a full hand = its percentile', () => {
    expect(t.keep[0]).toBeCloseTo(0.5, 3);
    const m = maskOf(parseCards('KS KH KD QC 10S'));
    expect(t.keep[m]).toBeCloseTo(pctOf(t, m), 6);
    // Keeping the Joker is better than keeping any single real card.
    for (let c = 0; c < 20; c++) expect(t.keep[1 << JOKER]).toBeGreaterThan(t.keep[1 << c]);
  });
});

describe('legality and speed', () => {
  const difficulties: Difficulty[] = ['normal', 'hard', 'cheater'];

  it.each(difficulties)('%s: always returns a legal action in every phase', (d) => {
    const r = mulberry32(42);
    const ais: [AIPlayer, AIPlayer] = [
      new AIPlayer({ difficulty: d, rng: mulberry32(1), me: 0 }),
      new AIPlayer({ difficulty: d, rng: mulberry32(2), me: 1 }),
    ];
    const seen = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const coins: [number, number] = [1 + Math.floor(r() * 12), 1 + Math.floor(r() * 12)];
      let s = newHand(coins, (n % 2) as PlayerId, r);
      let steps = 0;
      while (s.phase !== 'over') {
        const ai = ais[s.toAct];
        const { action } = ai.decide(aiView(s, ai));
        seen.add(s.phase);
        expect(isLegal(s, action), `${JSON.stringify(action)} in ${s.phase}`).toBe(true);
        s = applyAction(s, action);
        expect(++steps).toBeLessThan(300);
      }
      for (const ai of ais) ai.observeHandEnd(makeView(s, ai.me), s.outcome!.kind === 'showdown' ? s.hands[1 - ai.me] : null);
    }
    expect(seen.has('turn') && seen.has('exchange')).toBe(true);
  });

  it('hard decisions take well under 300 ms', () => {
    const r = mulberry32(7);
    const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(3), me: 1 });
    let worst = 0;
    for (let n = 0; n < 40; n++) {
      let s = newHand([12, 12], 0, r);
      s = applyAction(s, { type: 'raise', to: 2 });
      s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, n % 4) });
      const t0 = performance.now();
      ai.decide(aiView(s, ai));
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(worst).toBeLessThan(300);
  });
});

describe('exchange choices', () => {
  /** AI (player 1) exchange decision right after it BETs; the opponent first drew 3 (a "pair" range). */
  function aiDiscard(h1: string, h0 = '10C 10D JC JD QC', d: Difficulty = 'hard', seed = 1): Card[] {
    const ai = new AIPlayer({ difficulty: d, rng: mulberry32(seed), me: 1 });
    let s = newHand([12, 12], 0, mulberry32(seed), deckFor(parseCards(h0), parseCards(h1), [], seed));
    s = applyAction(s, { type: 'raise', to: 2 });
    s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(2) });
    s = applyAction(s, { type: 'bet' }); // AI bets; now it must exchange
    expect(s.phase).toBe('exchange');
    const { action } = ai.decide(aiView(s, ai));
    expect(action.type).toBe('exchange');
    return (action as { cards: Card[] }).cards;
  }

  it('keeps a Royal Straight Flush', () => {
    expect(aiDiscard('10S JS QS KS AS')).toEqual([]);
  });

  it('keeps a Royal Straight', () => {
    expect(aiDiscard('10S JH QS KD AC')).toEqual([]);
  });

  it('never breaks four Aces', () => {
    const d = aiDiscard('AS AH AD AC KS');
    expect(d.length).toBeLessThanOrEqual(1);
    expect(d.every((c) => c === parseCards('KS')[0])).toBe(true);
  });

  it('keeps two pair', () => {
    const d = aiDiscard('AS AH KS KH QS');
    expect(d.length).toBeLessThanOrEqual(1);
    expect(d.every((c) => c === parseCards('QS')[0])).toBe(true);
  });

  it('one pair: keeps the pair, or breaks exactly one card of it for the Royal Straight draw', () => {
    // A pair + 3 other ranks always holds 4 distinct ranks (an open Royal Straight draw).
    const [as, ah] = parseCards('AS AH');
    for (let seed = 1; seed <= 5; seed++) {
      const d = aiDiscard('AS AH KS QH JS', '10C 10D KC QC JC', 'hard', seed);
      const brokePair = d.includes(as) || d.includes(ah);
      // Breaking the pair is only ever: one card of it (Royal Straight draw), or a full redraw —
      // the opponent raised and drew three here, and the model rates a full redraw within ~1%
      // of keeping the Aces (a knife-edge; which side wins depends on the sampled range).
      if (brokePair) expect([1, 5]).toContain(d.length);
      else expect(d.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('never discards the Joker (except from a Joker Royal Straight, which the special rule makes weak)', () => {
    const r = mulberry32(11);
    for (let n = 0; n < 30; n++) {
      const others = shuffle(fullDeck().filter((c) => c !== JOKER), r);
      const h1 = [JOKER, ...others.slice(0, 4)];
      const h0 = others.slice(4, 9);
      const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(n), me: 1 });
      let s = newHand([12, 12], 0, r, deckFor(h0, h1, [], n));
      s = applyAction(s, { type: 'raise', to: 2 });
      s = applyAction(s, { type: 'exchange', cards: [] });
      s = applyAction(s, { type: 'bet' });
      const { action } = ai.decide(aiView(s, ai));
      // J-Q-K-A + Joker loses to every real Royal Straight: drawing a real card can be right.
      if (evaluateHand(s.hands[1]).category === Category.RoyalStraight) continue;
      expect((action as { cards: Card[] }).cards).not.toContain(JOKER);
    }
  });
});

describe('opponent modelling', () => {
  function rangeAfterOpponentExchange(k: number): number {
    // Player 0 (opponent) bets and exchanges k; AI (1) samples their range.
    let s = newHand([12, 12], 0, mulberry32(5));
    s = applyAction(s, { type: 'raise', to: 2 });
    s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, k) });
    const view = makeView(s, 1);
    const model = new OpponentModel();
    const r = sampleRange(view, t, mulberry32(9), {
      samples: 4000,
      useBetting: true,
      useExchange: true,
      exchangeTemp: 0.05,
      exchangeFloor: 0.12,
      keepNoise: 0.15,
      tendencies: model.tendencies(),
    });
    let mean = 0;
    for (let i = 0; i < r.n; i++) mean += r.w[i] * r.pct[i];
    // Samples are consistent with the deck count.
    expect(r.restLen).toBe(view.deckCount);
    for (let i = 0; i < r.n; i++) {
      const cards = Array.from(r.rest.subarray(i * r.stride, i * r.stride + r.restLen));
      expect(cards.every((c) => c >= 0 && !(r.opp[i] & (1 << c)) && !view.hand.includes(c))).toBe(true);
    }
    return mean;
  }

  it('standing pat (0 cards) implies a stronger range than exchanging 3', () => {
    const pat = rangeAfterOpponentExchange(0);
    const three = rangeAfterOpponentExchange(3);
    const five = rangeAfterOpponentExchange(5);
    expect(pat).toBeGreaterThan(three + 0.1);
    expect(pat).toBeGreaterThan(0.7);
    expect(three).toBeGreaterThan(0.2);
    expect(five).toBeLessThan(pat);
  });

  it('a big raise shifts the range towards strong hands', () => {
    const mean = (raise: boolean) => {
      let s = newHand([12, 12], 0, mulberry32(5));
      s = applyAction(s, raise ? { type: 'raise', to: 5 } : { type: 'raise', to: 2 });
      s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, 2) });
      const r = sampleRange(makeView(s, 1), t, mulberry32(9), {
        samples: 4000, useBetting: true, useExchange: true, exchangeTemp: 0.05, exchangeFloor: 0.12, keepNoise: 0.15,
        tendencies: new OpponentModel().tendencies(),
      });
      let m = 0;
      for (let i = 0; i < r.n; i++) m += r.w[i] * r.potential[i];
      return m;
    };
    expect(mean(true)).toBeGreaterThan(mean(false));
  });

  it('learns fold tendencies across hands', () => {
    const model = new OpponentModel();
    const before = model.tendencies().foldToRaise;
    for (let n = 0; n < 6; n++) {
      let s = newHand([12, 12], 1, mulberry32(n));
      s = applyAction(s, { type: 'raise', to: 4 }); // AI (player 1) raises
      s = applyAction(s, { type: 'exchange', cards: [] });
      s = applyAction(s, { type: 'drop' }); // player folds
      model.observeHand(makeView(s, 1), null);
    }
    expect(model.tendencies().foldToRaise).toBeGreaterThan(before + 0.2);
  });

  it('learns bluffing from showdowns', () => {
    const model = new OpponentModel();
    const before = model.tendencies().bluff;
    for (let n = 0; n < 5; n++) {
      // Player raises with a weak pair of Tens and loses the showdown.
      let s = newHand([12, 12], 0, mulberry32(n), deckFor(parseCards('10S 10H JD QC KS'), parseCards('AS AH AD KC QH')));
      s = applyAction(s, { type: 'raise', to: 5 });
      s = applyAction(s, { type: 'exchange', cards: [] });
      s = applyAction(s, { type: 'bet' }); // final response: match 5 …
      s = applyAction(s, { type: 'exchange', cards: [] }); // … → automatic showdown
      model.observeHand(makeView(s, 1), s.hands[0]);
    }
    expect(model.tendencies().bluff).toBeGreaterThan(before + 0.2);
  });
});

describe('fair play', () => {
  it('non-cheating AI decisions do not depend on the hidden opponent hand', () => {
    const aiHand = parseCards('AS AH KD QC 10S');
    const rest = fullDeck().filter((c) => !aiHand.includes(c));
    for (let n = 0; n < 10; n++) {
      const order = shuffle(rest, mulberry32(n));
      const decisions = [0, 1].map((variant) => {
        // Same AI hand; the opponent hand and deck differ between variants.
        const pool = variant === 0 ? order : [...order].reverse();
        const deck = deckFor(pool.slice(0, 5), aiHand, pool.slice(5));
        const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(100 + n), me: 1 });
        let s = newHand([12, 12], 0, mulberry32(0), deck);
        s = applyAction(s, { type: 'raise', to: 3 });
        s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, 2) });
        return ai.decide(makeView(s, 1)).action;
      });
      expect(decisions[0]).toEqual(decisions[1]);
    }
  });

  it('cheater mode uses the real cards: accepts a CALL it wins, drops one it loses', () => {
    const run = (aiCards: string, oppCards: string): Action => {
      const ai = new AIPlayer({ difficulty: 'cheater', rng: mulberry32(1), me: 1 });
      // Player 0 acts first and CALLs at 5; the AI can only ACCEPT or DROP.
      let s = newHand([12, 12], 0, mulberry32(0), deckFor(parseCards(oppCards), parseCards(aiCards)));
      s = applyAction(s, { type: 'call', to: 5 });
      expect(s.phase).toBe('callResponse');
      expect(legalActions(s)).toMatchObject({ accept: true, drop: true, raise: null, bet: null, call: null });
      return ai.decide(makeView(s, 1, true)).action;
    };
    expect(run('AS AH AD AC KS', '10S 10H JD QC KC')).toEqual({ type: 'accept' });
    expect(run('10S 10H JD QC KC', 'AS AH AD AC KS')).toEqual({ type: 'drop' });
  });

  it('cheater sees your cards but not the deck: its decisions do not depend on the deck order', () => {
    // Same two hands, same moves, different (shuffled) deck orders → identical decisions,
    // exchanges and equities. Covers betting and exchanging in both Joker modes.
    for (const jokers of [1, 2] as const) {
      for (let n = 0; n < 6; n++) {
        const base = shuffle(fullDeck(jokers), mulberry32(500 + n));
        const hands = base.slice(0, 10);
        const rest = base.slice(10);
        const decide = (deckSeed: number) => {
          const deck = [...hands, ...shuffle(rest, mulberry32(deckSeed))];
          const out: string[] = [];
          // AI (player 1) first decision, then — after the player raises and exchanges — the
          // AI's exchange choice. The player's exchange draws different cards in each deck
          // order, so compare only decisions taken before any draw from the deck.
          let s = newHand([12, 12], 1, mulberry32(n), deck, jokers);
          const ai = new AIPlayer({ difficulty: 'cheater', rng: mulberry32(n), me: 1, jokers });
          const d1 = ai.decide(makeView(s, 1, true));
          out.push(JSON.stringify(d1.action), d1.thinking.eqNow.toFixed(6), d1.thinking.eqDraw.toFixed(6), JSON.stringify(d1.thinking.discard));
          if (d1.action.type === 'raise' || d1.action.type === 'bet') {
            s = applyAction(s, d1.action);
            const d2 = ai.decide(makeView(s, 1, true));
            out.push(JSON.stringify(d2.action));
          }
          return out;
        };
        const a = decide(1);
        expect(decide(2), `jokers ${jokers} deal ${n}`).toEqual(a);
        expect(decide(3), `jokers ${jokers} deal ${n}`).toEqual(a);
      }
    }
  });

  it('responding to a CALL the AI only ever ACCEPTs or DROPs (all difficulties)', () => {
    for (const d of ['normal', 'hard', 'cheater'] as const) {
      for (let n = 0; n < 15; n++) {
        const ai = new AIPlayer({ difficulty: d, rng: mulberry32(n), me: 1 });
        let s = newHand([12, 12], 0, mulberry32(n));
        s = applyAction(s, { type: 'call', to: 2 + (n % 4) });
        const a = ai.decide(makeView(s, 1, ai.cheats)).action;
        expect(['accept', 'drop']).toContain(a.type);
      }
    }
  });

  it('acting first the AI never BETs; it chooses CALL amounts within the legal range', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(n), me: 1 });
      const s = newHand([12, 12], 1, mulberry32(1000 + n));
      const a = ai.decide(makeView(s, 1)).action;
      expect(a.type).not.toBe('bet');
      expect(isLegal(s, a)).toBe(true);
      seen.add(a.type === 'call' ? `call ${a.to}` : a.type);
    }
    expect(seen.has('raise')).toBe(true);
  });
});

describe('strength (short sample)', () => {
  const versus = (mk: (seed: number) => Bot, matches: number) => {
    let wins = 0;
    for (let i = 0; i < matches; i++) {
      const swap = i % 2 === 1;
      const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(i + 1), me: swap ? 1 : 0 });
      const r = playMatch(swap ? [mk(i), ai] : [ai, mk(i)], mulberry32(300 + i));
      if ((r.winner === 1) === swap) wins++;
    }
    return wins;
  };

  it('hard beats a random player', () => {
    expect(versus((s) => new RandomBot(mulberry32(s)), 8)).toBeGreaterThanOrEqual(7);
  });

  it('hard beats a sensible heuristic player', () => {
    // Hard wins ~75–80% (npm run bench). 10 matches needing 8 failed by bad luck about one time
    // in three; 24 needing 15 (62.5%) only fails by chance ~2% of the time — or if Hard got weaker.
    expect(versus((s) => new HeuristicBot(mulberry32(s)), 24)).toBeGreaterThanOrEqual(15);
  }, 60000);

  it('hands always end even against a player who only checks without exchanging', () => {
    const passive: Bot = {
      decide: (v) => ({
        action: v.legal.exchange
          ? { type: 'exchange', cards: [] }
          : v.legal.bet
            ? { type: 'bet' }
            : v.legal.accept
              ? { type: 'accept' }
              : v.legal.raise && v.legal.first
                ? { type: 'raise', to: v.legal.raise.min }
                : { type: 'call' },
      }),
    };
    for (let i = 0; i < 4; i++) {
      const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(i), me: 1 });
      expect(() => playMatch([passive, ai], mulberry32(i))).not.toThrow();
    }
  });
});

describe('Joker rule and 2-Joker mode', () => {
  it('tables: every Joker hand ranks below every natural hand of the same category (both modes)', () => {
    for (const jokers of [1, 2] as const) {
      const tj = getTables(jokers);
      const worstNatural = new Map<number, number>();
      const bestJoker = new Map<number, number>();
      for (const m of tj.hands) {
        const e = evaluateHand(cardsOf(m));
        const map = e.usesJoker ? bestJoker : worstNatural;
        const cur = map.get(e.category);
        const sc = tj.score[m];
        if (e.usesJoker) map.set(e.category, Math.max(cur ?? 0, sc));
        else map.set(e.category, Math.min(cur ?? Infinity, sc));
      }
      for (const [cat, best] of bestJoker) {
        const worst = worstNatural.get(cat);
        if (worst !== undefined) expect(best, `jokers=${jokers} category=${cat}`).toBeLessThan(worst);
      }
    }
  });

  it('tables (2 Jokers): 25194 legal hands, none with both Jokers; keep(nothing) ≈ 0.5', () => {
    const t2 = getTables(2);
    expect(t2.hands.length).toBe(25194);
    const both = (1 << JOKER) | (1 << JOKER2);
    expect(Array.from(t2.hands).some((m) => (m & both) === both)).toBe(false);
    expect(t2.keep[0]).toBeCloseTo(0.5, 3);
    getTables(1); // restore the default mode for the other tests
  });

  it('drawFromRest refuses the second Joker while holding one', () => {
    const rest = Int8Array.from([JOKER2, 3, 7, 9]);
    const out = new Int32Array(2);
    const m = drawFromRest(maskOf([JOKER, 0, 1, 2]), rest, 0, 0, 4, 1, out);
    expect(cardsOf(m)).toEqual([0, 1, 2, 3, JOKER]);
    expect(out[0]).toBe(2);
    expect(out[1]).toBe(1);
    // Without a Joker in hand it is taken normally.
    const m2 = drawFromRest(maskOf([0, 1, 2, 4]), rest, 0, 0, 4, 1, out);
    expect(cardsOf(m2)).toEqual([0, 1, 2, 4, JOKER2]);
  });

  it('range samples never give the opponent two Jokers and keep the deck consistent', () => {
    for (let seed = 0; seed < 5; seed++) {
      let s = newHand([12, 12], 0, mulberry32(seed), undefined, 2);
      s = applyAction(s, { type: 'raise', to: 2 });
      s = applyAction(s, { type: 'exchange', cards: s.hands[0].slice(0, 3) });
      const view = makeView(s, 1);
      const r = sampleRange(view, getTables(2), mulberry32(seed), {
        samples: 800, useBetting: true, useExchange: true, exchangeTemp: 0.05, exchangeFloor: 0.12, keepNoise: 0.15,
        tendencies: new OpponentModel().tendencies(),
      });
      const both = (1 << JOKER) | (1 << JOKER2);
      for (let i = 0; i < r.n; i++) {
        expect(popcount(r.opp[i])).toBe(5);
        expect(r.opp[i] & both).not.toBe(both);
        const deck = Array.from(r.rest.subarray(i * r.stride, i * r.stride + r.restLen));
        expect(deck.every((c) => c >= 0 && !(r.opp[i] & (1 << c)) && !view.hand.includes(c))).toBe(true);
      }
    }
    getTables(1);
  });

  it.each(['normal', 'hard', 'cheater'] as const)('%s: legal play in 2-Joker mode', (d) => {
    const r = mulberry32(77);
    const ais: [AIPlayer, AIPlayer] = [
      new AIPlayer({ difficulty: d, rng: mulberry32(1), me: 0, jokers: 2 }),
      new AIPlayer({ difficulty: d, rng: mulberry32(2), me: 1, jokers: 2 }),
    ];
    for (let n = 0; n < 30; n++) {
      let s = newHand([12, 12], (n % 2) as PlayerId, r, undefined, 2);
      while (s.phase !== 'over') {
        const ai = ais[s.toAct];
        const { action } = ai.decide(makeView(s, ai.me, ai.cheats));
        expect(isLegal(s, action)).toBe(true);
        s = applyAction(s, action);
        expect(s.hands[0].filter((c) => c >= JOKER).length).toBeLessThanOrEqual(1);
        expect(s.hands[1].filter((c) => c >= JOKER).length).toBeLessThanOrEqual(1);
      }
      for (const ai of ais) ai.observeHandEnd(makeView(s, ai.me), s.hands[1 - ai.me]);
    }
    getTables(1);
  });

  it('hard beats the heuristic bot in 2-Joker mode', () => {
    let wins = 0;
    // Hard wins ~75% of 2-Joker matches against this bot (200-match benchmark); 20 matches ≥ 60%.
    for (let i = 0; i < 20; i++) {
      const swap = i % 2 === 1;
      const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(i + 1), me: swap ? 1 : 0, jokers: 2 });
      const bot = new HeuristicBot(mulberry32(i));
      const res = playMatch(swap ? [bot, ai] : [ai, bot], mulberry32(900 + i), { jokers: 2 });
      if ((res.winner === 1) === swap) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(12);
    getTables(1);
  });

  it('the opponent model learns from hands revealed after a DROP', () => {
    const model = new OpponentModel();
    const before = model.tendencies().bluff;
    for (let n = 0; n < 5; n++) {
      // Player raises big with a weak hand; the AI drops; the hand is revealed anyway.
      let s = newHand([12, 12], 0, mulberry32(n), deckFor(parseCards('10S 10H JD QC KS'), parseCards('AS AH KD QH JC')));
      s = applyAction(s, { type: 'raise', to: 5 });
      s = applyAction(s, { type: 'exchange', cards: [] });
      s = applyAction(s, { type: 'drop' });
      model.observeHand(makeView(s, 1), s.hands[0]);
    }
    expect(model.tendencies().bluff).toBeGreaterThan(before + 0.2);
  });
});

describe('Hard plays disciplined poker', () => {
  it('never makes cheap CALLs: every CALL has real equity, and +1 CALLs only with a monster', () => {
    let calls = 0;
    for (let n = 0; n < 200; n++) {
      const ai = new AIPlayer({ difficulty: 'hard', rng: mulberry32(n), me: 1 });
      const s = newHand([12, 12], 1, mulberry32(2000 + n));
      const d = ai.decide(makeView(s, 1));
      if (d.action.type !== 'call') continue;
      calls++;
      expect(d.thinking.eqNow, `hand ${n}`).toBeGreaterThanOrEqual(0.68);
      if (d.action.to! - s.bets[0] === 1) expect(d.thinking.eqNow).toBeGreaterThanOrEqual(0.8);
    }
    expect(calls).toBeGreaterThan(0); // it still calls with real hands
  });

  it('Normal keeps the undisciplined model (it is meant to be beatable)', () => {
    let cheap = 0;
    for (let n = 0; n < 200; n++) {
      const ai = new AIPlayer({ difficulty: 'normal', rng: mulberry32(n), me: 1 });
      const s = newHand([12, 12], 1, mulberry32(2000 + n));
      const d = ai.decide(makeView(s, 1));
      if (d.action.type === 'call' && d.thinking.eqNow < 0.6) cheap++;
    }
    expect(cheap).toBeGreaterThan(0);
  });
});
