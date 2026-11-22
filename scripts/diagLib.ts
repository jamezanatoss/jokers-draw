/** Shared helpers for the diagnosis and the benchmark: a decision-logging wrapper around the AI. */
import { type PlayerView, CATEGORY_NAMES, compareHands, evaluateHand, mulberry32 } from '../src/engine';
import { AIPlayer, type AIDecision } from '../src/ai/ai';
import { type Bot, HeuristicBot, playMatch } from '../src/ai/sim';

export interface CallRecord {
  to: number;
  extra: number;
  eq: number;
  category: string;
  first: boolean;
}

export interface Diagnosis {
  hands: number;
  matchWins: number;
  matches: number;
  decisions: Record<string, number>;
  calls: CallRecord[];
  acceptRate: number;
  responses: number;
  /** Net coins for Hard by how the hand ended. */
  ledger: Record<string, { hands: number; net: number }>;
  /** Folds to a player CALL that would have won / accepts that lost. */
  foldedWinners: number;
  acceptedLosers: number;
}

/** Wrap a Hard AI so every decision is recorded. */
export class Logged implements Bot {
  readonly cheats = false;
  calls: CallRecord[] = [];
  decisions: Record<string, number> = {};
  accepts = 0;
  responses = 0;
  ledger: Record<string, { hands: number; net: number }> = {};
  foldedWinners = 0;
  acceptedLosers = 0;
  constructor(private ai: AIPlayer) {}
  decide(v: PlayerView): AIDecision {
    const d = this.ai.decide(v);
    const a = d.action;
    if (a.type !== 'exchange') {
      const key = `${v.phase}:${a.type}`;
      this.decisions[key] = (this.decisions[key] ?? 0) + 1;
    }
    if (a.type === 'call') {
      const n = v.bets[1 - v.me];
      this.calls.push({
        to: a.to!,
        extra: a.to! - n,
        eq: d.thinking.eqNow,
        category: CATEGORY_NAMES[evaluateHand(v.hand).category],
        first: v.legal.first,
      });
    }
    if (v.phase === 'callResponse') {
      this.responses++;
      if (a.type === 'accept') this.accepts++;
    }
    return d;
  }
  observeHandEnd(view: PlayerView, revealed: number[] | null): void {
    this.ai.observeHandEnd(view, revealed);
    if (!revealed) return;
    const me = view.me;
    const opp = 1 - me;
    const h = view.history;
    const last = h[h.length - 1];
    const weWin = compareHands(view.hand, revealed).winner === 0;
    const bets = last.bets;
    const where = (ph: string) => (ph === 'callResponse' ? ' vs CALL' : ph === 'final' ? ' in final' : '');
    let key: string;
    let net: number;
    if (last.type === 'drop') {
      key = (last.player === me ? 'Hard drops' : 'player drops') + where(last.phase);
      if (last.phase === 'final') key += h.some((e) => e.player === me && e.phase === 'turn' && (e.to ?? 0) >= view.cap) ? ' (Hard capped)' : ' (player capped)';
      net = last.player === me ? -bets[me] : bets[opp];
      if (last.player === me && last.phase === 'callResponse' && weWin) this.foldedWinners++;
    } else {
      const caller = h.find((e) => e.type === 'call');
      const capper = h.find((e) => e.phase === 'turn' && (e.type === 'raise' || e.type === 'bet') && (e.to ?? 0) >= view.cap);
      key = caller
        ? caller.player === me ? 'showdown after Hard CALL' : 'showdown after player CALL'
        : `showdown, final (${capper ? (capper.player === me ? 'Hard capped' : 'player capped') : 'cap 1'})`;
      net = weWin ? bets[opp] : -bets[me];
      if (caller && caller.player === opp && !weWin) this.acceptedLosers++;
    }
    const r = (this.ledger[key] ??= { hands: 0, net: 0 });
    r.hands++;
    r.net += net;
  }
}

export function diagnose(opts: { hands: number; jokers: 1 | 2; opp: 'heuristic' | 'normal'; seed?: number }): Diagnosis {
  let hands = 0;
  let wins = 0;
  let matches = 0;
  const calls: CallRecord[] = [];
  const decisions: Record<string, number> = {};
  let accepts = 0;
  let responses = 0;
  const ledger: Record<string, { hands: number; net: number }> = {};
  let foldedWinners = 0;
  let acceptedLosers = 0;
  for (let i = 0; hands < opts.hands; i++) {
    const swap = i % 2 === 1;
    const hard = new Logged(new AIPlayer({ difficulty: 'hard', rng: mulberry32((opts.seed ?? 0) + i * 7 + 1), me: swap ? 1 : 0 }));
    const opp: Bot =
      opts.opp === 'normal'
        ? new AIPlayer({ difficulty: 'normal', rng: mulberry32(i * 7 + 2), me: swap ? 0 : 1 })
        : new HeuristicBot(mulberry32(i * 7 + 3));
    const r = playMatch(swap ? [opp, hard] : [hard, opp], mulberry32(5000 + i), { jokers: opts.jokers });
    hands += r.hands;
    matches++;
    if ((r.winner === 1) === swap) wins++;
    calls.push(...hard.calls);
    for (const [k, v] of Object.entries(hard.decisions)) decisions[k] = (decisions[k] ?? 0) + v;
    accepts += hard.accepts;
    responses += hard.responses;
    foldedWinners += hard.foldedWinners;
    acceptedLosers += hard.acceptedLosers;
    for (const [k, v] of Object.entries(hard.ledger)) {
      const r = (ledger[k] ??= { hands: 0, net: 0 });
      r.hands += v.hands;
      r.net += v.net;
    }
  }
  return { hands, matchWins: wins, matches, decisions, calls, acceptRate: responses ? accepts / responses : 0, responses, ledger, foldedWinners, acceptedLosers };
}

export function report(d: Diagnosis): string {
  const total = Object.values(d.decisions).reduce((a, b) => a + b, 0);
  const pct = (x: number, of: number) => `${((100 * x) / Math.max(1, of)).toFixed(1)}%`;
  const turn = Object.entries(d.decisions).filter(([k]) => k.startsWith('turn:'));
  const turnTotal = turn.reduce((a, [, v]) => a + v, 0);
  const lines: string[] = [];
  lines.push(`hands ${d.hands}, matches ${d.matches} (Hard won ${d.matchWins}, ${pct(d.matchWins, d.matches)}), decisions ${total}`);
  lines.push(`turn actions: ${turn.sort().map(([k, v]) => `${k.slice(5)} ${pct(v, turnTotal)}`).join(' · ')}`);
  const other = Object.entries(d.decisions).filter(([k]) => !k.startsWith('turn:'));
  lines.push(`other phases: ${other.sort().map(([k, v]) => `${k} ${v}`).join(' · ')}; accepts ${pct(d.acceptRate * d.responses, d.responses)} of ${d.responses} player CALLs`);
  const c = d.calls;
  lines.push(`CALLs: ${c.length} = ${(c.length / d.hands).toFixed(2)} per hand, ${pct(c.filter((x) => x.first).length, c.length)} as first action`);
  const byExtra: Record<string, number> = {};
  for (const x of c) byExtra[`+${x.extra}`] = (byExtra[`+${x.extra}`] ?? 0) + 1;
  lines.push(`  size over N: ${Object.entries(byExtra).sort().map(([k, v]) => `${k}: ${pct(v, c.length)}`).join(' · ')}`);
  const mean = c.reduce((a, x) => a + x.eq, 0) / Math.max(1, c.length);
  const buckets = [0, 0.4, 0.55, 0.7, 0.85, 1.01];
  const hist = buckets.slice(0, -1).map((lo, i) => `${lo.toFixed(2)}–${buckets[i + 1] > 1 ? '1.00' : buckets[i + 1].toFixed(2)}: ${pct(c.filter((x) => x.eq >= lo && x.eq < buckets[i + 1]).length, c.length)}`);
  lines.push(`  equity at CALL (vs. inferred range): mean ${mean.toFixed(2)} | ${hist.join(' · ')}`);
  const cats: Record<string, number> = {};
  for (const x of c) cats[x.category] = (cats[x.category] ?? 0) + 1;
  lines.push(`  hand at CALL: ${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, c.length)}`).join(' · ')}`);
  const cheap = c.filter((x) => x.extra === 1 && x.eq < 0.6);
  lines.push(`  minimum-size CALLs (+1) with equity < 0.60: ${cheap.length} (${pct(cheap.length, c.length)} of CALLs)`);
  lines.push(`ledger (Hard's net coins by how hands ended):`);
  for (const [k, v] of Object.entries(d.ledger).sort((a, b) => a[1].net - b[1].net)) {
    lines.push(`  ${k.padEnd(28)} ${String(v.hands).padStart(4)} hands  net ${v.net >= 0 ? '+' : ''}${v.net}  (${(v.net / v.hands).toFixed(2)}/hand)`);
  }
  lines.push(`vs player CALLs: folded a winner ${d.foldedWinners}x, accepted a loser ${d.acceptedLosers}x`);
  return lines.join('\n');
}

