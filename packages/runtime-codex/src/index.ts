import { readFileSync } from "node:fs";
import { Codex, type CodexOptions, type ThreadEvent, type ThreadOptions, type TurnOptions } from "@openai/codex-sdk";
import type { Runtime, RuntimeSession, SendOptions, SessionEvent, SessionSpec } from "@bigtop/protocol";
import { TurnNormalizer } from "./normalize.ts";
import { killThreadProcesses } from "./orphans.ts";

export { TurnNormalizer } from "./normalize.ts";
export { killThreadProcesses } from "./orphans.ts";

/** The part of a Codex `Thread` this adapter uses. */
export interface CodexThread {
  readonly id: string | null;
  runStreamed(input: string, options?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

/** The part of the `Codex` class this adapter uses; tests pass a fake. */
export interface CodexClient {
  startThread(options?: ThreadOptions): CodexThread;
  resumeThread(id: string, options?: ThreadOptions): CodexThread;
}

export interface CodexRuntimeOptions {
  /** Creates the SDK client; called once per session with that session's options. */
  codex?: (options: CodexOptions) => CodexClient;
  /** The `codex` executable; defaults to the one bundled with the SDK. */
  codexPathOverride?: string;
  /** Stops commands an aborted turn left running; defaults to `killThreadProcesses` on Linux. */
  killOrphans?: (threadId: string) => Promise<unknown>;
}

function sdkVersion(): string {
  try {
    const entry = import.meta.resolve("@openai/codex-sdk");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
    return String(pkg.version);
  } catch {
    return "unknown";
  }
}

/**
 * Creates the Codex runtime. Without an injected `codex`, it checks right away
 * that the `codex` executable can be found and throws if not.
 */
export function createCodexRuntime(options: CodexRuntimeOptions = {}): Runtime {
  const codex = options.codex ?? ((o: CodexOptions) => new Codex(o));
  if (!options.codex) new Codex({ codexPathOverride: options.codexPathOverride });
  const killOrphans =
    options.killOrphans ?? (process.platform === "linux" ? killThreadProcesses : async () => {});

  const open = (spec: SessionSpec, id?: string): RuntimeSession => {
    const client = codex({
      codexPathOverride: options.codexPathOverride,
      // Appended to Codex's own instructions as a developer message.
      ...(spec.role.instructions ? { config: { developer_instructions: spec.role.instructions } } : {}),
    });
    const threadOptions: ThreadOptions = {
      model: spec.role.model,
      workingDirectory: spec.cwd,
      skipGitRepoCheck: true,
      // Codex cannot ask per tool call, so the sandbox is the whole boundary and
      // danger-full-access is never used.
      sandboxMode: spec.role.access === "read-only" ? "read-only" : "workspace-write",
      approvalPolicy: "never",
    };
    const thread = id ? client.resumeThread(id, threadOptions) : client.startThread(threadOptions);
    return new CodexSession(thread, spec, killOrphans);
  };
  return {
    kind: "codex",
    version: sdkVersion(),
    capabilities: { toolApproval: false, costUsd: false, maxTurns: false, maxCostUsd: false, structuredOutput: true, fork: false },
    start: async (spec) => open(spec),
    resume: async (id, spec) => open(spec, id),
  };
}

class CodexSession implements RuntimeSession {
  #thread: CodexThread;
  #spec: SessionSpec;
  #killOrphans: (threadId: string) => Promise<unknown>;
  #active: AbortController | undefined;
  #interrupted = false;
  #closed = false;

  constructor(thread: CodexThread, spec: SessionSpec, killOrphans: (threadId: string) => Promise<unknown>) {
    this.#thread = thread;
    this.#spec = spec;
    this.#killOrphans = killOrphans;
  }

  /** Codex assigns the id when the first turn starts. */
  get id(): string | undefined {
    return this.#thread.id ?? undefined;
  }

  async *send(input: string, options: SendOptions = {}): AsyncIterable<SessionEvent> {
    if (this.#closed) throw new Error("session is closed");
    if (this.#active) throw new Error("a turn is already running");

    const controller = new AbortController();
    this.#active = controller;
    this.#interrupted = false;
    const { deadline } = this.#spec.limits;
    const timer = deadline
      ? setTimeout(() => controller.abort(), Math.max(0, Date.parse(deadline) - Date.now()))
      : undefined;
    // Why the turn stopped early, if it did; replaces whatever error the SDK reports for it.
    const stopped = () =>
      this.#interrupted ? "interrupted" : controller.signal.aborted ? "session deadline passed" : undefined;

    const normalizer = new TurnNormalizer({ structured: options.outputSchema !== undefined });
    let ended = false;
    try {
      const { events } = await this.#thread.runStreamed(input, {
        signal: controller.signal,
        ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      for await (const raw of events) {
        for (const event of normalizer.push(raw)) {
          if (ended) continue;
          if (event.type === "turn.completed" || event.type === "error") ended = true;
          yield event.type === "error" ? { ...event, message: stopped() ?? event.message } : event;
        }
      }
      if (!ended) yield { type: "error", message: stopped() ?? "turn ended without a result" };
    } catch (err) {
      // After turn.failed the codex process also exits non-zero; that error adds nothing.
      if (!ended) yield { type: "error", message: stopped() ?? (err instanceof Error ? err.message : String(err)) };
    } finally {
      clearTimeout(timer);
      this.#active = undefined;
      // Aborting kills codex but not the command it was running.
      if (controller.signal.aborted && this.id) await this.#killOrphans(this.id).catch(() => {});
    }
  }

  async interrupt(): Promise<void> {
    if (!this.#active) return;
    this.#interrupted = true;
    this.#active.abort();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.interrupt();
  }
}
