import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { ProtocolError, parseDecision, type Envelope } from "@bigtop/protocol";
import type { Hub } from "./hub.ts";

export interface HttpOptions {
  /** Bearer token for the HTTP API. Connectors authenticate with their own token in `hello`. */
  adminToken: string;
  log?: (line: string) => void;
}

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_BODY = 64 * 1024;
const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * One port for everything:
 *   GET  /connect          WebSocket for connectors
 *   GET  /state            current connectors, dispatches, approvals and tasks
 *   GET  /events?after=N   server-sent events: the log after N, then live
 *   POST /approvals/:id    decide a pending approval: {"behavior":"allow"} or {"behavior":"deny","message":"…"}
 */
export function createHttpServer(hub: Hub, options: HttpOptions): Server {
  const log = options.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  const server = createServer((req, res) => {
    route(hub, options.adminToken, req, res).catch((err) => {
      log(`HTTP ${req.method} ${req.url} failed: ${(err as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/connect") {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const handle = hub.connect({
        send: (msg) => ws.send(JSON.stringify(msg)),
        close: (code, reason) => ws.close(code, reason),
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return ws.send(JSON.stringify({ type: "error", message: "binary frames are not supported" }));
        handle.receive(String(data));
      });
      ws.on("close", () => handle.closed());
      ws.on("error", (err) => log(`connector socket error: ${err.message}`));
    });
  });

  server.on("close", () => wss.close());
  return server;
}

async function route(hub: Hub, adminToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  if (!authorized(req, adminToken)) return json(res, 401, { error: "missing or wrong bearer token" });

  if (req.method === "GET" && url.pathname === "/state") return json(res, 200, hub.state());

  if (req.method === "GET" && url.pathname === "/events") {
    const after = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0) || 0;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const write = (e: Envelope) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    hub.events.since(after).forEach(write);
    const unsubscribe = hub.events.subscribe(write);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      unsubscribe();
      clearInterval(keepAlive);
    });
    return;
  }

  const approval = /^\/approvals\/([^/]+)$/.exec(url.pathname);
  if (req.method === "POST" && approval) {
    let decision;
    try {
      decision = parseDecision(JSON.parse(await body(req)));
    } catch (err) {
      const message = err instanceof ProtocolError || err instanceof SyntaxError ? err.message : "bad request";
      return json(res, 400, { error: message });
    }
    const decided = hub.decide(decodeURIComponent(approval[1]!), decision, { kind: "human", id: "admin" });
    return decided ? json(res, 200, { ok: true }) : json(res, 404, { error: "no such pending approval" });
  }

  json(res, 404, { error: "not found" });
}

function authorized(req: IncomingMessage, adminToken: string): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return token !== "" && timingSafeEqual(digest(token), digest(adminToken));
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ProtocolError("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
