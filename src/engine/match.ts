import type { Card, JokerCount } from './cards';
import {
  type Action,
  type HandOutcome,
  type HandState,
  type PlayerId,
  applyAction,
  newHand,
} from './betting';
import type { Rng } from './rng';

export const STARTING_COINS = 12;

export type TurnOrderChoice = 'first' | 'second' | 'random';
export type CoinFace = 'heads' | 'tails';

export interface HandSummary {
  handNumber: number;
  firstToAct: PlayerId;
  outcome: HandOutcome;
  /** Final hand state (full information, for logs / AI learning). */
  final: HandState;
}

export interface MatchState {
  /** Number of Jokers in the deck (1 = 21 cards, 2 = 22 cards). */
  jokers: JokerCount;
  /** Discards shown face up (public) or face down (counts only). */
  discardsFaceUp: boolean;
  coins: [number, number];
  handNumber: number;
  /** Who acts first in the next hand (the loser of the previous hand). */
  nextFirst: PlayerId;
  hand: HandState | null;
  winner: PlayerId | null;
  history: HandSummary[];
}

/** Heads → the human (player 0) goes first, Tails → second. */
export function coinFlip(rng: Rng): CoinFace {
  return rng() < 0.5 ? 'heads' : 'tails';
}

export function firstPlayerFromCoin(face: CoinFace): PlayerId {
  return face === 'heads' ? 0 : 1;
}

export function newMatch(
  firstToAct: PlayerId,
  startingCoins = STARTING_COINS,
  jokers: JokerCount = 1,
  discardsFaceUp = false,
): MatchState {
  return {
    jokers,
    discardsFaceUp,
    coins: [startingCoins, startingCoins],
    handNumber: 0,
    nextFirst: firstToAct,
    hand: null,
    winner: null,
    history: [],
  };
}

export function startHand(m: MatchState, rng: Rng, deckOrder?: readonly Card[]): MatchState {
  if (m.winner !== null) throw new Error('Match is over');
  if (m.hand && m.hand.phase !== 'over') throw new Error('A hand is already in progress');
  return {
    ...m,
    handNumber: m.handNumber + 1,
    hand: newHand(m.coins, m.nextFirst, rng, deckOrder, m.jokers, m.discardsFaceUp),
  };
}

/** Apply an action to the current hand; settles coins when the hand ends. */
export function matchAct(m: MatchState, action: Action): MatchState {
  if (!m.hand) throw new Error('No hand in progress');
  const hand = applyAction(m.hand, action);
  if (hand.phase !== 'over') return { ...m, hand };
  const out = hand.outcome!;
  const coins: [number, number] = [...out.coinsAfter];
  const winner: PlayerId | null = coins[0] <= 0 ? 1 : coins[1] <= 0 ? 0 : null;
  return {
    ...m,
    hand,
    coins,
    nextFirst: out.loser,
    winner,
    history: [...m.history, { handNumber: m.handNumber, firstToAct: hand.firstToAct, outcome: out, final: hand }],
  };
}
