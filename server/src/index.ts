/**
 * Cloudflare Worker entry: routes /parties/joker-room/<CODE> WebSockets to one Durable Object per
 * room. All game logic lives in RoomCore (./core.ts) and the shared engine (../../src/engine).
 *
 * Clocks: RoomCore keeps deadlines (turn timer, forfeit, auto-continue, empty-room expiry); this
 * class sets a Durable Object alarm for the earliest one and calls `tick()` when it fires. While
 * anyone is connected the alarm also runs a heartbeat check: a connection that has not pinged for
 * PING_TIMEOUT_MS (e.g. the network dropped without a close) is treated as disconnected.
 */
import { type Connection, type ConnectionContext, type WSMessage, Server, routePartykitRequest } from 'partyserver';
import { type ConnectQuery, PARTY_PREFIX, PING_TIMEOUT_MS, type ServerMsg, isRoomCode } from '../../shared/protocol';
import { type Outgoing, type RoomData, RoomCore } from './core';

declare global {
  namespace Cloudflare {
    interface Env {
      JokerRoom: DurableObjectNamespace<JokerRoom>;
    }
  }
}
type Env = Cloudflare.Env;

interface ConnState {
  seat: 0 | 1;
}

const STORAGE_KEY = 'room';
const HEARTBEAT_CHECK_MS = 5_000;

export class JokerRoom extends Server<Env> {
  private core!: RoomCore;
  /** Last message time per connection id. */
  private readonly seen = new Map<string, number>();
  /** Connections already counted as gone (heartbeat timeout) — their late onClose is ignored. */
  private readonly dropped = new Set<string>();

  async onStart(): Promise<void> {
    const data = (await this.ctx.storage.get<RoomData>(STORAGE_KEY)) ?? null;
    this.core = new RoomCore(this.name, data);
    this.core.resume([0, 0]);
    await this.schedule();
  }

  async onConnect(conn: Connection<ConnState>, ctx: ConnectionContext): Promise<void> {
    const params = new URL(ctx.request.url).searchParams;
    const q: Partial<ConnectQuery> = Object.fromEntries(params) as Partial<ConnectQuery>;
    const res = this.core.connect(q);
    if ('error' in res) {
      this.dropped.add(conn.id);
      conn.send(JSON.stringify(res.error));
      conn.close(4000, res.error.code);
      return;
    }
    conn.setState({ seat: res.seat });
    this.seen.set(conn.id, Date.now());
    await this.commit(res.out);
  }

  async onMessage(conn: Connection<ConnState>, message: WSMessage): Promise<void> {
    const seat = conn.state?.seat;
    if (seat === undefined || typeof message !== 'string' || this.dropped.has(conn.id)) return;
    this.seen.set(conn.id, Date.now());
    const out = this.core.message(seat, message);
    if (out.length === 1 && out[0].msg.type === 'pong') {
      conn.send(JSON.stringify(out[0].msg)); // heartbeats: answer this connection only, no save
      return;
    }
    await this.commit(out);
    if (!this.core.data) await this.ctx.storage.deleteAll(); // the host cancelled an empty room
  }

  async onClose(conn: Connection<ConnState>): Promise<void> {
    this.seen.delete(conn.id);
    if (this.dropped.delete(conn.id)) return;
    const seat = conn.state?.seat;
    if (seat === undefined || !this.core.data) return;
    await this.commit(this.core.disconnect(seat));
  }

  async onAlarm(): Promise<void> {
    // Heartbeat: connections that went silent count as disconnected.
    const now = Date.now();
    const out: Outgoing[] = [];
    for (const c of this.getConnections<ConnState>()) {
      const last = this.seen.get(c.id);
      if (c.state?.seat === undefined || this.dropped.has(c.id) || last === undefined) continue;
      if (now - last > PING_TIMEOUT_MS) {
        this.dropped.add(c.id);
        this.seen.delete(c.id);
        out.push(...this.core.disconnect(c.state.seat));
        try {
          c.close(4001, 'heartbeat timeout');
        } catch {
          /* already gone */
        }
      }
    }
    const { out: ticked, expired } = this.core.tick();
    if (expired) {
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.commit([...out, ...ticked]);
  }

  /** Save, send, and set the alarm for the next deadline. */
  private async commit(out: Outgoing[]): Promise<void> {
    if (this.core.data) await this.ctx.storage.put(STORAGE_KEY, this.core.data);
    this.flush(out);
    await this.schedule();
  }

  private async schedule(): Promise<void> {
    const wake = this.core.nextWake();
    const anyone = this.seen.size > 0;
    const times = [wake, anyone ? Date.now() + HEARTBEAT_CHECK_MS : null].filter((t): t is number => t !== null);
    if (times.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }

  private flush(out: Outgoing[]): void {
    if (!out.length) return;
    const conns = [...this.getConnections<ConnState>()].filter((c) => !this.dropped.has(c.id));
    for (const { to, msg } of out) {
      const text = JSON.stringify(msg satisfies ServerMsg);
      for (const c of conns) if (c.state?.seat === to) c.send(text);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    const res = await routePartykitRequest(request, env, {
      prefix: PARTY_PREFIX,
      onBeforeConnect: (_req, lobby) => {
        if (!isRoomCode(lobby.name)) return new Response('Invalid room code', { status: 400 });
      },
      onBeforeRequest: () => new Response('WebSocket only', { status: 426 }),
    });
    return res ?? new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
