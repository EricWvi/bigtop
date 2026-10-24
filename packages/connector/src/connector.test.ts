import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ConnectorMessage,
  DispatchOffer,
  Runtime,
  RuntimeSession,
  SessionEvent,
  SessionSpec,
  ToolApprovalDecision,
} from "@bigtop/protocol";
import { Connector, type ConnectorOptions } from "./connector.ts";

type Turn = (spec: SessionSpec, session: FakeSession) => AsyncIterable<SessionEvent>;

class FakeSession implements RuntimeSession {
  interrupts = 0;
  closed = false;
  interrupted = Promise.withResolvers<void>();
  id: string | undefined;
  #spec: SessionSpec;
  #turn: Turn;
  constructor(id: string | undefined, spec: SessionSpec, turn: Turn) {
    this.id = id;
    this.#spec = spec;
    this.#turn = turn;
  }
  send(): AsyncIterable<SessionEvent> {
    return this.#turn(this.#spec, this);
  }
  async interrupt() {
    this.interrupts++;
    this.interrupted.resolve();
  }
  async close() {
    this.closed = true;
  }
}

function fakeRuntime(turn: Turn, over: Partial<Runtime> = {}) {
  const sessions: FakeSession[] = [];
  const specs: SessionSpec[] = [];
  const resumed: string[] = [];
  const open = async (id: string | undefined, spec: SessionSpec) => {
    specs.push(spec);
    const session = new FakeSession(id, spec, turn);
    sessions.push(session);
    return session;
  };
  const runtime: Runtime = {
    kind: "claude",
    version: "1.0.0",
    capabilities: { toolApproval: true, costUsd: true, maxTurns: true, maxCostUsd: true, structuredOutput: true, fork: true },
    start: (spec) => open(`s${sessions.length + 1}`, spec),
    resume: (id, spec) => {
      resumed.push(id);
      return open(id, spec);
    },
    ...over,
  };
  return { runtime, sessions, specs, resumed };
}

const completed: SessionEvent = { type: "turn.completed", result: "ok", usage: { inputTokens: 1, outputTokens: 1 } };

function setup(runtimes: Runtime[], over: Partial<ConnectorOptions> = {}) {
  const sent: ConnectorMessage[] = [];
  const connector = new Connector({
    id: "c1",
    token: "secret",
    slots: 1,
    workspaces: { demo: "/work/demo" },
    runtimes,
    send: (msg) => sent.push(msg),
    ...over,
  });
  return { connector, sent };
}

const offer = (over: Partial<DispatchOffer> = {}): DispatchOffer => ({
  type: "dispatch.offer",
  dispatchId: "d1",
  task: { source: "local", id: "t1" },
  role: { name: "implementer", access: "workspace-write" },
  runtime: "claude",
  workspace: "demo",
  prompt: "do it",
  limits: { maxTurns: 3 },
  ...over,
});

const ofType = <T extends ConnectorMessage["type"]>(sent: ConnectorMessage[], type: T) =>
  sent.filter((m): m is Extract<ConnectorMessage, { type: T }> => m.type === type);

async function settle(connector: Connector) {
  await connector.drain();
}

test("hello describes the connector", () => {
  const { runtime } = fakeRuntime(async function* () {});
  const { connector } = setup([runtime], { slots: 2 });
  assert.deepEqual(connector.hello(), {
    type: "hello",
    protocol: 1,
    connectorId: "c1",
    token: "secret",
    capabilities: {
      runtimes: [{ kind: "claude", version: "1.0.0", capabilities: runtime.capabilities }],
      slots: 2,
      workspaces: ["demo"],
      platform: process.platform,
    },
    active: [],
  });
});

test("runs an offer: accept, stream events without raw, end", async () => {
  const fake = fakeRuntime(async function* () {
    yield { type: "message", text: "hi", raw: { big: true } };
    yield completed;
  });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer());
  assert.deepEqual(connector.activeDispatches, ["d1"]);
  await settle(connector);

  assert.deepEqual(sent, [
    { type: "dispatch.accept", dispatchId: "d1", sessionId: "s1" },
    { type: "session.event", dispatchId: "d1", seq: 0, event: { type: "message", text: "hi" } },
    { type: "session.event", dispatchId: "d1", seq: 1, event: completed },
    { type: "session.ended", dispatchId: "d1", sessionId: "s1", outcome: "completed" },
  ]);
  assert.equal(fake.specs[0]!.cwd, "/work/demo");
  assert.deepEqual(fake.specs[0]!.limits, { maxTurns: 3 });
  assert.equal(fake.sessions[0]!.closed, true);
  assert.deepEqual(connector.activeDispatches, []);
});

test("reports a session id the runtime assigns during the first turn when the session ends", async () => {
  const turn: Turn = async function* (_spec, session) {
    session.id = "thread-1";
    yield completed;
  };
  const fake = fakeRuntime(turn, { start: async (spec) => new FakeSession(undefined, spec, turn) });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer());
  await settle(connector);
  assert.deepEqual(ofType(sent, "dispatch.accept"), [{ type: "dispatch.accept", dispatchId: "d1" }]);
  assert.deepEqual(ofType(sent, "session.ended"), [
    { type: "session.ended", dispatchId: "d1", sessionId: "thread-1", outcome: "completed" },
  ]);
});

test("declines offers it cannot take", async () => {
  const fake = fakeRuntime(async function* (_spec, session) {
    await session.interrupted.promise;
  });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer({ runtime: "codex", dispatchId: "x1" }));
  connector.handle(offer({ workspace: "elsewhere", dispatchId: "x2" }));
  connector.handle(offer({ workspace: "toString", dispatchId: "x3" }));
  connector.handle(offer());
  connector.handle(offer());
  connector.handle(offer({ dispatchId: "d2" }));
  await connector.shutdown();

  assert.deepEqual(
    ofType(sent, "dispatch.decline").map((m) => [m.dispatchId, m.reason]),
    [
      ["x1", "runtime codex is not available"],
      ["x2", "unknown workspace elsewhere"],
      ["x3", "unknown workspace toString"],
      ["d1", "dispatch is already running"],
      ["d2", "no free slot"],
    ],
  );
});

test("declines when the session fails to start and frees the slot", async () => {
  const fake = fakeRuntime(async function* () {}, {
    start: async () => {
      throw new Error("no credentials");
    },
  });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer());
  await settle(connector);
  assert.deepEqual(sent, [{ type: "dispatch.decline", dispatchId: "d1", reason: "failed to start session: no credentials" }]);
  assert.deepEqual(connector.activeDispatches, []);
});

test("resumes the named session", async () => {
  const fake = fakeRuntime(async function* () {
    yield completed;
  });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer({ resume: "old" }));
  await settle(connector);
  assert.deepEqual(fake.resumed, ["old"]);
  assert.deepEqual(ofType(sent, "dispatch.accept")[0], { type: "dispatch.accept", dispatchId: "d1", sessionId: "old" });
});

test("reports failed turns and thrown errors", async () => {
  const failing = fakeRuntime(async function* () {
    yield { type: "error", message: "max turns" };
  });
  const a = setup([failing.runtime]);
  a.connector.handle(offer());
  await settle(a.connector);
  assert.deepEqual(ofType(a.sent, "session.ended")[0], {
    type: "session.ended",
    dispatchId: "d1",
    sessionId: "s1",
    outcome: "failed",
    error: "max turns",
  });

  const throwing = fakeRuntime(async function* () {
    throw new Error("crashed");
  });
  const b = setup([throwing.runtime]);
  b.connector.handle(offer());
  await settle(b.connector);
  assert.equal(ofType(b.sent, "session.ended")[0]!.error, "crashed");
});

test("session.interrupt interrupts the session and ends it as interrupted", async () => {
  const fake = fakeRuntime(async function* (_spec, session) {
    yield { type: "message", text: "working" };
    await session.interrupted.promise;
    yield { type: "error", message: "aborted" };
  });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer());
  await new Promise((r) => setImmediate(r));
  connector.handle({ type: "session.interrupt", dispatchId: "d1" });
  await settle(connector);
  assert.equal(fake.sessions[0]!.interrupts >= 1, true);
  assert.equal(ofType(sent, "session.ended")[0]!.outcome, "interrupted");
});

test("tool approvals go to the server and wait for its decision", async () => {
  const decisions: ToolApprovalDecision[] = [];
  const fake = fakeRuntime(async function* (spec) {
    decisions.push(await spec.onToolApproval!({ callId: "u1", tool: "Bash", input: { command: "ls" } }));
    yield completed;
  });
  const { connector, sent } = setup([fake.runtime]);
  connector.handle(offer());
  await new Promise((r) => setImmediate(r));

  const [request] = ofType(sent, "approval.request");
  assert.ok(request);
  assert.equal(request.dispatchId, "d1");
  assert.deepEqual(request.request, { callId: "u1", tool: "Bash", input: { command: "ls" } });
  connector.handle({ type: "approval.decision", approvalId: request.approvalId, decision: { behavior: "deny", message: "no" } });
  await settle(connector);
  assert.deepEqual(decisions, [{ behavior: "deny", message: "no" }]);
});

test("tool approvals time out as denials", async () => {
  const decisions: ToolApprovalDecision[] = [];
  const fake = fakeRuntime(async function* (spec) {
    decisions.push(await spec.onToolApproval!({ callId: "u1", tool: "Bash", input: {} }));
    yield completed;
  });
  const { connector } = setup([fake.runtime], { approvalTimeoutMs: 10 });
  connector.handle(offer());
  await settle(connector);
  assert.deepEqual(decisions, [{ behavior: "deny", message: "approval timed out" }]);
});

test("runtimes without tool approval get no onToolApproval", async () => {
  const fake = fakeRuntime(
    async function* () {
      yield completed;
    },
    { kind: "codex", capabilities: { toolApproval: false, costUsd: false, maxTurns: false, maxCostUsd: false, structuredOutput: true, fork: false } },
  );
  const { connector } = setup([fake.runtime]);
  connector.handle(offer({ runtime: "codex" }));
  await settle(connector);
  assert.equal(fake.specs[0]!.onToolApproval, undefined);
});
