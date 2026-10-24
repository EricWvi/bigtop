import assert from "node:assert/strict";
import { test } from "node:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent, SessionSpec } from "@bigtop/protocol";
import { createClaudeRuntime, type ClaudeQuery } from "./index.ts";

const assistant = (content: unknown[], parent: string | null = null) =>
  ({ type: "assistant", parent_tool_use_id: parent, message: { content } }) as unknown as SDKMessage;
const user = (content: unknown) =>
  ({ type: "user", parent_tool_use_id: null, message: { role: "user", content } }) as unknown as SDKMessage;
const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  structured_output: { ok: true },
  num_turns: 2,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 },
} as unknown as SDKMessage;

interface Call {
  prompt: string;
  options: Options;
}

function fakeQuery(script: (call: Call) => SDKMessage[] | Promise<SDKMessage[]>) {
  const calls: Call[] = [];
  let interrupts = 0;
  const query: ClaudeQuery = ({ prompt, options = {} }) => {
    const call = { prompt, options };
    calls.push(call);
    const gen = (async function* () {
      yield* await script(call);
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        interrupts++;
      },
    });
  };
  return { query, calls, interrupts: () => interrupts };
}

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  cwd: "/work",
  role: { name: "implementer", access: "workspace-write", instructions: "be careful", model: "claude-x" },
  limits: { maxTurns: 7, maxCostUsd: 2 },
  ...over,
});

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of stream) {
    const { raw: _raw, ...rest } = event;
    events.push(rest as SessionEvent);
  }
  return events;
}

test("normalizes a turn into session events", async () => {
  const fake = fakeQuery(() => [
    { type: "system", subtype: "init" } as unknown as SDKMessage,
    assistant([
      { type: "thinking", thinking: "hmm" },
      { type: "thinking", thinking: "" },
      { type: "text", text: "on it" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]),
    assistant([{ type: "text", text: "from a subagent" }], "t0"),
    user([{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }] }]),
    user([{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }]),
    success,
  ]);
  const session = await createClaudeRuntime({ query: fake.query }).start(spec());
  assert.deepEqual(await collect(session.send("go")), [
    { type: "reasoning", text: "hmm" },
    { type: "message", text: "on it" },
    { type: "tool.started", callId: "t1", tool: "Bash", input: { command: "ls" } },
    { type: "tool.completed", callId: "t1", ok: true, output: "a.txt" },
    { type: "tool.completed", callId: "t2", ok: false, output: "boom" },
    {
      type: "turn.completed",
      result: "done",
      structured: { ok: true },
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3, costUsd: 0.01, turns: 2 },
    },
  ]);
});

test("maps the role and limits onto SDK options", async () => {
  const fake = fakeQuery(() => [success]);
  const runtime = createClaudeRuntime({ query: fake.query });

  const writer = await runtime.start(spec());
  await collect(writer.send("go", { outputSchema: { type: "object" } }));
  const opts = fake.calls[0]!.options;
  assert.equal(opts.cwd, "/work");
  assert.equal(opts.model, "claude-x");
  assert.deepEqual(opts.systemPrompt, { type: "preset", preset: "claude_code", append: "be careful" });
  assert.deepEqual(opts.settingSources, ["project"]);
  assert.equal(opts.permissionMode, "acceptEdits");
  assert.deepEqual(opts.disallowedTools, []);
  assert.equal(opts.maxTurns, 7);
  assert.equal(opts.maxBudgetUsd, 2);
  assert.deepEqual(opts.outputFormat, { type: "json_schema", schema: { type: "object" } });
  assert.equal(opts.canUseTool, undefined);

  const reader = await runtime.start(spec({ role: { name: "reviewer", access: "read-only" } }));
  await collect(reader.send("look"));
  assert.equal(fake.calls[1]!.options.permissionMode, "default");
  assert.deepEqual(fake.calls[1]!.options.disallowedTools, ["Write", "Edit", "NotebookEdit"]);
});

test("first turn creates the session by id, later turns and resume() continue it", async () => {
  const fake = fakeQuery(() => [success]);
  const runtime = createClaudeRuntime({ query: fake.query });
  const session = await runtime.start(spec());
  await collect(session.send("one"));
  await collect(session.send("two"));
  assert.equal(fake.calls[0]!.options.sessionId, session.id);
  assert.equal(fake.calls[0]!.options.resume, undefined);
  assert.equal(fake.calls[1]!.options.resume, session.id);
  assert.equal(fake.calls[1]!.options.sessionId, undefined);

  const resumed = await runtime.resume("abc", spec());
  await collect(resumed.send("three"));
  assert.equal(resumed.id, "abc");
  assert.equal(fake.calls[2]!.options.resume, "abc");
});

test("routes tool approval through onToolApproval", async () => {
  const fake = fakeQuery(() => [success]);
  const asked: unknown[] = [];
  const session = await createClaudeRuntime({ query: fake.query }).start(
    spec({
      onToolApproval: async (req) => {
        asked.push(req);
        return req.tool === "Bash" ? { behavior: "deny", message: "no shell" } : { behavior: "allow" };
      },
    }),
  );
  await collect(session.send("go"));
  const canUseTool = fake.calls[0]!.options.canUseTool!;
  const signal = new AbortController().signal;
  assert.deepEqual(await canUseTool("Bash", { command: "rm -rf /" }, { signal, requestId: "r1", toolUseID: "u1", decisionReason: "risky" }), {
    behavior: "deny",
    message: "no shell",
    toolUseID: "u1",
  });
  assert.deepEqual(await canUseTool("WebFetch", {}, { signal, requestId: "r2", toolUseID: "u2" }), { behavior: "allow", toolUseID: "u2" });
  assert.deepEqual(asked[0], { callId: "u1", tool: "Bash", input: { command: "rm -rf /" }, reason: "risky" });
});

test("reports failed turns as a single error event", async () => {
  const cases: [SDKMessage[] | (() => never), string][] = [
    [[{ ...success, subtype: "error_max_turns", errors: ["limit"] } as unknown as SDKMessage], "error_max_turns: limit"],
    [[{ ...success, is_error: true, result: "api down" } as unknown as SDKMessage], "api down"],
    [[], "turn ended without a result"],
    [
      () => {
        throw new Error("spawn failed");
      },
      "spawn failed",
    ],
  ];
  for (const [script, message] of cases) {
    const fake = fakeQuery(() => (typeof script === "function" ? script() : script));
    const session = await createClaudeRuntime({ query: fake.query }).start(spec());
    assert.deepEqual(await collect(session.send("go")), [{ type: "error", message }]);
  }
});

test("interrupt reaches the running query; a passed deadline aborts it", async () => {
  let release!: () => void;
  const fake = fakeQuery(
    () =>
      new Promise((resolve) => {
        release = () => resolve([success]);
      }),
  );
  const session = await createClaudeRuntime({ query: fake.query }).start(spec());
  const done = collect(session.send("go"));
  await new Promise((r) => setImmediate(r));
  await session.interrupt();
  assert.equal(fake.interrupts(), 1);
  await assert.rejects(collect(session.send("again")), /already running/);
  release();
  await done;

  const deadlined = fakeQuery((call) => {
    assert.equal(call.options.abortController!.signal.aborted, false);
    return new Promise((resolve) => call.options.abortController!.signal.addEventListener("abort", () => resolve([])));
  });
  const late = await createClaudeRuntime({ query: deadlined.query }).start(
    spec({ limits: { deadline: new Date(Date.now() + 20).toISOString() } }),
  );
  assert.deepEqual(await collect(late.send("go")), [{ type: "error", message: "session deadline passed" }]);
});
