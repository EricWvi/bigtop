import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolError, parseServerMessage } from "./wire.ts";

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
