import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type SDKMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Runtime,
  RuntimeSession,
  SendOptions,
  SessionEvent,
  SessionSpec,
} from "@bigtop/protocol";
import { normalize } from "./normalize.ts";

export { normalize } from "./normalize.ts";

/** The part of the SDK's `query()` this adapter uses; tests pass a fake. */
export type ClaudeQuery = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
};

export interface ClaudeRuntimeOptions {
  query?: ClaudeQuery;
  /**
   * Filesystem settings the session loads. Defaults to `["project"]`: the
   * workspace's CLAUDE.md and `.claude/settings.json`, but not the person's own
   * `~/.claude` settings, so sessions behave the same on every connector.
   */
  settingSources?: SettingSource[];
  pathToClaudeCodeExecutable?: string;
}

/** Write tools a read-only role never gets. Bash stays available but goes through approval. */
const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit"];

function sdkVersion(): string {
  try {
    const entry = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    const pkg = JSON.parse(readFileSync(new URL("package.json", entry), "utf8"));
    return String(pkg.version);
  } catch {
    return "unknown";
  }
}

export function createClaudeRuntime(options: ClaudeRuntimeOptions = {}): Runtime {
  const query = options.query ?? (sdkQuery as ClaudeQuery);
  const settingSources = options.settingSources ?? ["project"];
  const open = async (id: string, spec: SessionSpec, started: boolean): Promise<RuntimeSession> =>
    new ClaudeSession(id, spec, started, {
      query,
      settingSources,
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    });
  return {
    kind: "claude",
    version: sdkVersion(),
    capabilities: { toolApproval: true, costUsd: true, maxTurns: true, maxCostUsd: true, structuredOutput: true, fork: true },
    start: (spec) => open(randomUUID(), spec, false),
    resume: (id, spec) => open(id, spec, true),
  };
}

interface SessionDeps {
  query: ClaudeQuery;
  settingSources: SettingSource[];
  pathToClaudeCodeExecutable?: string;
}

class ClaudeSession implements RuntimeSession {
  readonly id: string;
  #spec: SessionSpec;
  #deps: SessionDeps;
  /** Whether the SDK has created the session, so later turns resume it instead of creating it. */
  #started: boolean;
  #active: ReturnType<ClaudeQuery> | undefined;
  #interrupted = false;
  #closed = false;

  constructor(id: string, spec: SessionSpec, started: boolean, deps: SessionDeps) {
    this.id = id;
    this.#spec = spec;
    this.#started = started;
    this.#deps = deps;
  }

  async *send(input: string, options: SendOptions = {}): AsyncIterable<SessionEvent> {
    if (this.#closed) throw new Error("session is closed");
    if (this.#active) throw new Error("a turn is already running");

    const abortController = new AbortController();
    const { deadline } = this.#spec.limits;
    const timer = deadline
      ? setTimeout(() => abortController.abort(), Math.max(0, Date.parse(deadline) - Date.now()))
      : undefined;

    const q = this.#deps.query({ prompt: input, options: this.#options(abortController, options) });
    this.#active = q;
    this.#interrupted = false;
    // Why the turn stopped early, if it did; replaces whatever error the SDK reports for it.
    const stopped = () =>
      this.#interrupted ? "interrupted" : abortController.signal.aborted ? "session deadline passed" : undefined;
    let ended = false;
    try {
      for await (const msg of q) {
        this.#started = true;
        for (const event of normalize(msg)) {
          if (ended) continue;
          if (event.type === "turn.completed" || event.type === "error") ended = true;
          yield event.type === "error" ? { ...event, message: stopped() ?? event.message } : event;
        }
      }
      if (!ended) yield { type: "error", message: stopped() ?? "turn ended without a result" };
    } catch (err) {
      if (!ended) yield { type: "error", message: stopped() ?? (err instanceof Error ? err.message : String(err)) };
    } finally {
      clearTimeout(timer);
      this.#active = undefined;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.#active) return;
    this.#interrupted = true;
    await this.#active.interrupt();
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.interrupt();
  }

  #options(abortController: AbortController, send: SendOptions): Options {
    const { cwd, role, limits, onToolApproval } = this.#spec;
    const canUseTool: CanUseTool | undefined = onToolApproval
      ? async (tool, input, { toolUseID, decisionReason }) => {
          const decision = await onToolApproval({ callId: toolUseID, tool, input, reason: decisionReason });
          return decision.behavior === "allow"
            ? { behavior: "allow", toolUseID }
            : { behavior: "deny", message: decision.message, toolUseID };
        }
      : undefined;
    return {
      cwd,
      model: role.model,
      systemPrompt: { type: "preset", preset: "claude_code", append: role.instructions },
      settingSources: this.#deps.settingSources,
      // Without canUseTool, calls that would ask are denied, which is what we want.
      permissionMode: role.access === "workspace-write" ? "acceptEdits" : "default",
      disallowedTools: role.access === "read-only" ? WRITE_TOOLS : [],
      canUseTool,
      maxTurns: limits.maxTurns,
      maxBudgetUsd: limits.maxCostUsd,
      abortController,
      outputFormat: send.outputSchema ? { type: "json_schema", schema: send.outputSchema } : undefined,
      pathToClaudeCodeExecutable: this.#deps.pathToClaudeCodeExecutable,
      ...(this.#started ? { resume: this.id } : { sessionId: this.id }),
    };
  }
}
