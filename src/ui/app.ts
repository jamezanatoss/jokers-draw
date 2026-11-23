import {
  type Action,
  type Card,
  type CoinFace,
  type HandEvent,
  type HandState,
  type JokerCount,
  type MatchState,
  type PlayerId,
  type Rng,
  type TurnOrderChoice,
  CATEGORY_NAMES,
  STARTING_COINS,
  coinFlip,
  currentBet,
  describeHand,
  describeJoker,
  evaluateHand,
  firstPlayerFromCoin,
  other,
  resolvedTotal,
  legalActions,
  makeView,
  matchAct,
  mulberry32,
  newMatch,
  pot,
  randomSeed,
  startHand,
} from '../engine';
import { AIPlayer, type Difficulty } from '../ai/ai';
import { getTables } from '../ai/tables';
import { SWIPE, exchangeDisplay, sortedDisplay, swipeHand } from './animation';
import { amountRange, clampAmount, defaultAmount, previews } from './betControls';
import { cardBack, cardFace, discardCard, rankExample } from './cardView';
import { type RulesLang, modeLineTh, rulesHtmlTh } from './rulesTh';
import { checkAudioFile, clearCustomTrack, loadCustomTrack, probePlayable, saveCustomTrack } from './customMusic';
import { setHtml } from './safeHtml';
import { Sound } from './sound';
import { RANKINGS, RULES_HTML, TIEBREAK_LABEL, TITLE } from './text';
import { type LinkStatus, OnlineConnection, forgetRoom, lastRoom, randomRoomCode, rememberSeat } from '../online/connection';
import { localMatch } from '../online/localize';
import {
  type Intent,
  type OnlineView,
  ROOM_CODE_LENGTH,
  type RoomInfo,
  type RoomSettings,
  type ServerMsg,
  TURN_SECONDS,
  type TurnSeconds,
  isRoomCode,
  normalizeRoomCode,
} from '../../shared/protocol';

const HUMAN: PlayerId = 0;
const AI: PlayerId = 1;
const DEBUG = new URLSearchParams(location.search).has('debug');
const REDUCED_MOTION = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
/**
 * Dev only: a private, copyrighted track may sit in the gitignored local-audio/ folder. If it is
 * there, vs-AI matches use it during local development. Builds never reference it (this constant
 * is null in production, so the path is not even in the bundle); everything else uses the
 * game's own original loop.
 */
const LOCAL_TRACK: string | null = import.meta.env.DEV ? '/local-audio/osiris.mp3' : null;
const OPP_GONE = 'Your opponent is disconnected. The game continues when they come back (same link).';
/** How long the big action banner ("RAISE +2 → 4") stays before fading. */
const TOAST_MS = 900;

type Screen = 'setup' | 'lobby' | 'flip' | 'play' | 'over';
type PlayMode = 'ai' | 'online';

/** The online room this tab is in. */
interface OnlineState {
  conn: OnlineConnection;
  code: string;
  /** Settings sent when creating the room (host only; used to retry with a new code). */
  create: RoomSettings | null;
  room: RoomInfo | null;
  link: LinkStatus;
  /** Match number of the match on screen (0 = none yet). */
  matchNumber: number;
  /** Match whose coin flip was shown. */
  flipShown: number;
  /** This player pressed Play / Next / Rematch and waits for the opponent. */
  waiting: boolean;
  /** An intent was sent and its result has not arrived yet. */
  pending: { marked: number } | null;
}
type Who = 'you' | 'ai' | 'info' | 'result';
interface LogEntry {
  who: Who;
  html: string;
}
type Kind = 'drop' | 'bet' | 'raise' | 'call' | 'accept';

const DIFFICULTY_INFO: Record<Difficulty, string> = {
  normal: 'A fair opponent that plays solid but simple poker.',
  hard: 'Reads your exchanges and bets, learns your habits, bluffs and slow-plays.',
  cheater: 'Sees your cards and the deck order. Just for fun — good luck!',
};

function loadPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(`jokers-draw:${key}`) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`jokers-draw:${key}`, value);
  } catch {
    /* storage unavailable */
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, REDUCED_MOTION ? Math.min(ms, 60) : ms));

export class App {
  private readonly el: {
    felt: HTMLElement;
    toast: HTMLElement;
    actions: HTMLElement;
    side: HTMLElement;
    overlay: HTMLElement;
    modal: HTMLElement;
    soundPanel: HTMLElement;
    muteAll: HTMLButtonElement;
  };
  private readonly sound = new Sound();
  private screen: Screen = 'setup';
  private difficulty: Difficulty = loadPref('difficulty', 'hard', ['normal', 'hard', 'cheater'] as const);
  private order: TurnOrderChoice = loadPref('order', 'random', ['first', 'second', 'random'] as const);
  private jokers: JokerCount = loadPref('jokers', '1', ['1', '2'] as const) === '2' ? 2 : 1;
  private discardsUp: boolean = loadPref('discards', 'up', ['up', 'down'] as const) === 'up';
  /** Language of the Rules screen and the hand-ranking panel (the rest of the UI is English). */
  private rulesLang: RulesLang = loadPref('rulesLang', 'en', ['en', 'th'] as const);
  /** Coins to fly from a stack to the pot after the next render. */
  private potCoins: { p: PlayerId; n: number }[] = [];
  /** Player whose newest discard group should pop in on the next render. */
  private freshDiscards: PlayerId | null = null;
  private toastTimer = 0;
  private rng: Rng = mulberry32(randomSeed());
  private match: MatchState | null = null;
  private ai: AIPlayer | null = null;
  private selected = new Set<Card>();
  /**
   * The shared "Your bet" amount (a total for this hand) used by BET, RAISE and CALL.
   * Reset to the minimum legal amount at the start of every turn and every hand.
   */
  private amount = 0;
  private busy = false;
  private lastAction: { who: Who; html: string } | null = null;
  private log: LogEntry[] = [];
  private modalOpen = false;
  private gen = 0;
  private coinFace: CoinFace | null = null;
  private flipDone = false;
  private anim = { flip: false };
  /**
   * Display order of each hand. During the swipe-in it is the arrival order; after the
   * swipe-to-sort it is sorted (Joker last). For the AI's face-down hand it is cosmetic until
   * the reveal (backs are indistinguishable).
   */
  private disp: { you: Card[]; ai: Card[] } = { you: [], ai: [] };
  /** True while a card-swipe animation runs: cards and action buttons are blocked. */
  private animating = false;
  /** Number of the newest card animation; an older one that ends late must not continue the game. */
  private animSeq = 0;
  /**
   * The current hand's result has been shown (handOver ran: both hands revealed, logged). Until
   * then NEXT HAND is disabled, so a hand can never be skipped while its last cards are moving.
   */
  private resultShown = false;
  private stats = { hands: 0, won: 0, showdowns: 0 };
  private playMode: PlayMode = loadPref('mode', 'ai', ['ai', 'online'] as const);
  private online: OnlineState | null = null;
  /** Text typed into the "Join a room" box. */
  private joinCode = '';
  private onlineError = '';
  /** Server messages are handled one at a time, after any running card animation. */
  private queue: Promise<void> = Promise.resolve();
  /** Placeholder ids for the opponent's (unknown) drawn cards. */
  private oppSeq = 0;
  private copied = false;
  /** Phone: which bottom sheet is open (rankings, log, sound). */
  private sheet: 'ranks' | 'log' | 'sound' | null = null;
  /** Phone: the discards popover is open. */
  private discOpen = false;
  /** Last message of the "your music" picker. */
  private musicMsg: { kind: 'ok' | 'err'; text: string } | null = null;
  /** Host's turn timer choice (seconds, 0 = off). */
  private turnSeconds: TurnSeconds = Number(loadPref('timer', '30', ['0', '15', '30', '60'] as const)) as TurnSeconds;
  /** State messages received but not handled yet (a newer one makes older ones obsolete). */
  private pendingViews = 0;
  /** Last countdown second a warning tick was played for. */
  private lastTick = -1;
  /** Screen whose dialog is currently in the overlay. */
  private overlayShown: Screen | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <header class="topbar">
        <h1 class="logo"><span class="logo-star" aria-hidden="true">★</span>${TITLE}</h1>
        <nav class="topnav">
          <span id="net" class="net-ind" role="status" hidden></span>
          <button type="button" class="ghost icon phone-only" data-cmd="sheet" data-sheet="ranks" aria-label="Hand rankings" title="Hand rankings"><span aria-hidden="true">♠</span></button>
          <button type="button" class="ghost icon phone-only" data-cmd="sheet" data-sheet="log" aria-label="Table log" title="Table log"><span aria-hidden="true">☰</span></button>
          <button type="button" class="ghost icon phone-only" data-cmd="sheet" data-sheet="sound" aria-label="Sound and music" title="Sound and music"><span aria-hidden="true">♪</span></button>
          <button type="button" class="ghost icon" data-cmd="mute-all" id="mute-all" aria-pressed="false" title="Mute all sound (M)"></button>
          <button type="button" class="ghost" data-cmd="rules" aria-label="Rules"><span class="ico" aria-hidden="true">?</span><span class="lbl">Rules</span></button>
          <button type="button" class="ghost" data-cmd="new" aria-label="New game"><span class="ico" aria-hidden="true">↺</span><span class="lbl">New game</span></button>
        </nav>
      </header>
      <main class="layout">
        <section class="table" aria-label="Card table">
          <div class="felt-wrap">
            <div id="felt" class="felt"></div>
            <div id="toast" class="action-toast" aria-live="polite"></div>
          </div>
          <aside class="action-panel" aria-label="Actions">
            <div id="actions" class="actions-dyn"></div>
            <details class="sound-panel" id="sound-panel">
              <summary>Sound</summary>
              <button type="button" class="sheet-close" data-cmd="close-sheet" aria-label="Close">✕</button>
              <div class="sound-body"></div>
            </details>
          </aside>
        </section>
        <aside id="side" class="side" aria-label="Hand rankings and log"></aside>
      </main>
      <div id="sheet-backdrop" class="sheet-backdrop" data-cmd="close-sheet" hidden></div>
      <div id="overlay" class="overlay" hidden></div>
      <div id="modal" class="overlay modal" hidden></div>`;
    this.el = {
      felt: root.querySelector('#felt')!,
      toast: root.querySelector('#toast')!,
      actions: root.querySelector('#actions')!,
      side: root.querySelector('#side')!,
      overlay: root.querySelector('#overlay')!,
      modal: root.querySelector('#modal')!,
      soundPanel: root.querySelector('#sound-panel .sound-body')!,
      muteAll: root.querySelector('#mute-all')!,
    };
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('change', (e) => this.onChange(e));
    root.addEventListener('input', (e) => this.onInput(e));
    document.addEventListener('keydown', (e) => this.onKey(e));
    this.sound.onChange(() => this.renderSound());
    // Countdowns (turn timer, disconnect, auto-continue) tick from the server's deadlines.
    window.setInterval(() => this.updateClocks(), 250);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.online) this.enqueue(() => this.render());
    });
    this.renderSound();
    this.render();
    // Warm up the AI lookup tables after the first paint.
    setTimeout(() => getTables(this.jokers), 50);
    if (DEBUG) (window as unknown as { __jd: App }).__jd = this; // inspect from the console / tests
    // The player's own music, remembered in this browser (IndexedDB). Never uploaded.
    void loadCustomTrack().then((rec) => {
      if (rec) this.sound.setCustomTrack(URL.createObjectURL(rec.blob), rec.name);
    });
    if (LOCAL_TRACK) {
      fetch(LOCAL_TRACK, { method: 'HEAD' })
        .then((r) => {
          if (r.ok && (r.headers.get('content-type') ?? '').startsWith('audio/')) this.sound.setLocalTrack(LOCAL_TRACK);
        })
        .catch(() => {
          /* no local track: the original loop plays */
        });
    }
    // A share link (?room=CODE) joins that room right away.
    const linked = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '');
    if (isRoomCode(linked)) {
      this.playMode = 'online';
      this.joinCode = linked;
      this.connectRoom(linked, null);
    }
  }

  // ------------------------------------------------------------------ flow

  private start(): void {
    savePref('difficulty', this.difficulty);
    savePref('order', this.order);
    savePref('jokers', String(this.jokers));
    savePref('discards', this.discardsUp ? 'up' : 'down');
    this.gen++;
    this.ai = new AIPlayer({ difficulty: this.difficulty, rng: mulberry32(randomSeed()), me: AI, jokers: this.jokers });
    this.log = [];
    this.stats = { hands: 0, won: 0, showdowns: 0 };
    this.match = null;
    this.lastAction = null;
    this.selected.clear();
    if (this.order === 'random') {
      this.screen = 'flip';
      this.coinFace = coinFlip(this.rng);
      this.flipDone = false;
      this.render();
      this.sound.play('coinFlip');
      const g = this.gen;
      void wait(1900).then(() => {
        if (g !== this.gen) return;
        this.flipDone = true;
        this.sound.startMusic('local'); // match begins once the coin has landed
        this.render();
        this.focus('[data-cmd="begin"]');
      });
    } else {
      this.sound.startMusic('local');
      this.begin(this.order === 'first' ? HUMAN : AI);
    }
  }

  private begin(first: PlayerId): void {
    this.match = newMatch(first, STARTING_COINS, this.jokers, this.discardsUp);
    this.screen = 'play';
    const how =
      this.order === 'random'
        ? `Coin flip: ${this.coinFace === 'heads' ? 'Heads' : 'Tails'}.`
        : `You chose to go ${first === HUMAN ? 'first' : 'second'}.`;
    this.pushLog(
      'info',
      `New match vs. <b>${this.difficultyName()}</b> AI, ${plural(this.jokers, 'Joker')} (${this.jokers === 2 ? 22 : 21} cards), ` +
        `discards face ${this.discardsUp ? 'up' : 'down'}. ${how}`,
    );
    this.startNextHand();
  }

  private startNextHand(): void {
    this.match = startHand(this.match!, this.rng);
    void this.showNewHand();
  }

  /** Show the freshly dealt hand in `this.match`: log, ante, swipe-in (resolves when it has landed). */
  private showNewHand(): Promise<void> {
    const m = this.match!;
    this.resultShown = false;
    this.discOpen = false;
    this.selected.clear();
    this.amount = 0; // never carried over between hands
    // Cards arrive in dealt order; they are sorted by the swipe animation.
    this.disp = { you: [...m.hand!.hands[HUMAN]], ai: [...m.hand!.hands[AI]] };
    const first = m.hand!.firstToAct;
    const who = first === HUMAN ? 'You act' : `${this.TheOpp} acts`;
    const why = m.handNumber > 1 ? ' (loser of the last hand)' : '';
    this.lastAction = { who: 'info', html: `Hand ${m.handNumber}: both players ante 1. ${who} first${why}.` };
    this.pushLog(
      'info',
      `<b>Hand ${m.handNumber}</b> — ${first === HUMAN ? 'you act' : `${this.theOpp} acts`} first. Coins: you ${m.coins[0]}, ${this.opp} ${m.coins[1]}.`,
    );
    // Shuffle and ante, then both hands swipe in and sort themselves.
    this.sound.play('shuffle');
    this.sound.play('coin', 0.35);
    this.sound.play('coin', 0.45);
    this.potCoins.push({ p: HUMAN, n: 1 }, { p: AI, n: 1 });
    const all = [0, 1, 2, 3, 4];
    return this.animate(() => Promise.all([this.runSwipe(HUMAN, all), this.runSwipe(AI, all)]));
  }

  /**
   * Run a card animation: render the current state, block input while `run` plays, then
   * continue the game (unless a new game was started meanwhile).
   */
  private async animate(run: () => Promise<unknown>): Promise<void> {
    const g = this.gen;
    const token = ++this.animSeq;
    this.animating = true;
    this.busy = true;
    this.render();
    await run();
    // A new game, or a newer animation that started meanwhile, owns the game flow now.
    if (g !== this.gen || token !== this.animSeq) return;
    this.animating = false;
    this.afterAction();
  }

  /** Two-phase swipe on one hand; `newIdx` are display indexes of the cards that just arrived. */
  private async runSwipe(p: PlayerId, newIdx: number[]): Promise<void> {
    const key = p === HUMAN ? 'you' : 'ai';
    const g = this.gen;
    const sortNow = () => {
      this.disp[key] = sortedDisplay(this.disp[key]);
    };
    const handEl = this.el.felt.querySelector<HTMLElement>(p === HUMAN ? '.you-hand' : '.ai-hand');
    if (!handEl || REDUCED_MOTION) {
      sortNow();
      return;
    }
    await swipeHand(handEl, newIdx, {
      renderSorted: () => {
        if (g !== this.gen) return [];
        sortNow();
        setHtml(handEl, this.cardsHtml(p), 'hand');
        return Array.from(handEl.querySelectorAll<HTMLElement>('.card'));
      },
      swish: () => this.sound.play('swish'),
      tick: (ms) => this.sound.play('tick', ms / 1000),
    });
  }

  /** Discarded cards (at these display slots) fly from the hand into the owner's discard box. */
  private async discardOut(p: PlayerId, slots: number[]): Promise<void> {
    if (!slots.length) return;
    this.sound.play('exchange');
    if (REDUCED_MOTION) return;
    const hand = this.el.felt.querySelector(p === HUMAN ? '.you-hand' : '.ai-hand');
    const cards = hand ? Array.from(hand.querySelectorAll<HTMLElement>('.card')) : [];
    const row = this.el.felt.querySelector<HTMLElement>(`.drow[data-owner="${p}"] .dcards`);
    if (!row) return;
    let box = row.getBoundingClientRect();
    if (box.width === 0) box = (this.el.felt.querySelector('.dchip') ?? row).getBoundingClientRect(); // phone: collapsed into a chip
    const lastCard = row.lastElementChild?.getBoundingClientRect();
    const dh = box.height;
    const dw = dh / 1.4;
    const x0 = lastCard ? lastCard.right + 6 : box.left;
    const flights = slots.map((i, n) => {
      const el = cards[i];
      if (!el) return Promise.resolve();
      const r = el.getBoundingClientRect();
      const clone = el.cloneNode(true) as HTMLElement;
      clone.classList.remove('selected', 'selectable');
      clone.querySelector('.swap-tag')?.remove();
      clone.classList.add('flying-card');
      Object.assign(clone.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        transform: 'none',
      });
      clone.style.setProperty('--cw', `${r.width}px`);
      document.body.appendChild(clone);
      el.style.visibility = 'hidden';
      const scale = dw / r.width;
      const dx = Math.min(x0 + n * dw * 0.55, box.right - dw) - r.left;
      const dy = box.top - r.top;
      return clone
        .animate(
          [
            { transform: 'none', opacity: 1 },
            { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(6deg)`, opacity: 0.9 },
          ],
          { duration: SWIPE.discardMs, delay: n * SWIPE.discardStaggerMs, easing: 'cubic-bezier(0.5, 0, 0.3, 1)', fill: 'forwards' },
        )
        .finished.then(() => clone.remove());
    });
    await Promise.all(flights);
  }

  /** Big, short-lived banner in the middle of the table: who did what. Never blocks input. */
  private showToast(who: 'you' | 'ai', a: Action, before: HandState, note?: string): void {
    const n = before.bets[other(before.toAct)];
    const total = a.type === 'accept' ? n : resolvedTotal(before, a);
    let text: string;
    switch (a.type) {
      case 'raise':
        text = `RAISE +${total! - n} → ${total}`;
        break;
      case 'bet':
        text = `BET ${total}`;
        break;
      case 'call':
        text = `CALL ${total}`;
        break;
      case 'accept':
        text = `ACCEPT ${total}`;
        break;
      case 'drop':
        text = 'DROP';
        break;
      default:
        return;
    }
    const max = total !== null && total >= before.cap;
    const t = this.el.toast;
    t.className = `action-toast k-${a.type} w-${who}`;
    const final = max && (a.type === 'bet' || a.type === 'raise') && before.phase === 'turn';
    const tag = note ?? (max ? (final ? 'FINAL ROUND' : `MAX ${before.cap}`) : '');
    setHtml(t, `<span class="tw">${who === 'you' ? 'YOU' : this.oppTag}</span><b>${text}</b>${tag ? `<em>${tag}</em>` : ''}`, 'action banner');
    void t.offsetWidth; // restart the CSS animation
    t.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), TOAST_MS);
  }

  /** Queue coin flights for whatever `p` added to the pot between two states. */
  private queuePotCoins(p: PlayerId, before: HandState, after: HandState): void {
    if (after.phase === 'over' && after.outcome?.kind === 'drop' && after.outcome.loser === p) return;
    const n = after.bets[p] - before.bets[p];
    if (n > 0) this.potCoins.push({ p, n });
  }

  private afterAction(): void {
    const h = this.hand;
    if (!h) return;
    if (h.phase === 'over') {
      this.handOver();
      return;
    }
    if (h.toAct === AI) {
      this.busy = true;
      this.render();
      if (this.online) return; // the opponent's move arrives from the server
      const g = this.gen;
      void wait(650 + Math.random() * 350).then(() => {
        if (g === this.gen) void this.aiAct();
      });
    } else {
      // New turn for the player: the amount always starts at the minimum legal amount.
      this.amount = defaultAmount(h) ?? 0;
      this.busy = false;
      this.render();
      if (!document.querySelector('.table')?.contains(document.activeElement)) this.focusFirstAction();
    }
  }

  private async aiAct(): Promise<void> {
    const ai = this.ai!;
    const g = this.gen;
    let m = this.match!;
    const before = m.hand!;
    const d = ai.decide(makeView(before, AI, ai.cheats));
    this.showToast('ai', d.action, before);
    m = matchAct(m, d.action);
    let exchanged: number | null = null;
    let swipe: number[] | null = null;
    if (m.hand!.phase === 'exchange') {
      this.freshDiscards = AI;
      const d2 = ai.decide(makeView(m.hand!, AI, ai.cheats));
      const held = m.hand!.hands[AI];
      m = matchAct(m, d2.action);
      const now = m.hand!.hands[AI];
      const drawn = now.filter((c) => !held.includes(c)); // arrival order
      exchanged = drawn.length;
      if (drawn.length) {
        // The AI's cards are face down: which display slots leave must not reveal which real
        // cards were thrown, so random slots are used. Kept cards fill the other slots.
        const vacated = shuffleIdx(5, this.rng).slice(0, drawn.length);
        await this.discardOut(AI, vacated);
        if (g !== this.gen) return;
        const kept = now.filter((c) => held.includes(c));
        const base = [0, 1, 2, 3, 4].map((i) => (vacated.includes(i) ? -1 : kept.shift()!));
        const { order, newIdx } = exchangeDisplay(base, vacated, drawn);
        this.disp.ai = order;
        swipe = newIdx;
      }
    }
    this.match = m;
    this.queuePotCoins(AI, before, m.hand!);
    this.actionSound(d.action, before);
    const msg = this.describe('ai', d.action, before, exchanged);
    this.lastAction = { who: 'ai', html: msg };
    this.pushLog('ai', msg);
    if (DEBUG) {
      const t = d.thinking;
      this.pushLog(
        'info',
        `<small>AI: win now ${(t.eqNow * 100).toFixed(0)}%, after draw ${(t.eqDraw * 100).toFixed(0)}%, ` +
          `ESS ${t.ess}, ${t.ms} ms${t.note ? `, <b>${t.note}</b>` : ''} — ` +
          t.options.map((o) => `${o.label}: ${o.ev.toFixed(2)}`).join(', ') +
          '</small>',
      );
    }
    if (swipe) {
      const idx = swipe;
      void this.animate(() => this.runSwipe(AI, idx));
      return;
    }
    this.busy = false;
    this.afterAction();
  }

  private actionSound(a: Action, before: HandState): void {
    const me = before.toAct;
    const n = before.bets[other(me)];
    const total = a.type === 'accept' ? n : resolvedTotal(before, a);
    const added = total === null ? 0 : Math.max(0, total - before.bets[me]);
    const clinks = (k: number) => {
      for (let i = 0; i < Math.min(3, k); i++) this.sound.play('coin', i * 0.08);
    };
    switch (a.type) {
      case 'raise':
      case 'bet':
        clinks(Math.max(1, added));
        break;
      case 'call':
        clinks(added);
        this.sound.play('call', 0.08);
        break;
      case 'accept':
        clinks(Math.max(1, added));
        break;
      case 'drop':
        this.sound.play('drop');
        break;
    }
  }

  private async humanAct(kind: Kind): Promise<void> {
    const h = this.hand;
    if (!h || this.busy || h.toAct !== HUMAN || this.screen !== 'play') return;
    // The button's preview is exactly what gets sent.
    const marked = h.hands[HUMAN].filter((c) => this.selected.has(c)).length;
    const preview = previews(h, this.amount, marked)[kind];
    if (!preview || !preview.enabled || !preview.action) return;
    const action = preview.action;
    const exchangeAfter = kind === 'bet' || kind === 'raise';
    const cards = exchangeAfter ? this.disp.you.filter((c) => this.selected.has(c)).slice(0, h.deck.length) : [];
    const g = this.gen;
    this.busy = true;
    this.showToast('you', action, h);
    if (this.online) {
      // The server applies it; the result comes back as a new view (see onlineOwn).
      this.online.pending = { marked: cards.length };
      this.online.conn.send({ type: 'intent', intent: toIntent(action, cards) });
      if (cards.length) {
        const slots = cards.map((c) => this.disp.you.indexOf(c));
        this.enqueue(async () => {
          this.render();
          await this.discardOut(HUMAN, slots);
        });
      } else this.render();
      return;
    }
    if (cards.length) {
      // Discarded cards fly to the discard box before the new ones swipe in.
      this.render();
      await this.discardOut(HUMAN, cards.map((c) => this.disp.you.indexOf(c)));
      if (g !== this.gen) return;
    }
    let m = matchAct(this.match!, action);
    let exchanged: number | null = null;
    let swipe: number[] | null = null;
    if (m.hand!.phase === 'exchange') {
      const held = m.hand!.hands[HUMAN];
      this.freshDiscards = HUMAN;
      m = matchAct(m, { type: 'exchange', cards });
      const now = m.hand!.hands[HUMAN];
      const drawn = now.filter((c) => !held.includes(c)); // arrival order
      const thrown = held.filter((c) => !now.includes(c)); // fewer than marked if a draw was skipped
      exchanged = drawn.length;
      if (drawn.length) {
        const { order, newIdx } = exchangeDisplay(this.disp.you, thrown.map((c) => this.disp.you.indexOf(c)), drawn);
        this.disp.you = order;
        swipe = newIdx;
      }
    }
    this.match = m;
    this.selected.clear();
    this.queuePotCoins(HUMAN, h, m.hand!);
    this.actionSound(action, h);
    let msg = this.describe('you', action, h, exchanged);
    if (exchanged !== null && exchanged < cards.length) {
      msg += ` <small>(${plural(cards.length - exchanged, 'draw')} skipped — you can't hold both Jokers)</small>`;
    }
    this.lastAction = { who: 'you', html: msg };
    this.pushLog('you', msg);
    if (swipe) {
      const idx = swipe;
      void this.animate(() => this.runSwipe(HUMAN, idx));
      return;
    }
    this.busy = false;
    this.afterAction();
  }

  private handOver(): void {
    const m = this.match!;
    const h = m.hand!;
    const out = h.outcome!;
    if (this.resultShown) return; // already shown (e.g. a late duplicate call)
    this.resultShown = true;
    const showdown = out.kind === 'showdown';
    // Both hands are revealed after every hand; the AI may learn from what it sees.
    this.ai?.observeHandEnd(makeView(h, AI), h.hands[HUMAN]);
    if (this.online) this.disp.ai = sortedDisplay(h.hands[AI]); // the opponent's real cards, just revealed
    this.stats.hands++;
    if (out.winner === HUMAN) this.stats.won++;
    if (showdown) this.stats.showdowns++;
    this.anim.flip = true;
    const [ey, ea] = out.evaluations;
    const winner = out.winner === HUMAN ? 'You win' : `${this.TheOpp} wins`;
    let html: string;
    if (showdown) {
      html =
        `Showdown: you <b>${describeHand(ey)}</b> vs. ${this.opp} <b>${describeHand(ea)}</b>. ` +
        `${winner} — ${out.comparison.explanation} ` +
        `${out.winner === HUMAN ? 'You take' : `${this.opp} takes`} <b>${plural(out.gain, 'coin')}</b>.`;
    } else {
      const dropper = out.loser === HUMAN ? 'You dropped' : `${this.TheOpp} dropped`;
      html =
        `${dropper}. ${winner} the pot of ${out.pot} (<b>${out.loser === HUMAN ? '−' : '+'}${plural(out.gain, 'coin')}</b> for you). ` +
        `Revealed: you <b>${describeHand(ey)}</b>, ${this.opp} <b>${describeHand(ea)}</b>.`;
    }
    this.pushLog('result', html);
    this.busy = false;
    this.render();
    for (let i = 0; i < 5; i++) this.sound.play('flip', 0.05 + i * 0.06);
    this.sound.play(out.winner === HUMAN ? 'win' : 'lose', 0.45);
    for (let i = 0; i < Math.min(out.pot, 6); i++) this.sound.play('coin', 0.7 + i * 0.07);
    this.animateCoins(out.winner, out.pot);
    this.focus('[data-cmd="next"]');
  }

  private next(): void {
    const m = this.match;
    if (!m || !m.hand || m.hand.phase !== 'over' || !this.resultShown || this.animating) return;
    if (m.winner !== null) {
      this.screen = 'over';
      this.render();
      this.sound.stopMusic();
      this.sound.play(m.winner === HUMAN ? 'gameOverWin' : 'gameOverLose');
      this.focus('[data-cmd="restart"]');
      return;
    }
    if (this.online) {
      this.sendReady();
      return;
    }
    this.startNextHand();
  }

  /** "New game", "Leave room" and "Play again" vs. the AI: back to the start screen. */
  private toSetup(): void {
    this.leaveRoom();
    this.gen++;
    this.busy = false;
    this.animating = false;
    this.sound.stopMusic();
    this.screen = 'setup';
    this.render();
    this.focus(this.playMode === 'online' ? '[data-cmd="create"]' : '[data-cmd="start"]');
  }

  private beginCmd(): void {
    if (!this.flipDone) return;
    if (this.online) this.sendReady();
    else this.begin(firstPlayerFromCoin(this.coinFace!));
  }

  private restart(): void {
    if (this.online) this.sendReady(); // rematch in the same room
    else this.toSetup();
  }

  // ------------------------------------------------------------------ online

  private createRoom(): void {
    savePref('order', this.order);
    savePref('jokers', String(this.jokers));
    savePref('discards', this.discardsUp ? 'up' : 'down');
    savePref('mode', 'online');
    savePref('timer', String(this.turnSeconds));
    this.connectRoom(randomRoomCode(), {
      jokers: this.jokers,
      discardsFaceUp: this.discardsUp,
      order: this.order,
      turnSeconds: this.turnSeconds,
    });
  }

  private joinRoom(): void {
    const code = normalizeRoomCode(this.joinCode);
    if (!isRoomCode(code)) {
      this.onlineError = code
        ? `“${escapeHtml(code)}” is not a room code. Codes have ${ROOM_CODE_LENGTH} letters and digits.`
        : 'Type the room code you were given.';
      this.renderOverlay();
      this.focus('#room-code');
      return;
    }
    this.connectRoom(code, null);
  }

  private connectRoom(code: string, create: RoomSettings | null): void {
    this.leaveRoom();
    this.gen++;
    this.ai = null;
    this.match = null;
    this.log = [];
    this.lastAction = null;
    this.selected.clear();
    this.onlineError = '';
    this.copied = false;
    const conn = new OnlineConnection(code, create, {
      message: (m) => {
        if (this.online?.conn === conn) this.onServer(m);
      },
      status: (s) => {
        if (this.online?.conn !== conn) return;
        this.online.link = s;
        this.renderNet();
        this.enqueue(() => this.render());
      },
      net: () => this.renderNet(),
    });
    this.online = { conn, code, create, room: null, link: 'connecting', matchNumber: 0, flipShown: 0, waiting: false, pending: null };
    this.pendingViews = 0;
    setRoomParam(code);
    this.screen = 'lobby';
    this.render();
  }

  /** Close the room connection (if any). */
  private leaveRoom(): void {
    if (!this.online) return;
    this.online.conn.close();
    this.online = null;
    this.queue = Promise.resolve();
    setRoomParam(null);
    this.renderNet();
  }

  /** True while a match in this room is being played (leaving now forfeits it). */
  private matchActive(): boolean {
    const r = this.online?.room;
    return !!r && (r.status === 'flip' || r.status === 'playing' || r.status === 'handOver');
  }

  /** "Leave room" / "New game": during an online match, confirm first — leaving forfeits. */
  private leaveCmd(confirmed = false): void {
    const o = this.online;
    if (!o) {
      this.toSetup();
      return;
    }
    if (this.matchActive() && !confirmed) {
      this.openConfirmLeave();
      return;
    }
    if (o.room) o.conn.send({ type: 'leave' });
    forgetRoom(o.code);
    this.toSetup();
  }

  private openConfirmLeave(): void {
    this.modalOpen = true;
    this.el.modal.hidden = false;
    this.el.modal.innerHTML = `
      <div class="dialog confirm" role="alertdialog" aria-modal="true" aria-label="Leave the match?">
        <h2>Leave the match?</h2>
        <p class="lead">The match is still running. If you leave now you <b>forfeit</b> — your opponent wins.</p>
        <div class="dialog-actions">
          <button type="button" class="ghost" data-cmd="close-modal">Stay</button>
          <button type="button" class="primary danger" data-cmd="confirm-leave">Leave &amp; forfeit</button>
        </div>
      </div>`;
    this.focus('.dialog.confirm [data-cmd="close-modal"]');
  }

  private sendReady(): void {
    const o = this.online;
    if (!o || o.waiting) return;
    o.waiting = true;
    o.conn.send({ type: 'ready' });
    this.sound.play('click');
    this.render();
  }

  private copyLink(): void {
    const url = shareLink(this.online?.code ?? '');
    const done = () => {
      this.copied = true;
      this.renderOverlay();
      this.focus('[data-cmd="copy-link"]');
    };
    navigator.clipboard?.writeText(url).then(done, () => {
      document.querySelector<HTMLInputElement>('#share-link')?.select();
    });
  }

  /** Run server messages strictly in order, each after the previous one (and its animation). */
  private enqueue(task: () => void | Promise<void>): void {
    const g = this.gen;
    this.queue = this.queue
      .then(() => (g === this.gen ? task() : undefined))
      .catch((e: unknown) => console.error(e));
  }

  private onServer(msg: ServerMsg): void {
    if (msg.type === 'error') this.enqueue(() => this.onServerError(msg));
    else if (msg.type === 'room') this.enqueue(() => this.onRoom(msg.room));
    else if (msg.type === 'state') {
      this.pendingViews++;
      this.enqueue(() => {
        this.pendingViews--;
        return this.onView(msg.view);
      });
    }
  }

  private onServerError(msg: ServerMsg & { type: 'error' }): void {
    const o = this.online!;
    if (!o.room) {
      // Could not get into the room.
      if (msg.code === 'room-taken' && o.create) {
        this.connectRoom(randomRoomCode(), o.create); // code collision: try another one
        return;
      }
      this.leaveRoom();
      this.gen++;
      this.playMode = 'online';
      this.onlineError = escapeHtml(msg.message);
      this.screen = 'setup';
      this.render();
      this.focus('#room-code');
      return;
    }
    // A rejected move (the buttons only offer legal ones, so this is rare).
    o.pending = null;
    this.busy = false;
    this.selected.clear();
    const html = `<b>Not allowed:</b> ${escapeHtml(msg.message)}`;
    this.lastAction = { who: 'info', html };
    this.pushLog('info', html);
    this.render();
  }

  private onRoom(room: RoomInfo): void {
    const o = this.online!;
    o.room = room;
    rememberSeat(o.code, room.token);
    if (o.conn.net.rtt === null) o.conn.net.offset = room.serverNow - Date.now(); // until the first ping
    if (room.status === 'over' && room.forfeit && this.screen !== 'over') {
      this.showForfeit(room);
      return;
    }
    if (room.status === 'waiting') {
      this.screen = 'lobby';
      this.render();
      return;
    }
    if (room.status === 'flip' && room.flip && o.flipShown !== room.matchNumber) {
      o.flipShown = room.matchNumber;
      o.waiting = false;
      this.screen = 'flip';
      this.coinFace = room.flip.face;
      this.flipDone = false;
      this.sound.stopMusic();
      this.render();
      this.sound.play('coinFlip');
      const g = this.gen;
      void wait(1900).then(() => {
        if (g !== this.gen || this.screen !== 'flip') return;
        this.flipDone = true;
        this.render();
        this.focus('[data-cmd="begin"]');
      });
      return;
    }
    // Ready flags / who is connected changed.
    if (!this.animating) this.render();
  }

  private async onView(view: OnlineView): Promise<void> {
    const o = this.online!;
    // A newer state is already waiting: skip straight to it (a hidden tab catching up).
    if (this.pendingViews > 0) return;
    const m = localMatch(view);
    const cur = this.match;
    const forfeited = o.room?.status === 'over' && !!o.room.forfeit;
    const sameHand =
      !!cur?.hand && o.matchNumber === view.matchNumber && cur.handNumber === m.handNumber && this.screen !== 'flip';
    if (!sameHand) {
      if (o.matchNumber !== view.matchNumber) this.beginOnlineMatch(m, view);
      o.waiting = false;
      o.pending = null;
      this.screen = forfeited ? 'over' : 'play';
      this.match = m;
      const h = m.hand!;
      if (h.history.length === 0 && h.phase !== 'over' && !document.hidden && !forfeited) {
        // A fresh deal: swipe in. Later messages (a quick first move) wait until it has landed.
        await this.showNewHand();
        return;
      }
      // Joined in the middle of a hand (reload / reconnect / a tab coming back): show it as it is.
      this.showSilently(m, cur ? `Caught up — hand ${m.handNumber}.` : `Back in room <b>${o.code}</b> — hand ${m.handNumber} continues.`);
      return;
    }
    const before = cur!.hand!;
    const fresh = m.hand!.history.slice(before.history.length);
    if (!fresh.length) {
      this.match = m;
      if (!this.animating) this.render();
      return;
    }
    // Several moves at once (this tab was in the background) or nobody watching: no animations.
    const groups = fresh.filter((e) => e.action.type !== 'exchange').length;
    if (groups > 1 || document.hidden) {
      this.showSilently(m, `Caught up (${plural(groups, 'move')} while this tab was in the background).`);
      return;
    }
    const timedOut = view.timeouts.includes(before.history.length);
    if (fresh[0].player === HUMAN) await this.onlineOwn(before, m, fresh, timedOut);
    else await this.onlineOpp(before, m, fresh, timedOut);
  }

  /** Jump to a state without animating the steps in between. */
  private showSilently(m: MatchState, note: string): void {
    const o = this.online!;
    const h = m.hand!;
    o.pending = null;
    this.match = m;
    this.selected.clear();
    this.animating = false;
    this.disp = { you: sortedDisplay(h.hands[HUMAN]), ai: h.phase === 'over' ? sortedDisplay(h.hands[AI]) : [...h.hands[AI]] };
    this.lastAction = { who: 'info', html: note };
    this.pushLog('info', note);
    this.busy = false;
    if (h.history.length === 0 || h.phase !== 'over') this.resultShown = false;
    if (o.room?.status === 'over' && o.room.forfeit) {
      this.screen = 'over';
      this.render();
    } else if (h.phase === 'over') this.handOver();
    else this.afterAction();
  }

  /** The match ended because a player left or stayed away too long. */
  private showForfeit(room: RoomInfo): void {
    const youWin = room.forfeit!.by !== room.seat;
    this.online!.waiting = false;
    this.online!.matchNumber = room.matchNumber;
    this.busy = false;
    this.animating = false;
    this.screen = 'over';
    const who = youWin ? 'Your opponent' : 'You';
    const why = room.forfeit!.reason === 'left' ? 'left the match' : 'were disconnected for more than 60 s';
    this.pushLog('result', `${who} ${youWin && room.forfeit!.reason !== 'left' ? 'was disconnected for more than 60 s' : why} — <b>${youWin ? 'you win' : 'you lose'}</b> by forfeit.`);
    this.render();
    this.sound.stopMusic();
    this.sound.play(youWin ? 'gameOverWin' : 'gameOverLose');
    this.focus('[data-cmd="restart"]');
  }

  private beginOnlineMatch(m: MatchState, view: OnlineView): void {
    const o = this.online!;
    o.matchNumber = view.matchNumber;
    this.log = [];
    this.stats = { hands: 0, won: 0, showdowns: 0 };
    this.lastAction = null;
    this.selected.clear();
    this.sound.startMusic('original'); // online: always the game's own track
    const r = o.room;
    const first = m.hand!.history.length === 0 && m.handNumber === 1 ? m.hand!.firstToAct : null;
    const how = r?.flip
      ? `Coin flip: ${r.flip.face === 'heads' ? 'Heads' : 'Tails'}.`
      : r
        ? `${r.seat === 0 ? 'You' : 'The host'} chose to go ${r.settings.order === 'first' ? 'first' : 'second'}.`
        : '';
    this.pushLog(
      'info',
      `${view.matchNumber > 1 ? 'Rematch' : 'Online match'} in room <b>${o.code}</b>: ${plural(m.jokers, 'Joker')} ` +
        `(${m.jokers === 2 ? 22 : 21} cards), discards face ${m.discardsFaceUp ? 'up' : 'down'}. ${how}` +
        (first === null ? '' : ` ${first === HUMAN ? 'You go' : 'Your opponent goes'} first.`),
    );
  }

  /** The server applied this player's move. */
  private async onlineOwn(before: HandState, m: MatchState, fresh: HandEvent[], timedOut = false): Promise<void> {
    const o = this.online!;
    const action = fresh[0].action;
    const marked = o.pending?.marked ?? 0;
    if (!o.pending || timedOut) this.showToast('you', action, before, timedOut ? "TIME'S UP" : undefined);
    o.pending = null;
    let exchanged: number | null = null;
    let swipe: number[] | null = null;
    if (fresh.some((e) => e.action.type === 'exchange')) {
      const held = before.hands[HUMAN];
      const now = m.hand!.hands[HUMAN];
      this.freshDiscards = HUMAN;
      const drawn = now.filter((c) => !held.includes(c)); // arrival order
      const thrown = held.filter((c) => !now.includes(c));
      exchanged = drawn.length;
      if (drawn.length) {
        const { order, newIdx } = exchangeDisplay(this.disp.you, thrown.map((c) => this.disp.you.indexOf(c)), drawn);
        this.disp.you = order;
        swipe = newIdx;
      }
    }
    this.match = m;
    if (m.hand!.phase === 'over') this.disp.ai = sortedDisplay(m.hand!.hands[AI]); // revealed cards, never placeholders
    this.selected.clear();
    this.queuePotCoins(HUMAN, before, m.hand!);
    this.actionSound(action, before);
    let msg = timedOut ? "Your time ran out — automatic <b>DROP</b>." : this.describe('you', action, before, exchanged);
    if (exchanged !== null && exchanged < marked) {
      msg += ` <small>(${plural(marked - exchanged, 'draw')} skipped — you can't hold both Jokers)</small>`;
    }
    this.lastAction = { who: 'you', html: msg };
    this.pushLog('you', msg);
    if (swipe) {
      const idx = swipe;
      await this.animate(() => this.runSwipe(HUMAN, idx));
      return;
    }
    this.busy = false;
    this.afterAction();
  }

  /** The opponent moved: same presentation as an AI move, with unknown cards. */
  private async onlineOpp(before: HandState, m: MatchState, fresh: HandEvent[], timedOut = false): Promise<void> {
    const g = this.gen;
    const action = fresh[0].action;
    this.showToast('ai', action, before, timedOut ? "TIME'S UP" : undefined);
    const ex = fresh.find((e) => e.action.type === 'exchange');
    let exchanged: number | null = null;
    let swipe: number[] | null = null;
    if (ex) {
      const k = ex.count ?? 0;
      exchanged = k;
      this.freshDiscards = AI;
      if (k) {
        // Face down: random display slots leave (the real positions are unknown anyway).
        const vacated = shuffleIdx(5, this.rng).slice(0, k);
        await this.discardOut(AI, vacated);
        if (g !== this.gen) return;
        const drawn = Array.from({ length: k }, () => -1000 - this.oppSeq++);
        const { order, newIdx } = exchangeDisplay(this.disp.ai, vacated, drawn);
        this.disp.ai = order;
        swipe = newIdx;
      }
    }
    this.match = m;
    if (m.hand!.phase === 'over') {
      // The hand ended with this move: show the revealed cards (they flip over) instead of
      // swiping in placeholders for cards we only now know.
      this.disp.ai = sortedDisplay(m.hand!.hands[AI]);
      swipe = null;
    }
    this.queuePotCoins(AI, before, m.hand!);
    this.actionSound(action, before);
    const msg = timedOut ? "Your opponent's time ran out — automatic <b>DROP</b>." : this.describe('ai', action, before, exchanged);
    this.lastAction = { who: 'ai', html: msg };
    this.pushLog('ai', msg);
    if (swipe) {
      const idx = swipe;
      await this.animate(() => this.runSwipe(AI, idx));
      return;
    }
    this.busy = false;
    this.afterAction();
  }

  /** Online: the opponent's seat in the room. */
  private oppConnected(): boolean {
    const r = this.online?.room;
    return !r || r.players[1 - r.seat].connected;
  }

  /** Panel status while it is not this player's move. */
  private waitingStatus(): string {
    if (!this.online) return 'AI is thinking…';
    if (this.online.link !== 'open') return 'Reconnecting…';
    if (this.online.pending) return 'Sending…';
    if (!this.oppConnected()) return 'Opponent disconnected<span class="clock-away" data-clock="away"></span>';
    return 'Opponent is thinking…';
  }

  /** Topbar indicator: connection state and ping. */
  private renderNet(): void {
    const el = document.getElementById('net');
    if (!el) return;
    const o = this.online;
    if (!o) {
      el.hidden = true;
      return;
    }
    const n = o.conn.net;
    el.hidden = false;
    const state = n.status !== 'open' ? 'down' : n.rtt === null ? 'wait' : n.rtt < 150 ? 'good' : n.rtt < 400 ? 'ok' : 'slow';
    el.className = `net-ind net-${state}`;
    el.title = n.status !== 'open' ? 'Not connected — reconnecting…' : `Connected to room ${o.code}${n.rtt !== null ? ` · ping ${n.rtt} ms` : ''}`;
    el.innerHTML = `<span class="net-dot" aria-hidden="true"></span><span class="net-text">${
      n.status !== 'open' ? 'offline' : n.rtt === null ? '…' : `${n.rtt} ms`
    }</span>`;
  }

  /** Update every countdown on screen from the server's deadlines (no re-render). */
  private updateClocks(): void {
    const o = this.online;
    const r = o?.room;
    if (!o || !r) return;
    const now = o.conn.serverNow();
    const secs = (t: number) => Math.max(0, Math.ceil((t - now) / 1000));
    const total = r.settings.turnSeconds;
    const h = this.hand;
    const mine = !!h && h.phase !== 'over' && h.toAct === HUMAN;
    const left = r.turnDeadline === null ? null : Math.max(0, Math.min(total, (r.turnDeadline - now) / 1000));
    for (const el of document.querySelectorAll<HTMLElement>('[data-clock="turn"]')) {
      const paused = left === null;
      el.classList.toggle('paused', paused);
      el.classList.toggle('mine', mine);
      el.classList.toggle('low', !paused && left! <= 5);
      el.querySelector('.tc-label')!.textContent = paused ? 'Clock paused' : mine ? 'Your turn' : "Opponent's turn";
      el.querySelector('.tc-secs')!.textContent = paused ? '–' : `${Math.ceil(left!)} s`;
      el.querySelector<HTMLElement>('.tc-bar i')!.style.width = `${paused ? 100 : (left! / total) * 100}%`;
    }
    // A soft tick in the last five seconds of your own turn.
    if (mine && left !== null && left > 0 && left <= 5 && !this.busy) {
      const sec = Math.ceil(left);
      if (sec !== this.lastTick) {
        this.lastTick = sec;
        this.sound.play('tick');
      }
    } else this.lastTick = -1;
    const fa = r.forfeitAt[1 - r.seat];
    for (const el of document.querySelectorAll<HTMLElement>('[data-clock="away"]')) {
      el.textContent = fa !== null ? ` — they forfeit in ${secs(fa)} s` : '';
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-clock="auto"]')) {
      el.textContent = r.autoContinueAt !== null ? ` Starts by itself in ${secs(r.autoContinueAt)} s.` : '';
    }
  }

  // ------------------------------------------------------------------ phone sheets

  /** Phone: open a bottom sheet (hand rankings, table log, sound & music), or close it (null). */
  private openSheet(name: 'ranks' | 'log' | 'sound' | null): void {
    this.sheet = this.sheet === name ? null : name;
    if (this.sheet) document.body.dataset.sheet = this.sheet;
    else delete document.body.dataset.sheet;
    const backdrop = document.getElementById('sheet-backdrop');
    if (backdrop) backdrop.hidden = !this.sheet;
    if (this.sheet === 'sound') (document.getElementById('sound-panel') as HTMLDetailsElement).open = true;
    for (const b of document.querySelectorAll<HTMLElement>('[data-cmd="sheet"]')) {
      b.setAttribute('aria-pressed', String(b.dataset.sheet === this.sheet));
    }
    if (this.sheet) this.focus(this.sheet === 'sound' ? '#sound-panel .sheet-close' : '#side .sheet-close');
  }

  // ------------------------------------------------------------------ your music

  /** A file picked in the sound panel: check it, play it, remember it on this device. */
  private async chooseMusic(file: File): Promise<void> {
    const bad = checkAudioFile(file);
    if (bad) {
      this.musicMsg = { kind: 'err', text: bad };
      this.renderSound();
      return;
    }
    this.musicMsg = { kind: 'ok', text: `Checking “${file.name}”…` };
    this.renderSound();
    const url = URL.createObjectURL(file);
    const unplayable = await probePlayable(url, file.name);
    if (unplayable) {
      URL.revokeObjectURL(url);
      this.musicMsg = { kind: 'err', text: unplayable };
      this.renderSound();
      return;
    }
    this.sound.setCustomTrack(url, file.name);
    try {
      await saveCustomTrack(file, file.name);
      this.musicMsg = { kind: 'ok', text: 'Saved in this browser — it replaces the default music.' };
    } catch {
      this.musicMsg = { kind: 'ok', text: "Playing your file now, but this browser can't remember it for next time." };
    }
    this.sound.play('click');
    this.renderSound();
  }

  private async useDefaultMusic(): Promise<void> {
    this.sound.setCustomTrack(null);
    await clearCustomTrack();
    this.musicMsg = { kind: 'ok', text: "Back to the default music, “Joker's Gambit”." };
    this.sound.play('click');
    this.renderSound();
  }

  /** The "your music" block of the sound panel (rebuilt on every sound change). */
  private musicPickHtml(): string {
    const name = this.sound.customTrackName;
    const err = this.sound.customError;
    const msg = err ? { kind: 'err', text: err } : this.musicMsg;
    return `
      <div class="music-now">Music: ${
        name ? `<b title="${escapeHtml(name)}">${escapeHtml(name)}</b> <small>your file</small>` : "<b>Joker's Gambit</b> <small>default</small>"
      }</div>
      <div class="music-btns">
        <label class="ghost small file-btn">Choose music file…<input type="file" name="music-file" accept="audio/*" class="sr"></label>
        ${name ? '<button type="button" class="ghost small" data-cmd="music-default">Use default music</button>' : ''}
      </div>
      ${msg ? `<p class="music-msg ${msg.kind}" role="${msg.kind === 'err' ? 'alert' : 'status'}">${escapeHtml(msg.text)}</p>` : ''}
      <p class="music-note">Your file stays on this device — it is never uploaded.</p>`;
  }

  // ------------------------------------------------------------------ text

  private get opp(): string {
    return this.online ? 'Opponent' : 'AI';
  }
  private get theOpp(): string {
    return this.online ? 'your opponent' : 'the AI';
  }
  private get TheOpp(): string {
    return this.online ? 'Your opponent' : 'The AI';
  }
  /** Short label (toast, discard rows). */
  private get oppTag(): string {
    return this.online ? 'OPP' : 'AI';
  }

  private oppSeatName(): string {
    if (!this.online) return `AI <span class="diff diff-${this.difficulty}">${this.difficultyName()}</span>`;
    const off = this.oppConnected() ? '' : '<span class="badge offline" title="Disconnected — the game waits for them">offline</span>';
    return `Opponent <span class="diff diff-online">Online</span>${off}`;
  }

  private difficultyName(d: Difficulty = this.difficulty): string {
    return d === 'normal' ? 'Normal' : d === 'hard' ? 'Hard' : 'Cheater';
  }

  private describe(who: 'you' | 'ai', a: Action, before: HandState, exchanged: number | null): string {
    const you = who === 'you';
    const name = you ? 'You' : this.opp;
    const v = (base: string, s = 's') => (you ? base : base + s);
    const n = before.bets[other(before.toAct)];
    const total = a.type === 'accept' ? n : resolvedTotal(before, a);
    const swap =
      exchanged === null
        ? ''
        : exchanged === 0
          ? ` and ${v('stand')} pat`
          : ` and ${v('exchange')} <b>${plural(exchanged, 'card')}</b>`;
    switch (a.type) {
      case 'drop':
        return `${name} ${v('drop')}.`;
      case 'bet':
        return total === n
          ? `${name} ${v('bet')} <b>${total}</b> (${v('match', 'es')})${swap}.`
          : `${name} ${v('bet')} <b>${total}</b>${swap}.`;
      case 'raise':
        return `${name} ${v('raise')} to <b>${total}</b>${swap}.`;
      case 'call':
        return `${name} <b>${v('call')}</b> at ${total} — no more exchanges this hand!`;
      case 'accept':
        return `${name} ${v('accept')} — ${v('match', 'es')} ${total}. Showdown!`;
      default:
        return '';
    }
  }

  private prompt(h: HandState): string {
    if (h.phase === 'over') return '';
    if (h.toAct === AI) return this.ai?.cheats ? 'The AI is peeking at your cards…' : `${this.TheOpp} is thinking…`;
    const l = legalActions(h);
    const n = h.bets[AI];
    if (h.phase === 'callResponse') {
      return `${this.TheOpp} called at ${n}. No more exchanges: <b>ACCEPT</b> (match ${n} → showdown) or <b>DROP</b>.`;
    }
    if (h.phase === 'final') {
      return `<b>Final round:</b> ${n >= h.cap ? `${this.theOpp} is at the maximum (${h.cap}). ` : ''}<b>BET ${h.cap}</b> (match) and exchange, or <b>DROP</b> — then showdown.`;
    }
    if (!l.bet && !l.raise) return 'No more exchange rounds this hand — <b>CALL</b> or <b>DROP</b>.';
    const empty = h.deck.length === 0 ? ' The deck is empty, so BET/RAISE exchange nothing.' : '';
    if (l.first) return `You act first: <b>RAISE</b> (then exchange), <b>CALL</b> to show down, or <b>DROP</b>.${empty}`;
    return `${this.TheOpp}'s bet is ${n}. <b>BET</b> or <b>RAISE</b> (then exchange), <b>CALL</b>, or <b>DROP</b>.${empty}`;
  }

  private pushLog(who: Who, html: string): void {
    this.log.push({ who, html });
    if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
  }

  // ------------------------------------------------------------------ events

  private get hand(): HandState | null {
    return this.match?.hand ?? null;
  }

  private canSelect(h: HandState): boolean {
    if (this.busy || this.animating || h.toAct !== HUMAN || h.deck.length === 0) return false;
    const l = legalActions(h);
    return (h.phase === 'turn' || h.phase === 'final') && (!!l.bet || !!l.raise);
  }

  private toggleCard(c: Card): void {
    const h = this.hand;
    if (!h || !this.canSelect(h) || !h.hands[HUMAN].includes(c)) return;
    if (this.selected.has(c)) {
      this.selected.delete(c);
      this.sound.play('deselect');
    } else if (this.selected.size < h.deck.length) {
      this.selected.add(c);
      this.sound.play('select');
    }
    this.render();
  }

  private setCard(slot: number, on: boolean): void {
    const h = this.hand;
    if (!h) return;
    const c = this.disp.you[slot];
    if (c === undefined || this.selected.has(c) === on) return;
    this.toggleCard(c);
  }

  private adjustAmount(delta: number): void {
    const h = this.hand;
    if (!h || h.toAct !== HUMAN || this.busy) return;
    const next = clampAmount(h, this.amount + delta);
    if (next === null) return;
    if (next !== this.amount) this.sound.play('click');
    this.amount = next;
    this.render();
  }

  private onClick(e: Event): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-cmd], [data-card]');
    if (!t || (t as HTMLButtonElement).disabled) return;
    const cmd = t.dataset.cmd;
    if (!cmd && t.dataset.card !== undefined && t.closest('.you-hand')) {
      this.toggleCard(Number(t.dataset.card));
      return;
    }
    switch (cmd) {
      case 'rules':
        this.openModal();
        break;
      case 'lang-th':
      case 'lang-en':
        this.setRulesLang(cmd === 'lang-th' ? 'th' : 'en');
        break;
      case 'close-modal':
        this.closeModal();
        break;
      case 'mute-all':
        this.sound.toggleAll();
        break;
      case 'mute-music':
        this.sound.toggleMusic();
        break;
      case 'sheet':
        this.openSheet((t.dataset.sheet as 'ranks' | 'log' | 'sound') ?? null);
        break;
      case 'close-sheet':
        this.openSheet(null);
        break;
      case 'discards': {
        this.discOpen = !this.discOpen;
        const box = this.el.felt.querySelector('.discard-box');
        box?.classList.toggle('open', this.discOpen);
        t.setAttribute('aria-expanded', String(this.discOpen));
        break;
      }
      case 'music-default':
        void this.useDefaultMusic();
        break;
      case 'mute-sfx':
        this.sound.toggleSfx();
        this.sound.play('click');
        break;
      case 'new':
      case 'leave':
        this.leaveCmd();
        break;
      case 'confirm-leave':
        this.closeModal();
        this.leaveCmd(true);
        break;
      case 'rejoin': {
        const code = lastRoom();
        if (code) this.connectRoom(code, null);
        break;
      }
      case 'start':
        this.start();
        break;
      case 'create':
        this.createRoom();
        break;
      case 'join':
        this.joinRoom();
        break;
      case 'copy-link':
        this.copyLink();
        break;
      case 'begin':
        this.beginCmd();
        break;
      case 'next':
        this.next();
        break;
      case 'restart':
        this.restart();
        break;
      case 'raise-up':
        this.adjustAmount(1);
        break;
      case 'raise-down':
        this.adjustAmount(-1);
        break;
      case 'clear':
        this.selected.clear();
        this.sound.play('deselect');
        this.render();
        break;
      case 'drop':
      case 'bet':
      case 'raise':
      case 'call':
      case 'accept':
        void this.humanAct(cmd);
        break;
    }
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.type === 'file' && t.name === 'music-file') {
      const f = t.files?.[0];
      t.value = ''; // choosing the same file again still fires
      if (f) void this.chooseMusic(f);
      return;
    }
    if (t.type !== 'radio') return;
    if (t.name === 'mode') {
      this.playMode = t.value === 'online' ? 'online' : 'ai';
      savePref('mode', this.playMode);
      this.onlineError = '';
    }
    if (t.name === 'difficulty') this.difficulty = t.value as Difficulty;
    if (t.name === 'order') this.order = t.value as TurnOrderChoice;
    if (t.name === 'discards') this.discardsUp = t.value === 'up';
    if (t.name === 'timer') this.turnSeconds = Number(t.value) as TurnSeconds;
    if (t.name === 'jokers') {
      this.jokers = t.value === '2' ? 2 : 1;
      setTimeout(() => getTables(this.jokers), 30);
    }
    this.sound.play('click');
    this.renderOverlay();
    this.focus(`input[name="${t.name}"][value="${t.value}"]`);
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.name === 'room-code') {
      this.joinCode = t.value;
      return;
    }
    if (t.name === 'music-volume') this.sound.setMusicVolume(Number(t.value) / 100);
    if (t.name === 'sfx-volume') this.sound.setSfxVolume(Number(t.value) / 100);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;
    const target = e.target as HTMLElement | null;
    if (target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range') {
      if (key === 'Escape') target.blur();
      return; // let sliders use the arrow keys
    }
    if (target?.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') {
      // Typing a room code: no shortcuts (M, D, R… are code letters).
      if (key === 'Enter' && (target as HTMLInputElement).name === 'room-code') {
        e.preventDefault();
        this.joinRoom();
      } else if (key === 'Escape') target.blur();
      return;
    }
    if (key === 'm' || key === 'M') {
      e.preventDefault();
      this.sound.toggleAll();
      return;
    }
    if (this.sheet && key === 'Escape') {
      e.preventDefault();
      this.openSheet(null);
      return;
    }
    if (this.modalOpen) {
      if (key === 'Escape') {
        e.preventDefault();
        this.closeModal();
      }
      return;
    }
    const onButton = (document.activeElement as HTMLElement | null)?.tagName === 'BUTTON';
    if (this.screen === 'setup') {
      if (key === 'Enter' && !onButton) {
        e.preventDefault();
        if (this.playMode === 'online') this.createRoom();
        else this.start();
      }
      return;
    }
    if (this.screen === 'lobby') return;
    if (this.screen === 'flip') {
      if (key === 'Enter' && !onButton) {
        e.preventDefault();
        this.beginCmd();
      }
      return;
    }
    if (this.screen === 'over') {
      if (key === 'Enter' && !onButton) {
        e.preventDefault();
        this.restart();
      }
      return;
    }
    const h = this.hand;
    if (!h || this.animating) return; // input is blocked while cards are moving
    if (h.phase === 'over') {
      if ((key === 'Enter' && !onButton) || key === 'n' || key === 'N') {
        e.preventDefault();
        this.next();
      }
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const activeSlot = active?.closest('.you-hand') ? active.dataset.slot : undefined;
    switch (key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault();
        const items = Array.from(
          document.querySelectorAll<HTMLElement>('.you-hand .card:not([disabled]), .actions-dyn button:not([disabled])'),
        );
        if (!items.length) return;
        const i = active ? items.indexOf(active) : -1;
        const j = i < 0 ? 0 : (i + (key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
        items[j].focus();
        return;
      }
      case 'ArrowUp':
      case 'ArrowDown':
        e.preventDefault();
        if (activeSlot !== undefined) this.setCard(Number(activeSlot), key === 'ArrowUp');
        else this.adjustAmount(key === 'ArrowUp' ? 1 : -1);
        return;
      case 'Escape':
        if (this.selected.size) this.sound.play('deselect');
        this.selected.clear();
        this.render();
        return;
    }
    if (/^[1-5]$/.test(key)) {
      const c = this.disp.you[Number(key) - 1];
      if (c !== undefined) this.toggleCard(c);
      return;
    }
    const map: Record<string, Kind[]> = { d: ['drop'], r: ['raise'], b: ['bet'], c: ['call', 'accept'], a: ['accept'] };
    const kinds = map[key.toLowerCase()];
    if (kinds) {
      const k = kinds.find((x) => this.el.actions.querySelector(`[data-cmd="${x}"]:not([disabled])`));
      if (k) {
        e.preventDefault();
        void this.humanAct(k);
      }
    }
  }

  private openModal(): void {
    this.modalOpen = true;
    this.el.modal.hidden = false;
    const th = this.rulesLang === 'th';
    const lang = (code: RulesLang, label: string) =>
      `<button type="button" class="lang-btn" data-cmd="lang-${code}" aria-pressed="${this.rulesLang === code}" lang="${code}">${label}</button>`;
    this.el.modal.innerHTML = `
      <div class="dialog rules ${th ? 'lang-th' : ''}" role="dialog" aria-modal="true" aria-label="${th ? 'กติกา' : 'Rules'}" lang="${this.rulesLang}">
        <div class="rules-head">
          <div class="lang-toggle" role="group" aria-label="Language">${lang('th', 'ไทย')}${lang('en', 'English')}</div>
          <button type="button" class="close" data-cmd="close-modal" aria-label="Close">✕</button>
        </div>
        <div class="rules-body">${th ? rulesHtmlTh(this.modeLineThai()) : this.modeLine() + RULES_HTML}</div>
        <div class="dialog-actions"><button type="button" class="primary" data-cmd="close-modal">${th ? 'เข้าใจแล้ว' : 'Got it'} <kbd>Esc</kbd></button></div>
      </div>`;
    // Always open at the top. Focus the language toggle (at the top) without scrolling —
    // focusing "Got it" at the bottom used to scroll the screen down.
    const dialog = this.el.modal.querySelector<HTMLElement>('.rules')!;
    const toTop = () => {
      dialog.scrollTop = 0;
    };
    toTop();
    requestAnimationFrame(() => {
      this.el.modal.querySelector<HTMLElement>(`[data-cmd="lang-${this.rulesLang}"]`)?.focus({ preventScroll: true });
      toTop();
    });
  }

  private setRulesLang(lang: RulesLang): void {
    this.rulesLang = lang;
    savePref('rulesLang', lang);
    this.sound.play('click');
    this.openModal();
  }

  private modeLineThai(): string {
    const m = this.match;
    const jokers = m && this.screen !== 'setup' ? m.jokers : this.jokers;
    const up = m && this.screen !== 'setup' ? m.discardsFaceUp : this.discardsUp;
    return modeLineTh(jokers, up);
  }

  /** "This table: 1 Joker · discards face up" — the current (or selected) match settings. */
  private modeLine(): string {
    const m = this.match;
    const jokers = m && this.screen !== 'setup' ? m.jokers : this.jokers;
    const up = m && this.screen !== 'setup' ? m.discardsFaceUp : this.discardsUp;
    return `<p class="mode-line">This table: <b>${plural(jokers, 'Joker')}</b> (${jokers === 2 ? 22 : 21} cards) ·
      discards <b>face ${up ? 'up' : 'down'}</b> — ${up ? 'both players see every discarded card' : 'only the number of discarded cards is shown'}.</p>`;
  }

  private closeModal(): void {
    this.modalOpen = false;
    this.el.modal.hidden = true;
    this.el.modal.innerHTML = '';
    if (this.screen === 'play') this.focusFirstAction();
  }

  private focus(sel: string): void {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(sel)?.focus());
  }

  /** Focus the safest default button (never DROP when anything else is available). */
  private focusFirstAction(): void {
    requestAnimationFrame(() => {
      const a = this.el.actions;
      const el =
        a.querySelector<HTMLElement>('button.primary:not([disabled])') ??
        a.querySelector<HTMLElement>('button:not([disabled]):not([data-cmd="drop"])') ??
        a.querySelector<HTMLElement>('button:not([disabled])');
      el?.focus();
    });
  }

  // ------------------------------------------------------------------ rendering

  private render(): void {
    const activeKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
    this.renderFelt();
    this.renderActions();
    this.renderSide();
    this.renderOverlay();
    this.updateClocks();
    if (activeKey) document.querySelector<HTMLElement>(`.table [data-key="${activeKey}"]`)?.focus();
    this.anim.flip = false;
    this.freshDiscards = null;
    for (const { p, n } of this.potCoins.splice(0)) this.flyCoins(`coins-${p}`, 'pot', n, 0);
  }

  private coinStack(n: number): string {
    const shown = Math.min(n, 24);
    let html = '';
    for (let i = 0; i < shown; i++) html += '<span class="coin"></span>';
    return `<span class="coin-stack" aria-hidden="true">${html}</span>`;
  }

  private renderFelt(): void {
    const m = this.match;
    const h = m?.hand;
    if (!m || !h || this.screen === 'setup' || this.screen === 'flip') {
      this.el.felt.innerHTML = `<div class="felt-empty"><span class="logo-star big" aria-hidden="true">★</span><p>${TITLE}</p></div>`;
      return;
    }
    const over = h.phase === 'over';
    const cheater = this.ai?.cheats;

    const aiCards = this.cardsHtml(AI);
    const youCards = this.cardsHtml(HUMAN);

    const handName = (p: PlayerId) => {
      if (over) {
        const e = h.outcome!.evaluations[p];
        const j = describeJoker(e);
        const won = h.outcome!.winner === p;
        return `<div class="hand-name ${won ? 'won' : 'lost'}">${won ? '<span class="crown" aria-hidden="true">♛</span>' : ''}${describeHand(e)}${j ? ` <small>(${j})</small>` : ''}</div>`;
      }
      if (p === HUMAN) return `<div class="hand-name live">${describeHandSafe(h.hands[HUMAN])}</div>`;
      return '';
    };
    const badges = (p: PlayerId) =>
      (h.firstToAct === p ? '<span class="badge first" title="Acts first this hand">1st</span>' : '') +
      (!over && h.toAct === p ? '<span class="badge turn">to act</span>' : '');
    const seat = (p: PlayerId, name: string) => {
      const max = h.bets[p] >= h.cap;
      return `
      <div class="seat">
        <div class="seat-name">${name}${badges(p)}</div>
        <div class="seat-money">
          <div class="seat-coins" id="coins-${p}" title="Coins not in the pot">${this.coinStack(h.stacks[p])}<span class="coin-count">${h.stacks[p]}</span></div>
          <div class="bet-big ${max ? 'max' : ''}" title="${p === HUMAN ? 'Your' : `${this.TheOpp}'s`} bet this hand${max ? ' (maximum)' : ''}">
            <span class="bet-label">${max ? 'MAX' : 'BET'}</span><b>${h.bets[p]}</b></div>
        </div>
      </div>`;
    };
    const cur = currentBet(h);

    setHtml(this.el.felt, `
      <div class="zone ai-zone ${h.toAct === AI && !over ? 'active' : ''}">
        ${seat(AI, this.oppSeatName())}
        <div class="hand ai-hand">${aiCards}</div>
        <div class="zone-side">
          ${cheater ? '<div class="cheat-badge" title="The AI can see your hand and the deck order"><span class="eye" aria-hidden="true"></span>CHEATER<span class="cheat-long"> — sees your cards &amp; the deck</span></div>' : ''}
          ${handName(AI)}
        </div>
      </div>

      <div class="center">
        <div class="deck-box" title="Cards left in the deck">
          <div class="pile-cards">${h.deck.length ? cardBack({ cls: 'pile-top' }) : '<div class="card empty"></div>'}</div>
          <div class="last-box"><span>LAST</span><b>${String(h.deck.length).padStart(2, '0')}</b></div>
          ${h.jokers === 2 ? '<span class="jk-mode" title="2-Joker mode">★★</span>' : ''}
        </div>
        <div class="pot" id="pot">
          <div class="pot-coins">${this.coinStack(pot(h))}</div>
          <div class="pot-total"><span>POT</span><b>${pot(h)}</b></div>
          <div class="pot-meta">${cur >= h.cap ? `<em class="max-flag">MAX ${h.cap}</em>` : `Bet ${cur} · Max ${h.cap}`}</div>
        </div>
        ${this.discardBoxHtml(h)}
      </div>

      ${over ? this.resultPanel(h) : this.bannerHtml(h)}

      <div class="zone you-zone ${h.toAct === HUMAN && !over ? 'active' : ''}">
        ${seat(HUMAN, 'You')}
        <div class="hand you-hand" role="group" aria-label="Your hand — select cards to exchange">${youCards}</div>
        <div class="zone-side">${handName(HUMAN)}</div>
      </div>`,
      'table',
    );
  }

  /**
   * Framed discard box: one row per player, cards in discard order, grouped by exchange round.
   * Face down shows backs only (no card identities in the DOM) and the count per player.
   */
  private discardBoxHtml(h: HandState): string {
    const up = h.discardsFaceUp;
    const row = (p: PlayerId, label: string) => {
      const groups = h.history
        .filter((e) => e.player === p && e.action.type === 'exchange' && e.action.cards.length > 0)
        .map((e) => (e.action as { cards: Card[] }).cards);
      const n = groups.reduce((a, g) => a + g.length, 0);
      const fresh = this.freshDiscards === p ? groups.length - 1 : -1;
      const html = groups
        .map((g, gi) =>
          g
            .map(
              (c, ci) =>
                `<span class="dslot${gi > 0 && ci === 0 ? ' gstart' : ''}${gi === fresh ? ' fresh' : ''}" style="--k:${ci}">${discardCard(c, up)}</span>`,
            )
            .join(''),
        )
        .join('');
      return `<div class="drow" data-owner="${p}">
        <span class="downer">${label}<b>${n}</b></span>
        <div class="dcards">${html}</div></div>`;
    };
    const count = (p: PlayerId) => h.discards[p].length;
    return `<div class="discard-box ${up ? 'up' : 'down'}${this.discOpen ? ' open' : ''}" title="Discarded cards are out until the next hand">
      <button type="button" class="dchip" data-cmd="discards" aria-expanded="${this.discOpen}" aria-label="Discards: ${this.oppTag} ${count(AI)}, you ${count(HUMAN)}${up ? ' — show the cards' : ''}">
        <span class="dchip-t">Discards</span><b>${count(AI)}</b><span class="dchip-sep">·</span><b class="you">${count(HUMAN)}</b>${up ? '<span class="dchip-more" aria-hidden="true">▾</span>' : ''}</button>
      <div class="dtitle">DISCARDS <small>face ${up ? 'up' : 'down'}</small></div>
      ${row(AI, this.oppTag)}${row(HUMAN, 'YOU')}</div>`;
  }

  /** Cards of one hand in display order. The AI's are face down until the hand is over. */
  private cardsHtml(p: PlayerId): string {
    const h = this.hand!;
    if (p === AI) {
      const over = h.phase === 'over';
      return this.disp.ai
        .map((c, i) =>
          over && c >= 0
            ? cardFace(c, { cls: this.anim.flip ? 'flip-in' : '', style: `--i:${i}`, slot: i })
            : cardBack({ slot: i }),
        )
        .join('');
    }
    const selectable = this.canSelect(h);
    return this.disp.you
      .map((c, i) =>
        cardFace(c, {
          button: true,
          selected: this.selected.has(c),
          cls: selectable ? 'selectable' : '',
          key: `card-${i}`,
          slot: i,
          disabled: !selectable,
        }),
      )
      .join('');
  }

  private bannerHtml(h: HandState): string {
    const last = this.lastAction;
    const final = h.phase === 'final' || h.finalTurns > 0;
    const r = this.online?.room;
    const clock =
      r && r.settings.turnSeconds > 0
        ? `<div class="turn-clock" data-clock="turn" aria-hidden="true"><span class="tc-label"></span><span class="tc-bar"><i></i></span><b class="tc-secs"></b></div>`
        : '';
    const away =
      r && !this.oppConnected()
        ? `<div class="away-flag" role="alert">Opponent disconnected<span data-clock="away"></span></div>`
        : '';
    return `<div class="banner ${final ? 'is-final' : ''}" role="status" aria-live="polite">
      ${clock}${away}
      ${final ? `<div class="final-flag">FINAL ROUND · MAX ${h.cap}</div>` : ''}
      ${last ? `<div class="last who-${last.who}">${last.html}</div>` : ''}
      <div class="prompt">${this.prompt(h)}</div>
    </div>`;
  }

  private resultPanel(h: HandState): string {
    const out = h.outcome!;
    const youWin = out.winner === HUMAN;
    const [ey] = out.evaluations;
    const cmp = out.comparison;
    let body: string;
    if (out.kind === 'showdown') {
      body = `<p class="why">${cmp.explanation}</p>
        <p class="decided">Decided by: <b>${TIEBREAK_LABEL[cmp.reason]}</b>${cmp.reason !== 'category' ? ` <small>(both ${CATEGORY_NAMES[ey.category]})</small>` : ''}</p>`;
    } else {
      const wouldWin = cmp.winner === HUMAN;
      body = `<p class="why">${out.loser === HUMAN ? 'You dropped' : `${this.TheOpp} dropped`}. Hands revealed:
        at a showdown ${wouldWin ? 'yours' : `${this.theOpp}'s`} would have won <small>(${cmp.explanation})</small></p>`;
    }
    const sign = youWin ? '+' : '−';
    return `<div class="result ${youWin ? 'win' : 'lose'}" role="status" aria-live="polite">
      <h2>${youWin ? 'You win the hand!' : `${this.TheOpp} wins the hand`}
        <span class="transfer">${youWin ? 'You take' : `${this.opp} takes`} the pot of ${out.pot}:
        <b class="${youWin ? 'plus' : 'minus'}">${sign}${plural(out.gain, 'coin')}</b></span></h2>
      ${body}
    </div>`;
  }

  private renderActions(): void {
    const a = this.el.actions;
    const m = this.match;
    const h = m?.hand;
    if (!m || !h || this.screen !== 'play') {
      setHtml(a, `<div class="panel-status">${this.screen === 'over' ? 'Match over' : 'No game in progress'}</div>
        <button type="button" class="act primary" data-cmd="new" data-key="new"><span class="act-name">NEW GAME</span></button>`, 'action panel');
      return;
    }
    if (h.phase === 'over') {
      const last = m.winner !== null;
      const o = this.online;
      const oppReady = !!o?.room && o.room.ready[1 - o.room.seat];
      const hint = !o
        ? 'Both hands stay face up until you continue.'
        : !this.oppConnected()
          ? `${OPP_GONE}<span data-clock="away"></span>`
          : o.waiting
          ? 'Waiting for your opponent to press Next…<span data-clock="auto"></span>'
          : last
            ? 'See the final result.'
            : oppReady
              ? 'Your opponent is ready for the next hand.<span data-clock="auto"></span>'
              : 'The next hand starts when both players press Next.<span data-clock="auto"></span>';
      setHtml(a, `<div class="panel-status">${h.outcome!.winner === HUMAN ? 'You won the hand' : `${this.TheOpp} won the hand`}</div>
        <button type="button" class="act primary next" data-cmd="next" data-key="next" ${o?.waiting || !this.resultShown || this.animating ? 'disabled' : ''}>
          <span class="act-name">${last ? 'FINAL RESULT' : o?.waiting ? 'WAITING…' : 'NEXT HAND'}</span><span class="act-sub">Enter</span></button>
        <p class="panel-hint">${hint}</p>`, 'action panel');
      return;
    }
    const mine = h.toAct === HUMAN && !this.busy;
    // While the AI acts, show the player's standard (disabled) panel.
    const view: HandState = mine ? h : { ...h, phase: 'turn', toAct: HUMAN };
    const range = amountRange(view);
    if (range) this.amount = clampAmount(view, this.amount) ?? range.min;
    const nSel = h.hands[HUMAN].filter((c) => this.selected.has(c)).length;
    const pv = previews(view, this.amount, nSel);
    const n = h.bets[AI];

    const btn = (cmd: Kind, b: ReturnType<typeof previews>['drop'] | null, primary = false) =>
      b
        ? `<span class="act-wrap" title="${mine && !b.enabled ? b.reason : ''}"><button type="button" class="act ${cmd}${primary ? ' primary' : ''}"
            data-cmd="${cmd}" data-key="${cmd}" ${mine && b.enabled ? '' : 'disabled'}>
            <span class="act-name">${b.name}</span><span class="act-sub">${b.sub}</span></button></span>`
        : '';

    // 1. status + short hint (marked cards)
    const hint = this.canSelect(h)
      ? nSel
        ? `<span><b>${plural(nSel, 'card')}</b> marked to exchange</span><button type="button" class="ghost small" data-cmd="clear">Clear <kbd>Esc</kbd></button>`
        : '<span class="hint-idle">Click cards (or <kbd>1</kbd>–<kbd>5</kbd>) to mark them for exchange.</span><span class="hint-idle-phone">Tap cards to mark them for exchange</span>'
      : view.phase === 'callResponse'
        ? `<span>${this.TheOpp} called at <b>${n}</b> — no more exchanges.</span>`
        : '';
    const finalHint = mine && view.phase === 'final' ? `<div class="final-flag panel">FINAL ROUND — one last turn, then showdown</div>` : '';

    // 2. shared amount selector
    const isMax = range !== null && this.amount >= h.cap;
    const amountBlock =
      range && view.phase === 'turn'
        ? `<div class="amount-block" role="group" aria-label="Your bet">
            <div class="amount-label">Your bet</div>
            <div class="amount-row">
              <button type="button" class="step" data-cmd="raise-down" data-key="raise-down" aria-label="Lower the amount" ${mine && this.amount > range.min ? '' : 'disabled'}>−</button>
              <b class="amount-val ${isMax ? 'max' : ''}" aria-live="polite">${this.amount}</b>
              <button type="button" class="step" data-cmd="raise-up" data-key="raise-up" aria-label="Raise the amount" ${mine && this.amount < range.max ? '' : 'disabled'}>+</button>
            </div>
            <div class="amount-meta">${this.opp} bet ${n} · ${isMax ? `<em class="max-flag">MAX ${h.cap}</em>` : `max ${h.cap}`}</div>
          </div>`
        : '';

    // 3. action buttons, each previewing its real result
    const buttons =
      view.phase === 'callResponse'
        ? btn('accept', pv.accept, true) + btn('drop', pv.drop)
        : btn('bet', pv.bet, true) + btn('raise', pv.raise, !pv.bet) + btn('call', pv.call) + btn('drop', pv.drop);

    const status = this.animating ? 'Sorting cards…' : mine ? 'Your turn' : this.ai?.cheats ? 'AI is peeking…' : this.waitingStatus();
    setHtml(a, `
      <div class="panel-status ${mine ? 'mine' : ''}">${status}</div>
      ${finalHint}
      ${hint ? `<div class="exchange-box">${hint}${this.canSelect(h) && h.deck.length < 5 ? `<small>Deck: ${plural(h.deck.length, 'card')} left.</small>` : ''}</div>` : ''}
      ${amountBlock}
      <div class="action-buttons" role="toolbar" aria-label="Betting actions">${buttons}</div>
      <p class="panel-hint keys"><kbd>↑</kbd><kbd>↓</kbd> amount · <kbd>←</kbd><kbd>→</kbd> move · <kbd>B</kbd><kbd>R</kbd><kbd>C</kbd><kbd>D</kbd> act · <kbd>M</kbd> mute</p>`, 'action panel');
  }

  private renderSound(): void {
    this.renderSoundControls();
    const pick = this.el.soundPanel.querySelector('.music-pick');
    if (pick) setHtml(pick, this.musicPickHtml(), 'music picker');
  }

  private renderSoundControls(): void {
    const s = this.sound.settings;
    const row = (label: string, name: string, vol: number, muted: boolean, cmd: string) => `
      <div class="sound-row">
        <button type="button" class="mute ${muted ? 'is-muted' : ''}" data-cmd="${cmd}" aria-pressed="${muted}" title="${muted ? 'Unmute' : 'Mute'} ${label.toLowerCase()}">${muted ? '✕' : '♪'}</button>
        <label>${label}<input type="range" name="${name}" min="0" max="100" step="5" value="${Math.round(vol * 100)}" aria-label="${label} volume"></label>
        <span class="vol">${muted ? 'off' : Math.round(vol * 100)}</span>
      </div>`;
    // Only build once; afterwards update in place (keeps a slider usable while it is dragged).
    const body = this.el.soundPanel;
    if (!body.querySelector('input')) {
      body.innerHTML =
        row('Music', 'music-volume', s.musicVolume, s.musicMuted, 'mute-music') +
        row('Effects', 'sfx-volume', s.sfxVolume, s.sfxMuted, 'mute-sfx') +
        '<div class="music-pick" aria-label="Your music"></div>';
    } else {
      const rows = body.querySelectorAll('.sound-row');
      ([[s.musicVolume, s.musicMuted], [s.sfxVolume, s.sfxMuted]] as const).forEach(([vol, muted], i) => {
        const r = rows[i];
        const b = r.querySelector<HTMLButtonElement>('.mute')!;
        b.classList.toggle('is-muted', muted);
        b.setAttribute('aria-pressed', String(muted));
        b.textContent = muted ? '✕' : '♪';
        const input = r.querySelector<HTMLInputElement>('input')!;
        if (document.activeElement !== input) input.value = String(Math.round(vol * 100));
        r.querySelector('.vol')!.textContent = muted ? 'off' : String(Math.round(vol * 100));
      });
    }
    const all = this.sound.allMuted;
    this.el.muteAll.setAttribute('aria-pressed', String(all));
    this.el.muteAll.innerHTML = `<span aria-hidden="true">${all ? '🔇' : '🔊'}</span><span class="sr">${all ? 'Unmute' : 'Mute'} all</span> <kbd>M</kbd>`;
  }

  private renderSide(): void {
    // English only (the Rules screen has the Thai version). Row: number + name (+ note), then the
    // five example cards — under the name, or beside it when the panel is wide (container query).
    const ranks = RANKINGS.map(
      (r, i) => `<li><span class="rk-num">${i + 1}</span>
        <span class="rk-name">${r.name}${r.note ? `<small class="rk-note">${r.note}</small>` : ''}</span>
        <span class="rk-ex" aria-label="Example: ${r.example.replace('★', 'Joker')}">${rankExample(r.example)}</span></li>`,
    ).join('');
    const log = this.log
      .slice()
      .reverse()
      .map((e) => `<li class="who-${e.who}">${e.html}</li>`)
      .join('');
    setHtml(this.el.side, `
      <button type="button" class="sheet-close" data-cmd="close-sheet" aria-label="Close">✕</button>
      <details class="panel rankings" open lang="en">
        <summary>Hand rankings</summary>
        <ol class="rank-list">${ranks}</ol>
        <p class="panel-note">A &gt; K &gt; Q &gt; J &gt; 10 · ♠ &gt; ♥ &gt; ♦ &gt; ♣ · No ties.
        <b>Joker rule:</b> same category and only one hand holds a Joker → the Joker hand loses.</p>
      </details>
      <section class="panel log">
        <h2>Table log</h2>
        <ol class="log-list">${log || '<li class="muted">No hands played yet.</li>'}</ol>
      </section>`, 'side panel');
  }

  private renderOverlay(): void {
    const o = this.el.overlay;
    if (this.screen === 'play') {
      o.hidden = true;
      o.innerHTML = '';
      this.overlayShown = null;
      return;
    }
    o.hidden = false;
    // Re-rendering the same screen (a setting changed, the opponent got ready…) must not replay
    // the dialog's pop-in.
    const again = this.overlayShown === this.screen;
    this.overlayShown = this.screen;
    this.fillOverlay(o);
    if (again) o.querySelector('.dialog')?.classList.add('no-pop');
  }

  private fillOverlay(o: HTMLElement): void {
    if (this.screen === 'setup') {
      const radio = (name: string, value: string, label: string, checked: boolean, sub = '') =>
        `<label class="seg"><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}>
          <span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></label>`;
      const online = this.playMode === 'online';
      const rejoin = online ? lastRoom() : null;
      const tableSections = `
          <fieldset class="setup-section"><legend>Turn order (first hand)</legend>
            <div class="segs">
              ${radio('order', 'first', 'Go first', this.order === 'first')}
              ${radio('order', 'second', 'Go second', this.order === 'second')}
              ${radio('order', 'random', 'Random', this.order === 'random', 'coin flip')}
            </div>
          </fieldset>
          <fieldset class="setup-section"><legend>Jokers</legend>
            <div class="segs two">
              ${radio('jokers', '1', '1 Joker', this.jokers === 1, '21 cards')}
              ${radio('jokers', '2', '2 Jokers', this.jokers === 2, '22 cards')}
            </div>
          </fieldset>
          <fieldset class="setup-section"><legend>Discards</legend>
            <div class="segs two">
              ${radio('discards', 'up', 'Face Up', this.discardsUp)}
              ${radio('discards', 'down', 'Face Down', !this.discardsUp)}
            </div>
            <p class="seg-info">Face Up: both players see all discarded cards. Face Down: only counts are shown.</p>
          </fieldset>`;
      const body = online
        ? `<p class="lead">Play a friend in another browser or on another device. The server deals the cards
            and checks every move — nobody can peek.</p>
          <section class="online-block" aria-label="Create a room">
            <h3 class="block-title">Create a room <small>you choose the table</small></h3>
            ${tableSections}
            <fieldset class="setup-section"><legend>Turn timer</legend>
              <div class="segs four">
                ${TURN_SECONDS.filter((t) => t > 0)
                  .map((t) => radio('timer', String(t), `${t} s`, this.turnSeconds === t))
                  .join('')}
                ${radio('timer', '0', 'Off', this.turnSeconds === 0)}
              </div>
              <p class="seg-info">Out of time → automatic DROP. A player away for 60 s forfeits the match.</p>
            </fieldset>
          </section>
          <section class="online-block join-block" aria-label="Join a room">
            <h3 class="block-title">Join a room <small>got a code?</small></h3>
            <div class="join-row">
              <input type="text" id="room-code" name="room-code" class="code-input" value="${escapeHtml(this.joinCode)}"
                maxlength="12" placeholder="CODE" autocomplete="off" autocapitalize="characters" spellcheck="false"
                aria-label="Room code" ${this.onlineError ? 'aria-invalid="true" aria-describedby="online-error"' : ''}>
              <button type="button" class="ghost" data-cmd="join">Join</button>
            </div>
            ${this.onlineError ? `<p class="form-error" id="online-error" role="alert">${this.onlineError}</p>` : ''}
            ${rejoin ? `<p class="rejoin-row">You were in room <b class="code-inline">${rejoin}</b>. <button type="button" class="ghost small" data-cmd="rejoin">Rejoin ${rejoin}</button></p>` : ''}
          </section>`
        : `<p class="lead">Draw poker for two with a 21-card deck (10 to A) and a wild Joker.
          Start with 12 coins — empty the AI's stack to win.</p>
          <fieldset class="setup-section"><legend>Opponent</legend>
            <div class="segs">
              ${radio('difficulty', 'normal', 'Normal', this.difficulty === 'normal')}
              ${radio('difficulty', 'hard', 'Hard', this.difficulty === 'hard')}
              ${radio('difficulty', 'cheater', 'Cheater', this.difficulty === 'cheater')}
            </div>
            <p class="seg-info">${DIFFICULTY_INFO[this.difficulty]}</p>
          </fieldset>
          ${tableSections}`;
      setHtml(o, `
        <div class="dialog setup" role="dialog" aria-modal="true" aria-label="New match">
          <h2 class="setup-title"><span class="logo-star" aria-hidden="true">★</span>${TITLE}</h2>
          <div class="segs two mode-tabs" role="radiogroup" aria-label="Game mode">
            ${radio('mode', 'ai', 'Play vs AI', !online)}
            ${radio('mode', 'online', 'Play Online', online, 'two players')}
          </div>
          ${body}
          <div class="dialog-actions">
            <button type="button" class="ghost" data-cmd="rules">Rules</button>
            ${
              online
                ? '<button type="button" class="primary" data-cmd="create">Create room <kbd>Enter</kbd></button>'
                : '<button type="button" class="primary" data-cmd="start">Deal <kbd>Enter</kbd></button>'
            }
          </div>
        </div>`, 'dialog');
    } else if (this.screen === 'lobby') {
      const s = this.online;
      const r = s?.room;
      const set = r?.settings ?? s?.create;
      const orderText = (st: RoomSettings) =>
        st.order === 'random'
          ? 'coin flip for the first hand'
          : `${r?.seat === 1 ? 'the host goes' : 'you go'} ${st.order} in the first hand`;
      const settingsLine = set
        ? `<p class="room-settings">${plural(set.jokers, 'Joker')} · discards face ${set.discardsFaceUp ? 'up' : 'down'} · ${orderText(set)} · ${set.turnSeconds ? `${set.turnSeconds} s per turn` : 'no turn timer'}</p>`
        : '';
      let content: string;
      if (!r) {
        content = `<p class="lead">${s?.create ? 'Creating' : 'Joining'} room <b class="code-inline">${s?.code ?? ''}</b>…</p>
          <p class="waiting"><span class="dots" aria-hidden="true"></span>Connecting to the server</p>`;
      } else {
        const link = shareLink(r.code);
        content = `<p class="lead">Send your opponent this code or link. The match starts as soon as they join.</p>
          <div class="room-code" aria-label="Room code ${r.code.split('').join(' ')}">${r.code}</div>
          <div class="share-row">
            <input type="text" id="share-link" class="share-link" value="${escapeHtml(link)}" readonly aria-label="Share link">
            <button type="button" class="ghost" data-cmd="copy-link">${this.copied ? 'Copied ✓' : 'Copy link'}</button>
          </div>
          ${settingsLine}
          <p class="waiting"><span class="dots" aria-hidden="true"></span>${s!.link === 'open' ? 'Waiting for an opponent to join…' : 'Reconnecting…'}</p>`;
      }
      setHtml(o, `
        <div class="dialog lobby" role="dialog" aria-modal="true" aria-label="Online room">
          <h2>Online room</h2>
          ${content}
          <div class="dialog-actions"><button type="button" class="ghost" data-cmd="leave">Cancel</button></div>
        </div>`, 'dialog');
    } else if (this.screen === 'flip') {
      const face = this.coinFace!;
      const r = this.online?.room;
      // Online, the server flipped: heads = the host goes first.
      const youFirst = r?.flip ? r.flip.first === r.seat : face === 'heads';
      const lead = !r
        ? 'Heads — you go first. Tails — you go second.'
        : r.seat === 0
          ? 'Heads — you (the host) go first. Tails — your opponent goes first.'
          : 'Heads — the host goes first. Tails — you go first.';
      const oppReady = !!r && r.ready[1 - r.seat];
      const waiting = !!this.online?.waiting;
      setHtml(o, `
        <div class="dialog flip" role="dialog" aria-modal="true" aria-label="Coin flip">
          <h2>Coin flip</h2>
          <p class="lead">${lead}</p>
          <div class="coin3d-wrap"><div class="coin3d ${REDUCED_MOTION || this.flipDone ? 'static' : ''} land-${face}">
            <div class="coin-side heads">H</div><div class="coin-side tails">T</div>
          </div></div>
          <p class="flip-result" aria-live="polite">${
            this.flipDone
              ? `<b>${face === 'heads' ? 'Heads' : 'Tails'}!</b> ${youFirst ? 'You go first.' : `${this.TheOpp} goes first.`}`
              : '&nbsp;'
          }</p>
          ${r && this.flipDone ? `<p class="seg-info ready-line">${!this.oppConnected() ? `${OPP_GONE}<span data-clock="away"></span>` : waiting ? 'Waiting for your opponent to press Play…' : oppReady ? 'Your opponent is ready.' : 'The match starts when both players press Play.'}<span data-clock="auto"></span></p>` : ''}
          <div class="dialog-actions">
            ${r ? '<button type="button" class="ghost" data-cmd="leave">Leave</button>' : ''}
            <button type="button" class="primary" data-cmd="begin" ${this.flipDone && !waiting ? '' : 'disabled'}>${waiting ? 'Waiting…' : 'Play <kbd>Enter</kbd>'}</button>
          </div>
        </div>`, 'dialog');
    } else if (this.screen === 'over') {
      const m = this.match;
      const s = this.online;
      const r = s?.room;
      const ff = r?.status === 'over' ? r.forfeit : null;
      const youWin = ff ? ff.by !== r!.seat : m?.winner === HUMAN;
      const oppSeat = r ? 1 - r.seat : 1;
      const oppReady = !!r && r.ready[oppSeat];
      const oppLeft = !!r && r.left[oppSeat];
      const lead = ff
        ? ff.by === r!.seat
          ? ff.reason === 'left'
            ? 'You left the match, so it counts as a forfeit.'
            : 'You were disconnected for more than 60 seconds — the match was forfeited.'
          : ff.reason === 'left'
            ? 'Your opponent left the match — you win by forfeit.'
            : 'Your opponent was disconnected for more than 60 seconds — you win by forfeit.'
        : youWin
          ? s
            ? 'Your opponent is out of coins.'
            : `The ${this.difficultyName()} AI is out of coins.`
          : 'You are out of coins.';
      const rematchLine = !s
        ? ''
        : oppLeft
          ? 'Your opponent left the room.'
          : !this.oppConnected()
            ? 'Your opponent is not connected — a rematch needs both players.'
            : s.waiting
              ? 'Waiting for your opponent to accept the rematch…'
              : oppReady
                ? 'Your opponent wants a rematch!'
                : 'Rematch with the same settings, or leave the room.';
      setHtml(o, `
        <div class="dialog over ${youWin ? 'win' : 'lose'}" role="dialog" aria-modal="true" aria-label="Game over">
          <h2>${youWin ? 'You win the match!' : `Game over — ${this.theOpp} wins`}</h2>
          <p class="lead">${lead}</p>
          ${m ? `<div class="final-coins"><div><span>You</span><b>${m.coins[HUMAN]}</b></div><div><span>${this.opp}</span><b>${m.coins[AI]}</b></div></div>` : ''}
          <p class="stats">${plural(this.stats.hands, 'hand')} played · you won ${this.stats.won} · ${plural(this.stats.showdowns, 'showdown')}</p>
          ${s ? `<p class="seg-info ready-line">${rematchLine}</p>` : ''}
          <div class="dialog-actions">
            ${s ? '<button type="button" class="ghost" data-cmd="leave">Leave room</button>' : ''}
            <button type="button" class="primary" data-cmd="restart" ${s?.waiting || oppLeft ? 'disabled' : ''}>${s ? (s.waiting ? 'Waiting…' : 'Rematch <kbd>Enter</kbd>') : 'Play again <kbd>Enter</kbd>'}</button>
          </div>
        </div>`, 'dialog');
    }
  }

  private animateCoins(winner: PlayerId, n: number): void {
    this.flyCoins('pot', `coins-${winner}`, n, 300);
  }

  /** Coins flying between two elements (stack → pot for bets, pot → stack for the winner). */
  private flyCoins(fromId: string, toId: string, n: number, delayMs: number): void {
    if (REDUCED_MOTION || n <= 0) return;
    const from = document.getElementById(fromId)?.getBoundingClientRect();
    const to = document.getElementById(toId)?.getBoundingClientRect();
    if (!from || !to) return;
    const count = Math.min(n, 10);
    for (let i = 0; i < count; i++) {
      const c = document.createElement('span');
      c.className = 'flying-coin';
      document.body.appendChild(c);
      const x0 = from.left + from.width / 2 + (Math.random() - 0.5) * 30;
      const y0 = from.top + from.height / 3;
      const x1 = to.left + to.width / 2 + (Math.random() - 0.5) * 20;
      const y1 = to.top + to.height / 2;
      const a = c.animate(
        [
          { transform: `translate(${x0}px, ${y0}px) scale(1)`, opacity: 1 },
          { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - 60}px) scale(1.2)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${x1}px, ${y1}px) scale(0.8)`, opacity: 0.2 },
        ],
        { duration: 600, delay: delayMs + i * 70, easing: 'cubic-bezier(.4,.0,.2,1)', fill: 'both' },
      );
      a.onfinish = () => c.remove();
    }
  }
}

function describeHandSafe(cards: Card[]): string {
  try {
    return describeHand(evaluateHand(cards));
  } catch {
    return '';
  }
}

/** Random permutation of 0..n-1. */
function shuffleIdx(n: number, rng: Rng): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The engine action the buttons produced → the intent the server expects. */
function toIntent(a: Action, cards: Card[]): Intent {
  switch (a.type) {
    case 'drop':
    case 'accept':
      return { action: a.type };
    case 'call':
      return a.to === undefined ? { action: 'call' } : { action: 'call', amount: a.to };
    case 'bet':
      return a.to === undefined ? { action: 'bet', exchange: cards } : { action: 'bet', amount: a.to, exchange: cards };
    case 'raise':
      return { action: 'raise', amount: a.to, exchange: cards };
    case 'exchange':
      throw new Error('exchanges are sent with BET/RAISE');
  }
}

function shareLink(code: string): string {
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('room', code);
  return u.toString();
}

/** Keep ?room=CODE in the address bar while in a room, so a reload rejoins the same seat. */
function setRoomParam(code: string | null): void {
  try {
    const u = new URL(location.href);
    if (code) u.searchParams.set('room', code);
    else u.searchParams.delete('room');
    history.replaceState(null, '', u.toString());
  } catch {
    /* ignore */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
