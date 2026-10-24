import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { ConnectorMessage, ServerMessage } from "@bigtop/protocol";
import { ConnectorClient, type ClientPeer } from "./client.ts";

interface Received {
  socket: ServerSocket;
  messages: ConnectorMessage[];
}

async function server() {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const connections: Received[] = [];
  const waiters: (() => void)[] = [];
  const notify = () => waiters.splice(0).forEach((w) => w());
  wss.on("connection", (socket) => {
    const conn: Received = { socket, messages: [] };
    connections.push(conn);
    socket.on("message", (data) => {
      conn.messages.push(JSON.parse(String(data)));
      notify();
    });
    notify();
  });
  /** Waits until `check` holds, re-checking whenever something arrives. */
  const until = async (check: () => boolean, ms = 2000) => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  };
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return { wss, url, connections, until, close: () => new Promise((r) => wss.close(r)) };
}

function peer() {
  const handled: ServerMessage[] = [];
  let hellos = 0;
  const p: ClientPeer = {
    hello: () => ({ type: "hello", protocol: 1, connectorId: `c${++hellos}`, token: "t", capabilities: { runtimes: [], slots: 1, workspaces: [], platform: "linux" }, active: [] }),
    heartbeat: () => ({ type: "heartbeat", active: [] }),
    handle: (msg) => handled.push(msg),
  };
  return { p, handled };
}

const welcome = (heartbeatMs = 60_000) => JSON.stringify({ type: "welcome", connectorId: "c1", heartbeatMs });

test("hello first, queue until welcome, then forward and heartbeat", async () => {
  const srv = await server();
  const { p, handled } = peer();
  const client = new ConnectorClient({ url: srv.url });
  client.start(p);
  client.send({ type: "heartbeat", active: ["queued"] });

  await srv.until(() => srv.connections[0]?.messages.length === 1);
  const conn = srv.connections[0]!;
  assert.equal(conn.messages[0]!.type, "hello");

  conn.socket.send(welcome(30));
  await srv.until(() => conn.messages.length >= 3);
  assert.deepEqual(conn.messages[1], { type: "heartbeat", active: ["queued"] });
  assert.deepEqual(conn.messages[2], { type: "heartbeat", active: [] });

  conn.socket.send("garbage");
  conn.socket.send(JSON.stringify({ type: "session.interrupt", dispatchId: "d1" }));
  await srv.until(() => handled.length === 1);
  assert.deepEqual(handled, [{ type: "session.interrupt", dispatchId: "d1" }]);

  client.stop();
  await client.closed;
  await srv.close();
});

test("reconnects after the connection drops and says hello again", async () => {
  const srv = await server();
  const { p } = peer();
  const client = new ConnectorClient({ url: srv.url, minBackoffMs: 10 });
  client.start(p);
  await srv.until(() => srv.connections[0]?.messages.length === 1);
  srv.connections[0]!.socket.terminate();
  await srv.until(() => srv.connections[1]?.messages.length === 1);
  assert.deepEqual(
    srv.connections.map((c) => (c.messages[0] as { connectorId: string }).connectorId),
    ["c1", "c2"],
  );
  client.stop();
  await srv.close();
});

test("a fatal server error stops the client", async () => {
  const srv = await server();
  const { p } = peer();
  const client = new ConnectorClient({ url: srv.url, minBackoffMs: 10 });
  client.start(p);
  await srv.until(() => srv.connections[0]?.messages.length === 1);
  srv.connections[0]!.socket.send(JSON.stringify({ type: "error", message: "bad token", fatal: true }));
  await client.closed;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(srv.connections.length, 1);
  await srv.close();
});
