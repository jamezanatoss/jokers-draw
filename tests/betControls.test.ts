import { describe, expect, it } from 'vitest';
import { type Action, MAX_EXCHANGE_ROUNDS, applyAction, isLegal, mulberry32, newHand } from '../src/engine';
import { amountRange, clampAmount, defaultAmount, previews } from '../src/ui/betControls';

const rng = mulberry32(1);
const ex: Action = { type: 'exchange', cards: [] };
const act = (s: ReturnType<typeof newHand>, ...a: Action[]) => a.reduce(applyAction, s);

describe('default amount = minimum legal amount', () => {
  it('acting first: 2 (RAISE and CALL both need N+1; there is no BET)', () => {
    const s = newHand([12, 12], 0, rng);
    expect(defaultAmount(s)).toBe(2);
    expect(amountRange(s)).toEqual({ min: 2, max: 5 });
  });

  it('responding to an AI raise to 3: N = 3', () => {
    const s = act(newHand([12, 12], 1, rng), { type: 'raise', to: 3 }, ex);
    expect(defaultAmount(s)).toBe(3);
    expect(amountRange(s)).toEqual({ min: 3, max: 5 });
  });

  it('low coins: the range shrinks to the cap', () => {
    expect(amountRange(newHand([3, 12], 0, rng))).toEqual({ min: 2, max: 3 });
    expect(amountRange(newHand([1, 12], 0, rng))).toBeNull(); // cap 1: final round, no amount to choose
  });

  it('after a CALL there is no amount to choose', () => {
    const s = act(newHand([12, 12], 1, rng), { type: 'call', to: 2 });
    expect(amountRange(s)).toBeNull();
    expect(defaultAmount(s)).toBeNull();
  });

  it('clamps into the legal range', () => {
    const s = newHand([12, 12], 0, rng);
    expect(clampAmount(s, 9)).toBe(5);
    expect(clampAmount(s, 0)).toBe(2);
  });
});

describe('button previews', () => {
  it('acting first: no BET button; RAISE and CALL use max(amount, N+1); CALL / DROP previews', () => {
    const s = newHand([12, 12], 0, rng);
    const p = previews(s, 2, 0);
    expect(p.bet).toBeNull();
    expect(p.raise).toMatchObject({ name: 'RAISE → 2', sub: 'keep all', enabled: true, action: { type: 'raise', to: 2 } });
    expect(p.call).toMatchObject({ name: 'CALL 2', sub: 'no more exchanges', enabled: true, action: { type: 'call', to: 2 } });
    expect(p.drop).toMatchObject({ name: 'DROP', sub: 'lose 1' });
    expect(previews(s, 4, 2).raise).toMatchObject({ name: 'RAISE → 4', sub: 'exchange 2' });
    expect(previews(s, 5, 0).raise).toMatchObject({ name: 'RAISE → 5', sub: 'keep all · final round' });
  });

  it('responding to N = 2: BET uses the amount, RAISE at least N+1', () => {
    const s = act(newHand([12, 12], 1, rng), { type: 'raise', to: 2 }, ex);
    const p = previews(s, 2, 3);
    expect(p.bet).toMatchObject({ name: 'BET 2', sub: 'exchange 3', enabled: true, action: { type: 'bet', to: 2 } });
    expect(p.raise).toMatchObject({ name: 'RAISE → 3', action: { type: 'raise', to: 3 } });
    expect(p.call).toMatchObject({ name: 'CALL 3', action: { type: 'call', to: 3 } }); // N+1
    const p4 = previews(s, 4, 0);
    expect(p4.bet!.name).toBe('BET 4');
    expect(p4.raise!.name).toBe('RAISE → 4');
    expect(p4.call!.name).toBe('CALL 4');
  });

  it('every enabled preview sends a legal action (all amounts, several states)', () => {
    const states = [
      newHand([12, 12], 0, rng),
      act(newHand([12, 12], 1, rng), { type: 'raise', to: 3 }, ex),
      act(newHand([4, 12], 1, rng), { type: 'raise', to: 2 }, ex),
      act(newHand([12, 12], 1, rng), { type: 'raise', to: 4 }, ex),
    ];
    for (const s of states) {
      const r = amountRange(s)!;
      for (let a = r.min; a <= r.max; a++) {
        const p = previews(s, a, 0);
        for (const b of [p.bet, p.raise, p.call, p.drop]) {
          if (!b) continue;
          if (b.enabled) expect(isLegal(s, b.action!), `${b.name} @${a}`).toBe(true);
          else expect(b.action).toBeNull();
        }
      }
    }
  });

  it('final round (opponent at the cap): only BET 5 (then showdown) or DROP', () => {
    const s = act(newHand([12, 12], 1, rng), { type: 'raise', to: 5 }, ex);
    expect(amountRange(s)).toBeNull();
    const p = previews(s, 0, 2);
    expect(p.raise).toBeNull();
    expect(p.call).toBeNull();
    expect(p.bet).toMatchObject({ name: 'BET 5', sub: 'exchange 2 · then showdown', enabled: true, action: { type: 'bet', to: 5 } });
    expect(p.drop.enabled).toBe(true);
  });

  it('one below the cap: CALL can only be the cap, RAISE goes to the final round', () => {
    const s = act(newHand([12, 12], 1, rng), { type: 'raise', to: 4 }, ex);
    const p = previews(s, 4, 0);
    expect(p.call).toMatchObject({ name: 'CALL 5', enabled: true });
    expect(p.raise).toMatchObject({ name: 'RAISE → 5', sub: 'keep all · final round' });
    expect(p.bet).toMatchObject({ name: 'BET 4', enabled: true });
  });

  it('after the last exchange round: BET and RAISE disabled with a reason, CALL still works', () => {
    let s = act(newHand([12, 12], 0, rng), { type: 'raise', to: 2 }, ex);
    for (let i = 1; i < MAX_EXCHANGE_ROUNDS; i++) s = act(s, { type: 'bet' }, ex);
    const p = previews(s, 2, 0);
    expect(p.bet!.enabled).toBe(false);
    expect(p.bet!.reason).toMatch(/exchange rounds/);
    expect(p.raise!.enabled).toBe(false);
    expect(p.call).toMatchObject({ name: 'CALL 3', enabled: true });
  });

  it('after a CALL: only ACCEPT (match the call) and DROP', () => {
    const s = act(newHand([12, 12], 1, rng), { type: 'call', to: 3 });
    const p = previews(s, 0, 0);
    expect(p.bet).toBeNull();
    expect(p.raise).toBeNull();
    expect(p.call).toBeNull();
    expect(p.accept).toMatchObject({ name: 'ACCEPT 3', enabled: true, action: { type: 'accept' } });
    expect(p.drop).toMatchObject({ name: 'DROP', sub: 'lose 1', enabled: true });
  });

  it('empty deck: BET / RAISE say they exchange nothing', () => {
    let s = act(newHand([12, 12], 0, rng), { type: 'raise', to: 2 });
    s = act(s, { type: 'exchange', cards: s.hands[0].slice(0, 5) });
    s = act(s, { type: 'bet' });
    s = act(s, { type: 'exchange', cards: s.hands[1].slice(0, 5) });
    s = act(s, { type: 'bet' });
    s = act(s, { type: 'exchange', cards: s.hands[0].slice(0, 1) });
    expect(s.deck).toHaveLength(0);
    expect(previews(s, 2, 3).bet!.sub).toBe('deck empty · no exchange');
  });
});
