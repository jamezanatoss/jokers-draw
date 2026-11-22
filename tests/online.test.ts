import { describe, expect, it } from 'vitest';
import { type Card, type PlayerId, fullDeck, legalActions, mulberry32, shuffle } from '../src/engine';
import { localMatch } from '../src/online/localize';
import type { ConnectQuery, Intent, OnlineView, ServerMsg } from '../shared/protocol';
import { type CoreOptions, GRACE_MS, type Outgoing, RoomCore } from '../server/src/core';

const HOST = 'host-pid-0001';
const GUEST = 'guest-pid-0002';

function seededRng(seed: number): CoreOptions['rng'] {
  const r = mulberry32(seed);
  return () => mulberry32(Math.floor(r() * 2 ** 32));
}

/** A room with both players seated. Collects every message per seat. */
function room(settings: Partial<ConnectQuery> = {}, opts: CoreOptions = {}) {
  const core = new RoomCore('ABCDE', null, { rng: seededRng(7), ...opts });
  const inbox: [ServerMsg[], ServerMsg[]] = [[], []];
  const deliver = (out: Outgoing[]) => out.forEach((o) => inbox[o.to].push(o.msg));
  const a = core.connect({ pid: HOST, create: '1', jokers: '1', discards: 'down', order: 'first', ...settings });
  if ('error' in a) throw new Error(a.error.message);
  deliver(a.out);
  const b = core.connect({ pid: GUEST });
  if ('error' in b) throw new Error(b.error.message);
  deliver(b.out);
  const send = (seat: PlayerId, msg: unknown) => {
    const out = core.message(seat, typeof msg === 'string' ? msg : JSON.stringify(msg));
    deliver(out);
    return out;
  };
  const act = (seat: PlayerId, intent: Intent) => send(seat, { type: 'intent', intent });
  const view = (seat: PlayerId): OnlineView => {
    const v = [...inbox[seat]].reverse().find((m) => m.type === 'state');
    if (!v || v.type !== 'state') throw new Error('no state yet');
    return v.view;
  };
  return { core, inbox, send, act, view };
}

const errorOf = (out: Outgoing[]) => {
  expect(out).toHaveLength(1);
  const m = out[0].msg;
  expect(m.type).toBe('error');
  return m as ServerMsg & { type: 'error' };
};

describe('online room: lobby', () => {
  it('seats host and guest, starts the match when both are connected', () => {
    const r = room();
    const rooms = r.inbox.map((box) => box.filter((m) => m.type === 'room').at(-1));
    expect(rooms[0]).toMatchObject({ room: { seat: 0, status: 'playing', code: 'ABCDE' } });
    expect(rooms[1]).toMatchObject({ room: { seat: 1, status: 'playing' } });
    expect(r.view(0).hand).toHaveLength(5);
    expect(r.view(0).toAct).toBe(0); // host chose "first"
  });

  it('rejects unknown rooms, a third player, taken codes and bad settings', () => {
    const empty = new RoomCore('ZZZZZ');
    expect(empty.connect({ pid: 'someone-123' })).toMatchObject({ error: { code: 'not-found' } });
    expect(empty.connect({ pid: 'someone-123', create: '1', jokers: '3' })).toMatchObject({ error: { code: 'bad-request' } });
    const r = room();
    expect(r.core.connect({ pid: 'intruder-999' })).toMatchObject({ error: { code: 'room-full' } });
    expect(r.core.connect({ pid: 'intruder-999', create: '1' })).toMatchObject({ error: { code: 'room-taken' } });
    expect(r.core.connect({ pid: 'x' })).toMatchObject({ error: { code: 'bad-request' } });
  });

  it('a reconnect with the same player id gets the same seat and the current state', () => {
    const r = room();
    r.core.disconnect(1);
    const back = r.core.connect({ pid: GUEST });
    expect(back).toMatchObject({ seat: 1 });
    const state = (back as { out: Outgoing[] }).out.find((o) => o.to === 1 && o.msg.type === 'state');
    expect(state).toBeTruthy();
    // The host creating again (e.g. auto-reconnect with the create query) is also a rejoin.
    expect(r.core.connect({ pid: HOST, create: '1' })).toMatchObject({ seat: 0 });
  });

  it('random order: the server flips once and both players see the same result', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = room({ order: 'random' }, { rng: seededRng(seed) });
      const flips = r.inbox.map((box) => {
        const m = box.filter((x) => x.type === 'room').at(-1);
        return m?.type === 'room' ? m.room : null;
      });
      expect(flips[0]!.status).toBe('flip');
      expect(flips[0]!.flip).toEqual(flips[1]!.flip);
      expect(flips[0]!.flip!.first).toBe(flips[0]!.flip!.face === 'heads' ? 0 : 1);
      // No cards before both press Play.
      expect(r.inbox[0].some((m) => m.type === 'state')).toBe(false);
      expect(errorOf(r.act(flips[0]!.flip!.first, { action: 'drop' })).code).toBe('not-your-turn');
      r.send(0, { type: 'ready' });
      expect(r.inbox[1].some((m) => m.type === 'state')).toBe(false);
      r.send(1, { type: 'ready' });
      expect(r.view(0).toAct).toBe(flips[0]!.flip!.first);
      expect(r.view(1).firstToAct).toBe(flips[0]!.flip!.first);
    }
  });
});

describe('online room: the server rejects illegal actions', () => {
  it('rejects out-of-turn, malformed and impossible intents without changing the state', () => {
    const r = room();
    const before = JSON.stringify(r.core.data);
    const cases: [PlayerId, unknown, string][] = [
      [1, { type: 'intent', intent: { action: 'raise', amount: 2 } }, 'not-your-turn'],
      [0, 'not json', 'bad-request'],
      [0, { type: 'hack' }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'fold' } }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'raise' } }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'raise', amount: 2.5 } }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'call', amount: 2, exchange: [] } }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'raise', amount: 2, exchange: [1, 2, 3, 4, 5, 6] } }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'drop', amount: 1 } }, 'bad-request'],
      [0, { type: 'intent', intent: { action: 'bet', amount: 1 } }, 'illegal'], // no BET on the first action
      [0, { type: 'intent', intent: { action: 'raise', amount: 6 } }, 'illegal'], // above the max
      [0, { type: 'intent', intent: { action: 'raise', amount: 1 } }, 'illegal'], // must add at least 1
      [0, { type: 'intent', intent: { action: 'call', amount: 1 } }, 'illegal'], // CALL must be >= N+1
      [0, { type: 'intent', intent: { action: 'accept' } }, 'illegal'], // nothing to accept
      [0, { type: 'ready' }, 'bad-request'],
    ];
    for (const [seat, msg, code] of cases) {
      expect(errorOf(r.send(seat, msg)).code, JSON.stringify(msg)).toBe(code);
    }
    // Exchanging the opponent's cards or a card twice.
    const oppCard = r.core.data!.match!.hand!.hands[1][0];
    const mine = r.view(0).hand;
    expect(errorOf(r.act(0, { action: 'raise', amount: 2, exchange: [oppCard] })).message).toMatch(/own hand/);
    expect(errorOf(r.act(0, { action: 'raise', amount: 2, exchange: [mine[0], mine[0]] })).message).toMatch(/twice/);
    expect(JSON.stringify(r.core.data)).toBe(before);
  });

  it('enforces the CALL / final-round rules', () => {
    const r = room();
    r.act(0, { action: 'call', amount: 3 });
    expect(r.view(1).phase).toBe('callResponse');
    expect(errorOf(r.act(1, { action: 'raise', amount: 4 })).message).toMatch(/ACCEPT or DROP/);
    expect(errorOf(r.act(1, { action: 'bet', amount: 3, exchange: [] })).code).toBe('illegal');
    r.act(1, { action: 'accept' });
    expect(r.view(0).phase).toBe('over');
    expect(errorOf(r.act(0, { action: 'drop' })).code).toBe('not-your-turn');

    const f = room();
    f.act(0, { action: 'raise', amount: 5, exchange: [] }); // to the cap → final round
    expect(f.view(1).phase).toBe('final');
    expect(f.view(1).legal).toMatchObject({ final: true, bet: { min: 5, max: 5 }, raise: null, call: null });
    expect(errorOf(f.act(1, { action: 'call', amount: 5 })).code).toBe('illegal');
    expect(errorOf(f.act(1, { action: 'bet', amount: 4 })).code).toBe('illegal');
    f.act(1, { action: 'bet', exchange: [f.view(1).hand[0]] });
    expect(f.view(1).phase).toBe('over'); // automatic showdown
    expect(f.view(1).reveal!.outcome.kind).toBe('showdown');
  });

  it('BET/RAISE and the exchange are applied together; a bad exchange rejects both', () => {
    const r = room();
    const hand = r.view(0).hand;
    r.act(0, { action: 'raise', amount: 2, exchange: [hand[1], hand[3]] });
    const v = r.view(0);
    expect(v.bets[0]).toBe(2);
    expect(v.myDiscards).toEqual([hand[1], hand[3]]);
    expect(v.hand.filter((c) => !hand.includes(c))).toHaveLength(2);
    expect(v.toAct).toBe(1);
    expect(v.phase).toBe('turn'); // the exchange phase is never visible
  });
});

/** Card ids appearing in card-carrying fields of a message (bets/amounts are not cards). */
function cardsIn(msg: unknown): Card[] {
  const found: Card[] = [];
  const walk = (x: unknown, key: string) => {
    if (Array.isArray(x)) {
      if (['hand', 'cards', 'myDiscards', 'oppDiscards', 'hands'].includes(key)) {
        x.forEach((c) => (typeof c === 'number' ? found.push(c) : walk(c, key)));
      } else x.forEach((c) => walk(c, key));
    } else if (x && typeof x === 'object') {
      for (const [k, v] of Object.entries(x)) walk(v, k);
    } else if (typeof x === 'number' && ['topCard', 'highestReal', 'jokerAs'].includes(key)) found.push(x);
  };
  walk(msg, '');
  return found;
}

const FORBIDDEN_KEYS = ['deck', 'deckOrder', 'seed', 'oppHand', 'hands', 'outcome', 'evaluations'];
function keysIn(msg: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object')
      for (const [k, v] of Object.entries(x)) {
        keys.add(k);
        walk(v);
      }
  };
  walk(msg);
  return keys;
}

/** A bot that only sees its own view (like a real client). */
function botIntent(v: OnlineView, rnd: () => number): Intent {
  const l = v.legal;
  const pick = () => v.hand.filter(() => rnd() < 0.35).slice(0, Math.min(5, v.deckCount));
  if (l.accept) return rnd() < 0.65 ? { action: 'accept' } : { action: 'drop' };
  if (l.final) return rnd() < 0.85 ? { action: 'bet', exchange: pick() } : { action: 'drop' };
  const x = rnd();
  const amt = (r: { min: number; max: number }) => r.min + Math.floor(rnd() * (r.max - r.min + 1));
  if (l.raise && x < 0.45) return { action: 'raise', amount: amt(l.raise), exchange: pick() };
  if (l.bet && x < 0.7) return { action: 'bet', amount: amt(l.bet), exchange: pick() };
  if (l.call && x < 0.92) return { action: 'call', amount: amt(l.call) };
  return { action: 'drop' };
}

/** Play the room's current match to game over, checking each message as it goes. */
function playOut(r: ReturnType<typeof room>, seed: number, check?: (seat: PlayerId, msg: ServerMsg) => void): number {
  const rnd = mulberry32(seed);
  let hands = 0;
  let seen: [number, number] = [r.inbox[0].length, r.inbox[1].length];
  const inspect = () => {
    for (const p of [0, 1] as PlayerId[]) {
      for (const m of r.inbox[p].slice(seen[p])) check?.(p, m);
    }
    seen = [r.inbox[0].length, r.inbox[1].length];
  };
  inspect();
  for (let steps = 0; steps < 5000; steps++) {
    const d = r.core.data!;
    if (d.status === 'over') return hands;
    if (d.status === 'handOver' || d.status === 'flip') {
      if (d.status === 'handOver') hands++;
      r.send(0, { type: 'ready' });
      r.send(1, { type: 'ready' });
    } else {
      const toAct = d.match!.hand!.toAct;
      const out = r.act(toAct, botIntent(r.view(toAct), rnd));
      expect(out.some((o) => o.msg.type === 'error'), JSON.stringify(out)).toBe(false);
    }
    inspect();
  }
  throw new Error('match did not finish');
}

describe('online room: hidden information', () => {
  for (const discards of ['down', 'up'] as const) {
    for (const jokers of ['1', '2'] as const) {
      it(`no message ever contains the opponent's hidden cards (${jokers} Joker, discards ${discards})`, () => {
        for (let seed = 1; seed <= 6; seed++) {
          const r = room({ discards, jokers, order: 'random' }, { rng: seededRng(seed * 31) });
          let checked = 0;
          playOut(r, seed, (seat, msg) => {
            const h = r.core.data!.match?.hand;
            if (msg.type !== 'state' || !h) return;
            const opp = (1 - seat) as PlayerId;
            const v = msg.view;
            if (v.phase === 'over') {
              expect(v.reveal).toBeTruthy(); // reveal only at the end of the hand
              return;
            }
            const hidden = new Set<Card>([...h.hands[opp], ...h.deck, ...(discards === 'down' ? h.discards[opp] : [])]);
            const leaked = cardsIn(msg).filter((c) => hidden.has(c));
            expect(leaked, `seat ${seat} saw ${leaked}`).toEqual([]);
            for (const k of FORBIDDEN_KEYS) expect(keysIn(msg).has(k), `key ${k}`).toBe(false);
            // Own cards are exactly the hand; counts are right.
            expect(v.hand.sort()).toEqual([...h.hands[seat]].sort());
            expect(v.oppCardCount).toBe(5);
            expect(v.deckCount).toBe(h.deck.length);
            if (discards === 'down') expect(v.oppDiscards).toBeUndefined();
            else expect(v.oppDiscards).toEqual(h.discards[opp]);
            checked++;
          });
          expect(checked).toBeGreaterThan(10);
        }
      });
    }
  }

  it("what a player receives does not depend on the opponent's cards (face down)", () => {
    // Two worlds: seat 0's cards are the same, the opponent's cards and the deck are permuted.
    // Every message seat 0 gets before the reveal must be identical in both worlds.
    for (let seed = 1; seed <= 20; seed++) {
      const base = shuffle(fullDeck(1), mulberry32(seed));
      const mineIdx = [0, 2, 4, 6, 8]; // host acts first: dealt cards 0, 2, 4, 6, 8
      const rest = base.filter((_, i) => !mineIdx.includes(i));
      const other = shuffle(rest, mulberry32(seed + 1000));
      const deckB = [...base];
      let k = 0;
      for (let i = 0; i < deckB.length; i++) if (!mineIdx.includes(i)) deckB[i] = other[k++];
      const worlds = [base, deckB].map((deck) => {
        const r = room({ discards: 'down', order: 'first' }, { rng: seededRng(seed), deckFor: () => deck, now: () => 5000, token: () => 'fixed-token-0000000000' });
        // Same public script in both worlds; the opponent throws the cards in the same slots.
        r.act(0, { action: 'raise', amount: 2, exchange: [] });
        r.act(1, { action: 'bet', amount: 2, exchange: [r.core.data!.match!.hand!.hands[1][0], r.core.data!.match!.hand!.hands[1][3]] });
        r.act(0, { action: 'raise', amount: 3, exchange: [] });
        r.act(1, { action: 'raise', amount: 4, exchange: [r.core.data!.match!.hand!.hands[1][2]] });
        r.act(0, { action: 'call', amount: 5 });
        return r.inbox[0].map((m) => JSON.stringify(m));
      });
      expect(worlds[0].length).toBeGreaterThan(5);
      expect(worlds[1]).toEqual(worlds[0]);
    }
  });
});

describe('online room: full matches', () => {
  it('plays full matches to game over, then a rematch in the same room', () => {
    for (let seed = 1; seed <= 15; seed++) {
      const settings = {
        jokers: seed % 2 ? '1' : '2',
        discards: seed % 3 ? 'up' : 'down',
        order: (['first', 'second', 'random'] as const)[seed % 3],
      } as const;
      const r = room(settings, { rng: seededRng(seed) });
      const hands = playOut(r, seed);
      const d = r.core.data!;
      expect(d.status).toBe('over');
      const m = d.match!;
      expect(m.winner).not.toBeNull();
      expect(m.coins[0] + m.coins[1]).toBe(24);
      expect(m.coins[1 - m.winner!]).toBe(0);
      expect(hands + 1).toBe(m.handNumber);
      // Both players are told who won.
      expect(r.view(0).matchWinner).toBe(m.winner);
      expect(r.view(1).matchWinner).toBe(m.winner);
      // Rematch: both press Play again.
      r.send(0, { type: 'ready' });
      expect(r.core.data!.matchNumber).toBe(1);
      r.send(1, { type: 'ready' });
      expect(r.core.data!.matchNumber).toBe(2);
      expect(['playing', 'flip']).toContain(r.core.data!.status);
    }
  });

  it('room data survives a JSON round trip (Durable Object storage)', () => {
    const r = room();
    r.act(0, { action: 'raise', amount: 3, exchange: [r.view(0).hand[0]] });
    const copy = new RoomCore('ABCDE', JSON.parse(JSON.stringify(r.core.data)));
    expect(copy.connect({ pid: GUEST })).toMatchObject({ seat: 1 });
    const out = copy.message(1, JSON.stringify({ type: 'intent', intent: { action: 'call', amount: 4 } }));
    expect(out.some((o) => o.msg.type === 'error')).toBe(false);
    expect(copy.data!.match!.hand!.phase).toBe('callResponse');
  });
});

describe('online client: localizing the view', () => {
  it("the client's own-perspective state agrees with the server at every step", () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = room({ jokers: seed % 2 ? '1' : '2', discards: seed % 3 ? 'up' : 'down', order: 'random' }, { rng: seededRng(seed + 50) });
      let checked = 0;
      playOut(r, seed + 7, (seat, msg) => {
        if (msg.type !== 'state') return;
        const v = msg.view;
        const m = localMatch(v);
        const h = m.hand!;
        const real = r.core.data!.match!.hand!;
        const opp = (1 - seat) as PlayerId;
        // Local player 0 = this seat.
        expect(h.hands[0]).toEqual(real.hands[seat]);
        expect(h.bets).toEqual([real.bets[seat], real.bets[opp]]);
        expect(h.stacks).toEqual([real.stacks[seat], real.stacks[opp]]);
        expect(h.toAct).toBe(real.toAct === seat ? 0 : 1);
        expect(h.deck).toHaveLength(real.deck.length);
        expect(h.history).toHaveLength(real.history.length);
        if (v.phase === 'over') {
          expect(h.hands[1]).toEqual(real.hands[opp]);
          expect(h.outcome!.winner).toBe(real.outcome!.winner === seat ? 0 : 1);
          expect(m.coins).toEqual([real.outcome!.coinsAfter[seat], real.outcome!.coinsAfter[opp]]);
        } else {
          expect(h.hands[1].every((c) => c < 0)).toBe(true);
          // The buttons are built from the local state: they must offer exactly what the server allows.
          if (real.toAct === seat && r.core.data!.status === 'playing') {
            expect(legalActions(h)).toEqual(v.legal);
            expect(v.legal).toEqual(legalActions(real));
          }
        }
        checked++;
      });
      expect(checked).toBeGreaterThan(10);
    }
  });
});

// ------------------------------------------------------------------ session 2: robustness

/** A room on a fake clock. `advance` moves time and runs the server clocks like an alarm would. */
function clocked(settings: Partial<ConnectQuery> = {}) {
  let t = 1_000_000;
  let n = 0;
  const r = room(settings, { now: () => t, token: () => `token-${++n}-abcdefghijklmnop` });
  const advance = (ms: number) => {
    t += ms;
    const { out, expired } = r.core.tick();
    out.forEach((o) => r.inbox[o.to].push(o.msg));
    return { out, expired };
  };
  const lastRoom = (seat: PlayerId) => {
    const m = [...r.inbox[seat]].reverse().find((x) => x.type === 'room');
    if (!m || m.type !== 'room') throw new Error('no room info');
    return m.room;
  };
  const deliver = (res: unknown) => {
    const out = (res as { out?: Outgoing[] }).out ?? [];
    out.forEach((o) => r.inbox[o.to].push(o.msg));
    return res;
  };
  return { ...r, advance, lastRoom, deliver, now: () => t };
}

describe('online room: reconnect', () => {
  it('a closed tab reclaims its seat with the seat token; nobody else can', () => {
    const r = clocked();
    const guestToken = r.lastRoom(1).token;
    const hostToken = r.lastRoom(0).token;
    expect(guestToken).toMatch(/^token-/);
    expect(guestToken).not.toBe(hostToken);
    // The guest's token never reaches the host and vice versa.
    expect(JSON.stringify(r.inbox[0])).not.toContain(guestToken);
    expect(JSON.stringify(r.inbox[1])).not.toContain(hostToken);

    // While the guest is still connected, the token cannot steal the seat.
    expect(r.core.connect({ pid: 'new-tab-00001', tokens: guestToken })).toMatchObject({ error: { code: 'room-full' } });
    // The guest closes the tab; a new tab (new player id) with the token gets the seat and the state.
    r.core.disconnect(1);
    const back = r.core.connect({ pid: 'new-tab-00001', tokens: `junk-token-0000000000,${guestToken}` });
    expect(back).toMatchObject({ seat: 1 });
    const out = (back as { out: Outgoing[] }).out;
    const state = out.find((o) => o.to === 1 && o.msg.type === 'state');
    expect(state && state.msg.type === 'state' && state.msg.view.hand).toEqual(r.core.data!.match!.hand!.hands[1]);
    // A wrong token is just a third person.
    r.core.disconnect(1);
    expect(r.core.connect({ pid: 'stranger-0001', tokens: 'not-the-token-000000' })).toMatchObject({ error: { code: 'room-full' } });
  });

  it('a reload / network drop keeps the seat and the hand continues', () => {
    const r = clocked();
    r.act(0, { action: 'raise', amount: 2, exchange: [] });
    r.deliver({ out: r.core.disconnect(1) });
    expect(r.lastRoom(0).players[1].connected).toBe(false);
    expect(r.lastRoom(0).forfeitAt[1]).toBe(r.now() + 60_000);
    r.advance(20_000);
    expect(r.deliver(r.core.connect({ pid: GUEST }))).toMatchObject({ seat: 1 });
    expect(r.lastRoom(0).forfeitAt[1]).toBeNull();
    expect(r.view(1).toAct).toBe(1);
    expect(r.view(1).bets).toEqual([2, 1]);
    r.act(1, { action: 'call', amount: 3 });
    expect(r.view(0).phase).toBe('callResponse');
  });
});

describe('online room: turn timer', () => {
  it('runs out → automatic DROP, flagged as a timeout; animations get a grace period', () => {
    const r = clocked({ timer: '30' });
    const deadline = r.lastRoom(0).turnDeadline!;
    expect(deadline).toBe(r.now() + GRACE_MS.deal + 30_000); // the deal animation is not part of the turn
    expect(r.core.nextWake()).toBe(deadline);
    r.advance(GRACE_MS.deal + 29_000);
    expect(r.view(0).phase).toBe('turn');
    r.advance(1_000);
    const v = r.view(1);
    expect(v.phase).toBe('over');
    expect(v.reveal!.outcome).toMatchObject({ kind: 'drop', loser: 0, winner: 1 });
    expect(v.timeouts).toEqual([0]);
    expect(r.core.data!.status).toBe('handOver');
  });

  it('each move restarts the clock for the other player; no timer when the host turns it off', () => {
    const r = clocked({ timer: '15' });
    r.advance(10_000);
    r.act(0, { action: 'raise', amount: 2, exchange: [r.view(0).hand[0]] });
    expect(r.lastRoom(1).turnDeadline).toBe(r.now() + GRACE_MS.exchange + 15_000);
    const off = clocked({ timer: '0' });
    expect(off.lastRoom(0).turnDeadline).toBeNull();
    off.advance(10 * 60_000);
    expect(off.view(0).phase).toBe('turn');
  });

  it('pauses while the player to act is disconnected and restarts when they are back', () => {
    const r = clocked({ timer: '30' });
    r.core.disconnect(0); // host is to act
    r.advance(40_000);
    expect(r.view(1).phase).toBe('turn'); // no timeout while away
    expect(r.core.connect({ pid: HOST })).toMatchObject({ seat: 0 });
    expect(r.core.data!.turnDeadline).toBe(r.now() + GRACE_MS.resume + 30_000);
  });

  it('the next hand starts by itself 30 s after a hand ends', () => {
    const r = clocked({ timer: '30' });
    r.act(0, { action: 'drop' });
    expect(r.lastRoom(0).autoContinueAt).toBe(r.now() + 30_000);
    r.send(0, { type: 'ready' });
    r.advance(30_000);
    expect(r.core.data!.status).toBe('playing');
    expect(r.view(1).handNumber).toBe(2);
  });
});

describe('online room: forfeit and leaving', () => {
  it('a player gone for more than 60 s forfeits the match', () => {
    const r = clocked({ timer: '0' });
    r.core.disconnect(1);
    r.advance(59_000);
    expect(r.core.data!.status).toBe('playing');
    r.advance(1_000);
    expect(r.core.data!.status).toBe('over');
    expect(r.lastRoom(0).forfeit).toEqual({ by: 1, reason: 'disconnect' });
    expect(r.view(0).matchWinner).toBe(0);
    // Coming back afterwards shows the result.
    expect(r.core.connect({ pid: GUEST })).toMatchObject({ seat: 1 });
  });

  it('no forfeit while both are away; the first one back wins once the 60 s are up', () => {
    const r = clocked({ timer: '0' });
    r.core.disconnect(0);
    r.core.disconnect(1);
    r.advance(5 * 60_000);
    expect(r.core.data!.status).toBe('playing');
    r.core.connect({ pid: HOST });
    expect(r.core.nextWake()).toBeLessThanOrEqual(r.now());
    r.advance(0);
    expect(r.core.data!.forfeit).toEqual({ by: 1, reason: 'disconnect' });
  });

  it('leaving during a match forfeits at once; the host cancelling an empty room deletes it', () => {
    const r = clocked();
    r.send(1, { type: 'leave' });
    expect(r.core.data!.forfeit).toEqual({ by: 1, reason: 'left' });
    expect(r.lastRoom(0).left).toEqual([false, true]);
    const solo = new RoomCore('QWERT');
    solo.connect({ pid: HOST, create: '1' });
    solo.message(0, JSON.stringify({ type: 'leave' }));
    expect(solo.data).toBeNull();
    expect(solo.connect({ pid: GUEST })).toMatchObject({ error: { code: 'not-found' } });
  });
});

describe('online room: rematch, full room, expiry', () => {
  it('rematch needs both players; it keeps the settings and starts a fresh match', () => {
    const r = clocked({ jokers: '2', discards: 'down', order: 'first', timer: '60' });
    r.send(1, { type: 'leave' }); // forfeit → over
    expect(r.core.data!.status).toBe('over');
    r.deliver(r.core.connect({ pid: GUEST })); // came back
    r.send(0, { type: 'ready' });
    expect(r.lastRoom(1).ready).toEqual([true, false]);
    expect(r.core.data!.matchNumber).toBe(1);
    r.send(1, { type: 'ready' });
    const d = r.core.data!;
    expect(d.matchNumber).toBe(2);
    expect(d.status).toBe('playing');
    expect(d.forfeit).toBeNull();
    expect(d.match!.coins).toEqual([12, 12]);
    expect(r.view(0)).toMatchObject({ jokers: 2, discardsFaceUp: false, matchWinner: null, handNumber: 1 });
    expect(r.lastRoom(0).settings).toEqual({ jokers: 2, discardsFaceUp: false, order: 'first', turnSeconds: 60 });
  });

  it('a third person gets "Room is full"', () => {
    const r = clocked();
    const third = r.core.connect({ pid: 'third-person-01' });
    expect(third).toMatchObject({ error: { code: 'room-full' } });
    expect((third as { error: { message: string } }).error.message).toMatch(/Room is full/);
  });

  it('a room with nobody connected expires after 10 minutes; a connected room does not', () => {
    const r = clocked({ timer: '0' });
    r.advance(30 * 60_000); // both connected: nothing expires
    expect(r.core.data).not.toBeNull();
    r.core.disconnect(0);
    r.core.disconnect(1);
    expect(r.advance(9 * 60_000).expired).toBe(false);
    expect(r.advance(60_000).expired).toBe(true);
    expect(r.core.data).toBeNull();
    expect(r.core.connect({ pid: HOST })).toMatchObject({ error: { code: 'not-found' } });
  });

  it('timers survive a restart (storage round trip)', () => {
    const r = clocked({ timer: '30' });
    const copy = new RoomCore('ABCDE', JSON.parse(JSON.stringify(r.core.data)), { now: r.now });
    copy.resume([0, 0]);
    expect(copy.data!.awaySince).toEqual([r.now(), r.now()]);
    expect(copy.data!.turnDeadline).toBeNull(); // the player to act is not back yet
    expect(copy.connect({ pid: HOST })).toMatchObject({ seat: 0 });
    expect(copy.data!.turnDeadline).toBe(r.now() + GRACE_MS.resume + 30_000);
  });
});
