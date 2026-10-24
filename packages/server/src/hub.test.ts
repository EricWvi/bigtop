import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ConnectorMessage, Hello, ServerMessage, Source, Task, TaskUpdate } from "@bigtop/protocol";
import { Hub, type HubOptions } from "./hub.ts";
import { createDefaultPlaybook } from "./playbook.ts";

function memorySource(tasks: Task[]) {
  const updates: [string, TaskUpdate][] = [];
  let onChange = () => {};
  const source: Source & { updates: typeof updates; changed(): void } = {
    name: "mem",
    updates,
    list: async () => tasks.map((t) => ({ ...t })),
    watch: (cb) => {
      onChange = cb;
      return () => {};
    },
    update: async (id, update) => {
      updates.push([id, update]);
      const task = tasks.find((t) => t.ref.id === id)!;
      task.status = update.status;
    },
    changed: () => onChange(),
  };
  return source;
}

const task = (id: string, fields: Record<string, string> = { workspace: "demo" }): Task => ({
  ref: { source: "mem", id, title: `Task ${id}` },
  status: "open",
  body: `Do ${id}.`,
  fields,
});

class FakeConn {
  sent: ServerMessage[] = [];
  closedWith: [number, string] | undefined;
  send(msg: ServerMessage) {
    this.sent.push(msg);
  }
  close(code: number, reason: string) {
    this.closedWith = [code, reason];
  }
  of<T extends ServerMessage["type"]>(type: T) {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

const hello = (over: Partial<Hello> = {}): Hello => ({
  type: "hello",
  protocol: 1,
  connectorId: "alice",
  token: "secret",
  capabilities: {
    runtimes: [{ kind: "claude", version: "1", capabilities: { toolApproval: true, costUsd: true, maxTurns: true, maxCostUsd: true, fork: true } }],
    slots: 1,
    workspaces: ["demo"],
    platform: "linux",
  },
  active: [],
  ...over,
});

const hubs: Hub[] = [];
afterEach(() => hubs.splice(0).forEach((h) => h.stop()));

async function setup(tasks: Task[], over: Partial<HubOptions> = {}) {
  const source = memorySource(tasks);
  const hub = new Hub({
    sources: [source],
    playbook: createDefaultPlaybook(),
    connectorTokens: { alice: "secret", bob: "bob-secret" },
    ...over,
  });
  hubs.push(hub);
  await hub.start();
  const connect = (h: Hello = hello()) => {
    const conn = new FakeConn();
    const handle = hub.connect(conn);
    const send = (msg: ConnectorMessage) => handle.receive(JSON.stringify(msg));
    send(h);
    return { conn, handle, send };
  };
  return { hub, source, connect };
}

const types = (hub: Hub) => hub.events.since().map((e) => e.type);
const tick = () => new Promise((r) => setTimeout(r, 5));

test("rejects bad hellos and anything before hello", async () => {
  const { hub, connect } = await setup([]);
  for (const [h, message] of [
    [hello({ token: "wrong" }), "unknown connector or wrong token"],
    [hello({ connectorId: "mallory" }), "unknown connector or wrong token"],
    [hello({ connectorId: "toString" }), "unknown connector or wrong token"],
    [hello({ protocol: 99 }), "protocol 99 is not supported; this server speaks 1"],
  ] as const) {
    const { conn } = connect(h);
    assert.deepEqual(conn.sent, [{ type: "error", message, fatal: true }]);
    assert.equal(conn.closedWith?.[0], 4003);
  }
  const conn = new FakeConn();
  hub.connect(conn).receive(JSON.stringify({ type: "heartbeat", active: [] }));
  assert.deepEqual(conn.closedWith, [4001, "hello required"]);
  assert.equal(hub.state().connectors.length, 0);
});

test("dispatches an open task to a connector and writes the result back", async () => {
  const { hub, source, connect } = await setup([task("t1")]);
  const { conn, send } = connect();
  assert.deepEqual(conn.sent[0], { type: "welcome", connectorId: "alice", heartbeatMs: 15_000 });

  const [offer] = conn.of("dispatch.offer");
  assert.ok(offer);
  assert.equal(offer.workspace, "demo");
  assert.equal(offer.role.name, "implementer");
  assert.match(offer.prompt, /Task t1[\s\S]*Do t1\./);
  assert.equal(hub.state().tasks[0]!.busy, true);

  send({ type: "dispatch.accept", dispatchId: offer.dispatchId, sessionId: "s1" });
  send({ type: "session.event", dispatchId: offer.dispatchId, seq: 0, event: { type: "message", text: "working" } });
  send({
    type: "session.event",
    dispatchId: offer.dispatchId,
    seq: 1,
    event: { type: "turn.completed", result: "Added it.", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } },
  });
  send({ type: "session.ended", dispatchId: offer.dispatchId, sessionId: "s1", outcome: "completed" });
  await tick();

  assert.deepEqual(source.updates, [["t1", { status: "done", note: "Added it.\n\nSession `s1`, $0.5000." }]]);
  assert.deepEqual(types(hub), [
    "task.discovered",
    "connector.online",
    "dispatch.offered",
    "dispatch.accepted",
    "session.event",
    "session.event",
    "session.ended",
    "task.written",
    "task.updated",
  ]);
  const ended = hub.events.since().find((e) => e.type === "session.ended")!;
  assert.deepEqual(ended.subject, { task: "mem:t1", dispatch: offer.dispatchId, connector: "alice", session: "s1" });
  assert.equal(hub.state().dispatches.length, 0);
  assert.equal(conn.of("dispatch.offer").length, 1);
});

test("respects slots, workspaces and runtimes", async () => {
  const { connect } = await setup([task("a"), task("b"), task("c", { workspace: "other" }), task("d", { workspace: "demo", runtime: "codex" })]);
  const { conn } = connect(hello({ capabilities: { ...hello().capabilities, slots: 2 } }));
  assert.deepEqual(
    conn.of("dispatch.offer").map((o) => o.task.id),
    ["a", "b"],
  );
});

test("skipped tasks are reported once with the reason", async () => {
  const { hub, connect } = await setup([task("t1", {}), task("t2", { workspace: "demo", role: "wizard" })]);
  connect();
  await hub.refresh();
  const skipped = hub.events.since().filter((e) => e.type === "task.skipped");
  assert.deepEqual(
    skipped.map((e) => [e.subject?.task, (e.data as { reason: string }).reason]),
    [
      ["mem:t1", "no workspace: set workspace on the task or a default"],
      ["mem:t2", "unknown role wizard"],
    ],
  );
});

test("a declined task goes to another connector, not back to the decliner", async () => {
  const { connect } = await setup([task("t1")]);
  const alice = connect();
  const [offer] = alice.conn.of("dispatch.offer");
  alice.send({ type: "dispatch.decline", dispatchId: offer!.dispatchId, reason: "busy" });
  assert.equal(alice.conn.of("dispatch.offer").length, 1);
  const bob = connect(hello({ connectorId: "bob", token: "bob-secret" }));
  assert.equal(bob.conn.of("dispatch.offer").length, 1);
});

test("unanswered offers expire and are retried after the cooldown", async () => {
  const { hub, connect } = await setup([task("t1")], { offerTimeoutMs: 20, retryCooldownMs: 40 });
  const { conn } = connect();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(types(hub).includes("dispatch.expired"));
  assert.equal(conn.of("session.interrupt").length, 1);
  await new Promise((r) => setTimeout(r, 40));
  await hub.refresh();
  assert.equal(conn.of("dispatch.offer").length, 2);
});

test("a connector that reconnects keeps its running dispatches; lost ones expire", async () => {
  const { hub, connect } = await setup([task("t1"), task("t2")], { leaseMs: 30 });
  const first = connect(hello({ capabilities: { ...hello().capabilities, slots: 2 } }));
  const [o1, o2] = first.conn.of("dispatch.offer");
  first.send({ type: "dispatch.accept", dispatchId: o1!.dispatchId, sessionId: "s1" });
  first.send({ type: "dispatch.accept", dispatchId: o2!.dispatchId, sessionId: "s2" });
  first.handle.closed();
  assert.equal(hub.state().connectors[0]!.online, false);

  const second = connect(hello({ active: [o1!.dispatchId], capabilities: { ...hello().capabilities, slots: 2 } }));
  assert.deepEqual(
    hub.state().dispatches.map((d) => d.id),
    [o1!.dispatchId],
  );
  // t2 was lost, so after its cooldown it can be offered again; t1 is still running.
  assert.ok(hub.events.since().some((e) => e.type === "dispatch.expired" && e.subject?.dispatch === o2!.dispatchId));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(hub.state().dispatches.length, 1, "the lease timer of the first connection must not fire");
  // Messages on the old connection are ignored.
  first.send({ type: "session.ended", dispatchId: o1!.dispatchId, sessionId: "s1", outcome: "completed" });
  assert.equal(hub.state().dispatches.length, 1);
  assert.equal(second.conn.of("welcome").length, 1);
});

test("dispatches of a connector that never comes back expire after the lease", async () => {
  const { hub, connect } = await setup([task("t1")], { leaseMs: 20 });
  const { conn, handle, send } = connect();
  send({ type: "dispatch.accept", dispatchId: conn.of("dispatch.offer")[0]!.dispatchId, sessionId: "s1" });
  handle.closed();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(hub.state().dispatches.length, 0);
  assert.equal(hub.state().tasks[0]!.busy, false);
});

test("work the hub does not track is interrupted", async () => {
  const { connect } = await setup([]);
  const { conn, send } = connect();
  send({ type: "dispatch.accept", dispatchId: "ghost", sessionId: "s" });
  assert.deepEqual(conn.of("session.interrupt"), [{ type: "session.interrupt", dispatchId: "ghost" }]);
});

test("approvals are held until someone decides", async () => {
  const { hub, connect } = await setup([task("t1")]);
  const { conn, send } = connect();
  const dispatchId = conn.of("dispatch.offer")[0]!.dispatchId;
  send({ type: "dispatch.accept", dispatchId, sessionId: "s1" });
  send({ type: "approval.request", dispatchId, approvalId: "a1", request: { callId: "u1", tool: "Bash", input: { command: "ls" } } });
  assert.deepEqual(hub.state().approvals, [{ id: "a1", dispatchId, request: { callId: "u1", tool: "Bash", input: { command: "ls" } } }]);

  assert.equal(hub.decide("a1", { behavior: "allow" }, { kind: "human", id: "eric" }), true);
  assert.deepEqual(conn.of("approval.decision"), [{ type: "approval.decision", approvalId: "a1", decision: { behavior: "allow" } }]);
  assert.equal(hub.decide("a1", { behavior: "allow" }, { kind: "human", id: "eric" }), false);
  const decided = hub.events.since().find((e) => e.type === "approval.decided")!;
  assert.deepEqual(decided.actor, { kind: "human", id: "eric" });
  assert.equal(decided.subject?.approval, "a1");
});

test("failed sessions mark the task failed and it is not retried", async () => {
  const { hub, source, connect } = await setup([task("t1")]);
  const { conn, send } = connect();
  const dispatchId = conn.of("dispatch.offer")[0]!.dispatchId;
  send({ type: "dispatch.accept", dispatchId, sessionId: "s1" });
  send({ type: "session.ended", dispatchId, sessionId: "s1", outcome: "failed", error: "max turns" });
  await tick();
  await hub.refresh();
  assert.deepEqual(source.updates, [["t1", { status: "failed", note: "The session failed: max turns\n\nSession `s1`." }]]);
  assert.equal(conn.of("dispatch.offer").length, 1);
});

test("a session id first reported on session.ended is recorded", async () => {
  const { hub, source, connect } = await setup([task("t1")]);
  const { conn, send } = connect();
  const dispatchId = conn.of("dispatch.offer")[0]!.dispatchId;
  send({ type: "dispatch.accept", dispatchId });
  send({ type: "session.ended", dispatchId, sessionId: "thread-1", outcome: "failed", error: "boom" });
  await tick();
  const ended = hub.events.since().find((e) => e.type === "session.ended")!;
  assert.equal(ended.subject?.session, "thread-1");
  assert.deepEqual(source.updates, [["t1", { status: "failed", note: "The session failed: boom\n\nSession `thread-1`." }]]);
});

test("connections closed by stop() start no grace timer", async () => {
  const { hub, connect } = await setup([task("t1")], { leaseMs: 10 });
  const { conn, handle, send } = connect();
  send({ type: "dispatch.accept", dispatchId: conn.of("dispatch.offer")[0]!.dispatchId, sessionId: "s1" });
  hub.stop();
  handle.closed();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(types(hub).includes("dispatch.expired"), false);
});

test("a failed write-back marks the task stuck instead of re-running it", async () => {
  const source = memorySource([task("t1")]);
  source.update = async () => {
    throw new Error("disk full");
  };
  const { hub, connect } = await setup([], { sources: [source] });
  const { conn, send } = connect();
  const dispatchId = conn.of("dispatch.offer")[0]!.dispatchId;
  send({ type: "session.ended", dispatchId, sessionId: "s1", outcome: "completed" });
  await tick();
  await hub.refresh();
  assert.equal(hub.state().tasks[0]!.stuck, true);
  assert.equal(conn.of("dispatch.offer").length, 1);
  assert.ok(types(hub).includes("task.write_failed"));
});

test("new tasks from a source change are dispatched", async () => {
  const tasks = [task("t1")];
  const { hub, source, connect } = await setup(tasks);
  const { conn, send } = connect(hello({ capabilities: { ...hello().capabilities, slots: 2 } }));
  tasks.push(task("t2"));
  source.changed();
  await hub.refresh();
  assert.deepEqual(
    conn.of("dispatch.offer").map((o) => o.task.id),
    ["t1", "t2"],
  );
  send({ type: "heartbeat", active: [] });
});
