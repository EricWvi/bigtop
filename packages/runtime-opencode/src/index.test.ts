import assert from "node:assert/strict";
import { test } from "node:test";
import type { V2Event } from "@opencode/client";
import type { SessionEvent, SessionSpec, ToolApprovalRequest } from "@bigtop/protocol";
import { fakeServer } from "./fake.ts";
import { createOpencodeRuntime, parseModel, permissionsFor } from "./index.ts";

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  cwd: "/work",
  role: { name: "implementer", access: "workspace-write", instructions: "be careful", model: "deepseek/flash" },
  limits: {},
  ...over,
});

const ev = (type: string, data: Record<string, unknown>) => ({ type, data }) as unknown as V2Event;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const { raw: _raw, ...event } of stream) events.push(event as SessionEvent);
  return events;
}

function setup(script: Parameters<typeof fakeServer>[0] = []) {
  const fake = fakeServer(script);
  const runtime = createOpencodeRuntime({ endpoint: { url: "http://fake" }, client: () => fake.client });
  return { fake, runtime };
}

test("roles map onto session permissions; models are provider/model", () => {
  const ask = (action: string) => ({ action, resource: "*", effect: "ask" });
  assert.deepEqual(permissionsFor("workspace-write"), [ask("shell"), ask("external_directory"), { action: "question", resource: "*", effect: "deny" }]);
  assert.deepEqual(permissionsFor("read-only").at(-1), { action: "edit", resource: "*", effect: "deny" });
  assert.deepEqual(parseModel("deepseek/deepseek-flash"), { providerID: "deepseek", id: "deepseek-flash" });
  assert.deepEqual(parseModel("openrouter/a/b"), { providerID: "openrouter", id: "a/b" });
  for (const bad of ["flash", "/flash", "deepseek/"]) assert.throws(() => parseModel(bad), /provider\/model/);
});

test("start creates a session; resume re-applies the role to the existing one", async () => {
  const { fake, runtime } = setup();
  const started = await runtime.start(spec());
  const id = started.id!;
  assert.deepEqual(fake.sessions.get(id), {
    created: true,
    directory: "/work",
    model: "deepseek/flash",
    permissions: permissionsFor("workspace-write"),
    instructions: "be careful",
    prompts: 0,
  });
  await runtime.resume(id, spec({ role: { name: "reviewer", access: "read-only" } }));
  assert.deepEqual(fake.sessions.get(id)?.permissions, permissionsFor("read-only"));
  assert.equal(fake.sessions.get(id)?.instructions, undefined, "the old role's instructions are cleared");
  assert.equal(fake.sessions.size, 1);
});

test("maxTurns and maxCostUsd interrupt the session between steps", async () => {
  const step = (sessionID: string, cost: number) =>
    ev("session.step.ended", {
      sessionID,
      assistantMessageID: "m",
      finish: "tool-calls",
      cost,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      files: [],
    });
  for (const [limits, steps, message] of [
    [{ maxTurns: 2 }, [0, 0], "max turns (2) reached"],
    [{ maxCostUsd: 0.5 }, [0.3, 0.3], "max cost ($0.5) reached"],
  ] as const) {
    const { fake, runtime } = setup([[{ kind: "hang" }]]);
    const session = await runtime.start(spec({ limits }));
    const done = collect(session.send("go"));
    await tick();
    fake.emit(step(session.id!, steps[0]));
    await tick();
    assert.deepEqual(fake.interrupts, [], "not yet");
    fake.emit(step(session.id!, steps[1]));
    assert.deepEqual(await done, [{ type: "error", message }]);
    assert.deepEqual(fake.interrupts, [session.id]);
  }
});

test("reports files a step changed, resolved against the workspace", async () => {
  const { fake, runtime } = setup([[{ kind: "hang" }]]);
  const session = await runtime.start(spec());
  const done = collect(session.send("go"));
  await tick();
  fake.emit(
    ev("session.step.ended", {
      sessionID: session.id,
      assistantMessageID: "m",
      finish: "stop",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      files: ["src/a.ts"],
    }),
  );
  fake.emit(ev("session.execution.succeeded", { sessionID: session.id }));
  const events = await done;
  assert.deepEqual(events[0], { type: "file.changed", path: "/work/src/a.ts", kind: "update" });
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("answers permission requests from subagent sessions, and denies without an approver", async () => {
  const { fake, runtime } = setup([[{ kind: "hang" }]]);
  const asked: ToolApprovalRequest[] = [];
  const replies: unknown[] = [];
  const reply = fake.client.permission.reply;
  fake.client.permission.reply = async (input) => {
    replies.push(input);
    return reply(input);
  };
  const session = await runtime.start(
    spec({
      onToolApproval: async (request) => {
        asked.push(request);
        return { behavior: "allow" };
      },
    }),
  );
  const done = collect(session.send("go"));
  await tick();
  fake.emit(ev("session.created", { sessionID: "child", parentID: session.id }));
  fake.emit(ev("permission.asked", { id: "per_1", sessionID: "child", action: "webfetch", resources: ["https://x"], message: "fetch?" }));
  fake.emit(ev("permission.asked", { id: "per_2", sessionID: "stranger", action: "shell", resources: ["ls"] }));
  await tick();
  assert.deepEqual(asked, [{ callId: "per_1", tool: "webfetch", input: { resources: ["https://x"] }, reason: "fetch?" }]);
  assert.deepEqual(replies, [{ sessionID: "child", requestID: "per_1", decision: "once" }]);
  await session.interrupt();
  await done;

  const bare = setup([[{ kind: "approval", callId: "c1", command: "ls" }, { kind: "hang" }]]);
  const s2 = await bare.runtime.start(spec());
  const turn = collect(s2.send("go"));
  await tick();
  assert.deepEqual(bare.fake.decisions, [{ behavior: "deny", message: "No approver is available." }]);
  await s2.interrupt();
  await turn;
});
