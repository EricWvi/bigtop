// The Runtime interface every agent SDK adapter implements. It covers only what
// all supported SDKs can do; differences are declared in `capabilities`.

export type RuntimeKind = "claude" | "codex" | "opencode";

export const RUNTIME_KINDS: readonly RuntimeKind[] = ["claude", "codex", "opencode"];

export interface RuntimeCapabilities {
  /** Can intercept individual tool calls and ask `onToolApproval`. */
  toolApproval: boolean;
  /** Reports cost in USD on `turn.completed`. */
  costUsd: boolean;
  /** Enforces `SessionLimits.maxTurns`; runtimes without it ignore the limit. */
  maxTurns: boolean;
  /** Enforces `SessionLimits.maxCostUsd`; runtimes without it ignore the limit. */
  maxCostUsd: boolean;
  fork: boolean;
}

export type JsonSchema = Record<string, unknown>;

/** What a role may touch. Adapters map this onto their SDK's permission presets. */
export type RoleAccess = "read-only" | "workspace-write";

export interface ResolvedRole {
  name: string;
  /** Appended to the runtime's default system prompt. */
  instructions?: string;
  model?: string;
  access: RoleAccess;
}

export interface SessionLimits {
  maxTurns?: number;
  maxCostUsd?: number;
  /** ISO time after which the runtime interrupts the session. */
  deadline?: string;
}

export interface ToolApprovalRequest {
  /** The SDK's id for this tool call. */
  callId: string;
  tool: string;
  input: unknown;
  /** Why the SDK is asking, when it says. */
  reason?: string;
}

export type ToolApprovalDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string };

export interface SessionSpec {
  cwd: string;
  role: ResolvedRole;
  limits: SessionLimits;
  /** Called for tool calls the runtime wants approved. Without it, such calls are denied. */
  onToolApproval?: (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

export interface Usage {
  /** Input tokens not read from the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  costUsd?: number;
  turns?: number;
}

/** Normalized session events. `raw` keeps the SDK's original event for debugging. */
export type SessionEvent =
  | { type: "message"; text: string; raw?: unknown }
  | { type: "reasoning"; text: string; raw?: unknown }
  | { type: "tool.started"; callId: string; tool: string; input: unknown; raw?: unknown }
  | { type: "tool.completed"; callId: string; ok: boolean; output?: string; raw?: unknown }
  | { type: "file.changed"; path: string; kind: "add" | "update" | "delete"; raw?: unknown }
  | { type: "turn.completed"; result: string; structured?: unknown; usage: Usage; raw?: unknown }
  | { type: "error"; message: string; raw?: unknown };

export interface SendOptions {
  outputSchema?: JsonSchema;
}

export interface RuntimeSession {
  /**
   * Stable id; pass it to `Runtime.resume` to continue the conversation.
   * Undefined until the SDK assigns one: Codex does so during the first turn.
   */
  readonly id: string | undefined;
  /**
   * Runs one turn. The stream ends with exactly one `turn.completed` or `error`;
   * an `error` event means the turn failed. A turn stopped by `interrupt()`
   * ends with the error "interrupted".
   */
  send(input: string, options?: SendOptions): AsyncIterable<SessionEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface Runtime {
  readonly kind: RuntimeKind;
  readonly version: string;
  readonly capabilities: RuntimeCapabilities;
  start(spec: SessionSpec): Promise<RuntimeSession>;
  resume(id: string, spec: SessionSpec): Promise<RuntimeSession>;
}
