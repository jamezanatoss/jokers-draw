/**
 * Turns the server's per-player view into the MatchState shape the table UI renders, seen from
 * the local player: the local player is always player 0, the opponent player 1.
 *
 * Unknown cards (the opponent's hand, the deck, face-down discards) become negative placeholder
 * ids. They only carry a count; nothing about real cards can be read from them.
 */
import {
  type Action,
  type Card,
  type HandEvent,
  type HandOutcome,
  type HandState,
  type MatchState,
  type PlayerId,
  other,
} from '../engine';
import type { OnlineEvent, OnlineView } from '../../shared/protocol';

/** Placeholder ids: opponent hand −1…, deck −100…, opponent discards −200…, other unknowns −300…. */
const unknown = (n: number, base: number): Card[] => Array.from({ length: n }, (_, i) => base - i);
export const isPlaceholder = (c: Card): boolean => c < 0;

export function localMatch(v: OnlineView): MatchState {
  const me = v.me;
  /** Server seat → local seat (me = 0). */
  const L = (p: PlayerId): PlayerId => (me === 0 ? p : other(p));
  const pair = <T>(a: readonly [T, T]): [T, T] => (me === 0 ? [a[0], a[1]] : [a[1], a[0]]);
  const opp = other(me);

  let hidden = 0;
  const event = (e: OnlineEvent): HandEvent => {
    let action: Action;
    switch (e.type) {
      case 'exchange':
        action = { type: 'exchange', cards: e.cards ? [...e.cards] : unknown(e.count ?? 0, -300 - (hidden += 10)) };
        break;
      case 'bet':
      case 'call':
        action = { type: e.type, to: e.to };
        break;
      case 'raise':
        action = { type: 'raise', to: e.to ?? 0 };
        break;
      default:
        action = { type: e.type };
    }
    const out: HandEvent = { player: L(e.player), phase: e.phase, action, bets: pair(e.bets), deckBefore: e.deckBefore };
    if (e.count !== undefined) out.count = e.count;
    return out;
  };

  const r = v.reveal;
  const oppHand = r ? [...r.hands[opp]] : unknown(v.oppCardCount, -1);
  let outcome: HandOutcome | null = null;
  if (r) {
    const o = r.outcome;
    outcome = {
      ...o,
      winner: L(o.winner),
      loser: L(o.loser),
      coinsAfter: pair(o.coinsAfter),
      evaluations: pair(o.evaluations),
      comparison: { ...o.comparison, winner: L(o.comparison.winner) },
    };
  }

  const hand: HandState = {
    jokers: v.jokers,
    discardsFaceUp: v.discardsFaceUp,
    hands: [[...v.hand], oppHand],
    deck: unknown(v.deckCount, -100),
    discards: [[...v.myDiscards], v.oppDiscards ? [...v.oppDiscards] : unknown(v.oppDiscardCount, -200)],
    bets: pair(v.bets),
    stacks: pair(v.stacks),
    cap: v.cap,
    firstToAct: L(v.firstToAct),
    toAct: L(v.toAct),
    phase: v.phase,
    caller: v.caller === null ? null : L(v.caller),
    exchangeRounds: v.exchangeRounds,
    finalTurns: v.finalTurns,
    exchangeInFinal: v.exchangeInFinal,
    history: v.history.map(event),
    outcome,
    seed: 0,
  };
  return {
    jokers: v.jokers,
    discardsFaceUp: v.discardsFaceUp,
    coins: outcome ? [...outcome.coinsAfter] : pair(v.coinsAtStart),
    handNumber: v.handNumber,
    nextFirst: outcome ? outcome.loser : hand.firstToAct,
    hand,
    winner: v.matchWinner === null ? null : L(v.matchWinner),
    history: [],
  };
}
