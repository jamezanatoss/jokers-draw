/**
 * Headless match simulation + simple baseline bots (used by tests and benchmarks).
 */
import {
  type Action,
  type Card,
  type JokerCount,
  type MatchState,
  type PlayerId,
  type PlayerView,
  type Rng,
  makeView,
  matchAct,
  newMatch,
  other,
  startHand,
} from '../engine';
import { AIPlayer, type Difficulty } from './ai';
import { bestKeep, getTables, maskOf, pctOf } from './tables';

export interface Bot {
  readonly cheats?: boolean;
  decide(view: PlayerView): { action: Action };
  observeHandEnd?(view: PlayerView, revealed: Card[] | null): void;
}

/** Uniformly random legal play (random amounts, random number of exchanged cards). */
export class RandomBot implements Bot {
  constructor(private rng: Rng) {}
  decide(v: PlayerView): { action: Action } {
    const l = v.legal;
    if (l.exchange) {
      const k = Math.floor(this.rng() * (l.exchange.max + 1));
      return { action: { type: 'exchange', cards: v.hand.slice(0, k) } };
    }
    const pick = (r: { min: number; max: number }) => r.min + Math.floor(this.rng() * (r.max - r.min + 1));
    const opts: Action[] = [];
    if (l.drop) opts.push({ type: 'drop' });
    if (l.call) opts.push({ type: 'call', to: pick(l.call) });
    if (l.bet) opts.push({ type: 'bet', to: pick(l.bet) }, { type: 'bet', to: l.bet.min });
    if (l.raise) opts.push({ type: 'raise', to: pick(l.raise) });
    if (l.accept) opts.push({ type: 'accept' });
    return { action: opts[Math.floor(this.rng() * opts.length)] };
  }
}

/**
 * A reasonable "human-like" player: draws with the static best-keep table, raises strong
 * hands, calls made hands, drops weak hands facing big bets. Never bluffs.
 */
export class HeuristicBot implements Bot {
  constructor(private rng: Rng) {}
  decide(v: PlayerView): { action: Action } {
    const l = v.legal;
    const t = getTables(v.jokers);
    const my = maskOf(v.hand);
    const p = pctOf(t, my);
    const bk = bestKeep(t, my, Math.min(5, v.deckCount));
    if (l.exchange) {
      const cards = v.hand.filter((c) => !(bk.keep & (1 << c))).slice(0, l.exchange.max);
      return { action: { type: 'exchange', cards } };
    }
    const n = v.bets[1 - v.me];
    const toCall = n - v.bets[v.me];
    const exchanges = v.history.filter((e) => e.player === v.me && e.type === 'exchange').length;
    if (v.phase === 'callResponse') return { action: { type: p > 0.45 || n <= 2 ? 'accept' : 'drop' } };
    if (v.phase === 'final') return { action: p > 0.45 || bk.value > 0.5 ? { type: 'bet' } : { type: 'drop' } };
    const callMin: Action = l.call ? { type: 'call', to: l.call.min } : { type: 'drop' };
    // turn
    if (p > 0.8 && l.raise) return { action: { type: 'raise', to: Math.min(l.raise.max, n + 2) } };
    const canDraw = !!l.bet || !!l.raise;
    if (p > 0.75 || (exchanges >= 2 && p > 0.5) || !canDraw) {
      if (!canDraw && p < 0.35 && toCall >= 2) return { action: { type: 'drop' } };
      return { action: callMin };
    }
    if (bk.value < 0.45 && toCall >= 3 && this.rng() < 0.7) return { action: { type: 'drop' } };
    if (bk.value > 0.7 && l.raise && this.rng() < 0.5) return { action: { type: 'raise', to: l.raise.min } };
    if (l.bet) return { action: { type: 'bet', to: n } };
    // First action of the hand (no BET): pay one more to draw, or call right away.
    return { action: l.raise && bk.value > p ? { type: 'raise', to: l.raise.min } : callMin };
  }
}

export function makeAI(difficulty: Difficulty, rng: Rng, me: PlayerId): Bot {
  return new AIPlayer({ difficulty, rng, me });
}

export interface MatchResult {
  winner: PlayerId;
  hands: number;
  coins: [number, number];
  maxDecisionMs: number;
}

/** Play one full match between bots[0] (player 0) and bots[1] (player 1). */
export function playMatch(
  bots: [Bot, Bot],
  rng: Rng,
  opts: { first?: PlayerId; maxHands?: number; jokers?: JokerCount; discardsFaceUp?: boolean } = {},
): MatchResult {
  let m: MatchState = newMatch(opts.first ?? (rng() < 0.5 ? 0 : 1), undefined, opts.jokers ?? 1, opts.discardsFaceUp ?? false);
  let maxMs = 0;
  const maxHands = opts.maxHands ?? 400;
  while (m.winner === null && m.handNumber < maxHands) {
    m = startHand(m, rng);
    let steps = 0;
    while (m.hand!.phase !== 'over') {
      const p = m.hand!.toAct;
      const bot = bots[p];
      const view = makeView(m.hand!, p, !!bot.cheats);
      const t0 = performance.now();
      const { action } = bot.decide(view);
      maxMs = Math.max(maxMs, performance.now() - t0);
      m = matchAct(m, action);
      if (++steps > 500) throw new Error('Hand did not terminate');
    }
    const h = m.hand!;
    // Hands are revealed after every hand (showdown or DROP).
    for (const p of [0, 1] as PlayerId[]) bots[p].observeHandEnd?.(makeView(h, p), h.hands[other(p)]);
  }
  const winner: PlayerId = m.winner ?? (m.coins[0] >= m.coins[1] ? 0 : 1);
  return { winner, hands: m.handNumber, coins: m.coins, maxDecisionMs: maxMs };
}
