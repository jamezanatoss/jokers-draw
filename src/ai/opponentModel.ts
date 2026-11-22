/**
 * Opponent modelling.
 *
 * 1. Tendencies (across the match): Beta-distributed estimates of how often the
 *    player folds to raises / calls and how often their aggression is a bluff.
 *    Updated after every hand from what the AI could legitimately observe.
 *
 * 2. Range (this hand): importance-weighted samples of the player's current hand.
 *    Every sample replays the hand from the AI's point of view:
 *      - deal 5 random cards from the cards the AI has never seen,
 *      - at each of the player's exchanges of k cards, keep the best (5-k) cards
 *        (with some noise) and draw k more,
 *      - multiply the sample weight by the likelihood of each observed action
 *        (choosing k, raise size, CALL, ACCEPT ...) given the sample's hand.
 *    This is exact with respect to card removal — the deck order is uniformly random
 *    among the unseen cards — and only the *policy* of the player is modelled.
 */
import { type Card, HAND_SIZE, JOKER, MAX_CARDS, type PlayerId, type PlayerView, type Rng, deckSizeFor, other } from '../engine';
import { JOKER_BITS, type Tables, bestKeep, bestKeepBySize, getTables, maskOf, pctOf, popcount } from './tables';

interface Beta {
  a: number;
  b: number;
}
const mean = (x: Beta) => x.a / (x.a + x.b);

export interface Tendencies {
  foldToRaise: number;
  foldToCall: number;
  /** Fold rates split by size: "small" = +1 over the player's bet, "big" = +2 or more. */
  foldToSmallRaise: number;
  foldToBigRaise: number;
  foldToSmallCall: number;
  foldToBigCall: number;
  callerFold: number;
  bluff: number;
  /**
   * Learned from revealed hands (exact, because nothing changes after a CALL):
   *  - callStrength: typical percentile of the hand the player CALLs with;
   *  - acceptThreshold: percentile above which the player ACCEPTs our CALL (below: DROP).
   */
  callStrength: number;
  acceptThreshold: number;
  /** Typical final-hand percentile when the player raised to the cap (exact: no more draws after). */
  capRaiseStrength: number;
  handsObserved: number;
}

export class OpponentModel {
  private foldToRaise: Beta = { a: 1.75, b: 3.25 }; // prior ≈ 35%
  private foldToCall: Beta = { a: 1.2, b: 2.8 }; // ≈ 30%
  private callerFold: Beta = { a: 0.8, b: 3.2 }; // ≈ 20%
  private bluff: Beta = { a: 1, b: 5 }; // ≈ 17%
  // Same priors, split by size (small = +1, big = +2 or more over the player's bet).
  private foldSmallRaise: Beta = { a: 1.2, b: 3.3 };
  private foldBigRaise: Beta = { a: 1.8, b: 2.7 };
  private foldSmallCall: Beta = { a: 0.9, b: 3.1 };
  private foldBigCall: Beta = { a: 1.4, b: 2.6 };
  // Running means with priors: strength of the player's CALLs, and of hands they accept / drop with.
  private callPct = { sum: 0.65 * 3, n: 3 };
  private acceptPct = { sum: 0.6 * 2, n: 2 };
  private dropPct = { sum: 0.3 * 2, n: 2 };
  private capPct = { sum: 0.7 * 3, n: 3 };
  private hands = 0;

  constructor(private readonly learn = true) {}

  tendencies(): Tendencies {
    return {
      foldToRaise: mean(this.foldToRaise),
      foldToCall: mean(this.foldToCall),
      foldToSmallRaise: mean(this.foldSmallRaise),
      foldToBigRaise: mean(this.foldBigRaise),
      foldToSmallCall: mean(this.foldSmallCall),
      foldToBigCall: mean(this.foldBigCall),
      callerFold: mean(this.callerFold),
      bluff: mean(this.bluff),
      callStrength: this.callPct.sum / this.callPct.n,
      acceptThreshold: (this.acceptPct.sum / this.acceptPct.n + this.dropPct.sum / this.dropPct.n) / 2,
      capRaiseStrength: this.capPct.sum / this.capPct.n,
      handsObserved: this.hands,
    };
  }

  /**
   * Learn from a finished hand. `view` is the AI's own final view; `revealed` is the
   * opponent's final hand (hands are revealed after every hand, DROPs included), or null.
   */
  observeHand(view: PlayerView, revealed: Card[] | null): void {
    this.hands++;
    if (!this.learn) return;
    // Slow decay so the model can follow a player who changes style.
    for (const x of [this.foldToRaise, this.foldToCall, this.callerFold, this.bluff, this.foldSmallRaise, this.foldBigRaise, this.foldSmallCall, this.foldBigCall]) {
      x.a = 0.97 * x.a + 0.03 * 1;
      x.b = 0.97 * x.b + 0.03 * 3;
    }
    const me = view.me;
    const opp = other(me);
    const h = view.history;
    for (let i = 0; i < h.length; i++) {
      const e = h[i];
      if (e.player !== me) continue;
      const next = h.slice(i + 1).find((x) => x.player === opp && x.type !== 'exchange');
      if (!next) continue;
      const dropped = next.type === 'drop' ? 1 : 0;
      // Size of our move over the player's bet just before it.
      const before = i > 0 ? h[i - 1].bets : ([1, 1] as [number, number]);
      const extra = (e.to ?? 0) - before[opp];
      const add = (x: Beta) => {
        x.a += dropped;
        x.b += 1 - dropped;
      };
      if ((e.type === 'raise' || (e.type === 'bet' && extra > 0)) && e.phase === 'turn') {
        add(this.foldToRaise);
        add(extra >= 2 ? this.foldBigRaise : this.foldSmallRaise);
      } else if (e.type === 'call') {
        add(this.foldToCall);
        add(extra >= 2 ? this.foldBigCall : this.foldSmallCall);
      }
    }
    if (revealed) {
      const p = pctOf(getTables(view.jokers), maskOf(revealed));
      const decay = (x: { sum: number; n: number }) => {
        x.sum *= 0.95;
        x.n *= 0.95;
      };
      // Their CALL: the revealed hand is exactly the hand they called with.
      if (h.some((e) => e.player === opp && e.type === 'call')) {
        decay(this.callPct);
        this.callPct.sum += p;
        this.callPct.n += 1;
      }
      // They raised to the cap: after that they exchange once and never draw again, so the revealed
      // hand is the exact hand they took into the final round.
      if (h.some((e) => e.player === opp && e.phase === 'turn' && (e.type === 'raise' || e.type === 'bet') && (e.to ?? 0) >= view.cap)) {
        decay(this.capPct);
        this.capPct.sum += p;
        this.capPct.n += 1;
      }
      // Our CALL: they answered with exactly the revealed hand.
      const ourCall = h.findIndex((e) => e.player === me && e.type === 'call');
      if (ourCall >= 0) {
        const answer = h.slice(ourCall + 1).find((e) => e.player === opp);
        const bucket = answer?.type === 'accept' ? this.acceptPct : answer?.type === 'drop' ? this.dropPct : null;
        if (bucket) {
          decay(bucket);
          bucket.sum += p;
          bucket.n += 1;
        }
      }
      const aggressive = h.some((e) => e.player === opp && (e.type === 'raise' || e.type === 'call'));
      if (aggressive) {
        if (p < 0.4) this.bluff.a += 1;
        else this.bluff.b += 1;
      }
    }
  }
}

/** Struct-of-arrays sample set. */
export interface RangeSamples {
  n: number;
  /** Opponent's current 5-card mask. */
  opp: Int32Array;
  /** Normalised weights. */
  w: Float64Array;
  /** Remaining deck in random order: rest[i * stride + j]. Its length is the deck count. */
  rest: Int8Array;
  stride: number;
  restLen: number;
  /** Opponent's best keep for each kept size 0..5 (for simulating future redraws). */
  keepBySize: Int32Array;
  /** How many cards the opponent would exchange given the chance (canonical policy). */
  redrawK: Int8Array;
  /** Percentile of the opponent's current hand. */
  pct: Float32Array;
  /** Opponent's "potential": expected percentile with their best exchange. */
  potential: Float32Array;
  /** Effective sample size of the weights. */
  ess: number;
}

export interface SamplingOptions {
  samples: number;
  /** Use bet-size / call likelihoods (range inference). */
  useBetting: boolean;
  /** Use the exchange-count likelihood. */
  useExchange: boolean;
  /** Softmax temperature for the exchange-count likelihood. */
  exchangeTemp: number;
  /**
   * Floor mixed into the exchange-count likelihood: the chance a player picks a count
   * for reasons other than hand strength (snowing, trapping, misplays).
   */
  exchangeFloor: number;
  /** Probability the opponent keeps a random (not the best) subset. */
  keepNoise: number;
  tendencies: Tendencies;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Likelihood of an aggressive RAISE of `amount` coins given hand potential v. */
export function raiseLikelihood(v: number, amount: number, bluff: number): number {
  return bluff + (1 - bluff) * sigmoid((v - (0.42 + 0.06 * amount)) / 0.07);
}
/**
 * Likelihood of a CALL (showdown challenge with current cards) at `extra` coins above our bet,
 * given made percentile p. Bigger calls need (or represent) stronger hands.
 */
export function callLikelihood(p: number, bluff: number, extra = 0, center = 0.6): number {
  return 0.6 * bluff + (1 - 0.6 * bluff) * sigmoid((p - (center + 0.05 * extra)) / 0.07);
}

/**
 * Sample the opponent's hand. In cheat mode (view.oppHand present) the result is a single
 * exact sample with the real deck order.
 */
export function sampleRange(view: PlayerView, t: Tables, rng: Rng, opt: SamplingOptions): RangeSamples {
  const me: PlayerId = view.me;
  const opp = other(me);
  const restLen = view.deckCount;
  const stride = Math.max(1, restLen);
  const ksScratchMask = new Int32Array(HAND_SIZE + 1);
  const ksScratchVal = new Float32Array(HAND_SIZE + 1);

  const finish = (s: Omit<RangeSamples, 'keepBySize' | 'redrawK' | 'pct' | 'potential' | 'ess'>): RangeSamples => {
    const keepBySize = new Int32Array(s.n * (HAND_SIZE + 1));
    const redrawK = new Int8Array(s.n);
    const pct = new Float32Array(s.n);
    const potential = new Float32Array(s.n);
    let sw = 0;
    let sw2 = 0;
    for (let i = 0; i < s.n; i++) {
      const m = s.opp[i];
      bestKeepBySize(t, m, ksScratchMask, ksScratchVal);
      keepBySize.set(ksScratchMask, i * (HAND_SIZE + 1));
      const bk = bestKeep(t, m, Math.min(HAND_SIZE, restLen));
      redrawK[i] = HAND_SIZE - popcount(bk.keep);
      pct[i] = pctOf(t, m);
      potential[i] = bk.value;
      sw += s.w[i];
      sw2 += s.w[i] * s.w[i];
    }
    for (let i = 0; i < s.n; i++) s.w[i] /= sw;
    return { ...s, keepBySize, redrawK, pct, potential, ess: (sw * sw) / sw2 };
  };

  if (view.oppHand && view.deckOrder) {
    const rest = new Int8Array(stride);
    view.deckOrder.forEach((c, j) => (rest[j] = c));
    return finish({
      n: 1,
      opp: Int32Array.of(maskOf(view.oppHand)),
      w: Float64Array.of(1),
      rest,
      stride,
      restLen,
    });
  }

  // Cards the AI has never seen. With face-up discards the opponent's thrown cards are known too:
  // they are neither in the deck nor in the opponent's hand.
  const known = view.oppDiscards ? maskOf(view.oppDiscards) : 0;
  const seen = maskOf(view.hand) | maskOf(view.myDiscards) | known;
  const unseen: number[] = [];
  for (let c = 0; c < deckSizeFor(view.jokers); c++) if (!(seen & (1 << c))) unseen.push(c);
  const U = unseen.length;

  // Opponent events in order, with the bet before each. `thrown` is the exact discard mask when
  // discards are face up (0 when unknown).
  type OppEvent =
    | { kind: 'exchange'; k: number; maxK: number; thrown: number }
    | { kind: 'raise'; amount: number }
    | { kind: 'call'; extra: number }
    | { kind: 'accept' };
  const events: OppEvent[] = [];
  let prevBets: [number, number] = [1, 1];
  for (const e of view.history) {
    if (e.player === opp) {
      if (e.type === 'exchange') {
        events.push({
          kind: 'exchange',
          k: e.count ?? 0,
          maxK: Math.min(HAND_SIZE, e.deckBefore),
          thrown: known && e.cards ? maskOf(e.cards) : 0,
        });
      }
      // A BET above our bet is the same move as a RAISE.
      else if (e.type === 'raise' || (e.type === 'bet' && (e.to ?? 0) > prevBets[me])) {
        events.push({ kind: 'raise', amount: (e.to ?? 0) - prevBets[me] });
      } else if (e.type === 'call') {
        // A CALL before the player has drawn at all (on the dealt hand) is a stronger signal.
        const drewBefore = view.history.some((x) => x.player === opp && x.type === 'exchange' && x !== e && view.history.indexOf(x) < view.history.indexOf(e));
        events.push({ kind: 'call', extra: Math.max(0, (e.to ?? 0) - prevBets[me]) + (drewBefore ? 0 : 1) });
      }
      else if (e.type === 'accept') events.push({ kind: 'accept' });
    }
    prevBets = e.bets;
  }

  const bluff = opt.tendencies.bluff;
  // Did the opponent take the hand to the cap with a BET/RAISE (we are in their final round)?
  const capRaised = view.history.some(
    (e) => e.player === opp && e.phase === 'turn' && (e.type === 'raise' || e.type === 'bet') && (e.to ?? 0) >= view.cap,
  );
  const n = opt.samples;
  const oppArr = new Int32Array(n);
  const w = new Float64Array(n);
  const rest = new Int8Array(n * stride);
  const buf = new Int8Array(U);
  const bySizeMask = new Int32Array(HAND_SIZE + 1);
  const bySizeVal = new Float32Array(HAND_SIZE + 1);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < U; j++) buf[j] = unseen[j];
    let ptr = 0;
    // Random draw from the unseen cards. A hand that holds a Joker refuses the other one, which
    // stays in the deck (one-Joker rule). Returns -1 if only a refused Joker is left.
    const draw = (holding: number): number => {
      for (;;) {
        if (ptr >= U) return -1;
        const j = ptr + Math.floor(rng() * (U - ptr));
        const c = buf[j];
        if (c >= JOKER && (holding & JOKER_BITS) !== 0) {
          if (U - ptr === 1) return -1;
          continue;
        }
        buf[j] = buf[ptr];
        buf[ptr] = c;
        ptr++;
        return c;
      }
    };
    // Put a drawn card back into the unseen pool (used when a known discard must replace it).
    const undraw = (c: number) => {
      for (let j = 0; j < ptr; j++) {
        if (buf[j] === c) {
          buf[j] = buf[ptr - 1];
          buf[ptr - 1] = c;
          ptr--;
          return;
        }
      }
    };
    // The first known discards were in the initial hand.
    const firstEx = events.find((e) => e.kind === 'exchange');
    let hand = firstEx && firstEx.kind === 'exchange' ? firstEx.thrown : 0;
    while (popcount(hand) < HAND_SIZE) hand |= 1 << draw(hand);
    let weight = 1;

    for (const ev of events) {
      if (ev.kind === 'exchange' && ev.thrown) {
        // Face-up discards: the player threw exactly these cards. Any of them not yet in the
        // sampled hand must have been dealt or drawn earlier: swap it in for a random sampled card.
        const D = ev.thrown;
        let missing = D & ~hand;
        while (missing) {
          const c = 31 - Math.clz32(missing & -missing);
          missing &= ~(1 << c);
          let pool = hand & ~D & ~known;
          if (c >= JOKER && (pool & JOKER_BITS)) pool &= JOKER_BITS; // never two Jokers
          const cands = cardsOfMask(pool);
          if (!cands.length) continue;
          const r = cands[Math.floor(rng() * cands.length)];
          hand = (hand & ~(1 << r)) | (1 << c);
          undraw(r);
        }
        const kept = hand & ~D;
        if (opt.useExchange) {
          // Likelihood of keeping exactly this subset: softmax over all allowed keeps.
          let z = 0;
          let allowed = 0;
          for (let sub = hand; ; sub = (sub - 1) & hand) {
            if (HAND_SIZE - popcount(sub) <= ev.maxK) {
              z += Math.exp(t.keep[sub] / opt.exchangeTemp);
              allowed++;
            }
            if (sub === 0) break;
          }
          const soft = Math.exp(t.keep[kept] / opt.exchangeTemp) / z;
          weight *= (1 - opt.exchangeFloor) * soft + opt.exchangeFloor / allowed;
        }
        hand = kept;
        for (let j = 0; j < ev.k; j++) {
          const c = draw(hand);
          hand |= 1 << (c >= 0 ? c : draw(0));
        }
      } else if (ev.kind === 'exchange') {
        bestKeepBySize(t, hand, bySizeMask, bySizeVal);
        const k = Math.min(ev.k, U - ptr);
        if (opt.useExchange) {
          // Softmax over how many cards a sensible player would exchange.
          let z = 0;
          for (let kk = 0; kk <= ev.maxK; kk++) z += Math.exp(bySizeVal[HAND_SIZE - kk] / opt.exchangeTemp);
          const soft = Math.exp(bySizeVal[HAND_SIZE - k] / opt.exchangeTemp) / z;
          weight *= (1 - opt.exchangeFloor) * soft + opt.exchangeFloor / (ev.maxK + 1);
        }
        let kept = bySizeMask[HAND_SIZE - k];
        if (k > 0 && rng() < opt.keepNoise) {
          // Random subset of the right size.
          const cards: number[] = [];
          for (let c = 0; c < MAX_CARDS; c++) if (hand & (1 << c)) cards.push(c);
          for (let a = cards.length - 1; a > 0; a--) {
            const b = Math.floor(rng() * (a + 1));
            [cards[a], cards[b]] = [cards[b], cards[a]];
          }
          kept = 0;
          for (let j = 0; j < HAND_SIZE - k; j++) kept |= 1 << cards[j];
        }
        let thrown = hand & ~kept;
        hand = kept;
        for (let j = 0; j < k; j++) {
          const c = draw(hand);
          if (c >= 0) hand |= 1 << c;
          else {
            // Draw skipped: a discarded card stays in hand.
            const back = thrown & -thrown;
            hand |= back;
            thrown &= ~back;
          }
        }
      } else if (opt.useBetting) {
        if (ev.kind === 'raise') {
          weight *= raiseLikelihood(bestKeep(t, hand).value, ev.amount, bluff);
        } else if (ev.kind === 'call') {
          // Centre on the strength this player has actually been seen to CALL with.
          weight *= callLikelihood(pctOf(t, hand), bluff, ev.extra, opt.useBetting ? opt.tendencies.callStrength - 0.08 : 0.6);
        } else if (ev.kind === 'accept') {
          weight *= 0.15 + 0.85 * sigmoid((pctOf(t, hand) - 0.45) / 0.08);
        }
      }
    }

    if (capRaised && opt.useBetting) {
      // Calibrate to how strong this player really is when they push to the cap.
      const d = pctOf(t, hand) - opt.tendencies.capRaiseStrength;
      weight *= 0.15 + 0.85 * Math.exp(-(d * d) / (2 * 0.16 * 0.16));
    }
    oppArr[i] = hand;
    w[i] = weight + 1e-12;
    // Remaining unseen cards (in random order) are exactly the deck.
    const remaining = U - ptr; // equals restLen by construction
    for (let j = 0; j < restLen; j++) rest[i * stride + j] = j < remaining ? draw(0) : -1;
  }

  return finish({ n, opp: oppArr, w, rest, stride, restLen });
}

function cardsOfMask(mask: number): number[] {
  const out: number[] = [];
  for (let c = 0; c < MAX_CARDS; c++) if (mask & (1 << c)) out.push(c);
  return out;
}
