/**
 * Wire protocol shared by the browser client (src/online) and the room server (server/src).
 *
 * The server is authoritative. Clients only send intents; the server answers every change with a
 * per-player `OnlineView` that never contains hidden information:
 *   - your own hand, never the opponent's (until the hand is over → `reveal`);
 *   - the deck as a count only (no order, no RNG seed);
 *   - the opponent's discarded cards only when discards are face up (otherwise counts only).
 *
 * Seats: the host is seat 0, the guest seat 1. Views carry real seat numbers plus `me`; the
 * client turns them into its own perspective.
 */
import type {
  ActionType,
  Card,
  CoinFace,
  HandOutcome,
  JokerCount,
  LegalActions,
  Phase,
  PlayerId,
  TurnOrderChoice,
} from '../src/engine';

/** URL prefix + party name used by routePartykitRequest (binding `JokerRoom` → `joker-room`). */
export const PARTY_PREFIX = 'parties';
export const PARTY_NAME = 'joker-room';

/** Room codes: 5 characters, no look-alikes (0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isRoomCode(code: string): boolean {
  return ROOM_CODE_RE.test(code);
}

/** Turn timer choices (seconds; 0 = no timer). */
export const TURN_SECONDS = [0, 15, 30, 60] as const;
export type TurnSeconds = (typeof TURN_SECONDS)[number];
export const DEFAULT_TURN_SECONDS: TurnSeconds = 30;
/** A player disconnected this long during a match forfeits it. */
export const FORFEIT_MS = 60_000;
/** Rooms with nobody connected are deleted after this long. */
export const EMPTY_ROOM_MS = 10 * 60_000;
/** With a turn timer, the next hand / the first hand after the coin flip starts by itself after this. */
export const AUTO_CONTINUE_MS = 30_000;
/** Client heartbeat; the server drops connections silent for longer than PING_TIMEOUT_MS. */
export const PING_MS = 4_000;
export const PING_TIMEOUT_MS = 15_000;

/** Host's choices when creating a room. `order` is from the host's point of view. */
export interface RoomSettings {
  jokers: JokerCount;
  discardsFaceUp: boolean;
  order: TurnOrderChoice;
  /** Seconds per turn; a player who runs out DROPs automatically. 0 = no timer. */
  turnSeconds: TurnSeconds;
}

/** Query parameters of the WebSocket URL. */
export interface ConnectQuery {
  /** Player id of this browser tab (sessionStorage): a reload gets the same seat back. */
  pid: string;
  /**
   * Seat tokens this browser holds for the room (localStorage, comma-separated). A token reclaims
   * its seat after the tab was closed — only while no other tab holds that seat.
   */
  tokens?: string;
  /** Present when creating the room: the host's settings. */
  create?: '1';
  jokers?: string;
  discards?: 'up' | 'down';
  order?: TurnOrderChoice;
  timer?: string;
}

// ------------------------------------------------------------------ client → server

/** What a player wants to do. BET/RAISE carry the cards to exchange (empty = stand pat). */
export type Intent =
  | { action: 'drop' }
  | { action: 'bet'; amount?: number; exchange?: Card[] }
  | { action: 'raise'; amount: number; exchange?: Card[] }
  | { action: 'call'; amount?: number }
  | { action: 'accept' };

export type ClientMsg =
  | { type: 'intent'; intent: Intent }
  /** "Next hand" / "Play" after the coin flip / "Rematch" after game over. */
  | { type: 'ready' }
  /** Leave the room for good (during a match this forfeits it). */
  | { type: 'leave' }
  /** Heartbeat; answered with a pong carrying the server clock. */
  | { type: 'ping'; t: number };

// ------------------------------------------------------------------ server → client

export type RoomStatus =
  /** Waiting for the second player. */
  | 'waiting'
  /** Coin flip shown; waiting for both players to press Play. */
  | 'flip'
  | 'playing'
  /** Hand over (both hands revealed); waiting for both players to press Next. */
  | 'handOver'
  /** Match over; both pressing Play again starts a rematch. */
  | 'over';

export interface RoomInfo {
  code: string;
  settings: RoomSettings;
  /** Your seat (0 = host). */
  seat: PlayerId;
  status: RoomStatus;
  /** Whether each seat is taken / currently connected. */
  players: { joined: boolean; connected: boolean }[];
  /** Seats that pressed ready in the current waiting step. */
  ready: [boolean, boolean];
  /** Coin flip of the current match (random order only). */
  flip: { face: CoinFace; first: PlayerId } | null;
  /** Number of the current match in this room (rematches count up). */
  matchNumber: number;
  /** Server clock (ms) when this message was sent. All deadlines below use it. */
  serverNow: number;
  /** When the player to act DROPs automatically (null: no timer, or paused while they are away). */
  turnDeadline: number | null;
  /** When the next hand / the first hand starts by itself (status handOver or flip). */
  autoContinueAt: number | null;
  /** Per seat: when a disconnected player forfeits (null = connected or not in a match). */
  forfeitAt: [number | null, number | null];
  /** Set when a match ended by forfeit. */
  forfeit: { by: PlayerId; reason: 'disconnect' | 'left' } | null;
  /** Seats whose player left the room on purpose. */
  left: [boolean, boolean];
  /** Your secret seat token (store it to reclaim the seat after closing the tab). */
  token: string;
}

/** One public event of the hand. `cards` only for your own exchanges, or all when face up. */
export interface OnlineEvent {
  player: PlayerId;
  phase: Phase;
  type: ActionType;
  /** Resulting total for BET / RAISE / CALL. */
  to?: number;
  /** Cards exchanged (exchange events). */
  count?: number;
  cards?: Card[];
  bets: [number, number];
  deckBefore: number;
}

export interface OnlineView {
  me: PlayerId;
  matchNumber: number;
  handNumber: number;
  jokers: JokerCount;
  discardsFaceUp: boolean;
  /** Coins each player owned when this hand started (before the ante). */
  coinsAtStart: [number, number];
  /** Match winner, once someone is out of coins. */
  matchWinner: PlayerId | null;
  /** Your cards in arrival order (drawn cards take the discarded slots). */
  hand: Card[];
  oppCardCount: number;
  deckCount: number;
  myDiscards: Card[];
  oppDiscardCount: number;
  /** Only when discards are face up. */
  oppDiscards?: Card[];
  bets: [number, number];
  stacks: [number, number];
  cap: number;
  phase: Phase;
  toAct: PlayerId;
  firstToAct: PlayerId;
  caller: PlayerId | null;
  exchangeRounds: number;
  finalTurns: number;
  exchangeInFinal: boolean;
  history: OnlineEvent[];
  /** Your legal actions (all false/null when it is not your turn). */
  legal: LegalActions;
  /** History indexes of DROPs the server made because a turn timer ran out. */
  timeouts: number[];
  /** Only once the hand is over: both hands and the result. */
  reveal?: { hands: [Card[], Card[]]; outcome: HandOutcome };
}

export type ErrorCode = 'not-found' | 'room-full' | 'room-taken' | 'bad-request' | 'illegal' | 'not-your-turn';

export type ServerMsg =
  | { type: 'room'; room: RoomInfo }
  | { type: 'state'; view: OnlineView }
  | { type: 'pong'; t: number; now: number }
  | { type: 'error'; code: ErrorCode; message: string };
