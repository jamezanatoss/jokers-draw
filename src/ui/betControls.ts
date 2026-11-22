/**
 * Pure helpers for the action panel (no DOM, unit-tested).
 *
 * One shared amount selector ("Your bet") drives BET, RAISE and CALL. The amount is a TOTAL for
 * this hand (ante included). It defaults to the minimum legal amount (N when BET is possible,
 * otherwise N+1) and is reset every turn and every hand. RAISE and CALL use max(amount, N+1).
 */
import {
  type Action,
  type AmountRange,
  type HandState,
  MAX_EXCHANGE_ROUNDS,
  legalActions,
  other,
} from '../engine';

/** Range of the shared selector: from N (lowest BET/CALL) up to the cap. Null if no amount applies. */
export function amountRange(h: HandState): AmountRange | null {
  if (h.phase !== 'turn') return null;
  const l = legalActions(h);
  const rs = [l.bet, l.raise, l.call].filter((r): r is AmountRange => !!r);
  if (!rs.length) return null;
  return { min: Math.min(...rs.map((r) => r.min)), max: Math.max(...rs.map((r) => r.max)) };
}

/** Default selector value: the minimum legal amount (N when BET is possible, otherwise N+1). */
export function defaultAmount(h: HandState): number | null {
  return amountRange(h)?.min ?? null;
}

/** Keep a selected amount inside the selector range. */
export function clampAmount(h: HandState, amount: number): number | null {
  const r = amountRange(h);
  return r ? Math.max(r.min, Math.min(r.max, amount)) : null;
}

export interface ButtonPreview {
  /** Big label, e.g. "RAISE → 3". */
  name: string;
  /** Small line under it, e.g. "exchange 2" / "no more exchanges". */
  sub: string;
  enabled: boolean;
  /** Short reason shown on hover when disabled. */
  reason: string;
  /** The action the button sends (null if disabled). */
  action: Action | null;
}

export interface Previews {
  /** Null when BET is not offered at all (first action of the hand / after a CALL). */
  bet: ButtonPreview | null;
  raise: ButtonPreview | null;
  call: ButtonPreview | null;
  accept: ButtonPreview | null;
  drop: ButtonPreview;
}

const inRange = (x: number, r: AmountRange | null) => !!r && x >= r.min && x <= r.max;

/**
 * What every button would do with the selected `amount`. `marked` = cards marked for exchange
 * (only BET and RAISE exchange).
 */
export function previews(h: HandState, amount: number, marked: number): Previews {
  const l = legalActions(h);
  const me = h.toAct;
  const n = h.bets[other(me)];
  const swap = h.deck.length === 0 ? 'deck empty · no exchange' : marked ? `exchange ${Math.min(marked, h.deck.length)}` : 'keep all';
  const roundsUsed = h.exchangeRounds >= MAX_EXCHANGE_ROUNDS;
  const finalNote = (total: number) => (total >= h.cap ? ' · final round' : '');
  const drop: ButtonPreview = {
    name: 'DROP',
    sub: `lose ${h.bets[me]}`,
    enabled: l.drop,
    reason: l.drop ? '' : 'Not your turn',
    action: l.drop ? { type: 'drop' } : null,
  };

  if (h.phase === 'final') {
    const ok = !!l.bet;
    return {
      bet: { name: `BET ${h.cap}`, sub: `${swap} · then showdown`, enabled: ok, reason: '', action: ok ? { type: 'bet', to: h.cap } : null },
      raise: null,
      call: null,
      accept: null,
      drop,
    };
  }

  if (h.phase === 'callResponse') {
    const a = h.bets[other(me)];
    return {
      bet: null,
      raise: null,
      call: null,
      accept: { name: `ACCEPT ${a}`, sub: 'match → showdown', enabled: l.accept, reason: '', action: l.accept ? { type: 'accept' } : null },
      drop,
    };
  }

  const betShown = h.phase === 'turn' && !l.first;
  const betOk = inRange(amount, l.bet);
  const bet: ButtonPreview | null = betShown
    ? {
        name: `BET ${amount}`,
        sub: swap + finalNote(amount),
        enabled: betOk,
        reason: betOk ? '' : roundsUsed ? `No exchange rounds left (max ${MAX_EXCHANGE_ROUNDS}) — CALL or DROP` : `BET must be ${l.bet?.min ?? n}–${h.cap}`,
        action: betOk ? { type: 'bet', to: amount } : null,
      }
    : null;

  const raiseTo = Math.max(amount, n + 1);
  const raiseOk = inRange(raiseTo, l.raise);
  const raise: ButtonPreview = {
    name: `RAISE → ${raiseTo}`,
    sub: swap + finalNote(raiseTo),
    enabled: raiseOk,
    reason: raiseOk
      ? ''
      : roundsUsed
        ? `No exchange rounds left (max ${MAX_EXCHANGE_ROUNDS}) — CALL or DROP`
        : `Already at the maximum (${h.cap})`,
    action: raiseOk ? { type: 'raise', to: raiseTo } : null,
  };

  // CALL must add at least 1: it uses max(amount, N+1), like RAISE.
  const callTo = Math.max(amount, n + 1);
  const callOk = inRange(callTo, l.call);
  const call: ButtonPreview = {
    name: `CALL ${Math.min(callTo, h.cap)}`,
    sub: 'no more exchanges',
    enabled: callOk,
    reason: callOk ? '' : l.call ? `CALL must be ${l.call.min}–${h.cap}` : `Not possible: the bet is already at the maximum (${h.cap})`,
    action: callOk ? { type: 'call', to: callTo } : null,
  };

  return { bet, raise, call, accept: null, drop };
}
