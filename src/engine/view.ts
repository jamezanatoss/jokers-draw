/**
 * What one player is allowed to know. The AI only ever receives a PlayerView,
 * so it cannot cheat unless `cheat` is requested explicitly (Cheater difficulty).
 */
import type { Card, JokerCount } from './cards';
import {
  type Action,
  type HandState,
  type LegalActions,
  type Phase,
  type PlayerId,
  legalActions,
  other,
} from './betting';

export interface ViewEvent {
  player: PlayerId;
  phase: Phase;
  type: Action['type'];
  /** Resulting total for BET / RAISE / CALL. */
  to?: number;
  /** Cards exchanged (exchange events). */
  count?: number;
  /** The discarded cards — for the viewer's own exchanges, and for the opponent's when discards are face up. */
  cards?: Card[];
  bets: [number, number];
  deckBefore: number;
}

export interface PlayerView {
  me: PlayerId;
  /** Jokers in this deck (1 or 2). */
  jokers: JokerCount;
  hand: Card[];
  myDiscards: Card[];
  oppDiscardCount: number;
  /** True if discards are face up (public) at this table. */
  discardsFaceUp: boolean;
  /** The opponent's discarded cards, in discard order — only when discards are face up (or cheating). */
  oppDiscards?: Card[];
  deckCount: number;
  bets: [number, number];
  stacks: [number, number];
  cap: number;
  phase: Phase;
  toAct: PlayerId;
  firstToAct: PlayerId;
  caller: PlayerId | null;
  history: ViewEvent[];
  legal: LegalActions;
  /** Cheater-only extras. */
  oppHand?: Card[];
  deckOrder?: Card[];
}

export function makeView(s: HandState, me: PlayerId, cheat = false): PlayerView {
  const opp = other(me);
  const history: ViewEvent[] = s.history.map((e) => {
    const v: ViewEvent = {
      player: e.player,
      phase: e.phase,
      type: e.action.type,
      bets: [e.bets[0], e.bets[1]],
      deckBefore: e.deckBefore,
    };
    if (e.action.type === 'raise' || e.action.type === 'bet' || e.action.type === 'call') v.to = e.action.to;
    if (e.action.type === 'exchange') {
      v.count = e.action.cards.length;
      if (e.player === me || cheat || s.discardsFaceUp) v.cards = [...e.action.cards];
    }
    return v;
  });
  const view: PlayerView = {
    me,
    jokers: s.jokers,
    hand: [...s.hands[me]],
    myDiscards: [...s.discards[me]],
    oppDiscardCount: s.discards[opp].length,
    discardsFaceUp: s.discardsFaceUp,
    deckCount: s.deck.length,
    bets: [s.bets[0], s.bets[1]],
    stacks: [s.stacks[0], s.stacks[1]],
    cap: s.cap,
    phase: s.phase,
    toAct: s.toAct,
    firstToAct: s.firstToAct,
    caller: s.caller,
    history,
    legal: s.toAct === me ? legalActions(s) : legalActions({ ...s, phase: 'over' }),
  };
  if (s.discardsFaceUp || cheat) view.oppDiscards = [...s.discards[opp]];
  if (cheat) {
    view.oppHand = [...s.hands[opp]];
    view.deckOrder = [...s.deck];
  }
  return view;
}
