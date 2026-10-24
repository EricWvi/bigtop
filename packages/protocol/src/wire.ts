// Messages exchanged over the WebSocket the connector opens to the server.
// Every message is one JSON object per WebSocket text frame.

import {
  RUNTIME_KINDS,
  type ResolvedRole,
  type RuntimeCapabilities,
  type RuntimeKind,
  type SessionEvent,
  type SessionLimits,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "./runtime.ts";

export const PROTOCOL_VERSION = 1;

export interface TaskRef {
  /** Name of the Source the task comes from. */
  source: string;
  id: string;
  title?: string;
  url?: string;
}

export interface ConnectorCapabilities {
  runtimes: { kind: RuntimeKind; version: string; capabilities: RuntimeCapabilities }[];
  slots: number;
  /** Names of the workspaces configured on this connector. */
  workspaces: string[];
  platform: string;
}

// connector → server

export interface Hello {
  type: "hello";
  protocol: number;
  connectorId: string;
  token: string;
  capabilities: ConnectorCapabilities;
  /** Dispatches still running, so the server keeps their leases across a reconnect. */
  active: string[];
}

export interface DispatchAccept {
  type: "dispatch.accept";
  dispatchId: string;
  sessionId: string;
}

export interface DispatchDecline {
  type: "dispatch.decline";
  dispatchId: string;
  reason: string;
}

export interface SessionEventMessage {
  type: "session.event";
  dispatchId: string;
  /** Starts at 0 for each dispatch, so the server can spot gaps. */
  seq: number;
  event: SessionEvent;
}

export type SessionOutcome = "completed" | "failed" | "interrupted";

export interface SessionEnded {
  type: "session.ended";
  dispatchId: string;
  sessionId: string;
  outcome: SessionOutcome;
  error?: string;
}

export interface ApprovalRequestMessage {
  type: "approval.request";
  dispatchId: string;
  approvalId: string;
  request: ToolApprovalRequest;
}

export interface Heartbeat {
  type: "heartbeat";
  active: string[];
}

export type ConnectorMessage =
  | Hello
  | DispatchAccept
  | DispatchDecline
  | SessionEventMessage
  | SessionEnded
  | ApprovalRequestMessage
  | Heartbeat;

// server → connector

export interface Welcome {
  type: "welcome";
  connectorId: string;
  heartbeatMs: number;
}

export interface DispatchOffer {
  type: "dispatch.offer";
  dispatchId: string;
  task: TaskRef;
  role: ResolvedRole;
  runtime: RuntimeKind;
  /** Name of a workspace configured on the connector; the server never sends paths. */
  workspace: string;
  prompt: string;
  limits: SessionLimits;
  /** Continue this runtime session instead of starting a new one. */
  resume?: string;
}

export interface SessionInterrupt {
  type: "session.interrupt";
  dispatchId: string;
}

export interface ApprovalDecisionMessage {
  type: "approval.decision";
  approvalId: string;
  decision: ToolApprovalDecision;
}

export interface ServerError {
  type: "error";
  message: string;
  /** The server is about to close the connection; do not reconnect with the same hello. */
  fatal?: boolean;
}

export type ServerMessage =
  | Welcome
  | DispatchOffer
  | SessionInterrupt
  | ApprovalDecisionMessage
  | ServerError;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

type Json = Record<string, unknown>;

function object(value: unknown, path: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${path} must be an object`);
  }
  return value as Json;
}

function string(obj: Json, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value === "") {
    throw new ProtocolError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(obj: Json, key: string, path: string): void {
  if (obj[key] !== undefined && typeof obj[key] !== "string") {
    throw new ProtocolError(`${path}.${key} must be a string`);
  }
}

function optionalNumber(obj: Json, key: string, path: string): void {
  if (obj[key] !== undefined && (typeof obj[key] !== "number" || !Number.isFinite(obj[key]))) {
    throw new ProtocolError(`${path}.${key} must be a finite number`);
  }
}

function checkRole(value: unknown): void {
  const role = object(value, "role");
  string(role, "name", "role");
  optionalString(role, "instructions", "role");
  optionalString(role, "model", "role");
  if (role.access !== "read-only" && role.access !== "workspace-write") {
    throw new ProtocolError(`role.access must be "read-only" or "workspace-write"`);
  }
}

function checkDecision(value: unknown): void {
  const decision = object(value, "decision");
  if (decision.behavior === "allow") return;
  if (decision.behavior === "deny") {
    string(decision, "message", "decision");
    return;
  }
  throw new ProtocolError(`decision.behavior must be "allow" or "deny"`);
}

/** Parses and validates one frame from the server. Throws ProtocolError on anything malformed. */
export function parseServerMessage(text: string): ServerMessage {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProtocolError("message is not valid JSON");
  }
  const msg = object(data, "message");
  switch (msg.type) {
    case "welcome":
      string(msg, "connectorId", "welcome");
      if (typeof msg.heartbeatMs !== "number" || !(msg.heartbeatMs > 0)) {
        throw new ProtocolError("welcome.heartbeatMs must be a positive number");
      }
      break;
    case "dispatch.offer": {
      string(msg, "dispatchId", "dispatch.offer");
      string(msg, "workspace", "dispatch.offer");
      string(msg, "prompt", "dispatch.offer");
      optionalString(msg, "resume", "dispatch.offer");
      if (!RUNTIME_KINDS.includes(msg.runtime as RuntimeKind)) {
        throw new ProtocolError(`dispatch.offer.runtime must be one of ${RUNTIME_KINDS.join(", ")}`);
      }
      const task = object(msg.task, "dispatch.offer.task");
      string(task, "source", "dispatch.offer.task");
      string(task, "id", "dispatch.offer.task");
      checkRole(msg.role);
      const limits = object(msg.limits, "dispatch.offer.limits");
      optionalNumber(limits, "maxTurns", "dispatch.offer.limits");
      optionalNumber(limits, "maxCostUsd", "dispatch.offer.limits");
      optionalString(limits, "deadline", "dispatch.offer.limits");
      break;
    }
    case "session.interrupt":
      string(msg, "dispatchId", "session.interrupt");
      break;
    case "approval.decision":
      string(msg, "approvalId", "approval.decision");
      checkDecision(msg.decision);
      break;
    case "error":
      string(msg, "message", "error");
      break;
    default:
      throw new ProtocolError(`unknown message type ${JSON.stringify(msg.type)}`);
  }
  return msg as unknown as ServerMessage;
}
