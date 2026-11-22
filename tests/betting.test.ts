import { describe, expect, it } from 'vitest';
import {
  type Action,
  type Card,
  type HandState,
  IllegalActionError,
  JOKER,
  JOKER2,
  MAX_EXCHANGE_ROUNDS,
  type PlayerId,
  applyAction,
  coinFlip,
  coinsOf,
  firstPlayerFromCoin,
  fullDeck,
  isJoker,
  isLegal,
  legalActions,
  makeView,
  matchAct,
  mulberry32,
  newHand,
  newMatch,
  parseCards,
  startHand,
} from '../src/engine';

const rng = mulberry32(1);

/** Build a deck so player 0 gets h0, player 1 gets h1 (firstToAct deals first), then `top`. */
function stackedDeck(h0: string, h1: string, first: PlayerId = 0, top?: string): Card[] {
  const a = parseCards(first === 0 ? h0 : h1);
  const b = parseCards(first === 0 ? h1 : h0);
  const dealt: Card[] = [];
  for (let i = 0; i < 5; i++) dealt.push(a[i], b[i]);
  const topCards = top ? parseCards(top) : [];
  const rest = fullDeck().filter((c) => !dealt.includes(c) && !topCards.includes(c));
  return [...dealt, ...topCards, ...rest];
}

const H0 = 'AS AH KD QC 10S'; // pair of Aces
const H1 = 'KS KH JD JC 10H'; // two pair K/J

function start(coins: [number, number] = [12, 12], first: PlayerId = 0, top?: string): HandState {
  return newHand(coins, first, rng, stackedDeck(H0, H1, first, top));
}

const act = (s: HandState, ...actions: Action[]) => actions.reduce(applyAction, s);
const ex = (cards: Card[] = []): Action => ({ type: 'exchange', cards });
const raise = (to: number): Action => ({ type: 'raise', to });
const bet = (to?: number): Action => ({ type: 'bet', to });
const call = (to?: number): Action => ({ type: 'call', to });

function checkInvariants(s: HandState, totalCoins: number) {
  const all = [...s.hands[0], ...s.hands[1], ...s.deck, ...s.discards[0], ...s.discards[1]];
  const size = s.jokers === 2 ? 22 : 21;
  expect(all.length).toBe(size);
  expect(new Set(all).size).toBe(size);
  expect(s.hands[0]).toHaveLength(5);
  expect(s.hands[1]).toHaveLength(5);
  expect(s.hands[0].filter(isJoker).length).toBeLessThanOrEqual(1);
  expect(s.hands[1].filter(isJoker).length).toBeLessThanOrEqual(1);
  const coins = coinsOf(s);
  expect(coins[0] + coins[1]).toBe(totalCoins);
  expect(s.stacks[0]).toBeGreaterThanOrEqual(0);
  expect(s.stacks[1]).toBeGreaterThanOrEqual(0);
  expect(Math.max(...s.bets)).toBeLessThanOrEqual(s.cap);
}

describe('new hand', () => {
  it('antes 1 each, deals 5 each (dealt order), leaves 11 in the deck', () => {
    const s = start();
    expect(s.bets).toEqual([1, 1]);
    expect(s.stacks).toEqual([11, 11]);
    expect(s.deck).toHaveLength(11);
    expect(s.hands[0]).toEqual(parseCards(H0));
    expect(s.hands[1]).toEqual(parseCards(H1));
    expect(s.toAct).toBe(0);
    expect(s.phase).toBe('turn');
    expect(s.cap).toBe(5);
    expect(s.exchangeRounds).toBe(0);
    checkInvariants(s, 24);
  });

  it('caps the bet by the coins of the poorer player', () => {
    expect(start([3, 21]).cap).toBe(3);
    expect(start([21, 2]).cap).toBe(2);
    expect(start([1, 23]).cap).toBe(1);
  });

  it('the chosen player acts first', () => {
    expect(start([12, 12], 1).toAct).toBe(1);
  });
});

describe('acting first: only RAISE, CALL, DROP', () => {
  it('legal actions — no BET at all', () => {
    const l = legalActions(start());
    expect(l.first).toBe(true);
    expect(l.bet).toBeNull();
    expect(l.raise).toEqual({ min: 2, max: 5 });
    expect(l.call).toEqual({ min: 2, max: 5 }); // CALL must add at least 1 over the ante
    expect(l).toMatchObject({ drop: true, accept: false, exchange: null });
    expect(() => applyAction(start(), bet())).toThrow(IllegalActionError);
    expect(() => applyAction(start(), bet(2))).toThrow(IllegalActionError);
  });

  it('RAISE sets the total, then the same player exchanges', () => {
    let s = act(start(), raise(3));
    expect(s.phase).toBe('exchange');
    expect(s.toAct).toBe(0);
    expect(s.bets).toEqual([3, 1]);
    expect(s.stacks).toEqual([9, 11]);
    expect(s.exchangeRounds).toBe(1);
    expect(legalActions(s).exchange).toEqual({ max: 5 });
    s = act(s, ex());
    expect(s.phase).toBe('turn');
    expect(s.toAct).toBe(1);
  });

  it('RAISE / CALL bounds: min and max per action', () => {
    const s = start();
    expect(isLegal(s, raise(1))).toBe(false);
    expect(isLegal(s, raise(2))).toBe(true);
    expect(isLegal(s, raise(5))).toBe(true);
    expect(isLegal(s, raise(6))).toBe(false);
    expect(isLegal(s, raise(2.5))).toBe(false);
    expect(isLegal(s, call(0))).toBe(false);
    expect(isLegal(s, call(1))).toBe(false); // CALL min = N+1
    expect(isLegal(s, call(2))).toBe(true);
    expect(isLegal(s, call(5))).toBe(true);
    expect(isLegal(s, call(6))).toBe(false);
  });
});

describe('responding to a bet N', () => {
  const afterRaise3 = () => act(start(), raise(3), ex()); // P1 responds to N = 3

  it('legal actions: BET N..cap, RAISE N+1..cap, CALL N+1..cap, DROP', () => {
    const l = legalActions(afterRaise3());
    expect(l.first).toBe(false);
    expect(l.bet).toEqual({ min: 3, max: 5 });
    expect(l.raise).toEqual({ min: 4, max: 5 });
    expect(l.call).toEqual({ min: 4, max: 5 });
    expect(l.drop).toBe(true);
    expect(l.accept).toBe(false);
  });

  it('BET at N matches, then exchange', () => {
    const s = act(afterRaise3(), bet(3));
    expect(s.bets).toEqual([3, 3]);
    expect(s.phase).toBe('exchange');
    expect(s.toAct).toBe(1);
    expect(s.history[s.history.length - 1].action).toEqual({ type: 'bet', to: 3 });
  });

  it('BET defaults to N (match) when no amount is given', () => {
    expect(act(afterRaise3(), bet()).bets).toEqual([3, 3]);
  });

  it('BET above N and RAISE overlap: both set the same total', () => {
    const viaBet = act(afterRaise3(), bet(5), ex());
    const viaRaise = act(afterRaise3(), raise(5), ex());
    expect(viaBet.bets).toEqual(viaRaise.bets);
    expect(viaBet.bets).toEqual([3, 5]);
    expect(legalActions(viaBet)).toEqual(legalActions(viaRaise));
  });

  it('rejects amounts outside each action’s range', () => {
    const s = afterRaise3();
    expect(isLegal(s, bet(2))).toBe(false); // below N
    expect(isLegal(s, raise(3))).toBe(false); // RAISE must exceed N
    expect(isLegal(s, call(3))).toBe(false); // CALL must add at least 1
    expect(isLegal(s, call(4))).toBe(true);
    expect(isLegal(s, bet(6))).toBe(false);
    expect(isLegal(s, raise(6))).toBe(false);
  });

  it('after BET/RAISE leaves bets unequal, the other player must respond', () => {
    const s = act(afterRaise3(), raise(4), ex());
    expect(s.toAct).toBe(0);
    expect(legalActions(s).bet).toEqual({ min: 4, max: 5 });
    expect(legalActions(s).raise).toEqual({ min: 5, max: 5 });
  });

  it('equal bets: the next player still responds (BET at N = stay and exchange)', () => {
    const s = act(afterRaise3(), bet(3), ex());
    expect(s.toAct).toBe(0);
    expect(legalActions(s).bet).toEqual({ min: 3, max: 5 });
    const s2 = act(s, bet(3), ex([s.hands[0][0]]));
    expect(s2.bets).toEqual([3, 3]);
    expect(s2.discards[0]).toHaveLength(1);
  });

  it('one below the cap: CALL can only be the cap', () => {
    const s = act(start(), raise(4), ex());
    expect(legalActions(s).call).toEqual({ min: 5, max: 5 });
  });
});

describe('CALL', () => {
  it('the caller chooses the amount (N..cap); the opponent may only ACCEPT or DROP', () => {
    const s = act(start(), raise(2), ex(), call(4)); // P1 calls at 4 over N = 2
    expect(s.bets).toEqual([2, 4]);
    expect(s.phase).toBe('callResponse');
    expect(s.toAct).toBe(0);
    expect(s.caller).toBe(1);
    const l = legalActions(s);
    expect(l).toMatchObject({ accept: true, drop: true, bet: null, raise: null, call: null, exchange: null });
  });

  it('a CALL can not be raised and nobody can exchange after it', () => {
    const s = act(start(), call(2));
    for (const a of [raise(3), raise(5), bet(2), bet(3), call(3), ex([]), ex([s.hands[1][0]])]) {
      expect(isLegal(s, a), JSON.stringify(a)).toBe(false);
      expect(() => applyAction(s, a)).toThrow(IllegalActionError);
    }
  });

  it('ACCEPT matches the called amount → showdown with the current cards', () => {
    const s0 = act(start(), raise(2), ex(), call(4));
    const s = act(s0, { type: 'accept' });
    expect(s.phase).toBe('over');
    expect(s.bets).toEqual([4, 4]);
    expect(s.hands).toEqual(s0.hands);
    expect(s.outcome).toMatchObject({ kind: 'showdown', winner: 1, pot: 8, gain: 4 });
    expect(s.outcome!.coinsAfter).toEqual([8, 16]);
    checkInvariants(s, 24);
  });

  it('DROP after a CALL: the caller takes everything bet', () => {
    const s = act(start(), raise(2), ex(), call(5), { type: 'drop' });
    expect(s.outcome).toMatchObject({ kind: 'drop', winner: 1, loser: 0, pot: 7, gain: 2 });
    expect(s.outcome!.coinsAfter).toEqual([10, 14]);
  });

  it('first actor: the first CALL is 2 or more (both anted 1)', () => {
    expect(isLegal(start(), call(1))).toBe(false);
    const s = act(start(), call(2), { type: 'accept' });
    expect(s.outcome).toMatchObject({ kind: 'showdown', pot: 4, gain: 2 });
  });

  it('CALL defaults to N+1', () => {
    expect(act(start(), raise(3), ex(), call()).bets).toEqual([3, 4]);
  });
});

describe('final round (a BET/RAISE reaches the cap)', () => {
  it('RAISE to 5: the raiser exchanges, then the opponent gets one final turn (BET 5 or DROP)', () => {
    let s = act(start(), raise(5));
    expect(s.phase).toBe('exchange');
    expect(legalActions(s).exchange).toEqual({ max: 5 });
    s = act(s, ex([s.hands[0][4]]));
    expect(s.phase).toBe('final');
    expect(s.toAct).toBe(1);
    const l = legalActions(s);
    expect(l).toMatchObject({ final: true, bet: { min: 5, max: 5 }, raise: null, call: null, drop: true, accept: false });
    for (const a of [call(5), raise(5), bet(4)]) expect(isLegal(s, a)).toBe(false);
  });

  it('the final response matches 5, exchanges 0–5, then the showdown is automatic', () => {
    let s = act(start(), raise(5), ex(), bet());
    expect(s.bets).toEqual([5, 5]);
    expect(legalActions(s).exchange).toEqual({ max: 5 });
    s = act(s, ex(s.hands[1].slice(0, 3)));
    expect(s.phase).toBe('over');
    expect(s.outcome).toMatchObject({ kind: 'showdown', pot: 10, gain: 5 });
    expect(s.discards[1]).toHaveLength(3);
    checkInvariants(s, 24);
  });

  it('exactly one final response: nobody acts again after it', () => {
    const s = act(start(), raise(5), ex(), bet(), ex());
    expect(legalActions(s)).toMatchObject({ drop: false, bet: null, raise: null, call: null, accept: false, exchange: null });
    expect(s.history.filter((e) => e.phase === 'final')).toHaveLength(1);
  });

  it('DROP is allowed as the final response', () => {
    const s = act(start(), raise(5), ex(), { type: 'drop' });
    expect(s.outcome).toMatchObject({ kind: 'drop', winner: 0, loser: 1, gain: 1 });
  });

  it('BET above N to the cap starts the final round too', () => {
    let s = act(start(), raise(3), ex(), bet(5), ex());
    expect(s.phase).toBe('final');
    expect(s.toAct).toBe(0);
    s = act(s, bet(), ex());
    expect(s.outcome!.kind).toBe('showdown');
    expect(s.bets).toEqual([5, 5]);
  });

  it('CALL is not available when the opponent is at the cap', () => {
    const s = act(start(), raise(5), ex());
    expect(legalActions(s).call).toBeNull();
    expect(isLegal(s, call())).toBe(false);
  });

  it('works the same in 2-Joker mode', () => {
    let s = newHand([12, 12], 1, mulberry32(4), undefined, 2);
    s = act(s, raise(5), ex(s.hands[1].slice(0, 2)), bet(), ex(s.hands[0].slice(0, 5)));
    expect(s.outcome!.kind).toBe('showdown');
    checkInvariants(s, 24);
  });
});

describe('coin caps', () => {
  it('amounts never exceed the poorer player’s coins', () => {
    const s = start([3, 12]);
    expect(legalActions(s).raise).toEqual({ min: 2, max: 3 });
    expect(legalActions(s).call).toEqual({ min: 2, max: 3 });
    expect(isLegal(s, raise(4))).toBe(false);
    // Reaching this (lower) cap also starts the final round.
    const s2 = act(s, raise(3), ex());
    expect(s2.phase).toBe('final');
    expect(legalActions(s2)).toMatchObject({ final: true, raise: null, call: null, bet: { min: 3, max: 3 } });
  });

  it('with cap 1 (a player has one coin) the hand is a final round from the start', () => {
    let s = start([1, 12]);
    expect(s.phase).toBe('final');
    expect(legalActions(s)).toMatchObject({ final: true, raise: null, call: null, bet: { min: 1, max: 1 }, drop: true });
    s = act(s, bet(), ex([s.hands[0][0]])); // first player: stay + exchange
    expect(s.phase).toBe('final');
    expect(s.toAct).toBe(1);
    s = act(s, bet(), ex()); // second player: stay + exchange
    expect(s.phase).toBe('over');
    expect(s.outcome!.kind).toBe('showdown');
    expect(s.outcome!.pot).toBe(2);
  });
});

describe('exchange', () => {
  it('replaces discarded cards in place from the top of the deck', () => {
    let s = start([12, 12], 0, 'AD AC');
    const hand = s.hands[0];
    const kd = parseCards('KD')[0];
    const qc = parseCards('QC')[0];
    s = act(s, raise(2), ex([kd, qc]));
    // Dealt order AS AH KD QC 10S: KD (slot 2) gets the top card, QC (slot 3) the next.
    expect(hand.indexOf(kd)).toBe(2);
    expect(s.hands[0][2]).toBe(parseCards('AD')[0]);
    expect(s.hands[0][3]).toBe(parseCards('AC')[0]);
    expect(s.discards[0]).toEqual([kd, qc]);
    expect(s.deck).toHaveLength(9);
    checkInvariants(s, 24);
  });

  it('discarded cards never return to the deck', () => {
    let s = act(start(), raise(2));
    const discarded: Card[] = [];
    while (s.deck.length > 0) {
      const n = Math.min(5, s.deck.length);
      const cards = s.hands[s.toAct].slice(0, n);
      discarded.push(...cards);
      s = act(s, ex(cards));
      for (const c of discarded) {
        expect(s.deck).not.toContain(c);
        expect(s.hands[0]).not.toContain(c);
        expect(s.hands[1]).not.toContain(c);
      }
      checkInvariants(s, 24);
      if (s.deck.length) s = act(s, bet());
    }
    expect(discarded).toHaveLength(11);
  });

  it('cannot replace more cards than the deck holds', () => {
    let s = act(start(), raise(2), ex(start().hands[0].slice(0, 5))); // deck 6
    s = act(s, bet(), ex(s.hands[1].slice(0, 5))); // deck 1
    s = act(s, bet());
    expect(legalActions(s).exchange).toEqual({ max: 1 });
    expect(() => applyAction(s, ex(s.hands[0].slice(0, 2)))).toThrow(IllegalActionError);
  });

  it('empty deck: BET/RAISE still allowed, with 0-card exchanges', () => {
    let s = act(start(), raise(2), ex(start().hands[0].slice(0, 5)));
    s = act(s, bet(), ex(s.hands[1].slice(0, 5)));
    s = act(s, bet(), ex(s.hands[0].slice(0, 1)));
    expect(s.deck).toHaveLength(0);
    expect(legalActions(s).bet).toEqual({ min: 2, max: 5 });
    s = act(s, raise(3));
    expect(legalActions(s).exchange).toEqual({ max: 0 });
    expect(() => applyAction(s, ex([s.hands[1][0]]))).toThrow(IllegalActionError);
    s = act(s, ex());
    expect(s.phase).toBe('turn');
  });

  it('rejects cards not in hand and duplicates; exchange only right after BET/RAISE', () => {
    const s = act(start(), raise(2));
    expect(() => applyAction(s, ex([s.hands[1][0]]))).toThrow(IllegalActionError);
    expect(() => applyAction(s, ex([s.hands[0][0], s.hands[0][0]]))).toThrow(IllegalActionError);
    expect(() => applyAction(start(), ex([]))).toThrow(IllegalActionError);
  });
});

describe('termination', () => {
  it(`after ${MAX_EXCHANGE_ROUNDS} exchange rounds only CALL and DROP remain`, () => {
    let s = act(start(), raise(2), ex());
    for (let i = 1; i < MAX_EXCHANGE_ROUNDS; i++) s = act(s, bet(), ex());
    expect(s.exchangeRounds).toBe(MAX_EXCHANGE_ROUNDS);
    const l = legalActions(s);
    expect(l).toMatchObject({ bet: null, raise: null, drop: true });
    expect(l.call).toEqual({ min: 3, max: 5 });
  });

  it('random legal play keeps every invariant and always ends (both Joker modes)', () => {
    const r = mulberry32(99);
    for (let n = 0; n < 4000; n++) {
      const coins: [number, number] = [1 + Math.floor(r() * 12), 1 + Math.floor(r() * 12)];
      const total = coins[0] + coins[1];
      let s = newHand(coins, r() < 0.5 ? 0 : 1, r, undefined, n % 2 === 0 ? 1 : 2);
      let steps = 0;
      while (s.phase !== 'over') {
        const l = legalActions(s);
        const pick = (x: { min: number; max: number }) => x.min + Math.floor(r() * (x.max - x.min + 1));
        const options: Action[] = [];
        if (l.exchange) options.push(ex(s.hands[s.toAct].slice(0, Math.floor(r() * (l.exchange.max + 1)))));
        else {
          // Mostly passive (BET at N): the round cap must still end every hand.
          if (l.bet) options.push(bet(), bet(), bet(pick(l.bet)));
          if (l.raise) options.push(raise(pick(l.raise)));
          if (l.call && r() < 0.1) options.push(call(pick(l.call)));
          if (l.drop && r() < 0.05) options.push({ type: 'drop' });
          if (l.accept) options.push({ type: 'accept' });
          if (!options.length) options.push(l.call ? call(pick(l.call)) : { type: 'drop' });
        }
        s = applyAction(s, options[Math.floor(r() * options.length)]);
        checkInvariants(s, total);
        expect(++steps).toBeLessThan(2 * MAX_EXCHANGE_ROUNDS + 4);
      }
      const o = s.outcome!;
      expect(o.coinsAfter[o.winner]).toBe(coins[o.winner] + o.gain);
      expect(o.coinsAfter[o.loser]).toBe(coins[o.loser] - o.gain);
    }
  });
});

describe('DROP', () => {
  it('opponent takes all coins bet this hand; hands are still evaluated for the reveal', () => {
    const s = act(start(), raise(4), ex(), { type: 'drop' });
    expect(s.outcome).toMatchObject({ kind: 'drop', winner: 0, loser: 1, pot: 5, gain: 1 });
    expect(s.outcome!.coinsAfter).toEqual([13, 11]);
    expect(s.outcome!.evaluations.map((e) => e.cards)).toEqual([s.hands[0], s.hands[1]]);
    expect(s.outcome!.comparison.winner).toBe(1);
  });

  it('nothing is legal after the hand ends', () => {
    const s = act(start(), { type: 'drop' });
    expect(legalActions(s)).toMatchObject({ drop: false, bet: null, call: null, raise: null, accept: false });
    expect(() => applyAction(s, call(1))).toThrow(IllegalActionError);
  });
});

describe('2-Joker mode', () => {
  const real = (exclude: Card[]) => fullDeck(2).filter((c) => !isJoker(c) && !exclude.includes(c));

  it('the deck has 22 cards and both Jokers', () => {
    const s = newHand([12, 12], 0, mulberry32(3), undefined, 2);
    checkInvariants(s, 24);
    expect([...s.hands[0], ...s.hands[1], ...s.deck]).toEqual(expect.arrayContaining([JOKER, JOKER2]));
    expect(s.deck).toHaveLength(12);
  });

  it('deal: a player who holds a Joker gets the next card; the refused Joker goes back at a random position', () => {
    const positions = new Set<number>();
    for (let seed = 0; seed < 30; seed++) {
      const r = real([]);
      const order = [JOKER, r[0], JOKER2, r[1], r[2], r[3], r[4], r[5], r[6], r[7], ...r.slice(8)];
      const s = newHand([12, 12], 0, mulberry32(seed), order, 2);
      expect(s.hands[0]).toContain(JOKER);
      expect(s.hands[0]).not.toContain(JOKER2);
      expect(s.hands[0]).toContain(r[1]);
      positions.add(s.deck.indexOf(JOKER2));
      checkInvariants(s, 24);
    }
    expect(positions.size).toBeGreaterThan(3);
  });

  /** P0 holds JK; the deck (after the deal) starts with `top`. */
  function withJoker(top: Card[], seed = 1): HandState {
    const r = real(top);
    const h0 = [JOKER, r[0], r[1], r[2], r[3]];
    const h1 = [r[4], r[5], r[6], r[7], r[8]];
    const dealt: Card[] = [];
    for (let i = 0; i < 5; i++) dealt.push(h0[i], h1[i]);
    const rest = fullDeck(2).filter((c) => !dealt.includes(c) && !top.includes(c));
    return newHand([12, 12], 0, mulberry32(seed), [...dealt, ...top, ...rest], 2);
  }

  it('exchange: drawing the second Joker while holding one gives the next card instead', () => {
    const [x, y] = real([]).slice(-2);
    let s = withJoker([JOKER2, x, y]);
    const discard = s.hands[0].find((c) => !isJoker(c))!;
    const slot = s.hands[0].indexOf(discard);
    s = act(s, raise(2), ex([discard]));
    expect(s.hands[0][slot]).toBe(x);
    expect(s.deck).toContain(JOKER2);
    expect(s.deck).toHaveLength(11);
    checkInvariants(s, 24);
  });

  it('exchange: a player who discards their Joker may receive the other one', () => {
    const s = act(withJoker([JOKER2]), raise(2), ex([JOKER]));
    expect(s.hands[0]).toContain(JOKER2);
    expect(s.discards[0]).toEqual([JOKER]);
  });

  it('exchange: if only the refused Joker is left, the draw is skipped and the card stays', () => {
    let s = withJoker([...real([]).slice(9, 20)]);
    const nonJoker = (p: 0 | 1, n: number) => s.hands[p].filter((c) => !isJoker(c)).slice(0, n);
    s = act(s, raise(2), ex(nonJoker(0, 4))); // deck 8
    s = act(s, bet(), ex(nonJoker(1, 5))); // deck 3
    s = act(s, bet(), ex(nonJoker(0, 2))); // deck 1 = JK2
    expect(s.deck).toEqual([JOKER2]);
    s = act(s, bet(), ex());
    const before = s.hands[0];
    s = act(s, bet(), ex(nonJoker(0, 1)));
    expect(s.hands[0]).toEqual(before);
    expect(s.deck).toEqual([JOKER2]);
    expect(s.history[s.history.length - 1].count).toBe(0);
    checkInvariants(s, 24);
  });

  it('showdown where both players hold a Joker uses the normal tiebreak', () => {
    const h0 = parseCards('AS AH QD JC JK');
    const h1 = parseCards('KS KH QC JD JK2');
    const dealt: Card[] = [];
    for (let i = 0; i < 5; i++) dealt.push(h0[i], h1[i]);
    let s = newHand([12, 12], 0, rng, [...dealt, ...fullDeck(2).filter((c) => !dealt.includes(c))], 2);
    s = act(s, call(2), { type: 'accept' });
    expect(s.outcome).toMatchObject({ kind: 'showdown', winner: 0 });
    expect(s.outcome!.comparison.reason).toBe('rank');
  });
});

describe('match', () => {
  it('loser of the previous hand acts first', () => {
    let m = startHand(newMatch(0), rng);
    m = matchAct(m, { type: 'drop' }); // player 0 loses
    expect(m.nextFirst).toBe(0);
    m = startHand(m, rng);
    m = matchAct(m, raise(2));
    m = matchAct(m, ex());
    m = matchAct(m, { type: 'drop' }); // player 1 loses
    expect(m.nextFirst).toBe(1);
    expect(m.coins).toEqual([12, 12]);
    expect(startHand(m, rng).hand!.toAct).toBe(1);
  });

  it('ends when a player reaches 0 coins', () => {
    let m = startHand(newMatch(0, 2), rng, stackedDeck(H0, H1));
    expect(m.hand!.cap).toBe(2);
    m = matchAct(m, call(2)); // P0 calls at 2
    m = matchAct(m, { type: 'accept' }); // P1 matches → showdown, two pair wins
    expect(m.hand!.outcome!.winner).toBe(1);
    expect(m.coins).toEqual([0, 4]);
    expect(m.winner).toBe(1);
    expect(() => startHand(m, rng)).toThrow();
  });

  it('coin flip: heads → player first, tails → second', () => {
    expect(firstPlayerFromCoin('heads')).toBe(0);
    expect(firstPlayerFromCoin('tails')).toBe(1);
    const r = mulberry32(5);
    const heads = Array.from({ length: 1000 }, () => coinFlip(r)).filter((f) => f === 'heads').length;
    expect(heads).toBeGreaterThan(400);
    expect(heads).toBeLessThan(600);
  });
});

describe('player view', () => {
  it('hides the opponent hand and (face down) exchanged cards; shows amounts', () => {
    let s = act(start(), raise(3), ex([start().hands[0][0]]));
    s = act(s, bet(4), ex(s.hands[1].slice(0, 2)));
    const v = makeView(s, 0);
    expect(v.hand).toEqual(s.hands[0]);
    expect(v.oppHand).toBeUndefined();
    expect(v.oppDiscardCount).toBe(2);
    const oppBet = v.history.find((e) => e.player === 1 && e.type === 'bet')!;
    expect(oppBet.to).toBe(4);
    const oppExchange = v.history.find((e) => e.player === 1 && e.type === 'exchange')!;
    expect(oppExchange.count).toBe(2);
    expect(oppExchange.cards).toBeUndefined();
  });

  it('cheat view exposes the opponent hand and deck order', () => {
    const s = start();
    const v = makeView(s, 1, true);
    expect(v.oppHand).toEqual(s.hands[0]);
    expect(v.deckOrder).toEqual(s.deck);
  });

  it('legal actions are only given to the player to act', () => {
    const s = start();
    expect(makeView(s, 0).legal.raise).not.toBeNull();
    expect(makeView(s, 1).legal.raise).toBeNull();
  });
});
