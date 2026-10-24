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

/** Validates an approval decision, for example one a person submits. */
export function parseDecision(value: unknown): ToolApprovalDecision {
  const decision = object(value, "decision");
  if (decision.behavior === "allow") return { behavior: "allow" };
  if (decision.behavior === "deny") return { behavior: "deny", message: string(decision, "message", "decision") };
  throw new ProtocolError(`decision.behavior must be "allow" or "deny"`);
}

function parseFrame(text: string): Json {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProtocolError("message is not valid JSON");
  }
  return object(data, "message");
}

function stringArray(obj: Json, key: string, path: string): void {
  const value = obj[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new ProtocolError(`${path}.${key} must be an array of strings`);
  }
}

/** Parses and validates one frame from the server. Throws ProtocolError on anything malformed. */
export function parseServerMessage(text: string): ServerMessage {
  const msg = parseFrame(text);
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
      parseDecision(msg.decision);
      break;
    case "error":
      string(msg, "message", "error");
      break;
    default:
      throw new ProtocolError(`unknown message type ${JSON.stringify(msg.type)}`);
  }
  return msg as unknown as ServerMessage;
}

const OUTCOMES: readonly SessionOutcome[] = ["completed", "failed", "interrupted"];

/** Parses and validates one frame from a connector. Throws ProtocolError on anything malformed. */
export function parseConnectorMessage(text: string): ConnectorMessage {
  const msg = parseFrame(text);
  switch (msg.type) {
    case "hello": {
      string(msg, "connectorId", "hello");
      string(msg, "token", "hello");
      if (typeof msg.protocol !== "number") throw new ProtocolError("hello.protocol must be a number");
      stringArray(msg, "active", "hello");
      const caps = object(msg.capabilities, "hello.capabilities");
      if (!Number.isInteger(caps.slots) || (caps.slots as number) < 1) {
        throw new ProtocolError("hello.capabilities.slots must be a positive integer");
      }
      stringArray(caps, "workspaces", "hello.capabilities");
      string(caps, "platform", "hello.capabilities");
      if (!Array.isArray(caps.runtimes)) throw new ProtocolError("hello.capabilities.runtimes must be an array");
      for (const runtime of caps.runtimes) {
        const r = object(runtime, "hello.capabilities.runtimes[]");
        if (!RUNTIME_KINDS.includes(r.kind as RuntimeKind)) {
          throw new ProtocolError(`hello.capabilities.runtimes[].kind must be one of ${RUNTIME_KINDS.join(", ")}`);
        }
        string(r, "version", "hello.capabilities.runtimes[]");
        object(r.capabilities, "hello.capabilities.runtimes[].capabilities");
      }
      break;
    }
    case "dispatch.accept":
      string(msg, "dispatchId", "dispatch.accept");
      string(msg, "sessionId", "dispatch.accept");
      break;
    case "dispatch.decline":
      string(msg, "dispatchId", "dispatch.decline");
      string(msg, "reason", "dispatch.decline");
      break;
    case "session.event": {
      string(msg, "dispatchId", "session.event");
      if (!Number.isInteger(msg.seq)) throw new ProtocolError("session.event.seq must be an integer");
      const event = object(msg.event, "session.event.event");
      string(event, "type", "session.event.event");
      break;
    }
    case "session.ended":
      string(msg, "dispatchId", "session.ended");
      string(msg, "sessionId", "session.ended");
      optionalString(msg, "error", "session.ended");
      if (!OUTCOMES.includes(msg.outcome as SessionOutcome)) {
        throw new ProtocolError(`session.ended.outcome must be one of ${OUTCOMES.join(", ")}`);
      }
      break;
    case "approval.request": {
      string(msg, "dispatchId", "approval.request");
      string(msg, "approvalId", "approval.request");
      const request = object(msg.request, "approval.request.request");
      string(request, "callId", "approval.request.request");
      string(request, "tool", "approval.request.request");
      break;
    }
    case "heartbeat":
      stringArray(msg, "active", "heartbeat");
      break;
    default:
      throw new ProtocolError(`unknown message type ${JSON.stringify(msg.type)}`);
  }
  return msg as unknown as ConnectorMessage;
}
