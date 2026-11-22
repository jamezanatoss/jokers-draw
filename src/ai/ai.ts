/**
 * AI player.
 *
 * Every decision:
 *   1. Sample the opponent's range (see opponentModel.ts). Cheater mode uses one exact
 *      sample: the real hand and the real deck order.
 *   2. For each of the 32 discard subsets, play out the draw against every sample using
 *      that sample's remaining deck, and (when the opponent will get another turn) the
 *      opponent's own best redraw. → win probability per subset.
 *   3. Turn the win probabilities into coin EVs for every legal action, modelling the
 *      opponent's responses (folding to raises / calls, raising after a CALL) from the
 *      learned tendencies, then adjust for risk (coin lead) and position.
 *   4. Choose with a low-temperature softmax, plus occasional balanced bluffs and
 *      slow-plays so the AI is not predictable.
 */
import {
  type Action,
  type Card,
  HAND_SIZE,
  type PlayerId,
  type PlayerView,
  type Rng,
  other,
} from '../engine';
import { OpponentModel, type RangeSamples, type Tendencies, sampleRange } from './opponentModel';
import { type Tables, bestKeep, drawFromRest, getTables, maskOf, popcount } from './tables';

export type Difficulty = 'normal' | 'hard' | 'cheater';

interface Config {
  samples: number;
  useBetting: boolean;
  useExchange: boolean;
  exchangeTemp: number;
  exchangeFloor: number;
  keepNoise: number;
  /** Softmax temperature over option utilities (coins). */
  temperature: number;
  bluffInPosition: number;
  bluffOutOfPosition: number;
  slowPlay: number;
  /** Chance of picking a random reasonable option (Normal only). */
  mistake: number;
  learn: boolean;
  /** Choose discards by simulated win probability (true) or by the static keep table. */
  equityExchange: boolean;
  /**
   * Disciplined play (Hard): value CALLs only with real equity and only when locking the hand is
   * worth more than drawing on; bluffs are rare, purposeful and sized like value bets; fold rates
   * are learned per bet size; stack-aware risk.
   */
  disciplined: boolean;
  /** Minimum win equity (vs. the inferred range) for a value CALL. Tuned by simulation. */
  callMinEq: number;
}

const CONFIGS: Record<Difficulty, Config> = {
  normal: {
    samples: 250,
    useBetting: false,
    useExchange: false,
    exchangeTemp: 0.05,
    exchangeFloor: 0.12,
    keepNoise: 0.15,
    temperature: 0.35,
    bluffInPosition: 0.08,
    bluffOutOfPosition: 0.08,
    slowPlay: 0.1,
    mistake: 0.12,
    learn: false,
    equityExchange: false,
    disciplined: false,
    callMinEq: 0,
  },
  hard: {
    samples: 1500,
    useBetting: true,
    useExchange: true,
    exchangeTemp: 0.05,
    exchangeFloor: 0.12,
    keepNoise: 0.15,
    temperature: 0.06,
    bluffInPosition: 0.12,
    bluffOutOfPosition: 0.07,
    slowPlay: 0.25,
    mistake: 0,
    learn: true,
    equityExchange: true,
    disciplined: true,
    callMinEq: 0.68,
  },
  cheater: {
    samples: 1,
    useBetting: false,
    useExchange: false,
    exchangeTemp: 0.05,
    exchangeFloor: 0.12,
    keepNoise: 0,
    temperature: 0.04,
    bluffInPosition: 0.05,
    bluffOutOfPosition: 0.05,
    slowPlay: 0.3,
    mistake: 0,
    learn: true,
    equityExchange: true,
    disciplined: false,
    callMinEq: 0,
  },
};

/** Probability the opponent uses a redraw opportunity when their best play is to exchange. */
const REDRAW_PROB = 0.9;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface OptionInfo {
  label: string;
  ev: number;
  utility: number;
}

export interface Thinking {
  /** Win probability if the hand were shown down now. */
  eqNow: number;
  /** Win probability after the best exchange. */
  eqDraw: number;
  discard: Card[];
  options: OptionInfo[];
  /** Effective sample size of the range. */
  ess: number;
  ms: number;
  tendencies: Tendencies;
  note: '' | 'bluff' | 'slow-play' | 'mistake' | 'loop-guard';
}

export interface AIDecision {
  action: Action;
  thinking: Thinking;
}

interface Option {
  action: Action;
  discard: Card[];
  ev: number;
  /** Rough win probability used for the variance (risk) term. */
  eq: number;
  stake: number;
  label: string;
  utility?: number;
}

interface Analysis {
  eqNow: number;
  winNow: Uint8Array;
  /** eq[D] for every discard subset (bit j = discard hand[j]); -1 if not allowed. */
  eq: Float64Array;
  /** Per-sample win probability for every subset: perSample[D * n + i]. */
  perSample: Float32Array;
  best: number;
}

export interface AIOptions {
  difficulty: Difficulty;
  rng: Rng;
  me?: PlayerId;
  /** Joker mode to pre-build tables for (decisions always follow the view's mode). */
  jokers?: 1 | 2;
  /** Tuning/benchmark hook: override parts of the difficulty's configuration. */
  overrides?: Partial<Config>;
}

export class AIPlayer {
  readonly difficulty: Difficulty;
  readonly me: PlayerId;
  private readonly cfg: Config;
  /** Lookup tables for the Joker mode of the current hand (loaded lazily, by the view's mode). */
  private tables: Tables | null = null;
  private readonly rng: Rng;
  readonly model: OpponentModel;
  private plan: { handMask: number; discard: Card[] } | null = null;
  private readonly scratch = new Int32Array(2);
  private bluffed = false;
  private slowPlayed = false;

  constructor(opts: AIOptions) {
    this.difficulty = opts.difficulty;
    this.me = opts.me ?? 1;
    this.cfg = { ...CONFIGS[opts.difficulty], ...opts.overrides };
    this.rng = opts.rng;
    if (opts.jokers) this.tables = getTables(opts.jokers);
    this.model = new OpponentModel(this.cfg.learn);
  }

  /** Cheater mode needs the full view (opponent hand + deck order). */
  get cheats(): boolean {
    return this.difficulty === 'cheater';
  }

  observeHandEnd(view: PlayerView, revealedOpponentHand: Card[] | null): void {
    this.model.observeHand(view, revealedOpponentHand);
    this.resetHand();
  }

  private resetHand(): void {
    this.plan = null;
    this.bluffed = false;
    this.slowPlayed = false;
  }

  decide(view: PlayerView): AIDecision {
    const t0 = now();
    if (view.toAct !== this.me) throw new Error('Not my turn');
    // First decision of a new hand: forget per-hand state.
    if (!view.history.some((e) => e.player === this.me)) this.resetHand();

    if (this.tables?.jokers !== view.jokers) this.tables = getTables(view.jokers);
    const tend = this.model.tendencies();
    const samples = sampleRange(view, this.t, this.rng, {
      samples: this.cfg.samples,
      useBetting: this.cfg.useBetting,
      useExchange: this.cfg.useExchange,
      exchangeTemp: this.cfg.exchangeTemp,
      exchangeFloor: this.cfg.exchangeFloor,
      keepNoise: this.cfg.keepNoise,
      tendencies: tend,
    });

    const thinking = (a: Analysis | null, discard: Card[], options: Option[], note: Thinking['note']): Thinking => ({
      eqNow: a?.eqNow ?? 0,
      eqDraw: a && a.best >= 0 ? a.eq[a.best] : 0,
      discard,
      options: options.map((o) => ({ label: o.label, ev: round(o.ev), utility: round(o.utility ?? o.ev) })),
      ess: Math.round(samples.ess),
      ms: Math.round(now() - t0),
      tendencies: tend,
      note,
    });

    if (view.phase === 'exchange') {
      const discard = this.exchangeFor(view, samples);
      this.plan = null;
      return { action: { type: 'exchange', cards: discard }, thinking: thinking(null, discard, [], '') };
    }

    // Does the opponent get another exchange after ours? Not after a CALL, and not when they are
    // already at the cap (we are the final responder → showdown right after our exchange).
    const redrawMode = view.phase === 'turn' || (view.phase === 'final' && view.bets[other(this.me)] < view.cap);
    const a = this.analyze(view, samples, redrawMode);
    const discard = this.discardFromAnalysis(view, a);
    const allOptions = this.options(view, samples, a, discard, tend);
    const options = this.cfg.disciplined ? this.discipline(view, a, allOptions) : allOptions;
    let note: Thinking['note'] = '';
    let choice = this.choose(options);

    // Occasional mistakes (Normal).
    if (this.cfg.mistake > 0 && this.rng() < this.cfg.mistake) {
      const bestU = Math.max(...options.map((o) => o.utility!));
      const ok = options.filter((o) => o.utility! >= bestU - 1.5);
      choice = ok[Math.floor(this.rng() * ok.length)];
      note = 'mistake';
    }

    // Bluff: weak hand, bet like a strong one anyway. Hard bluffs rarely and on purpose — more when
    // the player looks weak, is short of coins or actually folds — and sizes like a value hand.
    const aggressive = (o: Option) => o.action.type === 'raise' || o.action.type === 'call';
    if (view.phase === 'turn' && !this.bluffed && !aggressive(choice)) {
      const eqDraw = a.eq[a.best];
      const inPosition = view.firstToAct !== this.me;
      let p = inPosition ? this.cfg.bluffInPosition : this.cfg.bluffOutOfPosition;
      const nOpp = view.bets[other(this.me)];
      const raises = allOptions.filter((o) => o.action.type === 'raise' && (!this.cfg.disciplined || o.stake - nOpp >= 2));
      const bigCalls = allOptions.filter((o) => o.action.type === 'call' && o.stake - nOpp >= 2);
      if (this.cfg.disciplined) p *= this.bluffFactor(view, tend);
      if ((raises.length || bigCalls.length) && eqDraw < 0.35 && this.rng() < p) {
        const useCall = bigCalls.length > 0 && (raises.length === 0 || this.rng() < 0.4);
        const pool = useCall ? bigCalls : raises;
        const pick = this.cfg.disciplined
          ? pool[pool.length - 1] // sized like a value hand: the biggest move
          : this.rng() < 0.5
            ? pool[pool.length - 1]
            : pool[Math.floor(this.rng() * pool.length)];
        if (pick.utility! >= choice.utility! - 0.8) {
          // Raise-bluffs sometimes "snow": keep the weak hand to represent a made one.
          choice = { ...pick, discard: pick.action.type === 'raise' && this.rng() < 0.3 ? [] : pick.discard };
          note = 'bluff';
          this.bluffed = true;
        }
      }
    }

    // Slow-play: very strong hand, just BET (match, no exchange) instead of raising.
    if (view.phase === 'turn' && !this.slowPlayed && choice.action.type === 'raise' && view.legal.bet) {
      const strongKept = a.best === 0 && a.eq[0] > 0.85;
      if (strongKept && this.rng() < this.cfg.slowPlay) {
        const bet = options.find((o) => o.action.type === 'bet' && o.stake === view.bets[other(this.me)]);
        if (bet) {
          choice = { ...bet, discard: [] };
          note = 'slow-play';
          this.slowPlayed = true;
        }
      }
    }

    // Loop guard: never BET without exchanging twice in a row (guarantees the hand ends).
    if (choice.action.type === 'bet' && choice.discard.length === 0 && this.lastTurnWasPassiveBet(view)) {
      // Prefer the best CALL; if CALL is unavailable (N at the cap), any exchange-taking option or DROP.
      const alt = options.filter((o) => o.action.type === 'call');
      const pool = alt.length ? alt : options.filter((o) => o.action.type === 'drop' || o.discard.length > 0);
      if (pool.length) choice = pool.reduce((b, o) => (o.utility! > b.utility! ? o : b), pool[0]);
      note = 'loop-guard';
    }

    if (choice.action.type === 'raise' || choice.action.type === 'bet') {
      this.plan = { handMask: maskOf(view.hand), discard: choice.discard };
    }
    return { action: choice.action, thinking: thinking(a, choice.discard, options, note) };
  }

  private get t(): Tables {
    return this.tables!;
  }

  // ---------------------------------------------------------------- analysis

  private analyze(view: PlayerView, s: RangeSamples, redraw: boolean): Analysis {
    const t = this.t;
    const hand = view.hand;
    const my = maskOf(hand);
    const myScore = t.score[my];
    const n = s.n;
    const deck = view.deckCount;
    const winNow = new Uint8Array(n);
    let eqNow = 0;
    for (let i = 0; i < n; i++) {
      if (myScore > t.score[s.opp[i]]) {
        winNow[i] = 1;
        eqNow += s.w[i];
      }
    }

    const subsets = 1 << HAND_SIZE;
    const eq = new Float64Array(subsets).fill(-1);
    const perSample = new Float32Array(subsets * n);
    let best = -1;
    for (let D = 0; D < subsets; D++) {
      const k = popcount(D);
      if (k > deck) continue;
      let keepMask = my;
      const thrown: number[] = [];
      for (let j = 0; j < HAND_SIZE; j++) {
        if (D & (1 << j)) {
          keepMask &= ~(1 << hand[j]);
          thrown.push(hand[j]);
        }
      }
      let total = 0;
      for (let i = 0; i < n; i++) {
        const base = i * s.stride;
        // Our draw (a refused second Joker is skipped and stays in the deck).
        let m = drawFromRest(keepMask, s.rest, base, 0, s.restLen, k, this.scratch);
        const pos = this.scratch[0];
        // Draw skipped (only a refused Joker left): those cards stay in hand.
        for (let j = this.scratch[1]; j < k; j++) m |= 1 << thrown[j];
        const sMy = t.score[m];
        const wn = sMy > t.score[s.opp[i]] ? 1 : 0;
        let e = wn;
        const r = Math.min(s.redrawK[i], s.restLen - pos);
        if (redraw && r > 0) {
          const om = drawFromRest(
            s.keepBySize[i * (HAND_SIZE + 1) + (HAND_SIZE - r)], s.rest, base, pos, s.restLen, r, this.scratch,
          );
          if (this.scratch[1] === r) {
            const wr = sMy > t.score[om] ? 1 : 0;
            e = REDRAW_PROB * wr + (1 - REDRAW_PROB) * wn;
          }
        }
        perSample[D * n + i] = e;
        total += s.w[i] * e;
      }
      eq[D] = total;
      // Prefer fewer discards on (near) ties: less information revealed.
      if (best < 0 || total > eq[best] + 1e-9 || (Math.abs(total - eq[best]) <= 1e-9 && k < popcount(best))) best = D;
    }
    return { eqNow, winNow, eq, perSample, best };
  }

  private discardFromAnalysis(view: PlayerView, a: Analysis): Card[] {
    if (this.cfg.equityExchange) return view.hand.filter((_, j) => a.best & (1 << j));
    // Normal: static "best keep" table, ignores the opponent entirely.
    const my = maskOf(view.hand);
    const k = bestKeep(this.t, my, Math.min(HAND_SIZE, view.deckCount)).keep;
    return view.hand.filter((c) => !(k & (1 << c)));
  }

  private exchangeFor(view: PlayerView, s: RangeSamples): Card[] {
    const my = maskOf(view.hand);
    let discard: Card[];
    if (this.plan && this.plan.handMask === my) discard = this.plan.discard;
    else discard = this.discardFromAnalysis(view, this.analyze(view, s, view.bets[other(this.me)] < view.cap));
    return discard.slice(0, view.legal.exchange?.max ?? 0);
  }

  private lastTurnWasPassiveBet(view: PlayerView): boolean {
    const h = view.history;
    for (let i = h.length - 1; i >= 0; i--) {
      const e = h[i];
      if (e.player !== this.me || e.type === 'exchange') continue;
      if (e.type !== 'bet') return false;
      const ex = h[i + 1];
      return !!ex && ex.type === 'exchange' && (ex.count ?? 0) === 0;
    }
    return false;
  }

  // ---------------------------------------------------------------- options / EVs

  private options(view: PlayerView, s: RangeSamples, a: Analysis, discard: Card[], tend: Tendencies): Option[] {
    const me = this.me;
    const opp = other(me);
    const nOpp = view.bets[opp]; // N: the opponent's current bet
    const myBet = view.bets[me];
    const l = view.legal;
    const out: Option[] = [];
    const n = s.n;
    const dMask = view.hand.reduce((m, c, j) => (discard.includes(c) ? m | (1 << j) : m), 0);
    const perD = a.perSample.subarray(dMask * n, dMask * n + n);
    const eqD = a.eq[dMask] >= 0 ? a.eq[dMask] : a.eqNow;

    if (view.phase === 'turn') {
      out.push({ action: { type: 'drop' }, discard: [], ev: -myBet, eq: 0, stake: 0, label: 'DROP' });
      if (l.call) {
        for (let to = l.call.min; to <= l.call.max; to++) {
          out.push({ ...this.callOption(s, a, tend, nOpp, to), label: `CALL ${to}` });
        }
      }
      // BET / RAISE to total X, then exchange. Opponent may fold to the extra amount.
      const fBase = (amount: number) =>
        this.cfg.disciplined
          ? clamp((amount >= 2 ? tend.foldToBigRaise : tend.foldToSmallRaise) / 0.35, 0.2, 2.5)
          : clamp(tend.foldToRaise / 0.35, 0.3, 2.2);
      const cont = (to: number): number => {
        const amount = to - nOpp;
        const fb = fBase(amount);
        let ev = 0;
        for (let i = 0; i < n; i++) {
          const pf =
            amount <= 0 ? 0 : Math.min(0.95, fb * sigmoid((0.38 + 0.05 * amount - s.potential[i]) / 0.07));
          ev += s.w[i] * (pf * nOpp + (1 - pf) * (2 * perD[i] - 1) * to);
        }
        return ev;
      };
      const lo = l.bet ? l.bet.min : l.raise ? l.raise.min : Infinity;
      for (let to = lo; to <= view.cap; to++) {
        // Match = BET; anything above N is a RAISE (BET above N is the same move).
        const action: Action | null =
          to === nOpp ? (l.bet ? { type: 'bet', to } : null) : l.raise && to >= l.raise.min ? { type: 'raise', to } : l.bet ? { type: 'bet', to } : null;
        if (!action) continue;
        out.push({ action, discard, ev: cont(to), eq: eqD, stake: to, label: `${action.type === 'bet' ? 'BET' : 'RAISE'} ${to}` });
      }
    } else if (view.phase === 'final') {
      // Final round: match the cap and exchange, or fold. Showdown follows.
      out.push({ action: { type: 'drop' }, discard: [], ev: -myBet, eq: 0, stake: 0, label: 'DROP' });
      out.push({ action: { type: 'bet', to: view.cap }, discard, ev: (2 * eqD - 1) * view.cap, eq: eqD, stake: view.cap, label: `BET ${view.cap} (final)` });
    } else if (view.phase === 'callResponse') {
      // The CALL can't be raised and nobody exchanges: match it (showdown) or fold.
      const amount = view.bets[opp];
      out.push({ action: { type: 'accept' }, discard: [], ev: (2 * a.eqNow - 1) * amount, eq: a.eqNow, stake: amount, label: `ACCEPT ${amount}` });
      out.push({ action: { type: 'drop' }, discard: [], ev: -myBet, eq: 0, stake: 0, label: 'DROP' });
    }

    // Risk adjustment from the coin lead: ahead → avoid variance, behind → seek it.
    const myCoins = view.stacks[me] + view.bets[me];
    const oppCoins = view.stacks[opp] + view.bets[opp];
    const lead = clamp((myCoins - oppCoins) / 12, -1, 1);
    const lambda = 0.03 * lead;
    for (const o of out) o.utility = o.ev - lambda * 4 * o.eq * (1 - o.eq) * o.stake * o.stake;
    return out;
  }

  /**
   * Hard's discipline layer, applied to the EV options before choosing.
   *  - Value CALLs need equity ≥ callMinEq vs. the inferred range, and CALL must not be clearly
   *    worse than drawing on (a CALL locks both hands: it pays when we are ahead now and the
   *    opponent's draw is the threat).
   *  - No minimum-size (+1) CALL with a merely decent hand: if we call, we call for value.
   *  - When short of coins, avoid coin-flip spots for big stakes.
   * If filtering would leave nothing sensible, the unfiltered options are used.
   */
  private discipline(view: PlayerView, a: Analysis, options: Option[]): Option[] {
    if (view.phase !== 'turn') return options;
    const me = this.me;
    const nOpp = view.bets[other(me)];
    const cont = options.filter((o) => o.action.type === 'bet' || o.action.type === 'raise');
    const bestCont = cont.length ? Math.max(...cont.map((o) => o.utility!)) : -Infinity;
    const threat = a.eqNow - (a.eq[0] >= 0 ? a.eq[0] : a.eqNow); // what the opponent's redraw costs us
    const kept = options.filter((o) => {
      if (o.action.type !== 'call') return true;
      if (!cont.length) return true; // CALL / DROP are the only choices left
      if (a.eqNow < this.cfg.callMinEq) return false; // medium/weak: draw instead
      if (o.stake - nOpp <= 1 && a.eqNow < 0.8 && o.stake < view.cap) return false; // no cheap value calls
      // Locking must be worth it: ahead now, and their draw is a real threat (or we are far ahead).
      return o.utility! >= bestCont - 0.15 && (threat > 0.03 || a.eqNow > 0.85);
    });
    // Short-stacked: drop big-variance coin flips.
    const myCoins = view.stacks[me] + view.bets[me];
    const safe = myCoins <= 4 ? kept.filter((o) => o.stake < 4 || o.eq > 0.62 || o.action.type === 'drop') : kept;
    return safe.length ? safe : kept.length ? kept : options;
  }

  /** How much more (or less) Hard bluffs here: player weakness, short stack, observed folding. */
  private bluffFactor(view: PlayerView, tend: Tendencies): number {
    const opp = other(this.me);
    let f = 1;
    const theirs = view.history.filter((e) => e.player === opp && e.type === 'exchange');
    const last = theirs[theirs.length - 1];
    if (last && (last.count ?? 0) >= 3) f *= 1.6; // they are drawing a lot → weak
    if (last && (last.count ?? 0) === 0) f *= 0.4; // they stood pat → strong (or a snow)
    const oppCoins = view.stacks[opp] + view.bets[opp];
    if (oppCoins <= 5) f *= 1.4; // short stack: losing hurts them more
    f *= clamp((tend.foldToBigRaise + tend.foldToBigCall) / 0.7, 0.2, 1.6); // only bluff a folder
    return f;
  }

  /**
   * EV of CALL at total `to`. The opponent can only ACCEPT (showdown at `to`) or DROP; the higher
   * the call above their bet, the more often weak hands fold (this is what makes bluff-calls work).
   */
  private callOption(s: RangeSamples, a: Analysis, tend: Tendencies, nOpp: number, to: number): Omit<Option, 'label'> {
    const extra = to - nOpp;
    const fDrop = this.cfg.disciplined
      ? clamp((extra >= 2 ? tend.foldToBigCall : tend.foldToSmallCall) / 0.3, 0.2, 2.8)
      : clamp(tend.foldToCall / 0.3, 0.3, 2.5);
    let ev = 0;
    // Hard: the player's learned accept threshold (from revealed hands) decides who folds.
    const thr = this.cfg.disciplined ? tend.acceptThreshold + 0.02 * extra : 0.35 + 0.06 * extra;
    for (let i = 0; i < s.n; i++) {
      const pDrop = Math.min(0.9, (this.cfg.disciplined ? clamp(fDrop, 0.5, 1.6) : fDrop) * sigmoid((thr - s.pct[i]) / 0.07));
      ev += s.w[i] * (pDrop * nOpp + (1 - pDrop) * (a.winNow[i] ? to : -to));
    }
    return { action: { type: 'call', to }, discard: [], ev, eq: a.eqNow, stake: to };
  }

  private choose(options: Option[]): Option {
    const tau = this.cfg.temperature;
    const best = Math.max(...options.map((o) => o.utility!));
    const ws = options.map((o) => Math.exp((o.utility! - best) / tau));
    let r = this.rng() * ws.reduce((x, y) => x + y, 0);
    for (let i = 0; i < options.length; i++) {
      r -= ws[i];
      if (r <= 0) return options[i];
    }
    return options[options.length - 1];
  }
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
