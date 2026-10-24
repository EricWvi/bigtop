import type { Envelope, SessionEvent } from "@bigtop/protocol";

const MAX = 120;

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX ? `${line.slice(0, MAX - 1)}…` : line;
}

function sessionDetail(event: SessionEvent): string {
  switch (event.type) {
    case "message":
      return `message: ${clip(event.text)}`;
    case "reasoning":
      return `reasoning: ${clip(event.text)}`;
    case "tool.started":
      return `tool ${event.tool} ${clip(JSON.stringify(event.input))}`;
    case "tool.completed":
      return `tool ${event.ok ? "ok" : "failed"}${event.output ? `: ${clip(event.output)}` : ""}`;
    case "file.changed":
      return `${event.kind} ${event.path}`;
    case "turn.completed": {
      const cost = event.usage.costUsd !== undefined ? ` ($${event.usage.costUsd.toFixed(4)})` : "";
      return `turn completed${cost}: ${clip(event.result)}`;
    }
    case "error":
      return `error: ${clip(event.message)}`;
  }
}

/** One human-readable line per event, for the server's console. */
export function formatEvent(e: Envelope): string {
  const time = e.at.slice(11, 19);
  const data = e.data as Record<string, unknown>;
  const task = e.subject?.task ?? "";
  const connector = e.subject?.connector ? ` @${e.subject.connector}` : "";
  let detail = "";
  switch (e.type) {
    case "session.event":
      detail = sessionDetail(data.event as SessionEvent);
      break;
    case "dispatch.offered":
      detail = `${data.role}/${data.runtime} in ${data.workspace}`;
      break;
    case "dispatch.declined":
    case "dispatch.expired":
    case "task.skipped":
    case "connector.offline":
      detail = String(data.reason);
      break;
    case "session.ended":
      detail = `${data.outcome}${data.error ? `: ${clip(String(data.error))}` : ""}`;
      break;
    case "task.discovered":
    case "task.updated":
      detail = `${(data.task as { title?: string }).title ?? ""} [${data.status}]`;
      break;
    case "task.written":
      detail = `status ${(data.update as { status: string }).status}`;
      break;
    case "task.write_failed":
      detail = String(data.error);
      break;
    case "approval.requested": {
      const request = data.request as { tool: string; input: unknown };
      detail = `${e.subject?.approval} ${request.tool} ${clip(JSON.stringify(request.input))}`;
      break;
    }
    case "approval.decided":
      detail = `${e.subject?.approval} ${(data.decision as { behavior: string }).behavior} by ${e.actor.id}`;
      break;
  }
  return [time, e.type.padEnd(18), `${task}${connector}`, detail].filter(Boolean).join("  ");
}
