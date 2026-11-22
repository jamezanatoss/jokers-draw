/**
 * Betting / exchange state machine for a single hand.
 *
 * "Bet" = a player's total coins committed this hand (ante included). cap = min(5, coins of
 * either player). N = the opponent's current bet (on your turn it is always >= your own bet).
 *
 * Phases
 *   turn          A normal turn.
 *                   First action of the hand: RAISE(to >= N+1), CALL(to >= N+1), DROP. No BET.
 *                   Responding:               BET(to >= N), RAISE(to >= N+1), CALL(to >= N+1), DROP.
 *                 All amounts are totals <= cap. BET above N and RAISE overlap on purpose
 *                 (as in the original game). BET and RAISE are followed by an exchange.
 *                 CALL must add at least 1, so it is unavailable when N is at the cap.
 *   exchange      Right after BET/RAISE the same player exchanges 0..min(5, deck) cards
 *                 (0 when the deck is empty). Then the other player's turn (or the final round).
 *   final         Final round, started when a BET/RAISE reaches the cap: the other player gets
 *                 exactly ONE turn — BET (match the cap) + exchange, or DROP — then an automatic
 *                 showdown. If the cap equals the ante (a player has a single coin), the hand
 *                 starts in the final round and each player gets one such turn.
 *   callResponse  The opponent CALLed at some amount A. No more exchanges for anyone and the
 *                 amount cannot be raised: ACCEPT (match A → showdown) or DROP.
 *   over          Hand finished (see `outcome`).
 *
 * Termination: after MAX_EXCHANGE_ROUNDS BET/RAISE rounds in a hand only CALL and DROP remain,
 * the final round is at most two turns, and every turn either ends the hand or uses up a round,
 * so every hand ends.
 *
 * Jokers: a player may never hold two Jokers (2-Joker mode). If a player who holds a Joker would
 * receive the other one (deal or exchange), they get the next card instead and that Joker goes
 * back into the remaining deck at a random position. If no other card is left, that draw is
 * skipped and the player keeps the card they meant to discard.
 *
 * All functions are pure: they return new state objects and never mutate inputs. Random choices
 * made after the deal use `seed`, which is stored in the state.
 */
import { type Card, HAND_SIZE, type JokerCount, fullDeck, isJoker } from './cards';
import { type Comparison, type Evaluation, compareEvaluations, evaluateHand } from './evaluate';
import { type Rng, shuffle, stepRandom } from './rng';

export type PlayerId = 0 | 1;
export const other = (p: PlayerId): PlayerId => (p === 0 ? 1 : 0);

export const MAX_BET = 5;
export const ANTE = 1;
/** BET/RAISE rounds (each followed by an exchange) allowed per hand before only CALL/DROP remain. */
export const MAX_EXCHANGE_ROUNDS = 6;

export type Phase = 'turn' | 'exchange' | 'final' | 'callResponse' | 'over';

export type Action =
  | { type: 'drop' }
  /** Set your total to `to` (>= N); defaults to N (match). */
  | { type: 'bet'; to?: number }
  /** Set your total to `to` (>= N+1). */
  | { type: 'raise'; to: number }
  /** Challenge at total `to` (>= N+1); defaults to N+1. Locks exchanges for the rest of the hand. */
  | { type: 'call'; to?: number }
  /** Answer a CALL: match its amount, then showdown. */
  | { type: 'accept' }
  | { type: 'exchange'; cards: Card[] };

export type ActionType = Action['type'];

export interface HandEvent {
  player: PlayerId;
  phase: Phase;
  /** The applied action, with amounts resolved (`to` always set for bet/raise/call). */
  action: Action;
  /** Number of cards exchanged (exchange events only). */
  count?: number;
  /** Bets after the event. */
  bets: [number, number];
  /** Deck size before the event. */
  deckBefore: number;
}

export interface HandOutcome {
  kind: 'drop' | 'showdown';
  winner: PlayerId;
  loser: PlayerId;
  /** Total coins in the pot (both bets). */
  pot: number;
  /** Net coins the winner takes from the loser (= loser's bet). */
  gain: number;
  /** Coins each player owns after the pot is paid out. */
  coinsAfter: [number, number];
  /** Both final hands, evaluated (also after a DROP, so the hands can be revealed). */
  evaluations: [Evaluation, Evaluation];
  /** How the hands compare. Decisive only for showdowns; after a DROP it is "what would have happened". */
  comparison: Comparison;
}

export interface HandState {
  jokers: JokerCount;
  /**
   * Discard display mode. Face up: every discarded card is public (both players see both piles).
   * Face down: only the counts are public. Affects what `makeView` reveals, not the rules.
   */
  discardsFaceUp: boolean;
  /** Each player's cards in arrival order (dealt order; drawn cards take the discarded slots). */
  hands: [Card[], Card[]];
  /** Remaining deck; deck[0] is the top card. */
  deck: Card[];
  /** Cards each player discarded this hand (out of play until the next hand). */
  discards: [Card[], Card[]];
  bets: [number, number];
  /** Coins not committed to the pot. */
  stacks: [number, number];
  /** Max bet per player this hand: min(5, coins of either player). */
  cap: number;
  firstToAct: PlayerId;
  toAct: PlayerId;
  phase: Phase;
  /** Who made the pending CALL, if any. */
  caller: PlayerId | null;
  /** BET/RAISE rounds used so far this hand (see MAX_EXCHANGE_ROUNDS). */
  exchangeRounds: number;
  /** Final-round turns still to come (0 = not in the final round). */
  finalTurns: number;
  /** Whether the pending exchange belongs to a final-round turn (→ showdown when none are left). */
  exchangeInFinal: boolean;
  history: HandEvent[];
  outcome: HandOutcome | null;
  /** State of the pure RNG used for re-inserting a refused Joker into the deck. */
  seed: number;
}

export interface AmountRange {
  min: number;
  max: number;
}
/** @deprecated use AmountRange */
export type RaiseRange = AmountRange;

export interface LegalActions {
  drop: boolean;
  /** BET total range (responding only), or null. */
  bet: AmountRange | null;
  /** RAISE total range, or null. */
  raise: AmountRange | null;
  /** CALL total range, or null. */
  call: AmountRange | null;
  /** ACCEPT a pending CALL. */
  accept: boolean;
  /** Max cards that may be exchanged now, or null if not in the exchange phase. */
  exchange: { max: number } | null;
  /** True on the first action of the hand (no BET offered). */
  first: boolean;
  /** True in the final round (only BET to the cap, or DROP; showdown follows). */
  final: boolean;
}

export class IllegalActionError extends Error {}

const NONE: LegalActions = {
  drop: false,
  bet: null,
  raise: null,
  call: null,
  accept: false,
  exchange: null,
  first: false,
  final: false,
};

export const currentBet = (s: HandState): number => Math.max(s.bets[0], s.bets[1]);
export const pot = (s: HandState): number => s.bets[0] + s.bets[1];

/**
 * Draw the top card for a player. If it is a Joker and the player already holds one, the player
 * takes the next card instead and the Joker is re-inserted at a random position (`rand` in [0,1)).
 * Returns null (and leaves the deck unchanged) if no acceptable card exists.
 */
function drawFor(deck: Card[], holdsJoker: boolean, rand: () => number): Card | null {
  if (deck.length === 0) return null;
  if (!(holdsJoker && isJoker(deck[0]))) return deck.shift()!;
  if (deck.length === 1) return null;
  const joker = deck.shift()!;
  const card = deck.shift()!; // only two Jokers exist, so this one is a real card
  deck.splice(Math.floor(rand() * (deck.length + 1)), 0, joker);
  return card;
}

/**
 * Start a hand. `coins` are the totals each player owns before the ante.
 * Pass `deckOrder` to fix the deck (tests); otherwise it is shuffled with `rng`.
 */
export function newHand(
  coins: readonly [number, number],
  firstToAct: PlayerId,
  rng: Rng,
  deckOrder?: readonly Card[],
  jokers: JokerCount = 1,
  discardsFaceUp = false,
): HandState {
  if (coins[0] < ANTE || coins[1] < ANTE) throw new Error('Both players need a coin to ante');
  const deck = deckOrder ? [...deckOrder] : shuffle(fullDeck(jokers), rng);
  if (deck.length < HAND_SIZE * 2 + 1) throw new Error('Deck too small');
  // Deal alternately, starting with the first player.
  const dealt: [Card[], Card[]] = [[], []];
  for (let i = 0; i < HAND_SIZE * 2; i++) {
    const p = (i % 2 === 0 ? firstToAct : other(firstToAct)) as PlayerId;
    dealt[p].push(drawFor(deck, dealt[p].some(isJoker), rng)!);
  }
  return {
    jokers,
    discardsFaceUp,
    seed: Math.floor(rng() * 4294967296) >>> 0,
    // Hands keep their dealt (arrival) order; exchanges replace cards in place. Display order
    // (sorting) is a UI concern.
    hands: [dealt[0], dealt[1]],
    deck,
    discards: [[], []],
    bets: [ANTE, ANTE],
    stacks: [coins[0] - ANTE, coins[1] - ANTE],
    cap: Math.min(MAX_BET, coins[0], coins[1]),
    firstToAct,
    toAct: firstToAct,
    // Cap = ante (a player has one coin): nobody can add anything, so the hand is a final round
    // from the start — each player gets one BET (stay) + exchange or DROP, then showdown.
    phase: Math.min(MAX_BET, coins[0], coins[1]) <= ANTE ? 'final' : 'turn',
    caller: null,
    exchangeRounds: 0,
    finalTurns: Math.min(MAX_BET, coins[0], coins[1]) <= ANTE ? 2 : 0,
    exchangeInFinal: false,
    history: [],
    outcome: null,
  };
}

export function legalActions(s: HandState): LegalActions {
  const n = s.bets[other(s.toAct)];
  switch (s.phase) {
    case 'turn': {
      const first = s.history.length === 0;
      const canDraw = s.exchangeRounds < MAX_EXCHANGE_ROUNDS;
      return {
        ...NONE,
        first,
        drop: true,
        bet: !first && canDraw ? { min: n, max: s.cap } : null,
        raise: canDraw && n + 1 <= s.cap ? { min: n + 1, max: s.cap } : null,
        // CALL must add at least 1 over N, so it does not exist once N is at the cap.
        call: n + 1 <= s.cap ? { min: n + 1, max: s.cap } : null,
      };
    }
    case 'final':
      return { ...NONE, final: true, drop: true, bet: { min: s.cap, max: s.cap } };
    case 'exchange':
      return { ...NONE, exchange: { max: Math.min(HAND_SIZE, s.deck.length) } };
    case 'callResponse':
      return { ...NONE, accept: true, drop: true };
    case 'over':
      return NONE;
  }
}

const inRange = (to: number, r: AmountRange | null) => !!r && Number.isInteger(to) && to >= r.min && to <= r.max;

/** The total an amount-taking action resolves to (BET defaults to N, CALL to N+1). */
export function resolvedTotal(s: HandState, a: Action): number | null {
  const n = s.bets[other(s.toAct)];
  if (a.type === 'raise') return a.to;
  if (a.type === 'bet') return a.to ?? n;
  if (a.type === 'call') return a.to ?? n + 1;
  return null;
}

export function isLegal(s: HandState, a: Action): boolean {
  const l = legalActions(s);
  switch (a.type) {
    case 'drop':
      return l.drop;
    case 'bet':
      return inRange(resolvedTotal(s, a)!, l.bet);
    case 'raise':
      return inRange(a.to, l.raise);
    case 'call':
      return inRange(resolvedTotal(s, a)!, l.call);
    case 'accept':
      return l.accept;
    case 'exchange': {
      if (!l.exchange) return false;
      const hand = s.hands[s.toAct];
      return (
        a.cards.length <= l.exchange.max &&
        new Set(a.cards).size === a.cards.length &&
        a.cards.every((c) => hand.includes(c))
      );
    }
  }
}

function clone(s: HandState): HandState {
  return {
    ...s,
    hands: [[...s.hands[0]], [...s.hands[1]]],
    deck: [...s.deck],
    discards: [[...s.discards[0]], [...s.discards[1]]],
    bets: [s.bets[0], s.bets[1]],
    stacks: [s.stacks[0], s.stacks[1]],
    history: [...s.history],
  };
}

function setBet(s: HandState, p: PlayerId, amount: number): void {
  const add = amount - s.bets[p];
  if (add < 0) throw new IllegalActionError('Bets cannot go down');
  if (add > s.stacks[p]) throw new IllegalActionError('Not enough coins');
  s.bets[p] = amount;
  s.stacks[p] -= add;
}

function finish(s: HandState, winner: PlayerId | null, kind: 'drop' | 'showdown'): void {
  const evaluations: [Evaluation, Evaluation] = [evaluateHand(s.hands[0]), evaluateHand(s.hands[1])];
  const comparison = compareEvaluations(evaluations[0], evaluations[1]);
  const w = winner ?? comparison.winner;
  const loser = other(w);
  const total = pot(s);
  const coinsAfter: [number, number] = [s.stacks[0], s.stacks[1]];
  coinsAfter[w] += total;
  s.outcome = { kind, winner: w, loser, pot: total, gain: s.bets[loser], coinsAfter, evaluations, comparison };
  s.phase = 'over';
}

/** Apply an action for the player to act. Throws IllegalActionError if illegal. */
export function applyAction(state: HandState, action: Action): HandState {
  if (!isLegal(state, action)) {
    throw new IllegalActionError(`Illegal action ${JSON.stringify(action)} in phase ${state.phase}`);
  }
  const s = clone(state);
  const p = s.toAct;
  const o = other(p);
  let applied: Action = action;
  const event: HandEvent = { player: p, phase: s.phase, action, bets: [0, 0], deckBefore: s.deck.length };

  switch (s.phase) {
    case 'turn':
      if (action.type === 'drop') finish(s, o, 'drop');
      else if (action.type === 'bet' || action.type === 'raise') {
        const to = resolvedTotal(state, action)!;
        applied = { type: action.type, to };
        setBet(s, p, to);
        s.exchangeRounds++;
        // Reaching the cap starts the final round: the opponent gets exactly one more turn.
        if (to >= s.cap) s.finalTurns = 1;
        s.exchangeInFinal = false;
        s.phase = 'exchange';
      } else if (action.type === 'call') {
        const to = resolvedTotal(state, action)!;
        applied = { type: 'call', to };
        setBet(s, p, to);
        s.caller = p;
        s.phase = 'callResponse';
        s.toAct = o;
      }
      break;

    case 'exchange': {
      if (action.type !== 'exchange') break;
      const hand = s.hands[p];
      // A Joker being discarded no longer counts as held.
      let holds = hand.some((c) => isJoker(c) && !action.cards.includes(c));
      const rand = () => {
        const [v, next] = stepRandom(s.seed);
        s.seed = next;
        return v;
      };
      const discarded: Card[] = [];
      // Replacement cards go into the same slots as the discarded ones.
      for (let i = 0; i < hand.length; i++) {
        if (!action.cards.includes(hand[i])) continue;
        const c = drawFor(s.deck, holds, rand);
        if (c === null) {
          // Draw skipped: the card stays in hand. A kept Joker counts as held again.
          if (isJoker(hand[i])) holds = true;
          continue;
        }
        discarded.push(hand[i]);
        s.discards[p].push(hand[i]);
        hand[i] = c;
        if (isJoker(c)) holds = true;
      }
      applied = { type: 'exchange', cards: discarded };
      event.count = discarded.length;
      if (s.finalTurns > 0) {
        s.phase = 'final';
        s.toAct = o;
      } else if (s.exchangeInFinal) {
        finish(s, null, 'showdown'); // final round complete → automatic showdown
      } else {
        s.phase = 'turn';
        s.toAct = o;
      }
      break;
    }

    case 'final':
      if (action.type === 'drop') finish(s, o, 'drop');
      else if (action.type === 'bet') {
        applied = { type: 'bet', to: s.cap };
        setBet(s, p, s.cap);
        s.finalTurns--;
        s.exchangeInFinal = true;
        s.phase = 'exchange';
      }
      break;

    case 'callResponse':
      if (action.type === 'accept') {
        setBet(s, p, s.bets[s.caller!]);
        finish(s, null, 'showdown');
      } else if (action.type === 'drop') finish(s, o, 'drop');
      break;

    case 'over':
      break;
  }

  event.action = applied;
  event.bets = [s.bets[0], s.bets[1]];
  s.history.push(event);
  return s;
}

/** Total coins each player owns right now (stack + bet), or after payout if over. */
export function coinsOf(s: HandState): [number, number] {
  if (s.outcome) return [...s.outcome.coinsAfter];
  return [s.stacks[0] + s.bets[0], s.stacks[1] + s.bets[1]];
}
