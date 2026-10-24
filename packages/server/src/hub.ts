import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  parseConnectorMessage,
  type Actor,
  type ConnectorCapabilities,
  type ConnectorMessage,
  type Envelope,
  type ServerMessage,
  type Source,
  type Task,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "@bigtop/protocol";
import { EventLog } from "./event-log.ts";
import type { DispatchPlan, Playbook } from "./playbook.ts";

export interface HubOptions {
  sources: Source[];
  playbook: Playbook;
  /** Connector id → shared secret. Only these connectors may connect. */
  connectorTokens: Record<string, string>;
  /** Heartbeat interval asked of connectors. */
  heartbeatMs?: number;
  /** A connector silent this long is dropped; its dispatches expire this long after it drops. */
  leaseMs?: number;
  /** An offer not accepted or declined in this time expires. */
  offerTimeoutMs?: number;
  /** After a decline or expiry, the same task is not offered to the same connector for this long. */
  retryCooldownMs?: number;
  events?: EventLog;
  log?: (line: string) => void;
}

/** A transport connection to one connector, as the hub sees it. */
export interface Connection {
  send(msg: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface ConnectionHandle {
  /** One text frame from the connector. */
  receive(text: string): void;
  /** The transport closed. */
  closed(): void;
}

interface ConnectorState {
  id: string;
  conn?: Connection;
  capabilities: ConnectorCapabilities;
  lastSeen: number;
  /** Fires when an offline connector's dispatches should expire. */
  expiry?: NodeJS.Timeout;
}

interface Dispatch {
  id: string;
  taskKey: string;
  task: Task;
  connectorId: string;
  plan: DispatchPlan;
  state: "offered" | "running";
  sessionId?: string;
  offerTimer?: NodeJS.Timeout;
  lastResult?: string;
  costUsd?: number;
}

interface PendingApproval {
  id: string;
  dispatchId: string;
  request: ToolApprovalRequest;
}

const SYSTEM: Actor = { kind: "system", id: "hub" };
const taskKey = (task: Task) => `${task.ref.source}:${task.ref.id}`;
const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * The server's core: authenticates connectors, keeps the task list from every
 * source, asks the playbook what to dispatch, leases work to connectors and
 * writes results back. Transport-agnostic: the WebSocket layer calls `connect`.
 */
export class Hub {
  readonly events: EventLog;
  #o: Required<Omit<HubOptions, "events" | "log">>;
  #log: (line: string) => void;
  #sources: Map<string, Source>;
  #tasks = new Map<string, Task>();
  #connectors = new Map<string, ConnectorState>();
  #dispatches = new Map<string, Dispatch>();
  #approvals = new Map<string, PendingApproval>();
  /** Tasks with a dispatch in flight or a result being written back. */
  #busy = new Set<string>();
  /** Tasks whose write-back failed; not dispatched again until restart. */
  #stuck = new Set<string>();
  #cooldown = new Map<string, number>();
  #skipped = new Map<string, string>();
  #unwatch: (() => void)[] = [];
  #sweep: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;
  #refreshAgain = false;
  #stopped = false;

  constructor(options: HubOptions) {
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#o = {
      sources: options.sources,
      playbook: options.playbook,
      connectorTokens: options.connectorTokens,
      heartbeatMs,
      leaseMs: options.leaseMs ?? heartbeatMs * 3,
      offerTimeoutMs: options.offerTimeoutMs ?? 30_000,
      retryCooldownMs: options.retryCooldownMs ?? 60_000,
    };
    this.events = options.events ?? new EventLog();
    this.#log = options.log ?? (() => {});
    this.#sources = new Map(options.sources.map((s) => [s.name, s]));
    if (this.#sources.size !== options.sources.length) throw new Error("source names must be unique");
  }

  async start(): Promise<void> {
    await this.refresh();
    for (const source of this.#o.sources) this.#unwatch.push(source.watch(() => void this.refresh()));
    this.#sweep = setInterval(() => this.#dropSilent(), this.#o.heartbeatMs);
  }

  stop(): void {
    this.#stopped = true;
    this.#unwatch.forEach((stop) => stop());
    clearInterval(this.#sweep);
    for (const d of this.#dispatches.values()) clearTimeout(d.offerTimer);
    for (const c of this.#connectors.values()) {
      clearTimeout(c.expiry);
      c.conn?.close(1001, "server stopping");
    }
  }

  /** Re-reads every source, then dispatches what it can. Concurrent calls coalesce. */
  async refresh(): Promise<void> {
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return this.#refreshing;
    }
    this.#refreshing = (async () => {
      do {
        this.#refreshAgain = false;
        for (const source of this.#o.sources) await this.#reload(source);
        this.#schedule();
      } while (this.#refreshAgain && !this.#stopped);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  connect(conn: Connection): ConnectionHandle {
    let connectorId: string | undefined;
    const current = () => (connectorId ? this.#connectors.get(connectorId) : undefined);
    return {
      receive: (text) => {
        let msg: ConnectorMessage;
        try {
          msg = parseConnectorMessage(text);
        } catch (err) {
          if (!(err instanceof ProtocolError)) throw err;
          conn.send({ type: "error", message: `malformed message: ${err.message}` });
          return;
        }
        if (!connectorId) {
          if (msg.type !== "hello") {
            conn.send({ type: "error", message: "send hello first", fatal: true });
            conn.close(4001, "hello required");
            return;
          }
          connectorId = this.#hello(conn, msg) ? msg.connectorId : undefined;
          return;
        }
        const state = current();
        // A newer connection for the same connector replaced this one.
        if (!state || state.conn !== conn) return;
        state.lastSeen = Date.now();
        this.#receive(state, msg);
      },
      closed: () => {
        const state = current();
        if (state && state.conn === conn) this.#offline(state, "connection closed");
      },
    };
  }

  /** Answers a pending approval. Returns false if it is unknown or already answered. */
  decide(approvalId: string, decision: ToolApprovalDecision, actor: Actor): boolean {
    const approval = this.#approvals.get(approvalId);
    if (!approval) return false;
    const dispatch = this.#dispatches.get(approval.dispatchId);
    const conn = dispatch && this.#connectors.get(dispatch.connectorId)?.conn;
    if (!dispatch || !conn) return false;
    this.#approvals.delete(approvalId);
    conn.send({ type: "approval.decision", approvalId, decision });
    this.events.append("approval.decided", actor, { decision }, this.#subject(dispatch, { approval: approvalId }));
    return true;
  }

  state() {
    return {
      connectors: [...this.#connectors.values()].map((c) => ({
        id: c.id,
        online: Boolean(c.conn),
        lastSeen: new Date(c.lastSeen).toISOString(),
        capabilities: c.capabilities,
        dispatches: this.#dispatchesOf(c.id).map((d) => d.id),
      })),
      dispatches: [...this.#dispatches.values()].map((d) => ({
        id: d.id,
        task: d.task.ref,
        connectorId: d.connectorId,
        state: d.state,
        sessionId: d.sessionId,
        role: d.plan.role.name,
        runtime: d.plan.runtime,
        workspace: d.plan.workspace,
      })),
      approvals: [...this.#approvals.values()],
      tasks: [...this.#tasks.entries()].map(([key, t]) => ({
        ...t.ref,
        status: t.status,
        busy: this.#busy.has(key),
        stuck: this.#stuck.has(key),
        skipped: this.#skipped.get(key),
      })),
    };
  }

  // connectors

  #hello(conn: Connection, hello: Extract<ConnectorMessage, { type: "hello" }>): boolean {
    const reject = (message: string) => {
      this.#log(`rejected connector ${hello.connectorId}: ${message}`);
      conn.send({ type: "error", message, fatal: true });
      conn.close(4003, message);
      return false;
    };
    if (hello.protocol !== PROTOCOL_VERSION) {
      return reject(`protocol ${hello.protocol} is not supported; this server speaks ${PROTOCOL_VERSION}`);
    }
    const expected = Object.hasOwn(this.#o.connectorTokens, hello.connectorId)
      ? this.#o.connectorTokens[hello.connectorId]
      : undefined;
    if (expected === undefined || !timingSafeEqual(digest(expected), digest(hello.token))) {
      return reject("unknown connector or wrong token");
    }

    const existing = this.#connectors.get(hello.connectorId);
    if (existing?.conn) existing.conn.close(4000, "replaced by a new connection");
    clearTimeout(existing?.expiry);
    const state: ConnectorState = { id: hello.connectorId, conn, capabilities: hello.capabilities, lastSeen: Date.now() };
    this.#connectors.set(state.id, state);
    conn.send({ type: "welcome", connectorId: state.id, heartbeatMs: this.#o.heartbeatMs });
    this.events.append("connector.online", this.#actor(state), { capabilities: hello.capabilities, active: hello.active }, { connector: state.id });
    this.#log(`connector ${state.id} online`);

    // Dispatches the connector no longer knows about were lost while it was away.
    const active = new Set(hello.active);
    for (const d of this.#dispatchesOf(state.id)) {
      if (!active.has(d.id)) this.#expire(d, "connector reconnected without it");
    }
    this.#schedule();
    return true;
  }

  #offline(state: ConnectorState, reason: string): void {
    state.conn = undefined;
    this.events.append("connector.offline", this.#actor(state), { reason }, { connector: state.id });
    this.#log(`connector ${state.id} offline: ${reason}`);
    clearTimeout(state.expiry);
    // stop() closes every connection; a grace timer started then would keep the process alive.
    if (this.#stopped) return;
    state.expiry = setTimeout(() => {
      for (const d of this.#dispatchesOf(state.id)) this.#expire(d, "connector did not come back");
    }, this.#o.leaseMs);
  }

  #dropSilent(): void {
    const now = Date.now();
    for (const state of this.#connectors.values()) {
      if (state.conn && now - state.lastSeen > this.#o.leaseMs) {
        const conn = state.conn;
        this.#offline(state, "heartbeat timed out");
        conn.close(4008, "heartbeat timed out");
      }
    }
  }

  #receive(state: ConnectorState, msg: ConnectorMessage): void {
    if (msg.type === "heartbeat" || msg.type === "hello") return;
    const dispatch = this.#dispatches.get(msg.dispatchId);
    if (!dispatch || dispatch.connectorId !== state.id) {
      // Work we no longer track (expired, or never ours): tell the connector to stop it.
      if (msg.type === "dispatch.accept" || msg.type === "session.event" || msg.type === "approval.request") {
        state.conn?.send({ type: "session.interrupt", dispatchId: msg.dispatchId });
      }
      this.#log(`ignored ${msg.type} for unknown dispatch ${msg.dispatchId} from ${state.id}`);
      return;
    }
    const actor = this.#actor(state);
    switch (msg.type) {
      case "dispatch.accept":
        clearTimeout(dispatch.offerTimer);
        dispatch.state = "running";
        dispatch.sessionId = msg.sessionId;
        this.events.append("dispatch.accepted", actor, {}, this.#subject(dispatch));
        return;
      case "dispatch.decline":
        this.#retryLater(dispatch);
        this.#drop(dispatch);
        this.events.append("dispatch.declined", actor, { reason: msg.reason }, this.#subject(dispatch));
        this.#schedule();
        return;
      case "session.event":
        if (msg.event.type === "turn.completed") {
          dispatch.lastResult = msg.event.result;
          dispatch.costUsd = msg.event.usage.costUsd;
        }
        this.events.append("session.event", actor, { seq: msg.seq, event: msg.event }, this.#subject(dispatch));
        return;
      case "approval.request":
        this.#approvals.set(msg.approvalId, { id: msg.approvalId, dispatchId: dispatch.id, request: msg.request });
        this.events.append("approval.requested", actor, { request: msg.request }, this.#subject(dispatch, { approval: msg.approvalId }));
        return;
      case "session.ended":
        this.events.append("session.ended", actor, { outcome: msg.outcome, error: msg.error }, this.#subject(dispatch));
        this.#drop(dispatch, { keepBusy: true });
        void this.#finish(dispatch, msg);
        return;
    }
  }

  // tasks and dispatches

  async #reload(source: Source): Promise<void> {
    let tasks: Task[];
    try {
      tasks = await source.list();
    } catch (err) {
      this.#log(`listing ${source.name} failed: ${(err as Error).message}`);
      return;
    }
    const seen = new Set<string>();
    for (const task of tasks) {
      const key = taskKey(task);
      seen.add(key);
      const before = this.#tasks.get(key);
      this.#tasks.set(key, task);
      if (!before) {
        this.events.append("task.discovered", SYSTEM, { task: task.ref, status: task.status }, { task: key });
      } else if (before.status !== task.status) {
        this.events.append("task.updated", SYSTEM, { task: task.ref, status: task.status, was: before.status }, { task: key });
      }
    }
    for (const [key, task] of this.#tasks) {
      if (task.ref.source === source.name && !seen.has(key)) {
        this.#tasks.delete(key);
        this.events.append("task.removed", SYSTEM, { task: task.ref }, { task: key });
      }
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    for (const [key, task] of this.#tasks) {
      if (task.status !== "open" || this.#busy.has(key) || this.#stuck.has(key)) continue;
      const plan = this.#o.playbook.plan(task);
      if ("skip" in plan) {
        if (this.#skipped.get(key) !== plan.skip) {
          this.#skipped.set(key, plan.skip);
          this.events.append("task.skipped", SYSTEM, { reason: plan.skip }, { task: key });
        }
        continue;
      }
      this.#skipped.delete(key);
      const connector = this.#pick(key, plan);
      if (connector) this.#offer(key, task, plan, connector);
    }
  }

  #pick(key: string, plan: DispatchPlan): ConnectorState | undefined {
    const now = Date.now();
    let best: ConnectorState | undefined;
    let bestFree = 0;
    for (const c of this.#connectors.values()) {
      if (!c.conn) continue;
      if (!c.capabilities.runtimes.some((r) => r.kind === plan.runtime)) continue;
      if (!c.capabilities.workspaces.includes(plan.workspace)) continue;
      if ((this.#cooldown.get(`${key}|${c.id}`) ?? 0) > now) continue;
      const free = c.capabilities.slots - this.#dispatchesOf(c.id).length;
      if (free > bestFree) {
        best = c;
        bestFree = free;
      }
    }
    return best;
  }

  #offer(key: string, task: Task, plan: DispatchPlan, connector: ConnectorState): void {
    const dispatch: Dispatch = { id: randomUUID(), taskKey: key, task, connectorId: connector.id, plan, state: "offered" };
    this.#dispatches.set(dispatch.id, dispatch);
    this.#busy.add(key);
    dispatch.offerTimer = setTimeout(() => {
      if (dispatch.state === "offered") this.#expire(dispatch, "offer was not answered in time");
    }, this.#o.offerTimeoutMs);
    connector.conn!.send({
      type: "dispatch.offer",
      dispatchId: dispatch.id,
      task: task.ref,
      role: plan.role,
      runtime: plan.runtime,
      workspace: plan.workspace,
      prompt: plan.prompt,
      limits: plan.limits,
    });
    this.events.append(
      "dispatch.offered",
      SYSTEM,
      { role: plan.role.name, runtime: plan.runtime, workspace: plan.workspace },
      this.#subject(dispatch),
    );
  }

  #expire(dispatch: Dispatch, reason: string): void {
    if (!this.#dispatches.has(dispatch.id)) return;
    this.#connectors.get(dispatch.connectorId)?.conn?.send({ type: "session.interrupt", dispatchId: dispatch.id });
    this.#retryLater(dispatch);
    this.#drop(dispatch);
    this.events.append("dispatch.expired", SYSTEM, { reason }, this.#subject(dispatch));
    this.#schedule();
  }

  #retryLater(dispatch: Dispatch): void {
    this.#cooldown.set(`${dispatch.taskKey}|${dispatch.connectorId}`, Date.now() + this.#o.retryCooldownMs);
  }

  /** Forgets a dispatch and its approvals. The task stays busy if `keepBusy`. */
  #drop(dispatch: Dispatch, { keepBusy = false } = {}): void {
    clearTimeout(dispatch.offerTimer);
    this.#dispatches.delete(dispatch.id);
    for (const [id, a] of this.#approvals) if (a.dispatchId === dispatch.id) this.#approvals.delete(id);
    if (!keepBusy) this.#busy.delete(dispatch.taskKey);
  }

  async #finish(dispatch: Dispatch, ended: Extract<ConnectorMessage, { type: "session.ended" }>): Promise<void> {
    const update = this.#o.playbook.finish(dispatch.task, {
      outcome: ended.outcome,
      sessionId: ended.sessionId,
      result: dispatch.lastResult,
      error: ended.error,
      costUsd: dispatch.costUsd,
    });
    const source = this.#sources.get(dispatch.task.ref.source);
    try {
      if (!source) throw new Error(`source ${dispatch.task.ref.source} is gone`);
      await source.update(dispatch.task.ref.id, update);
      this.events.append("task.written", SYSTEM, { update }, this.#subject(dispatch));
    } catch (err) {
      this.#stuck.add(dispatch.taskKey);
      this.events.append("task.write_failed", SYSTEM, { update, error: (err as Error).message }, this.#subject(dispatch));
      this.#log(`writing back ${dispatch.taskKey} failed: ${(err as Error).message}`);
    }
    // Re-read before releasing the task, so its old "open" status cannot dispatch it again.
    if (source) await this.#reload(source);
    this.#busy.delete(dispatch.taskKey);
    this.#schedule();
  }

  // helpers

  #dispatchesOf(connectorId: string): Dispatch[] {
    return [...this.#dispatches.values()].filter((d) => d.connectorId === connectorId);
  }

  #actor(state: ConnectorState): Actor {
    return { kind: "connector", id: state.id };
  }

  #subject(dispatch: Dispatch, extra: Envelope["subject"] = {}): Envelope["subject"] {
    return {
      task: dispatch.taskKey,
      dispatch: dispatch.id,
      connector: dispatch.connectorId,
      ...(dispatch.sessionId ? { session: dispatch.sessionId } : {}),
      ...extra,
    };
  }
}
