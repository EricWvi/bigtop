import {
  RUNTIME_KINDS,
  type ResolvedRole,
  type RuntimeKind,
  type SessionLimits,
  type SessionOutcome,
  type Task,
  type TaskUpdate,
} from "@bigtop/protocol";

export interface DispatchPlan {
  role: ResolvedRole;
  runtime: RuntimeKind;
  workspace: string;
  prompt: string;
  limits: SessionLimits;
}

export interface SessionResult {
  outcome: SessionOutcome;
  /** Missing if the session never got an id. */
  sessionId?: string;
  /** Final text of the last completed turn. */
  result?: string;
  error?: string;
  costUsd?: number;
}

/** Decides what to do with tasks. The hub calls it; it never talks to connectors itself. */
export interface Playbook {
  /** How to dispatch an open task, or why not to. */
  plan(task: Task): DispatchPlan | { skip: string };
  /** What to write back to the source when the task's session ends. */
  finish(task: Task, result: SessionResult): TaskUpdate;
}

export const BUILTIN_ROLES: Record<string, ResolvedRole> = {
  implementer: {
    name: "implementer",
    access: "workspace-write",
    instructions: "You are an implementer: make the change the task asks for, run the relevant checks, and keep the change focused.",
  },
  reviewer: {
    name: "reviewer",
    access: "read-only",
    instructions: "You are a reviewer: read the code the task points at and report concrete problems. Do not change files.",
  },
};

export interface DefaultPlaybookOptions {
  /** Extra or overriding roles, by name. */
  roles?: Record<string, ResolvedRole>;
  defaults?: {
    role?: string;
    runtime?: RuntimeKind;
    workspace?: string;
    limits?: SessionLimits;
  };
}

function positive(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * One task, one session. A task's fields choose `role`, `runtime` and
 * `workspace` (falling back to the defaults) and may tighten `max-turns` and
 * `max-cost-usd`. A completed session marks the task done with the agent's
 * summary; anything else marks it failed, so it is not retried without a person.
 */
export function createDefaultPlaybook(options: DefaultPlaybookOptions = {}): Playbook {
  const roles = { ...BUILTIN_ROLES, ...options.roles };
  const defaults = options.defaults ?? {};

  return {
    plan(task) {
      const roleName = task.fields.role || defaults.role || "implementer";
      const role = roles[roleName];
      if (!role) return { skip: `unknown role ${roleName}` };
      const runtime = (task.fields.runtime || defaults.runtime || "claude") as RuntimeKind;
      if (!RUNTIME_KINDS.includes(runtime)) return { skip: `unknown runtime ${runtime}` };
      const workspace = task.fields.workspace || defaults.workspace;
      if (!workspace) return { skip: "no workspace: set workspace on the task or a default" };

      const limits: SessionLimits = { ...defaults.limits };
      const maxTurns = positive(task.fields["max-turns"]);
      if (maxTurns !== undefined) limits.maxTurns = Math.floor(maxTurns);
      const maxCostUsd = positive(task.fields["max-cost-usd"]);
      if (maxCostUsd !== undefined) limits.maxCostUsd = maxCostUsd;

      const title = task.ref.title ?? task.ref.id;
      const prompt = [
        `You have been assigned the task "${title}" (${task.ref.source}:${task.ref.id}) in the ${role.name} role.`,
        task.body,
        "Work in the current directory. When you finish, reply with a short summary of what you did and anything left undone; it is recorded as the task's result.",
      ]
        .filter(Boolean)
        .join("\n\n");
      return { role, runtime, workspace, prompt, limits };
    },

    finish(_task, result) {
      const footer = [
        result.sessionId ? `Session \`${result.sessionId}\`` : "Session",
        result.costUsd !== undefined ? `, $${result.costUsd.toFixed(4)}` : "",
        ".",
      ].join("");
      switch (result.outcome) {
        case "completed":
          return { status: "done", note: `${result.result?.trim() || "(no summary)"}\n\n${footer}` };
        case "interrupted":
          return { status: "failed", note: `The session was interrupted.\n\n${footer}` };
        case "failed":
          return { status: "failed", note: `The session failed: ${result.error ?? "unknown error"}\n\n${footer}` };
      }
    },
  };
}
