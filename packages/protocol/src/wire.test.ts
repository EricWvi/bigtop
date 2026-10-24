import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolError, parseConnectorMessage, parseDecision, parseServerMessage } from "./wire.ts";

const offer = {
  type: "dispatch.offer",
  dispatchId: "d1",
  task: { source: "local", id: "t1" },
  role: { name: "implementer", access: "workspace-write" },
  runtime: "claude",
  workspace: "demo",
  prompt: "do it",
  limits: { maxTurns: 5 },
};

test("parses a valid dispatch offer", () => {
  assert.deepEqual(parseServerMessage(JSON.stringify(offer)), offer);
});

test("parses welcome, interrupt, decision and error", () => {
  for (const msg of [
    { type: "welcome", connectorId: "c1", heartbeatMs: 10_000 },
    { type: "session.interrupt", dispatchId: "d1" },
    { type: "approval.decision", approvalId: "a1", decision: { behavior: "allow" } },
    { type: "approval.decision", approvalId: "a1", decision: { behavior: "deny", message: "no" } },
    { type: "error", message: "bad token", fatal: true },
  ]) {
    assert.deepEqual(parseServerMessage(JSON.stringify(msg)), msg);
  }
});

test("rejects malformed frames", () => {
  const cases: [string, RegExp][] = [
    ["not json", /not valid JSON/],
    ["[]", /must be an object/],
    [JSON.stringify({ type: "nope" }), /unknown message type/],
    [JSON.stringify({ ...offer, runtime: "gpt" }), /runtime must be one of/],
    [JSON.stringify({ ...offer, role: { name: "x", access: "root" } }), /role.access/],
    [JSON.stringify({ ...offer, limits: { maxTurns: "5" } }), /maxTurns/],
    [JSON.stringify({ ...offer, task: { source: "local" } }), /task.id/],
    [JSON.stringify({ type: "welcome", connectorId: "c1", heartbeatMs: 0 }), /heartbeatMs/],
    [JSON.stringify({ type: "approval.decision", approvalId: "a1", decision: { behavior: "deny" } }), /decision.message/],
  ];
  for (const [text, message] of cases) {
    assert.throws(() => parseServerMessage(text), (err: unknown) => err instanceof ProtocolError && message.test(err.message));
  }
});

const hello = {
  type: "hello",
  protocol: 1,
  connectorId: "c1",
  token: "t",
  capabilities: {
    runtimes: [{ kind: "claude", version: "1", capabilities: { toolApproval: true, costUsd: true, fork: true } }],
    slots: 2,
    workspaces: ["demo"],
    platform: "linux",
  },
  active: [],
};

test("parses valid connector messages", () => {
  for (const msg of [
    hello,
    { type: "dispatch.accept", dispatchId: "d1", sessionId: "s1" },
    { type: "dispatch.decline", dispatchId: "d1", reason: "busy" },
    { type: "session.event", dispatchId: "d1", seq: 0, event: { type: "message", text: "hi" } },
    { type: "session.ended", dispatchId: "d1", sessionId: "s1", outcome: "failed", error: "x" },
    { type: "approval.request", dispatchId: "d1", approvalId: "a1", request: { callId: "u1", tool: "Bash", input: {} } },
    { type: "heartbeat", active: ["d1"] },
  ]) {
    assert.deepEqual(parseConnectorMessage(JSON.stringify(msg)), msg);
  }
});

test("rejects malformed connector messages", () => {
  const cases: [unknown, RegExp][] = [
    [{ ...hello, token: "" }, /hello.token/],
    [{ ...hello, active: [1] }, /hello.active/],
    [{ ...hello, capabilities: { ...hello.capabilities, slots: 0 } }, /slots/],
    [{ ...hello, capabilities: { ...hello.capabilities, runtimes: [{ kind: "gpt", version: "1", capabilities: {} }] } }, /kind/],
    [{ type: "session.event", dispatchId: "d1", seq: 0.5, event: { type: "x" } }, /seq/],
    [{ type: "session.event", dispatchId: "d1", seq: 0, event: {} }, /event.type/],
    [{ type: "session.ended", dispatchId: "d1", sessionId: "s1", outcome: "meh" }, /outcome/],
    [{ type: "approval.request", dispatchId: "d1", approvalId: "a1", request: { callId: "u1" } }, /request.tool/],
    [{ type: "dispatch.offer" }, /unknown message type/],
  ];
  for (const [value, message] of cases) {
    assert.throws(
      () => parseConnectorMessage(JSON.stringify(value)),
      (err: unknown) => err instanceof ProtocolError && message.test(err.message),
    );
  }
});

test("parseDecision keeps only the known fields", () => {
  assert.deepEqual(parseDecision({ behavior: "allow", extra: 1 }), { behavior: "allow" });
  assert.deepEqual(parseDecision({ behavior: "deny", message: "no" }), { behavior: "deny", message: "no" });
  assert.throws(() => parseDecision({ behavior: "maybe" }), ProtocolError);
});
