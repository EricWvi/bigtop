import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import type { SessionEvent } from "@bigtop/protocol";
import { createCodexRuntime, killThreadProcesses, TurnNormalizer } from "./index.ts";

function recordingCodex() {
  const clients: CodexOptions[] = [];
  const threads: { resume?: string; options?: ThreadOptions }[] = [];
  const thread = { id: null, runStreamed: async () => ({ events: (async function* () {})() }) };
  const codex = (options: CodexOptions) => {
    clients.push(options);
    return {
      startThread: (o?: ThreadOptions) => (threads.push({ options: o }), thread),
      resumeThread: (id: string, o?: ThreadOptions) => (threads.push({ resume: id, options: o }), thread),
    };
  };
  return { codex, clients, threads };
}

test("maps roles onto the sandbox, never asks for approval and never uses full access", async () => {
  const fake = recordingCodex();
  const runtime = createCodexRuntime({ codex: fake.codex, codexPathOverride: "/bin/codex" });
  assert.deepEqual(runtime.capabilities, { toolApproval: false, costUsd: false, maxTurns: false, maxCostUsd: false, fork: false });

  await runtime.start({ cwd: "/work", role: { name: "implementer", access: "workspace-write", instructions: "be careful", model: "gpt-x" }, limits: {} });
  await runtime.resume("t1", { cwd: "/work", role: { name: "reviewer", access: "read-only" }, limits: {} });
  assert.deepEqual(fake.clients, [
    { codexPathOverride: "/bin/codex", config: { developer_instructions: "be careful" } },
    { codexPathOverride: "/bin/codex" },
  ]);
  assert.deepEqual(fake.threads, [
    {
      options: { model: "gpt-x", workingDirectory: "/work", skipGitRepoCheck: true, sandboxMode: "workspace-write", approvalPolicy: "never" },
    },
    {
      resume: "t1",
      options: { model: undefined, workingDirectory: "/work", skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never" },
    },
  ]);
});

function normalize(events: ThreadEvent[], structured = false): SessionEvent[] {
  const normalizer = new TurnNormalizer({ structured });
  return events.flatMap((e) => [...normalizer.push(e)]).map(({ raw: _raw, ...rest }) => JSON.parse(JSON.stringify(rest)));
}

test("maps file changes, MCP calls and web searches", () => {
  assert.deepEqual(
    normalize([
      {
        type: "item.completed",
        item: { id: "p1", type: "file_change", status: "completed", changes: [{ path: "a.ts", kind: "update" }, { path: "b.ts", kind: "add" }] },
      },
      { type: "item.completed", item: { id: "p2", type: "file_change", status: "failed", changes: [{ path: "c.ts", kind: "delete" }] } },
      { type: "item.started", item: { id: "m1", type: "mcp_tool_call", server: "gh", tool: "issue", arguments: { n: 1 }, status: "in_progress" } },
      {
        type: "item.completed",
        item: {
          id: "m1",
          type: "mcp_tool_call",
          server: "gh",
          tool: "issue",
          arguments: { n: 1 },
          status: "completed",
          result: { content: [{ type: "text", text: "open" }], structured_content: null },
        },
      },
      {
        type: "item.completed",
        item: { id: "m2", type: "mcp_tool_call", server: "gh", tool: "merge", arguments: {}, status: "failed", error: { message: "denied" } },
      },
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "node 24" } },
      { type: "item.completed", item: { id: "t1", type: "todo_list", items: [] } },
      { type: "item.completed", item: { id: "e1", type: "error", message: "non-fatal" } },
      { type: "item.updated", item: { id: "t1", type: "todo_list", items: [] } },
    ]),
    [
      { type: "file.changed", path: "a.ts", kind: "update" },
      { type: "file.changed", path: "b.ts", kind: "add" },
      { type: "tool.started", callId: "p2", tool: "apply_patch", input: { changes: [{ path: "c.ts", kind: "delete" }] } },
      { type: "tool.completed", callId: "p2", ok: false },
      { type: "tool.started", callId: "m1", tool: "mcp__gh__issue", input: { n: 1 } },
      { type: "tool.completed", callId: "m1", ok: true, output: "open" },
      { type: "tool.started", callId: "m2", tool: "mcp__gh__merge", input: {} },
      { type: "tool.completed", callId: "m2", ok: false, output: "denied" },
      { type: "tool.started", callId: "w1", tool: "web_search", input: { query: "node 24" } },
      { type: "tool.completed", callId: "w1", ok: true },
    ],
  );
});

test("structured output that is not JSON leaves structured unset", () => {
  const usage = { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
  const [, completed] = normalize(
    [
      { type: "item.completed", item: { id: "a", type: "agent_message", text: "not json" } },
      { type: "turn.completed", usage },
    ],
    true,
  );
  assert.deepEqual(completed, { type: "turn.completed", result: "not json", usage: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 } });
  assert.deepEqual(normalize([{ type: "error", message: "stream broke" }]), [{ type: "error", message: "stream broke" }]);
});

test("killThreadProcesses signals only the processes of that thread", async () => {
  const proc = await mkdtemp(join(tmpdir(), "bigtop-proc-"));
  const environs: Record<string, string> = {
    "101": "PATH=/bin\0CODEX_THREAD_ID=t1\0",
    "102": "CODEX_THREAD_ID=t10\0",
    "103": "HOME=/home/x\0",
    self: "CODEX_THREAD_ID=t1\0",
  };
  for (const [pid, environ] of Object.entries(environs)) {
    await mkdir(join(proc, pid));
    await writeFile(join(proc, pid, "environ"), environ);
  }
  await mkdir(join(proc, "104")); // exited: no readable environ
  const killed: number[] = [];
  assert.deepEqual(await killThreadProcesses("t1", { procDir: proc, kill: (pid) => killed.push(pid) }), [101]);
  assert.deepEqual(killed, [101]);
  assert.deepEqual(await killThreadProcesses("t1", { procDir: join(proc, "missing") }), []);
});

test("an aborted turn stops the commands codex left running; a finished one does not", async () => {
  const swept: string[] = [];
  const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };
  const thread = {
    id: "t1",
    async runStreamed(_input: string, { signal }: { signal?: AbortSignal } = {}) {
      const events = (async function* (): AsyncGenerator<ThreadEvent> {
        if (_input === "quick") {
          yield { type: "turn.completed", usage };
          return;
        }
        await new Promise((resolve) => signal!.addEventListener("abort", resolve));
        throw new Error("aborted");
      })();
      return { events };
    },
  };
  const runtime = createCodexRuntime({
    codex: () => ({ startThread: () => thread, resumeThread: () => thread }),
    killOrphans: async (id) => swept.push(id),
  });
  const session = await runtime.start({ cwd: "/w", role: { name: "r", access: "read-only" }, limits: {} });
  for await (const _ of session.send("quick"));
  assert.deepEqual(swept, []);
  const turn = (async () => {
    for await (const _ of session.send("slow"));
  })();
  await new Promise((r) => setTimeout(r, 5));
  await session.interrupt();
  await turn;
  assert.deepEqual(swept, ["t1"]);
});
