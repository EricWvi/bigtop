import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { OpenCode, type PermissionRule, type V2Event } from "@opencode/client";
import type {
  RoleAccess,
  Runtime,
  RuntimeSession,
  SendOptions,
  SessionEvent,
  SessionSpec,
  ToolApprovalRequest,
} from "@bigtop/protocol";
import { TurnNormalizer } from "./normalize.ts";
import { LocalServer, type Endpoint, type LocalServerOptions } from "./server.ts";

export { TurnNormalizer } from "./normalize.ts";
export { LocalServer, parseServeLine, type Endpoint, type LocalServerOptions } from "./server.ts";

type Client = ReturnType<typeof OpenCode.make>;

/** The part of the `@opencode/client` client this adapter uses; tests pass a fake. */
export interface OpencodeClient {
  session: Pick<Client["session"], "create" | "update" | "switchModel" | "prompt" | "interrupt"> & {
    instructions: { entry: Pick<Client["session"]["instructions"]["entry"], "put"> };
  };
  permission: Pick<Client["permission"], "reply">;
  event: Pick<Client["event"], "subscribe">;
}

export interface OpencodeRuntimeOptions {
  /** Use this running server instead of starting a private `opencode serve`. */
  endpoint?: Endpoint;
  /** How to run the private server. */
  server?: LocalServerOptions;
  /** Creates the client for an endpoint; defaults to `@opencode/client`. */
  client?: (endpoint: Endpoint) => OpencodeClient;
}

/** The key under which the role's instructions are stored on a session. */
const INSTRUCTIONS_KEY = "bigtop";

/**
 * Session permissions, appended to the agent's own (the last matching rule
 * wins). Like Claude's presets: shell commands and paths outside the workspace
 * ask; read-only roles cannot edit; nobody is there to answer questions.
 */
export function permissionsFor(access: RoleAccess): PermissionRule[] {
  const rules: PermissionRule[] = [
    { action: "shell", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "question", resource: "*", effect: "deny" },
  ];
  if (access === "read-only") rules.push({ action: "edit", resource: "*", effect: "deny" });
  return rules;
}

/** OpenCode models are written `provider/model`. */
export function parseModel(model: string): { providerID: string; id: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) throw new Error(`OpenCode models are written provider/model, got "${model}"`);
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function clientVersion(): string {
  try {
    const entry = import.meta.resolve("@opencode/client");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", entry), "utf8"));
    return String(pkg.version);
  } catch {
    return "unknown";
  }
}

/** The installed `opencode` version; throws unless it is 2.x, the server this adapter speaks to. */
function cliVersion(command: string): string {
  let out: string;
  try {
    out = execFileSync(command, ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw new Error(`cannot run ${command}: ${(err as Error).message}`);
  }
  const version = /(\d+)\.\d+\.\d+\S*/.exec(out)?.[0];
  if (!version) throw new Error(`cannot read the version of ${command} from ${JSON.stringify(out.trim())}`);
  if (!version.startsWith("2.")) throw new Error(`opencode ${version} is not supported; bigtop needs OpenCode 2.x`);
  return version;
}

function defaultClient(endpoint: Endpoint): OpencodeClient {
  const auth = endpoint.password
    ? { authorization: `Basic ${Buffer.from(`${endpoint.username ?? "opencode"}:${endpoint.password}`).toString("base64")}` }
    : undefined;
  return OpenCode.make({ baseUrl: endpoint.url, ...(auth ? { headers: auth } : {}) });
}

/**
 * Creates the OpenCode runtime. Without an `endpoint` it runs a private
 * `opencode serve`, and checks right away that `opencode` 2.x is installed.
 */
export function createOpencodeRuntime(options: OpencodeRuntimeOptions = {}): Runtime {
  const makeClient = options.client ?? defaultClient;
  const server = options.endpoint ? undefined : new LocalServer(options.server);
  const version = options.endpoint || options.client ? clientVersion() : cliVersion(options.server?.command ?? "opencode");

  const connect = async (): Promise<{ client: OpencodeClient; release: () => void }> => {
    if (!server) return { client: makeClient(options.endpoint!), release: () => {} };
    const endpoint = await server.acquire();
    return { client: makeClient(endpoint), release: () => server.release() };
  };

  const open = async (spec: SessionSpec, resumeId?: string): Promise<RuntimeSession> => {
    const model = spec.role.model ? parseModel(spec.role.model) : undefined;
    const permissions = permissionsFor(spec.role.access);
    const { client, release } = await connect();
    try {
      let id: string;
      if (resumeId) {
        id = resumeId;
        await client.session.update({ sessionID: id, permissions });
        if (model) await client.session.switchModel({ sessionID: id, model });
      } else {
        const created = await client.session.create({ location: { directory: spec.cwd }, permissions, ...(model ? { model } : {}) });
        id = created.id;
      }
      // Always written, so a resumed session does not keep another role's instructions.
      await client.session.instructions.entry.put({ sessionID: id, key: INSTRUCTIONS_KEY, value: spec.role.instructions ?? "" });
      return new OpencodeSession(client, id, spec, release);
    } catch (err) {
      release();
      throw err;
    }
  };

  return {
    kind: "opencode",
    version,
    // Limits are enforced by interrupting the session between steps.
    capabilities: { toolApproval: true, costUsd: true, maxTurns: true, maxCostUsd: true, structuredOutput: false, fork: true },
    start: (spec) => open(spec),
    resume: (id, spec) => open(spec, id),
  };
}

const TERMINAL = new Set(["turn.completed", "error"]);

class OpencodeSession implements RuntimeSession {
  readonly id: string;
  #client: OpencodeClient;
  #spec: SessionSpec;
  #release: (() => void) | undefined;
  #active: { stop: (reason: string) => Promise<void> } | undefined;
  #closed = false;

  constructor(client: OpencodeClient, id: string, spec: SessionSpec, release: () => void) {
    this.#client = client;
    this.id = id;
    this.#spec = spec;
    this.#release = release;
  }

  async *send(input: string, options: SendOptions = {}): AsyncIterable<SessionEvent> {
    if (this.#closed) throw new Error("session is closed");
    if (this.#active) throw new Error("a turn is already running");
    if (options.outputSchema) {
      yield { type: "error", message: "OpenCode has no structured output; this turn needs a runtime that does" };
      return;
    }

    const controller = new AbortController();
    // Why bigtop stopped the turn, if it did; replaces the error OpenCode reports for it.
    let stopped: string | undefined;
    const stop = async (reason: string) => {
      stopped ??= reason;
      await this.#client.session.interrupt({ sessionID: this.id }).catch(() => {});
    };
    this.#active = { stop };
    const { deadline, maxTurns, maxCostUsd } = this.#spec.limits;
    const timer = deadline
      ? setTimeout(() => void stop("session deadline passed"), Math.max(0, Date.parse(deadline) - Date.now()))
      : undefined;

    const normalizer = new TurnNormalizer(this.#spec.cwd);
    // Subagent sessions started by this one: their permission requests are ours to answer.
    const children = new Set<string>();
    const events = this.#client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    let ended = false;
    try {
      // The subscription connects lazily; its first event says it is live, so nothing is missed.
      await events.next();
      await this.#client.session.prompt({ sessionID: this.id, text: input });
      for (;;) {
        const next = await events.next();
        if (next.done) break;
        const event = next.value as V2Event;
        if (event.type === "session.created" && event.data.parentID && (event.data.parentID === this.id || children.has(event.data.parentID))) {
          children.add(event.data.sessionID);
          continue;
        }
        if (event.type === "permission.asked" && (event.data.sessionID === this.id || children.has(event.data.sessionID))) {
          void this.#answer(event, normalizer);
          continue;
        }
        if (!("data" in event) || (event.data as { sessionID?: string }).sessionID !== this.id) continue;
        for (const out of normalizer.push(event)) {
          if (out.kind === "step") {
            const { step } = out;
            if (step.continues && maxTurns !== undefined && step.steps >= maxTurns) void stop(`max turns (${maxTurns}) reached`);
            if (step.continues && maxCostUsd !== undefined && step.costUsd >= maxCostUsd) void stop(`max cost ($${maxCostUsd}) reached`);
            continue;
          }
          const e = out.event;
          if (TERMINAL.has(e.type)) ended = true;
          yield e.type === "error" ? { ...e, message: stopped ?? e.message } : e;
        }
        if (ended) break;
      }
      if (!ended) yield { type: "error", message: stopped ?? "turn ended without a result" };
    } catch (err) {
      if (!ended) yield { type: "error", message: stopped ?? (err instanceof Error ? err.message : String(err)) };
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.#active = undefined;
    }
  }

  async #answer(event: Extract<V2Event, { type: "permission.asked" }>, normalizer: TurnNormalizer): Promise<void> {
    const { id: requestID, sessionID, action, resources, source, message } = event.data;
    const callId = source?.type === "tool" ? source.id : requestID;
    const request: ToolApprovalRequest = {
      callId,
      tool: action,
      input: normalizer.toolInput(callId) ?? { resources },
      ...(message ? { reason: message } : {}),
    };
    const decision = this.#spec.onToolApproval
      ? await this.#spec.onToolApproval(request).catch((err) => ({ behavior: "deny" as const, message: String(err) }))
      : { behavior: "deny" as const, message: "No approver is available." };
    await this.#client.permission
      .reply(
        decision.behavior === "allow"
          ? { sessionID, requestID, decision: "once" }
          : { sessionID, requestID, decision: "reject", message: decision.message },
      )
      .catch(() => {});
  }

  async interrupt(): Promise<void> {
    await this.#active?.stop("interrupted");
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.interrupt();
    this.#release?.();
    this.#release = undefined;
  }
}
