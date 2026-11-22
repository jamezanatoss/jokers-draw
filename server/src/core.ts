/**
 * Room logic, independent of the Durable Object runtime (so it can be unit-tested in Node with a
 * fake clock).
 *
 * One RoomCore per room. It owns the match (the shared engine in src/engine does all the rules),
 * deals with real randomness, validates every intent, runs every clock (turn timer, disconnect
 * forfeit, auto-continue, empty-room expiry) and produces per-player messages built by `viewFor`,
 * which is the single place that decides what a player may see.
 *
 * Clocks are deadlines stored in RoomData. The host runtime calls `tick()` when `nextWake()` is
 * due (a Durable Object alarm); nothing depends on any client being awake.
 */
import {
  type Action,
  type Card,
  type HandState,
  type MatchState,
  type PlayerId,
  type Rng,
  IllegalActionError,
  STARTING_COINS,
  coinFlip,
  isLegal,
  legalActions,
  matchAct,
  mulberry32,
  newMatch,
  other,
  randomSeed,
  startHand,
} from '../../src/engine';
import {
  AUTO_CONTINUE_MS,
  type ClientMsg,
  type ConnectQuery,
  DEFAULT_TURN_SECONDS,
  EMPTY_ROOM_MS,
  type ErrorCode,
  FORFEIT_MS,
  type Intent,
  type OnlineEvent,
  type OnlineView,
  type RoomInfo,
  type RoomSettings,
  type RoomStatus,
  type ServerMsg,
  TURN_SECONDS,
  type TurnSeconds,
} from '../../shared/protocol';

/**
 * Time the clients need to show a move before the next player can act (card swipes, discards
 * flying). The turn clock starts after it, so animations never eat into anyone's turn.
 */
export const GRACE_MS = { deal: 1600, exchange: 2000, action: 500, resume: 1000 } as const;

/** Everything persisted for a room (JSON-serialisable). */
export interface RoomData {
  code: string;
  settings: RoomSettings;
  /** Player id (browser tab) holding each seat (seat 0 = host). */
  seats: [string | null, string | null];
  /** Secret seat tokens; a token reclaims its seat when no tab holds it. */
  tokens: [string | null, string | null];
  status: RoomStatus;
  ready: [boolean, boolean];
  flip: RoomInfo['flip'];
  matchNumber: number;
  match: MatchState | null;
  turnDeadline: number | null;
  autoContinueAt: number | null;
  /** When each seat lost its last connection (null = connected). */
  awaySince: [number | null, number | null];
  /** When the room became empty (nobody connected). */
  emptySince: number | null;
  forfeit: RoomInfo['forfeit'];
  left: [boolean, boolean];
  /** History indexes (current hand) of DROPs caused by the turn timer. */
  timeouts: number[];
}

export interface Outgoing {
  to: PlayerId;
  msg: ServerMsg;
}

export interface CoreOptions {
  /** Fresh randomness for a deal / coin flip. Default: crypto-seeded mulberry32. */
  rng?: () => Rng;
  /** Fix the deck of a hand (tests only). */
  deckFor?: (matchNumber: number, handNumber: number) => readonly Card[] | undefined;
  /** Clock (ms). Default Date.now. */
  now?: () => number;
  /** Seat token generator. */
  token?: () => string;
}

export type ConnectResult = { seat: PlayerId; out: Outgoing[] } | { error: ServerMsg & { type: 'error' } };

const err = (code: ErrorCode, message: string): ServerMsg & { type: 'error' } => ({ type: 'error', code, message });

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const SEATS: PlayerId[] = [0, 1];

function defaultToken(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Settings from the connect query, or null if they are invalid. */
export function parseSettings(q: Partial<ConnectQuery>): RoomSettings | null {
  const jokers = q.jokers === '2' ? 2 : q.jokers === '1' || q.jokers === undefined ? 1 : null;
  const discards = q.discards ?? 'up';
  const order = q.order ?? 'random';
  const timer = q.timer === undefined ? DEFAULT_TURN_SECONDS : Number(q.timer);
  if (jokers === null || (discards !== 'up' && discards !== 'down')) return null;
  if (order !== 'first' && order !== 'second' && order !== 'random') return null;
  if (!(TURN_SECONDS as readonly number[]).includes(timer)) return null;
  return { jokers, discardsFaceUp: discards === 'up', order, turnSeconds: timer as TurnSeconds };
}

/**
 * Turn an untrusted message into a ClientMsg, or an error string. Only the documented fields are
 * read; card ids must be integers.
 */
export function parseClientMsg(raw: unknown): ClientMsg | string {
  let m: unknown = raw;
  if (typeof raw === 'string') {
    try {
      m = JSON.parse(raw);
    } catch {
      return 'Message is not valid JSON';
    }
  }
  if (!m || typeof m !== 'object') return 'Message must be an object';
  const o = m as Record<string, unknown>;
  if (o.type === 'ready') return { type: 'ready' };
  if (o.type === 'leave') return { type: 'leave' };
  if (o.type === 'ping') return { type: 'ping', t: typeof o.t === 'number' && Number.isFinite(o.t) ? o.t : 0 };
  if (o.type !== 'intent') return 'Unknown message type';
  const i = o.intent as Record<string, unknown> | undefined;
  if (!i || typeof i !== 'object') return 'Missing intent';
  const amount = i.amount;
  if (amount !== undefined && !isInt(amount)) return 'Amount must be a whole number';
  const ex = i.exchange;
  if (ex !== undefined && (!Array.isArray(ex) || !ex.every(isInt) || ex.length > 5)) {
    return 'Exchange must be a list of up to 5 card ids';
  }
  switch (i.action) {
    case 'drop':
    case 'accept':
      if (amount !== undefined || ex !== undefined) return `${String(i.action).toUpperCase()} takes no amount or cards`;
      return { type: 'intent', intent: { action: i.action } };
    case 'call':
      if (ex !== undefined) return 'CALL cannot exchange cards — exchanges end with a CALL';
      return { type: 'intent', intent: amount === undefined ? { action: 'call' } : { action: 'call', amount } };
    case 'bet': {
      const intent: Intent = { action: 'bet' };
      if (amount !== undefined) intent.amount = amount;
      if (ex !== undefined) intent.exchange = ex as Card[];
      return { type: 'intent', intent };
    }
    case 'raise': {
      if (amount === undefined) return 'RAISE needs an amount';
      const intent: Intent = { action: 'raise', amount };
      if (ex !== undefined) intent.exchange = ex as Card[];
      return { type: 'intent', intent };
    }
    default:
      return 'Unknown action';
  }
}

/** The per-player view. Hidden information (opponent cards, deck order, seed) never leaves here. */
export function viewFor(
  m: MatchState,
  matchNumber: number,
  me: PlayerId,
  playing: boolean,
  timeouts: readonly number[] = [],
): OnlineView {
  const s = m.hand!;
  const opp = other(me);
  const up = s.discardsFaceUp;
  const over = s.phase === 'over';
  const history: OnlineEvent[] = s.history.map((e) => {
    const v: OnlineEvent = {
      player: e.player,
      phase: e.phase,
      type: e.action.type,
      bets: [e.bets[0], e.bets[1]],
      deckBefore: e.deckBefore,
    };
    if (e.action.type === 'raise' || e.action.type === 'bet' || e.action.type === 'call') v.to = e.action.to;
    if (e.action.type === 'exchange') {
      v.count = e.action.cards.length;
      if (e.player === me || up) v.cards = [...e.action.cards];
    }
    return v;
  });
  const view: OnlineView = {
    me,
    matchNumber,
    handNumber: m.handNumber,
    jokers: s.jokers,
    discardsFaceUp: up,
    coinsAtStart: [s.stacks[0] + s.bets[0], s.stacks[1] + s.bets[1]],
    matchWinner: m.winner,
    hand: [...s.hands[me]],
    oppCardCount: s.hands[opp].length,
    deckCount: s.deck.length,
    myDiscards: [...s.discards[me]],
    oppDiscardCount: s.discards[opp].length,
    bets: [s.bets[0], s.bets[1]],
    stacks: [s.stacks[0], s.stacks[1]],
    cap: s.cap,
    phase: s.phase,
    toAct: s.toAct,
    firstToAct: s.firstToAct,
    caller: s.caller,
    exchangeRounds: s.exchangeRounds,
    finalTurns: s.finalTurns,
    exchangeInFinal: s.exchangeInFinal,
    history,
    legal: playing && !over && s.toAct === me ? legalActions(s) : legalActions({ ...s, phase: 'over' }),
    timeouts: [...timeouts],
  };
  if (up) view.oppDiscards = [...s.discards[opp]];
  if (over) view.reveal = { hands: [[...s.hands[0]], [...s.hands[1]]], outcome: structuredClone(s.outcome!) };
  return view;
}

export class RoomCore {
  data: RoomData | null;
  /** Live connections per seat (not persisted: the runtime recounts them after a restart). */
  readonly connections: [number, number] = [0, 0];
  private readonly rng: () => Rng;
  private readonly deckFor?: CoreOptions['deckFor'];
  readonly now: () => number;
  private readonly newToken: () => string;

  constructor(
    readonly code: string,
    data: RoomData | null = null,
    opts: CoreOptions = {},
  ) {
    this.data = data;
    this.rng = opts.rng ?? (() => mulberry32(randomSeed()));
    this.deckFor = opts.deckFor;
    this.now = opts.now ?? Date.now;
    this.newToken = opts.token ?? defaultToken;
  }

  /**
   * After a restart nobody is connected yet: every seat counts as away from now (players get
   * the full forfeit time to reconnect) and the turn clock waits for the player to act.
   */
  resume(connected: [number, number] = [0, 0]): void {
    const d = this.data;
    this.connections[0] = connected[0];
    this.connections[1] = connected[1];
    if (!d) return;
    const now = this.now();
    for (const p of SEATS) {
      if (this.connections[p] > 0) d.awaySince[p] = null;
      else if (d.seats[p] !== null && d.awaySince[p] === null) d.awaySince[p] = now;
    }
    if (this.connections[0] + this.connections[1] === 0) d.emptySince ??= now;
    this.armTurn(GRACE_MS.resume);
  }

  // ------------------------------------------------------------------ connections

  connect(q: Partial<ConnectQuery>): ConnectResult {
    const pid = typeof q.pid === 'string' && q.pid.length >= 8 && q.pid.length <= 64 ? q.pid : null;
    if (!pid) return { error: err('bad-request', 'Missing player id') };
    const d = this.data;
    // 1. Same tab (reload / network drop): its seat.
    const known = d ? d.seats.indexOf(pid) : -1;
    if (known >= 0) return this.attach(known as PlayerId);
    // 2. A seat token from this browser, for a seat no tab holds right now (the tab was closed).
    if (d) {
      const tokens = (typeof q.tokens === 'string' ? q.tokens.split(',') : []).filter((t) => t.length >= 16).slice(0, 8);
      for (const p of SEATS) {
        if (d.tokens[p] && tokens.includes(d.tokens[p]!) && this.connections[p] === 0) {
          d.seats[p] = pid;
          return this.attach(p);
        }
      }
    }
    if (q.create === '1') {
      if (d) return { error: err('room-taken', 'That room code is already in use') };
      const settings = parseSettings(q);
      if (!settings) return { error: err('bad-request', 'Invalid room settings') };
      this.data = {
        code: this.code,
        settings,
        seats: [pid, null],
        tokens: [this.newToken(), null],
        status: 'waiting',
        ready: [false, false],
        flip: null,
        matchNumber: 0,
        match: null,
        turnDeadline: null,
        autoContinueAt: null,
        awaySince: [null, null],
        emptySince: null,
        forfeit: null,
        left: [false, false],
        timeouts: [],
      };
      return this.attach(0);
    }
    if (!d) return { error: err('not-found', `No room with code ${this.code}`) };
    if (d.seats[1] !== null) return { error: err('room-full', 'Room is full — this room already has two players') };
    d.seats[1] = pid;
    d.tokens[1] = this.newToken();
    this.connections[1]++;
    d.emptySince = null;
    this.startMatch(); // both players are here
    return { seat: 1, out: this.snapshot() };
  }

  private attach(seat: PlayerId): ConnectResult {
    const d = this.data!;
    this.connections[seat]++;
    d.awaySince[seat] = null;
    d.left[seat] = false;
    d.emptySince = null;
    // A returning player to act gets a fresh turn (their clock was paused while away).
    if (d.status === 'playing' && d.turnDeadline === null) this.armTurn(GRACE_MS.resume);
    return { seat, out: this.snapshot() };
  }

  disconnect(seat: PlayerId): Outgoing[] {
    const d = this.data;
    this.connections[seat] = Math.max(0, this.connections[seat] - 1);
    if (!d) return [];
    const now = this.now();
    if (this.connections[seat] === 0) {
      d.awaySince[seat] = now;
      // The clock of an absent player stops; the forfeit countdown runs instead.
      if (d.status === 'playing' && d.match?.hand?.toAct === seat) d.turnDeadline = null;
    }
    if (this.connections[0] + this.connections[1] === 0) d.emptySince = now;
    return this.roomMessages();
  }

  // ------------------------------------------------------------------ messages

  message(seat: PlayerId, raw: unknown): Outgoing[] {
    const d = this.data;
    if (!d) return [{ to: seat, msg: err('not-found', 'Room not found') }];
    const parsed = parseClientMsg(raw);
    if (typeof parsed === 'string') return [{ to: seat, msg: err('bad-request', parsed) }];
    switch (parsed.type) {
      case 'ping':
        return [{ to: seat, msg: { type: 'pong', t: parsed.t, now: this.now() } }];
      case 'ready':
        return this.ready(seat);
      case 'leave':
        return this.leave(seat);
      case 'intent':
        return this.act(seat, parsed.intent);
    }
  }

  private ready(seat: PlayerId): Outgoing[] {
    const d = this.data!;
    if (d.status !== 'flip' && d.status !== 'handOver' && d.status !== 'over') {
      return [{ to: seat, msg: err('bad-request', 'Nothing to get ready for') }];
    }
    d.ready[seat] = true;
    if (!(d.ready[0] && d.ready[1])) return this.roomMessages();
    this.continueNow();
    return this.snapshot();
  }

  /** Both are ready (or the auto-continue clock ran out): next step. */
  private continueNow(): void {
    const d = this.data!;
    d.ready = [false, false];
    if (d.status === 'over') this.startMatch();
    else this.deal();
  }

  private leave(seat: PlayerId): Outgoing[] {
    const d = this.data!;
    d.left[seat] = true;
    d.ready[seat] = false;
    if (d.status === 'waiting') {
      // The host gave up before anyone joined: the room is gone.
      this.data = null;
      return [];
    }
    if (d.status === 'flip' || d.status === 'playing' || d.status === 'handOver') this.endByForfeit(seat, 'left');
    return this.snapshot();
  }

  private act(seat: PlayerId, intent: Intent): Outgoing[] {
    const d = this.data!;
    const m = d.match;
    const h = m?.hand;
    if (d.status !== 'playing' || !m || !h || h.phase === 'over') {
      return [{ to: seat, msg: err('not-your-turn', 'No hand is being played') }];
    }
    if (h.toAct !== seat) return [{ to: seat, msg: err('not-your-turn', 'It is not your turn') }];
    const result = applyIntent(m, intent);
    if (typeof result === 'string') return [{ to: seat, msg: err('illegal', result) }];
    const exchanged = (intent.action === 'bet' || intent.action === 'raise') && (intent.exchange?.length ?? 0) > 0;
    this.afterMove(result, exchanged ? GRACE_MS.exchange : GRACE_MS.action);
    return this.snapshot();
  }

  private afterMove(next: MatchState, grace: number): void {
    const d = this.data!;
    d.match = next;
    if (next.hand!.phase === 'over') {
      d.status = next.winner !== null ? 'over' : 'handOver';
      d.ready = [false, false];
      d.turnDeadline = null;
      d.autoContinueAt = d.status === 'handOver' && d.settings.turnSeconds > 0 ? this.now() + AUTO_CONTINUE_MS : null;
    } else this.armTurn(grace);
  }

  // ------------------------------------------------------------------ clocks

  /** Start the turn clock of the player to act (paused while that player is away). */
  private armTurn(grace: number): void {
    const d = this.data!;
    const h = d.match?.hand;
    const secs = d.settings.turnSeconds;
    if (d.status !== 'playing' || !h || h.phase === 'over' || secs <= 0 || this.connections[h.toAct] === 0) {
      d.turnDeadline = null;
      return;
    }
    d.turnDeadline = this.now() + grace + secs * 1000;
  }

  /** The earliest moment `tick` has something to do, or null. */
  nextWake(): number | null {
    const d = this.data;
    if (!d) return null;
    const times: number[] = [];
    if (d.status === 'playing' && d.turnDeadline !== null) times.push(d.turnDeadline);
    if ((d.status === 'handOver' || d.status === 'flip') && d.autoContinueAt !== null) times.push(d.autoContinueAt);
    if (this.inMatch()) {
      for (const p of SEATS) {
        const other_ = other(p);
        if (d.awaySince[p] !== null && this.connections[other_] > 0) times.push(d.awaySince[p]! + FORFEIT_MS);
      }
    }
    if (d.emptySince !== null) times.push(d.emptySince + EMPTY_ROOM_MS);
    return times.length ? Math.min(...times) : null;
  }

  /** Run every clock that is due. `expired` = the room was deleted. */
  tick(): { out: Outgoing[]; expired: boolean } {
    const d = this.data;
    if (!d) return { out: [], expired: false };
    const now = this.now();
    if (d.emptySince !== null && now >= d.emptySince + EMPTY_ROOM_MS && this.connections[0] + this.connections[1] === 0) {
      this.data = null;
      return { out: [], expired: true };
    }
    let changed = false;
    // Forfeit: away for too long while the opponent is still here.
    if (this.inMatch()) {
      for (const p of SEATS) {
        const since = d.awaySince[p];
        if (since !== null && now >= since + FORFEIT_MS && this.connections[other(p)] > 0) {
          this.endByForfeit(p, 'disconnect');
          changed = true;
          break;
        }
      }
    }
    // Turn timer: automatic DROP.
    const h = d.match?.hand;
    if (d.status === 'playing' && h && h.phase !== 'over' && d.turnDeadline !== null && now >= d.turnDeadline) {
      const result = applyIntent(d.match!, { action: 'drop' });
      if (typeof result !== 'string') {
        d.timeouts.push(h.history.length);
        this.afterMove(result, GRACE_MS.action);
        changed = true;
      }
    }
    // Next hand / first hand starts by itself.
    if ((d.status === 'handOver' || d.status === 'flip') && d.autoContinueAt !== null && now >= d.autoContinueAt) {
      this.continueNow();
      changed = true;
    }
    return { out: changed ? this.snapshot() : [], expired: false };
  }

  private inMatch(): boolean {
    const s = this.data?.status;
    return s === 'flip' || s === 'playing' || s === 'handOver';
  }

  private endByForfeit(seat: PlayerId, reason: 'disconnect' | 'left'): void {
    const d = this.data!;
    d.forfeit = { by: seat, reason };
    d.status = 'over';
    d.ready = [false, false];
    d.turnDeadline = null;
    d.autoContinueAt = null;
    if (d.match) d.match = { ...d.match, winner: other(seat) };
  }

  // ------------------------------------------------------------------ match flow

  private startMatch(): void {
    const d = this.data!;
    d.matchNumber++;
    d.ready = [false, false];
    d.forfeit = null;
    d.timeouts = [];
    const o = d.settings.order;
    if (o === 'random') {
      const face = coinFlip(this.rng());
      // Heads: the host goes first.
      d.flip = { face, first: face === 'heads' ? 0 : 1 };
      d.match = newMatch(d.flip.first, STARTING_COINS, d.settings.jokers, d.settings.discardsFaceUp);
      d.status = 'flip';
      d.turnDeadline = null;
      d.autoContinueAt = d.settings.turnSeconds > 0 ? this.now() + AUTO_CONTINUE_MS : null;
      return;
    }
    d.flip = null;
    d.match = newMatch(o === 'first' ? 0 : 1, STARTING_COINS, d.settings.jokers, d.settings.discardsFaceUp);
    this.deal();
  }

  private deal(): void {
    const d = this.data!;
    const m = d.match!;
    d.match = startHand(m, this.rng(), this.deckFor?.(d.matchNumber, m.handNumber + 1));
    d.status = 'playing';
    d.timeouts = [];
    d.autoContinueAt = null;
    this.armTurn(GRACE_MS.deal);
  }

  // ------------------------------------------------------------------ output

  roomInfo(seat: PlayerId): RoomInfo {
    const d = this.data!;
    const inMatch = this.inMatch();
    return {
      code: d.code,
      settings: { ...d.settings },
      seat,
      status: d.status,
      players: SEATS.map((p) => ({ joined: d.seats[p] !== null, connected: this.connections[p] > 0 })),
      ready: [d.ready[0], d.ready[1]],
      flip: d.flip ? { ...d.flip } : null,
      matchNumber: d.matchNumber,
      serverNow: this.now(),
      turnDeadline: d.status === 'playing' ? d.turnDeadline : null,
      autoContinueAt: d.status === 'handOver' || d.status === 'flip' ? d.autoContinueAt : null,
      forfeitAt: [
        inMatch && d.awaySince[0] !== null ? d.awaySince[0] + FORFEIT_MS : null,
        inMatch && d.awaySince[1] !== null ? d.awaySince[1] + FORFEIT_MS : null,
      ],
      forfeit: d.forfeit ? { ...d.forfeit } : null,
      left: [d.left[0], d.left[1]],
      token: d.tokens[seat] ?? '',
    };
  }

  private roomMessages(): Outgoing[] {
    if (!this.data) return [];
    return SEATS.map((p) => ({ to: p, msg: { type: 'room', room: this.roomInfo(p) } }));
  }

  /** Room info + the current view, for both seats. */
  snapshot(): Outgoing[] {
    const out = this.roomMessages();
    const d = this.data;
    if (d?.match?.hand) {
      for (const p of SEATS) {
        out.push({
          to: p,
          msg: { type: 'state', view: viewFor(d.match, d.matchNumber, p, d.status === 'playing', d.timeouts) },
        });
      }
    }
    return out;
  }
}

/** Apply an intent atomically (BET/RAISE and their exchange together). Returns an error text if illegal. */
export function applyIntent(m: MatchState, intent: Intent): MatchState | string {
  const h = m.hand!;
  let action: Action;
  switch (intent.action) {
    case 'drop':
      action = { type: 'drop' };
      break;
    case 'accept':
      action = { type: 'accept' };
      break;
    case 'call':
      action = intent.amount === undefined ? { type: 'call' } : { type: 'call', to: intent.amount };
      break;
    case 'bet':
      action = intent.amount === undefined ? { type: 'bet' } : { type: 'bet', to: intent.amount };
      break;
    case 'raise':
      action = { type: 'raise', to: intent.amount };
      break;
  }
  if (!isLegal(h, action)) return illegalReason(h, action);
  const exchange = intent.action === 'bet' || intent.action === 'raise' ? (intent.exchange ?? []) : [];
  try {
    let next = matchAct(m, action);
    if (next.hand!.phase === 'exchange') {
      const ex: Action = { type: 'exchange', cards: exchange };
      if (!isLegal(next.hand!, ex)) return exchangeReason(next.hand!, exchange);
      next = matchAct(next, ex);
    }
    return next;
  } catch (e) {
    if (e instanceof IllegalActionError) return e.message;
    throw e;
  }
}

function illegalReason(h: HandState, a: Action): string {
  const l = legalActions(h);
  const name = a.type.toUpperCase();
  const range = a.type === 'bet' ? l.bet : a.type === 'raise' ? l.raise : a.type === 'call' ? l.call : null;
  if (a.type === 'accept') return 'There is no CALL to accept';
  if (a.type === 'drop') return 'You cannot DROP now';
  if (!range) {
    if (h.phase === 'callResponse') return `A CALL is pending: only ACCEPT or DROP`;
    if (a.type === 'bet' && l.first) return 'No BET on the first action of a hand: RAISE, CALL or DROP';
    if (h.phase === 'final') return `Final round: only BET ${h.cap} or DROP`;
    return `${name} is not possible now`;
  }
  return `${name} must be between ${range.min} and ${range.max}`;
}

function exchangeReason(h: HandState, cards: readonly Card[]): string {
  const max = Math.min(5, h.deck.length);
  if (cards.length > max) return `You can exchange at most ${max} card${max === 1 ? '' : 's'} now`;
  if (new Set(cards).size !== cards.length) return 'The same card is listed twice';
  return 'You can only exchange cards from your own hand';
}
