// @vitest-environment happy-dom
/**
 * Regression: "undefined" flashed on the opponent's cards at the end of an online hand.
 *
 * Cause: when a hand ended with the opponent's last move (final-round BET + exchange →
 * automatic showdown), the table was rendered in its finished state while the opponent's
 * display still held placeholder ids for unknown cards, so card faces were drawn from
 * placeholders ("undefined of Spades"). NEXT HAND was also clickable during that animation;
 * vs. AI that let a late animation run the turn logic twice (AI acting out of turn).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlayerId } from '../src/engine';
import type { Intent, ServerMsg } from '../shared/protocol';
import { RoomCore } from '../server/src/core';
import { cardFace } from '../src/ui/cardView';
import { guardHtml } from '../src/ui/safeHtml';

// No real animations in the DOM test (the code path is the same, timings are instant).
beforeAll(() => {
  globalThis.fetch = (() => Promise.reject(new Error('offline in tests'))) as typeof fetch;
  window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});

type AppT = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function makeApp(): Promise<AppT> {
  document.body.innerHTML = '<div id="app"></div>';
  const { App } = await import('../src/ui/app');
  return new App(document.getElementById('app')!) as unknown as AppT;
}

/** The App as seat 0 of a real RoomCore; the opponent (seat 1) is driven by the test. */
async function onlineTable(settings: Record<string, string>) {
  const app = await makeApp();
  const core = new RoomCore('ABCDE');
  const feed = (out: { to: PlayerId; msg: ServerMsg }[]) => out.filter((o) => o.to === 0).forEach((o) => app.onServer(o.msg));
  const sent: unknown[] = [];
  app.online = {
    conn: { send: (m: unknown) => sent.push(m), net: { status: 'open', rtt: 10, offset: 0 }, serverNow: () => Date.now(), close() {} },
    code: 'ABCDE',
    create: null,
    room: null,
    link: 'open',
    matchNumber: 0,
    flipShown: 0,
    waiting: false,
    pending: null,
  };
  app.screen = 'lobby';
  const a = core.connect({ pid: 'host-pid-0001', create: '1', order: 'first', timer: '0', ...settings });
  feed((a as { out: { to: PlayerId; msg: ServerMsg }[] }).out);
  const b = core.connect({ pid: 'guest-pid-0002' });
  feed((b as { out: { to: PlayerId; msg: ServerMsg }[] }).out);
  const settle = async () => {
    for (let i = 0; i < 50; i++) {
      await app.queue;
      await new Promise((r) => setTimeout(r, 70));
      if (!app.animating) break;
    }
  };
  const act = async (seat: PlayerId, intent: Intent) => {
    feed(core.message(seat, JSON.stringify({ type: 'intent', intent })));
    await settle();
  };
  await settle();
  return { app, core, act, settle };
}

describe('reveal at the end of a hand', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const [jokers, discards] of [['1', 'up'], ['2', 'down']]) {
    it(`online: the opponent's last move ends the hand → only real cards are ever drawn face up (${jokers} Joker, discards ${discards})`, async () => {
      const warn = vi.spyOn(console, 'warn');
      const { app, core, act } = await onlineTable({ jokers, discards });
      // Record every render: which opponent cards were face up, and whether NEXT was clickable.
      const frames: { faces: number[]; phase: string; next: boolean; animating: boolean; html: string }[] = [];
      const render = app.render.bind(app);
      app.render = () => {
        render();
        frames.push({
          faces: [...document.querySelectorAll('.ai-hand .card.face')].map((e) => Number((e as HTMLElement).dataset.card)),
          phase: app.match?.hand?.phase,
          next: !!document.querySelector('[data-cmd="next"]:not([disabled])'),
          animating: app.animating,
          html: document.getElementById('app')!.innerHTML,
        });
      };
      // Host raises to the cap (final round); the opponent answers BET 5 + exchanges two cards.
      await act(0, { action: 'raise', amount: 5, exchange: [] });
      const oppHand = core.data!.match!.hand!.hands[1];
      await act(1, { action: 'bet', exchange: [oppHand[0], oppHand[1]] });
      const revealed = core.data!.match!.hand!.hands[1];
      expect(core.data!.match!.hand!.phase).toBe('over');

      const overFrames = frames.filter((f) => f.phase === 'over');
      expect(overFrames.length).toBeGreaterThan(0);
      for (const f of overFrames) {
        // Face-up opponent cards are exactly the revealed hand, never placeholders.
        expect(f.faces.every((c) => revealed.includes(c)), JSON.stringify(f.faces)).toBe(true);
        expect(f.html).not.toMatch(/\bundefined\b|\bNaN\b|\bnull\b/);
        if (f.animating) expect(f.next).toBe(false); // no NEXT HAND while cards still move
      }
      expect(overFrames.at(-1)!.faces.sort()).toEqual([...revealed].sort());
      expect(overFrames.at(-1)!.next).toBe(true);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('[ui-guard]'))).toEqual([]);
    });
  }

  it('a late animation cannot run the turn logic again (no double AI move)', async () => {
    const app = await makeApp();
    const after = vi.fn();
    app.afterAction = after;
    app.render = () => {};
    let endOld!: () => void;
    let endNew!: () => void;
    const oldAnim = app.animate(() => new Promise<void>((r) => (endOld = r)));
    const newAnim = app.animate(() => new Promise<void>((r) => (endNew = r)));
    endOld();
    await oldAnim;
    expect(after).not.toHaveBeenCalled(); // the older one ended late: ignored
    endNew();
    await newAnim;
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('NEXT HAND does nothing before the result was shown', async () => {
    const app = await makeApp();
    const start = vi.fn();
    app.startNextHand = start;
    app.match = { hand: { phase: 'over' }, winner: null };
    app.resultShown = false;
    app.next();
    expect(start).not.toHaveBeenCalled();
    app.resultShown = true;
    app.animating = true;
    app.next();
    expect(start).not.toHaveBeenCalled();
    app.animating = false;
    app.next();
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('UI text guard', () => {
  it('an unknown card is drawn face down, never as "undefined"', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const c of [-1, -1003, Number.NaN, 22, undefined as unknown as number]) {
      const html = cardFace(c);
      expect(html).toContain('card back');
      expect(html).not.toMatch(/undefined|NaN|null/);
    }
    expect(cardFace(20)).toContain('joker');
    expect(cardFace(19)).toContain('A');
  });

  it('never lets "undefined" / "null" / "NaN" through, and warns in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(guardHtml('<b>undefined</b> of Spades, NaN coins, null', 'test')).toBe('<b>—</b> of Spades, — coins, —');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[ui-guard] "undefined" would be rendered in test'));
    expect(guardHtml('<b>Pair of Kings</b>', 'test')).toBe('<b>Pair of Kings</b>');
  });
});
