import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type ConnectorMessage,
  type DispatchOffer,
  type Heartbeat,
  type Hello,
  type Runtime,
  type RuntimeKind,
  type RuntimeSession,
  type ServerMessage,
  type SessionOutcome,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "@bigtop/protocol";

export interface ConnectorOptions {
  id: string;
  token: string;
  /** How many sessions may run at once. */
  slots: number;
  /** Workspace name → local directory. Offers can only name these. */
  workspaces: Record<string, string>;
  runtimes: Runtime[];
  /** Delivers a message to the server; the transport buffers while disconnected. */
  send: (msg: ConnectorMessage) => void;
  /** How long a tool call waits for the server's decision before it is denied. */
  approvalTimeoutMs?: number;
  /** Forward the SDK's original events too. Off by default: they are large. */
  keepRaw?: boolean;
  log?: (line: string) => void;
}

interface ActiveDispatch {
  session?: RuntimeSession;
  interrupted: boolean;
  done: Promise<void>;
}

interface PendingApproval {
  dispatchId: string;
  resolve: (decision: ToolApprovalDecision) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

/**
 * Runs the sessions the server dispatches. Transport-agnostic: feed it server
 * messages through `handle()` and it replies through `options.send`.
 */
export class Connector {
  #options: ConnectorOptions;
  #runtimes: Map<RuntimeKind, Runtime>;
  #active = new Map<string, ActiveDispatch>();
  #approvals = new Map<string, PendingApproval>();
  #log: (line: string) => void;

  constructor(options: ConnectorOptions) {
    if (!(options.slots >= 1)) throw new Error("slots must be at least 1");
    this.#options = options;
    this.#runtimes = new Map(options.runtimes.map((r) => [r.kind, r]));
    this.#log = options.log ?? (() => {});
  }

  get activeDispatches(): string[] {
    return [...this.#active.keys()];
  }

  hello(): Hello {
    return {
      type: "hello",
      protocol: PROTOCOL_VERSION,
      connectorId: this.#options.id,
      token: this.#options.token,
      capabilities: {
        runtimes: this.#options.runtimes.map((r) => ({ kind: r.kind, version: r.version, capabilities: r.capabilities })),
        slots: this.#options.slots,
        workspaces: Object.keys(this.#options.workspaces),
        platform: process.platform,
      },
      active: this.activeDispatches,
    };
  }

  heartbeat(): Heartbeat {
    return { type: "heartbeat", active: this.activeDispatches };
  }

  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "dispatch.offer":
        this.#offer(msg);
        return;
      case "session.interrupt": {
        const active = this.#active.get(msg.dispatchId);
        if (!active) return this.#log(`interrupt for unknown dispatch ${msg.dispatchId}`);
        active.interrupted = true;
        active.session?.interrupt().catch((err) => this.#log(`interrupt failed: ${err}`));
        return;
      }
      case "approval.decision": {
        const pending = this.#approvals.get(msg.approvalId);
        if (!pending) return this.#log(`decision for unknown approval ${msg.approvalId}`);
        this.#settleApproval(msg.approvalId, msg.decision);
        return;
      }
      case "welcome":
      case "error":
        // Connection-level messages; the transport handles them.
        return;
    }
  }

  /** Waits for every running session to end on its own. */
  async drain(): Promise<void> {
    await Promise.all([...this.#active.values()].map((a) => a.done));
  }

  /** Interrupts every running session and waits for them to end. */
  async shutdown(): Promise<void> {
    for (const [id, active] of this.#active) {
      active.interrupted = true;
      active.session?.interrupt().catch((err) => this.#log(`interrupt ${id} failed: ${err}`));
    }
    await this.drain();
  }

  #offer(offer: DispatchOffer): void {
    const decline = (reason: string) => {
      this.#log(`declined ${offer.dispatchId}: ${reason}`);
      this.#options.send({ type: "dispatch.decline", dispatchId: offer.dispatchId, reason });
    };
    if (this.#active.has(offer.dispatchId)) return decline("dispatch is already running");
    if (this.#active.size >= this.#options.slots) return decline("no free slot");
    const runtime = this.#runtimes.get(offer.runtime);
    if (!runtime) return decline(`runtime ${offer.runtime} is not available`);
    const cwd = Object.hasOwn(this.#options.workspaces, offer.workspace)
      ? this.#options.workspaces[offer.workspace]
      : undefined;
    if (!cwd) return decline(`unknown workspace ${offer.workspace}`);

    // Reserve the slot synchronously so concurrent offers see it taken.
    const active: ActiveDispatch = { interrupted: false, done: Promise.resolve() };
    this.#active.set(offer.dispatchId, active);
    active.done = this.#run(offer, runtime, cwd, active, decline).finally(() => {
      this.#active.delete(offer.dispatchId);
    });
  }

  async #run(
    offer: DispatchOffer,
    runtime: Runtime,
    cwd: string,
    active: ActiveDispatch,
    decline: (reason: string) => void,
  ): Promise<void> {
    const { dispatchId } = offer;
    const spec = {
      cwd,
      role: offer.role,
      limits: offer.limits,
      onToolApproval: runtime.capabilities.toolApproval
        ? (request: ToolApprovalRequest) => this.#requestApproval(dispatchId, request)
        : undefined,
    };

    let session: RuntimeSession;
    try {
      session = offer.resume ? await runtime.resume(offer.resume, spec) : await runtime.start(spec);
    } catch (err) {
      return decline(`failed to start session: ${errorMessage(err)}`);
    }
    active.session = session;
    this.#options.send({ type: "dispatch.accept", dispatchId, sessionId: session.id });
    this.#log(`accepted ${dispatchId} as ${runtime.kind} session ${session.id}`);
    if (active.interrupted) await session.interrupt().catch(() => {});

    let outcome: SessionOutcome = "completed";
    let error: string | undefined;
    let seq = 0;
    try {
      for await (const event of session.send(offer.prompt)) {
        const sent = this.#options.keepRaw ? event : withoutRaw(event);
        this.#options.send({ type: "session.event", dispatchId, seq: seq++, event: sent });
        if (event.type === "error") {
          outcome = "failed";
          error = event.message;
        }
      }
    } catch (err) {
      outcome = "failed";
      error = errorMessage(err);
    }
    if (active.interrupted) outcome = "interrupted";

    await session.close().catch((err) => this.#log(`close ${dispatchId} failed: ${err}`));
    for (const [approvalId, pending] of this.#approvals) {
      if (pending.dispatchId === dispatchId) this.#settleApproval(approvalId, { behavior: "deny", message: "session ended" });
    }
    this.#options.send({ type: "session.ended", dispatchId, sessionId: session.id, outcome, ...(error ? { error } : {}) });
    this.#log(`ended ${dispatchId}: ${outcome}${error ? ` (${error})` : ""}`);
  }

  #requestApproval(dispatchId: string, request: ToolApprovalRequest): Promise<ToolApprovalDecision> {
    const approvalId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.#settleApproval(approvalId, { behavior: "deny", message: "approval timed out" }),
        this.#options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
      );
      this.#approvals.set(approvalId, { dispatchId, resolve, timer });
      this.#options.send({ type: "approval.request", dispatchId, approvalId, request });
    });
  }

  #settleApproval(approvalId: string, decision: ToolApprovalDecision): void {
    const pending = this.#approvals.get(approvalId);
    if (!pending) return;
    this.#approvals.delete(approvalId);
    clearTimeout(pending.timer);
    pending.resolve(decision);
  }
}

function withoutRaw<T extends { raw?: unknown }>(event: T): T {
  const { raw: _raw, ...rest } = event;
  return rest as T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
