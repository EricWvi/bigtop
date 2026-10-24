// A fake OpenCode server for tests: it plays SDK-neutral contract steps as the
// v2 events a real server would send.

import type { PermissionRule, V2Event } from "@opencode/client";
import type { ToolApprovalDecision } from "@bigtop/protocol";
import type { ObservedTurn, Step } from "@bigtop/runtime-contract";
import type { OpencodeClient } from "./index.ts";

interface FakeSessionState {
  directory?: string;
  model?: string;
  permissions?: PermissionRule[];
  instructions?: string;
  prompts: number;
  created: boolean;
}

/** Builds an event without the envelope fields the adapter ignores. */
const ev = (type: string, data: Record<string, unknown>) => ({ type, data }) as unknown as V2Event;

export interface FakeServer {
  client: OpencodeClient;
  turns: ObservedTurn[];
  decisions: ToolApprovalDecision[];
  sessions: Map<string, FakeSessionState>;
  /** Calls to session.interrupt, by session id. */
  interrupts: string[];
  /** Pushes an event to every open subscription. */
  emit(event: V2Event): void;
}

export function fakeServer(script: Step[][]): FakeServer {
  const turns: ObservedTurn[] = [];
  const decisions: ToolApprovalDecision[] = [];
  const sessions = new Map<string, FakeSessionState>();
  const interrupts: string[] = [];
  const subscribers = new Set<(event: V2Event | Error | null) => void>();
  const replies = new Map<string, (decision: ToolApprovalDecision) => void>();
  let interrupted: (() => void) | undefined;
  let nextSession = 0;

  const emit = (event: V2Event | Error | null) => subscribers.forEach((push) => push(event));
  const state = (id: string) => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { prompts: 0, created: false }));
    return s;
  };

  async function play(sessionID: string, steps: Step[]) {
    const assistantMessageID = "msg_1";
    const base = { sessionID, assistantMessageID };
    await Promise.resolve();
    emit(ev("session.execution.started", { sessionID }));
    for (const step of steps) {
      switch (step.kind) {
        case "message":
          emit(ev("session.text.ended", { ...base, ordinal: 0, text: step.text }));
          break;
        case "reasoning":
          emit(ev("session.reasoning.ended", { ...base, ordinal: 0, text: step.text }));
          break;
        case "command":
          emit(ev("session.tool.input.started", { ...base, id: step.callId, name: "shell" }));
          emit(ev("session.tool.called", { ...base, id: step.callId, input: { command: step.command }, executed: false }));
          emit(
            step.ok
              ? ev("session.tool.success", { ...base, id: step.callId, content: [{ type: "text", text: step.output }], executed: false })
              : ev("session.tool.failed", { ...base, id: step.callId, error: { type: "tool", message: step.output }, executed: false }),
          );
          break;
        case "approval": {
          emit(ev("session.tool.input.started", { ...base, id: step.callId, name: "shell" }));
          emit(ev("session.tool.called", { ...base, id: step.callId, input: { command: step.command }, executed: false }));
          const requestID = `per_${step.callId}`;
          const replied = new Promise<ToolApprovalDecision>((resolve) => replies.set(requestID, resolve));
          emit(
            ev("permission.asked", {
              id: requestID,
              sessionID,
              action: "shell",
              resources: [step.command],
              source: { type: "tool", messageID: assistantMessageID, id: step.callId },
            }),
          );
          decisions.push(await replied);
          break;
        }
        case "complete": {
          // The final reply is a step, and so a message, of its own.
          const final = { sessionID, assistantMessageID: "msg_final" };
          emit(ev("session.text.ended", { ...final, ordinal: 0, text: step.text }));
          emit(
            ev("session.step.ended", {
              ...final,
              finish: "stop",
              cost: step.usage.costUsd,
              tokens: { input: step.usage.input, output: step.usage.output, reasoning: 0, cache: { read: step.usage.cached, write: 0 } },
              files: [],
            }),
          );
          emit(ev("session.execution.succeeded", { sessionID }));
          break;
        }
        case "fail":
          emit(ev("session.execution.failed", { sessionID, error: { type: "provider", message: step.message } }));
          break;
        case "crash":
          emit(new Error(step.message));
          break;
        case "hang":
          await new Promise<void>((resolve) => (interrupted = resolve));
          emit(ev("session.execution.interrupted", { sessionID, reason: "user" }));
          break;
      }
    }
    // A turn that never finishes: end the stream, as a dropped connection would.
    if (!steps.some((s) => ["complete", "fail", "crash", "hang"].includes(s.kind))) emit(null);
  }

  const client = {
    session: {
      create: async (input: { location?: { directory: string } | null; model?: { providerID: string; id: string } | null; permissions?: PermissionRule[] | null } = {}) => {
        const id = `ses_${++nextSession}`;
        const s = state(id);
        s.created = true;
        s.directory = input.location?.directory;
        s.model = input.model ? `${input.model.providerID}/${input.model.id}` : undefined;
        s.permissions = input.permissions ?? undefined;
        return { id };
      },
      update: async (input: { sessionID: string; permissions?: PermissionRule[] | null }) => {
        state(input.sessionID).permissions = input.permissions ?? undefined;
      },
      switchModel: async (input: { sessionID: string; model?: { providerID: string; id: string } }) => {
        if (input.model) state(input.sessionID).model = `${input.model.providerID}/${input.model.id}`;
      },
      instructions: {
        entry: {
          put: async (input: { sessionID: string; key: string; value: unknown }) => {
            state(input.sessionID).instructions = (input.value as string) || undefined;
          },
        },
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        const s = state(input.sessionID);
        const readOnly = s.permissions?.some((r) => r.action === "edit" && r.effect === "deny") ?? false;
        turns.push({
          prompt: input.text,
          continues: s.created && s.prompts === 0 ? undefined : input.sessionID,
          cwd: s.directory ?? "",
          model: s.model,
          instructions: s.instructions,
          access: readOnly ? "read-only" : "workspace-write",
        });
        s.prompts++;
        void play(input.sessionID, script[turns.length - 1] ?? []);
        return { id: "msg_user" };
      },
      interrupt: async (input: { sessionID: string }) => {
        interrupts.push(input.sessionID);
        interrupted?.();
        interrupted = undefined;
        return { interrupted: true };
      },
    },
    permission: {
      reply: async (input: { requestID: string; decision: "once" | "always" | "reject"; message?: string | null }) => {
        replies.get(input.requestID)?.(
          input.decision === "reject" ? { behavior: "deny", message: input.message ?? "" } : { behavior: "allow" },
        );
      },
    },
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => ({
        async *[Symbol.asyncIterator]() {
          const queue: (V2Event | Error | null)[] = [ev("server.connected", {})];
          let wake: (() => void) | undefined;
          const push = (event: V2Event | Error | null) => {
            queue.push(event);
            wake?.();
          };
          subscribers.add(push);
          signal?.addEventListener("abort", () => push(null));
          try {
            for (;;) {
              while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
              const event = queue.shift()!;
              if (event === null) return;
              if (event instanceof Error) throw event;
              yield event;
            }
          } finally {
            subscribers.delete(push);
          }
        },
      }),
    },
  } as unknown as OpencodeClient;

  return { client, turns, decisions, sessions, interrupts, emit };
}
