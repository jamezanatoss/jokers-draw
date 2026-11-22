/**
 * Browser side of an online room: one auto-reconnecting PartySocket per room, a heartbeat that
 * measures the ping and the server clock, and the identities that get a player their seat back.
 *
 * Identity:
 *   - player id (sessionStorage, per tab): a reload keeps the seat; two windows of one browser
 *     are two players;
 *   - seat tokens (localStorage, per room): a tab that was closed reclaims its seat — the server
 *     only accepts a token while no other tab holds that seat.
 */
import { PartySocket } from 'partysocket';
import {
  type ClientMsg,
  type ConnectQuery,
  PARTY_NAME,
  PARTY_PREFIX,
  PING_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type RoomSettings,
  type ServerMsg,
} from '../../shared/protocol';

export type LinkStatus = 'connecting' | 'open' | 'closed';

export interface NetStats {
  status: LinkStatus;
  /** Round trip of the last heartbeat (ms), null before the first one. */
  rtt: number | null;
  /** serverClock ≈ Date.now() + offset. */
  offset: number;
}

export interface ConnectionHandlers {
  message: (m: ServerMsg) => void;
  status: (s: LinkStatus) => void;
  net?: (n: NetStats) => void;
}

/** No pong for this long → the socket is considered dead and is reopened. */
const STALE_MS = 10_000;

function randomToken(len: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function randomRoomCode(): string {
  return randomToken(ROOM_CODE_LENGTH, ROOM_CODE_ALPHABET);
}

/** Player id of this tab for a room (sessionStorage). */
export function playerId(code: string): string {
  const key = `jokers-draw:pid:${code}`;
  try {
    const old = sessionStorage.getItem(key);
    if (old) return old;
    const pid = randomToken(20, 'abcdefghijklmnopqrstuvwxyz0123456789');
    sessionStorage.setItem(key, pid);
    return pid;
  } catch {
    return randomToken(20, 'abcdefghijklmnopqrstuvwxyz0123456789');
  }
}

const tokensKey = (code: string) => `jokers-draw:tokens:${code}`;
const LAST_ROOM_KEY = 'jokers-draw:lastRoom';

/** Seat tokens this browser holds for a room (both seats when two windows played here). */
export function seatTokens(code: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(tokensKey(code)) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string').slice(-4) : [];
  } catch {
    return [];
  }
}

export function rememberSeat(code: string, token: string): void {
  if (!token) return;
  try {
    const list = seatTokens(code).filter((t) => t !== token);
    list.push(token);
    localStorage.setItem(tokensKey(code), JSON.stringify(list.slice(-4)));
    localStorage.setItem(LAST_ROOM_KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

/** Forget a room on purpose (Leave): no "Rejoin" offer, no token. */
export function forgetRoom(code: string): void {
  try {
    localStorage.removeItem(tokensKey(code));
    const last = lastRoom();
    if (last === code) localStorage.removeItem(LAST_ROOM_KEY);
    sessionStorage.removeItem(`jokers-draw:pid:${code}`);
  } catch {
    /* ignore */
  }
}

/** The room this browser was last seated in (within the last hour), for a "Rejoin" button. */
export function lastRoom(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_ROOM_KEY) ?? 'null') as { code?: string; at?: number } | null;
    if (!v?.code || !v.at || Date.now() - v.at > 60 * 60_000) return null;
    return v.code;
  } catch {
    return null;
  }
}

/**
 * The room server: VITE_PARTY_URL if the build sets it (page and rooms on different hosts),
 * otherwise this page's own origin.
 */
export function partyServer(): { host: string; protocol: 'ws' | 'wss' } {
  const configured = import.meta.env.VITE_PARTY_URL;
  const url = configured ? new URL(configured) : new URL(location.href);
  return { host: url.host, protocol: url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss' : 'ws' };
}

export class OnlineConnection {
  private readonly ws: PartySocket;
  private closed = false;
  private pingTimer = 0;
  private lastPong = 0;
  readonly net: NetStats = { status: 'connecting', rtt: null, offset: 0 };

  constructor(
    readonly code: string,
    create: RoomSettings | null,
    private readonly handlers: ConnectionHandlers,
  ) {
    const pid = playerId(code);
    const server = partyServer();
    this.ws = new PartySocket({
      host: server.host,
      protocol: server.protocol,
      prefix: PARTY_PREFIX,
      party: PARTY_NAME,
      room: code,
      // Built on every (re)connect, so a token received meanwhile is sent too.
      query: () => {
        const q: ConnectQuery = { pid };
        const tokens = seatTokens(code);
        if (tokens.length) q.tokens = tokens.join(',');
        if (create) {
          q.create = '1';
          q.jokers = String(create.jokers);
          q.discards = create.discardsFaceUp ? 'up' : 'down';
          q.order = create.order;
          q.timer = String(create.turnSeconds);
        }
        return { ...q };
      },
      maxRetries: Infinity,
      minReconnectionDelay: 500,
      maxReconnectionDelay: 4000,
    });
    this.ws.addEventListener('open', () => {
      if (this.closed) return;
      this.lastPong = performance.now();
      this.setStatus('open');
      this.ping();
    });
    this.ws.addEventListener('close', () => !this.closed && this.setStatus('connecting'));
    this.ws.addEventListener('message', (e: MessageEvent) => {
      if (this.closed || typeof e.data !== 'string') return;
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data) as ServerMsg;
      } catch {
        return;
      }
      if (m.type === 'pong') this.onPong(m);
      else handlers.message(m);
    });
    this.pingTimer = window.setInterval(() => this.heartbeat(), PING_MS);
  }

  private setStatus(s: LinkStatus): void {
    this.net.status = s;
    this.handlers.status(s);
    this.handlers.net?.(this.net);
  }

  private ping(): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping', t: performance.now() } satisfies ClientMsg));
  }

  private heartbeat(): void {
    if (this.closed) return;
    // A connection that stopped answering (network gone without a close) is reopened.
    if (this.ws.readyState === WebSocket.OPEN && performance.now() - this.lastPong > STALE_MS) {
      this.setStatus('connecting');
      this.ws.reconnect();
      return;
    }
    this.ping();
  }

  private onPong(m: { t: number; now: number }): void {
    const now = performance.now();
    this.lastPong = now;
    const rtt = Math.max(0, now - m.t);
    this.net.rtt = Math.round(rtt);
    this.net.offset = m.now + rtt / 2 - Date.now();
    this.handlers.net?.(this.net);
  }

  /** Estimated server clock. */
  serverNow(): number {
    return Date.now() + this.net.offset;
  }

  send(m: ClientMsg): void {
    if (!this.closed) this.ws.send(JSON.stringify(m)); // queued while reconnecting
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.pingTimer);
    this.ws.close();
  }
}
