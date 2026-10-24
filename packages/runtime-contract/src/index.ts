// The behaviour every Runtime adapter must share, as a node:test suite. Each
// runtime package runs it from a `contract.test.ts` with a harness that turns
// the SDK-neutral steps below into its own fake SDK.

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  JsonSchema,
  RoleAccess,
  Runtime,
  RuntimeKind,
  SessionEvent,
  SessionSpec,
  ToolApprovalDecision,
} from "@bigtop/protocol";

/** One thing the fake SDK does during a turn. */
export type Step =
  | { kind: "message"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "command"; callId: string; command: string; output: string; ok: boolean }
  /** The SDK asks to run `command` and records the runtime's decision. */
  | { kind: "approval"; callId: string; command: string }
  /** The final reply and the end of the turn; `text` is JSON when `structured` is set. */
  | { kind: "complete"; text: string; structured?: unknown; usage: StepUsage }
  /** The SDK reports that the turn failed. */
  | { kind: "fail"; message: string }
  /** The SDK throws, for example because its process died. */
  | { kind: "crash"; message: string }
  /** Waits until the turn is interrupted or aborted. */
  | { kind: "hang" };

export interface StepUsage {
  /** Input tokens not read from cache. */
  input: number;
  output: number;
  cached: number;
  costUsd: number;
}

/** What the fake SDK was asked to do for one turn, in SDK-neutral terms. */
export interface ObservedTurn {
  prompt: string;
  /** Id of the conversation the turn continued; undefined for a new one. */
  continues?: string;
  cwd: string;
  model?: string;
  instructions?: string;
  access: RoleAccess;
  outputSchema?: JsonSchema;
}

export interface FakeSdk {
  runtime: Runtime;
  /** One entry per turn the SDK was asked to run. */
  turns: ObservedTurn[];
  /** What the runtime answered the SDK for each `approval` step. */
  decisions: ToolApprovalDecision[];
}

export interface RuntimeHarness {
  kind: RuntimeKind;
  /** The tool name the runtime reports for a shell command. */
  shellTool: string;
  /** A runtime whose fake SDK plays `turns[i]` as the i-th turn it is asked to run. */
  create(turns: Step[][]): FakeSdk;
}

const usage: StepUsage = { input: 10, output: 5, cached: 3, costUsd: 0.01 };

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  cwd: "/work",
  role: { name: "implementer", access: "workspace-write", instructions: "be careful", model: "model-x" },
  limits: {},
  ...over,
});

/** Collects a turn's events without `raw`, `usage.turns` and undefined fields. */
async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of stream) {
    const { raw: _raw, ...rest } = event;
    if (rest.type === "turn.completed") delete rest.usage.turns;
    events.push(JSON.parse(JSON.stringify(rest)));
  }
  return events;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

export function runtimeContract(h: RuntimeHarness): void {
  const name = (title: string) => `${h.kind} runtime contract: ${title}`;

  test(name("declares its kind and every capability"), () => {
    const { runtime } = h.create([]);
    assert.equal(runtime.kind, h.kind);
    assert.match(runtime.version, /\S/);
    for (const key of ["toolApproval", "costUsd", "maxTurns", "maxCostUsd", "fork"] as const) {
      assert.equal(typeof runtime.capabilities[key], "boolean", key);
    }
  });

  test(name("normalizes a turn into session events"), async () => {
    const fake = h.create([
      [
        { kind: "reasoning", text: "hmm" },
        { kind: "message", text: "on it" },
        { kind: "command", callId: "c1", command: "ls", output: "a.txt", ok: true },
        { kind: "command", callId: "c2", command: "false", output: "boom", ok: false },
        { kind: "complete", text: "done", usage },
      ],
    ]);
    const session = await fake.runtime.start(spec());
    assert.deepEqual(await collect(session.send("go")), [
      { type: "reasoning", text: "hmm" },
      { type: "message", text: "on it" },
      { type: "tool.started", callId: "c1", tool: h.shellTool, input: { command: "ls" } },
      { type: "tool.completed", callId: "c1", ok: true, output: "a.txt" },
      { type: "tool.started", callId: "c2", tool: h.shellTool, input: { command: "false" } },
      { type: "tool.completed", callId: "c2", ok: false, output: "boom" },
      { type: "message", text: "done" },
      {
        type: "turn.completed",
        result: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 3,
          ...(fake.runtime.capabilities.costUsd ? { costUsd: 0.01 } : {}),
        },
      },
    ]);
    assert.equal(fake.turns[0]!.prompt, "go");
  });

  test(name("passes the workspace and role to the SDK"), async () => {
    const done: Step[] = [{ kind: "complete", text: "ok", usage }];
    const fake = h.create([done, done]);
    await collect((await fake.runtime.start(spec())).send("write"));
    await collect(
      (await fake.runtime.start(spec({ cwd: "/repo", role: { name: "reviewer", access: "read-only" } }))).send("read"),
    );
    assert.deepEqual(
      fake.turns.map(({ cwd, model, instructions, access }) => ({ cwd, model, instructions, access })),
      [
        { cwd: "/work", model: "model-x", instructions: "be careful", access: "workspace-write" },
        { cwd: "/repo", model: undefined, instructions: undefined, access: "read-only" },
      ],
    );
  });

  test(name("later turns and resume() continue the same conversation"), async () => {
    const done: Step[] = [{ kind: "complete", text: "ok", usage }];
    const fake = h.create([done, done, done]);
    const session = await fake.runtime.start(spec());
    await collect(session.send("one"));
    const id = session.id;
    assert.ok(id, "the session has an id after its first turn");
    await collect(session.send("two"));
    assert.equal(session.id, id);

    const resumed = await fake.runtime.resume("abc", spec());
    assert.equal(resumed.id, "abc");
    await collect(resumed.send("three"));
    assert.deepEqual(
      fake.turns.map((t) => [t.prompt, t.continues]),
      [
        ["one", undefined],
        ["two", id],
        ["three", "abc"],
      ],
    );
  });

  test(name("passes an output schema and returns the structured result"), async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const fake = h.create([[{ kind: "complete", text: '{"ok":true}', structured: { ok: true }, usage }]]);
    const session = await fake.runtime.start(spec());
    const events = await collect(session.send("judge", { outputSchema: schema }));
    const last = events.at(-1)!;
    assert.equal(last.type, "turn.completed");
    assert.deepEqual(last.type === "turn.completed" && last.structured, { ok: true });
    assert.deepEqual(fake.turns[0]!.outputSchema, schema);
  });

  test(name("a failed turn ends with exactly one error event"), async () => {
    const cases: [Step[], string][] = [
      [[{ kind: "fail", message: "api down" }], "api down"],
      [[{ kind: "crash", message: "spawn failed" }], "spawn failed"],
      [[{ kind: "message", text: "hi" }], "turn ended without a result"],
    ];
    for (const [steps, message] of cases) {
      const session = await h.create([steps]).runtime.start(spec());
      const events = await collect(session.send("go"));
      assert.deepEqual(events.filter((e) => e.type === "error" || e.type === "turn.completed"), [{ type: "error", message }]);
      assert.deepEqual(events.at(-1), { type: "error", message });
    }
  });

  test(name("interrupt() stops the running turn with an 'interrupted' error"), async () => {
    const fake = h.create([[{ kind: "message", text: "working" }, { kind: "hang" }]]);
    const session = await fake.runtime.start(spec());
    const done = collect(session.send("go"));
    await tick();
    await assert.rejects(collect(session.send("again")), /already running/);
    await session.interrupt();
    assert.deepEqual(await done, [
      { type: "message", text: "working" },
      { type: "error", message: "interrupted" },
    ]);
    await session.interrupt(); // no turn running: a no-op
  });

  test(name("a passed deadline aborts the turn"), async () => {
    const fake = h.create([[{ kind: "hang" }]]);
    const session = await fake.runtime.start(spec({ limits: { deadline: new Date(Date.now() + 20).toISOString() } }));
    assert.deepEqual(await collect(session.send("go")), [{ type: "error", message: "session deadline passed" }]);
  });

  test(name("a closed session takes no more turns"), async () => {
    const session = await h.create([]).runtime.start(spec());
    await session.close();
    await assert.rejects(collect(session.send("go")), /closed/);
  });

  test(name("tool approval goes through onToolApproval when supported"), async (t) => {
    const probe = h.create([]).runtime;
    if (!probe.capabilities.toolApproval) {
      t.skip("no per-tool approval");
      return;
    }
    const fake = h.create([
      [
        { kind: "approval", callId: "u1", command: "rm -rf /" },
        { kind: "approval", callId: "u2", command: "ls" },
        { kind: "complete", text: "ok", usage },
      ],
    ]);
    const asked: unknown[] = [];
    const session = await fake.runtime.start(
      spec({
        onToolApproval: async ({ reason: _reason, ...request }) => {
          asked.push(request);
          return (request.input as { command: string }).command === "ls"
            ? { behavior: "allow" }
            : { behavior: "deny", message: "too risky" };
        },
      }),
    );
    await collect(session.send("go"));
    assert.deepEqual(asked, [
      { callId: "u1", tool: h.shellTool, input: { command: "rm -rf /" } },
      { callId: "u2", tool: h.shellTool, input: { command: "ls" } },
    ]);
    assert.deepEqual(fake.decisions, [{ behavior: "deny", message: "too risky" }, { behavior: "allow" }]);
  });
}
