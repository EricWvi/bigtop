import { ProtocolError, parseServerMessage, type ConnectorMessage, type ServerMessage } from "@bigtop/protocol";

/** What the client needs from a Connector. */
export interface ClientPeer {
  hello(): ConnectorMessage;
  heartbeat(): ConnectorMessage;
  handle(msg: ServerMessage): void;
}

export interface ClientOptions {
  url: string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Messages kept while disconnected; the oldest are dropped beyond this. */
  maxQueue?: number;
  log?: (line: string) => void;
}

/**
 * Keeps a WebSocket open to the server for one peer. Sends `hello` on every
 * connection, queues outgoing messages until the server's `welcome`, heartbeats
 * at the interval the server asks for, and reconnects with backoff.
 */
export class ConnectorClient {
  #options: Required<Omit<ClientOptions, "log">>;
  #log: (line: string) => void;
  #peer: ClientPeer | undefined;
  #ws: WebSocket | undefined;
  #welcomed = false;
  #queue: string[] = [];
  #dropped = 0;
  #heartbeat: NodeJS.Timeout | undefined;
  #reconnect: NodeJS.Timeout | undefined;
  #backoff: number;
  #stopped = false;
  #closed = Promise.withResolvers<void>();

  constructor(options: ClientOptions) {
    this.#options = {
      url: options.url,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      maxQueue: options.maxQueue ?? 10_000,
    };
    this.#backoff = this.#options.minBackoffMs;
    this.#log = options.log ?? (() => {});
  }

  /** Resolves once the client stops for good: `stop()` or a fatal server error. */
  get closed(): Promise<void> {
    return this.#closed.promise;
  }

  start(peer: ClientPeer): void {
    if (this.#peer) throw new Error("client already started");
    this.#peer = peer;
    this.#connect();
  }

  send(msg: ConnectorMessage): void {
    const frame = JSON.stringify(msg);
    if (this.#welcomed && this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(frame);
      return;
    }
    this.#queue.push(frame);
    if (this.#queue.length > this.#options.maxQueue) {
      this.#queue.shift();
      if (this.#dropped++ === 0) this.#log("offline queue full; dropping oldest messages");
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#reconnect);
    clearInterval(this.#heartbeat);
    this.#ws?.close(1000, "connector stopping");
    this.#closed.resolve();
  }

  #connect(): void {
    if (this.#stopped) return;
    const ws = new WebSocket(this.#options.url);
    this.#ws = ws;
    this.#welcomed = false;

    ws.addEventListener("open", () => {
      this.#log(`connected to ${this.#options.url}`);
      ws.send(JSON.stringify(this.#peer!.hello()));
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return this.#log("ignored a binary frame");
      let msg: ServerMessage;
      try {
        msg = parseServerMessage(event.data);
      } catch (err) {
        if (err instanceof ProtocolError) return this.#log(`ignored a malformed message: ${err.message}`);
        throw err;
      }
      this.#receive(ws, msg);
    });

    ws.addEventListener("close", (event) => {
      if (this.#ws !== ws) return;
      clearInterval(this.#heartbeat);
      this.#welcomed = false;
      if (this.#stopped) return;
      const delay = this.#backoff * (0.5 + Math.random() / 2);
      this.#backoff = Math.min(this.#backoff * 2, this.#options.maxBackoffMs);
      this.#log(`disconnected (${event.code}${event.reason ? ` ${event.reason}` : ""}); reconnecting in ${Math.round(delay)} ms`);
      this.#reconnect = setTimeout(() => this.#connect(), delay);
    });

    // A failed connection also emits "close", which schedules the retry.
    ws.addEventListener("error", () => {});
  }

  #receive(ws: WebSocket, msg: ServerMessage): void {
    if (msg.type === "welcome") {
      this.#welcomed = true;
      this.#backoff = this.#options.minBackoffMs;
      clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.send(this.#peer!.heartbeat()), msg.heartbeatMs);
      if (this.#dropped) this.#log(`dropped ${this.#dropped} messages while offline`);
      this.#dropped = 0;
      for (const frame of this.#queue.splice(0)) ws.send(frame);
      return;
    }
    if (msg.type === "error") {
      this.#log(`server error: ${msg.message}`);
      if (msg.fatal) this.stop();
      return;
    }
    this.#peer!.handle(msg);
  }
}
