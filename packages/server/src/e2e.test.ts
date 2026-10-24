// End to end over real sockets: a task file in a local directory is dispatched
// through the server to a connector, run by a fake runtime, and written back.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Connector, ConnectorClient } from "@bigtop/connector";
import type { Runtime, RuntimeSession, SessionEvent, SessionSpec, ToolApprovalDecision } from "@bigtop/protocol";
import { createLocalSource } from "@bigtop/source-local";
import { createHttpServer } from "./http.ts";
import { Hub } from "./hub.ts";
import { createDefaultPlaybook } from "./playbook.ts";

const ADMIN = "admin-token";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A runtime that asks for one approval, then completes with a summary of what it was told. */
function scriptedRuntime(): Runtime & { prompts: string[]; decisions: ToolApprovalDecision[] } {
  const prompts: string[] = [];
  const decisions: ToolApprovalDecision[] = [];
  return {
    kind: "claude",
    version: "test",
    capabilities: { toolApproval: true, costUsd: true, maxTurns: true, maxCostUsd: true, structuredOutput: true, fork: false },
    prompts,
    decisions,
    async start(spec: SessionSpec): Promise<RuntimeSession> {
      return {
        id: "session-1",
        async *send(prompt: string): AsyncIterable<SessionEvent> {
          prompts.push(prompt);
          yield { type: "tool.started", callId: "u1", tool: "Bash", input: { command: "touch README.md" } };
          const decision = await spec.onToolApproval!({ callId: "u1", tool: "Bash", input: { command: "touch README.md" } });
          decisions.push(decision);
          yield { type: "tool.completed", callId: "u1", ok: decision.behavior === "allow" };
          yield { type: "turn.completed", result: `Worked in ${spec.cwd}.`, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 } };
        },
        interrupt: async () => {},
        close: async () => {},
      };
    },
    resume: () => Promise.reject(new Error("not supported")),
  };
}

async function stack() {
  const tasks = mkdtempSync(join(tmpdir(), "bigtop-e2e-tasks-"));
  const workspace = mkdtempSync(join(tmpdir(), "bigtop-e2e-ws-"));
  const hub = new Hub({
    sources: [createLocalSource({ dir: tasks, pollMs: 50 })],
    playbook: createDefaultPlaybook({ defaults: { workspace: "demo" } }),
    connectorTokens: { alice: "alice-token" },
    heartbeatMs: 1000,
  });
  const server = createHttpServer(hub, { adminToken: ADMIN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await hub.start();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => {
    hub.stop();
    server.closeAllConnections();
    return new Promise((r) => server.close(() => r()));
  });

  const runtime = scriptedRuntime();
  const client = new ConnectorClient({ url: `${base.replace("http", "ws")}/connect`, minBackoffMs: 20 });
  const connector = new Connector({
    id: "alice",
    token: "alice-token",
    slots: 1,
    workspaces: { demo: workspace },
    runtimes: [runtime],
    send: (msg) => client.send(msg),
  });
  client.start(connector);
  cleanups.push(() => client.stop());

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, ...init.headers } });
  return { hub, tasks, workspace, runtime, base, api };
}

async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, ms = 3000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("a task file is dispatched, approved over HTTP, run and written back", async () => {
  const { hub, tasks, workspace, runtime, api } = await stack();
  await until(() => hub.state().connectors[0]?.online);
  writeFileSync(join(tasks, "add-readme.md"), "---\ntitle: Add a README\n---\nCreate README.md.\n");

  // The approval shows up in /state; a person allows it over HTTP.
  const approval = await until(async () => {
    const state = (await (await api("/state")).json()) as { approvals: { id: string; request: { tool: string } }[] };
    return state.approvals[0] as { id: string; request: { tool: string } } | undefined;
  });
  assert.equal(approval.request.tool, "Bash");
  const decided = await api(`/approvals/${approval.id}`, { method: "POST", body: JSON.stringify({ behavior: "allow" }) });
  assert.equal(decided.status, 200);

  const file = join(tasks, "add-readme.md");
  await until(() => readFileSync(file, "utf8").includes("status: done"));
  assert.equal(
    readFileSync(file, "utf8"),
    `---\ntitle: Add a README\nstatus: done\n---\nCreate README.md.\n\n## Result\n\nWorked in ${workspace}.\n\nSession \`session-1\`, $0.2500.\n`,
  );
  assert.deepEqual(runtime.decisions, [{ behavior: "allow" }]);
  assert.match(runtime.prompts[0]!, /Add a README[\s\S]*Create README\.md\./);

  // The whole story is in the event stream, replayable over SSE.
  const res = await api("/events?after=0");
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("event: task.updated")) text += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(types, [
    "connector.online",
    "task.discovered",
    "dispatch.offered",
    "dispatch.accepted",
    "session.event",
    "approval.requested",
    "approval.decided",
    "session.event",
    "session.event",
    "session.ended",
    "task.written",
    "task.updated",
  ]);
});

test("the HTTP API requires the admin token and validates decisions", async () => {
  const { base, api } = await stack();
  assert.equal((await fetch(`${base}/state`)).status, 401);
  assert.equal((await fetch(`${base}/state`, { headers: { authorization: "Bearer nope" } })).status, 401);
  assert.equal((await api("/nowhere")).status, 404);
  const bad = await api("/approvals/x", { method: "POST", body: JSON.stringify({ behavior: "maybe" }) });
  assert.equal(bad.status, 400);
  const unknown = await api("/approvals/x", { method: "POST", body: JSON.stringify({ behavior: "allow" }) });
  assert.equal(unknown.status, 404);
  const state = await until(async () => {
    const s = (await (await api("/state")).json()) as { connectors: { id: string; online: boolean }[] };
    return s.connectors[0]?.online ? s : undefined;
  });
  assert.equal(state.connectors[0].id, "alice");
});
