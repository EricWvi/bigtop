import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";
import type { SessionEvent } from "@bigtop/protocol";

const MAX_TOOL_OUTPUT = 4000;

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}…` : text;
}

type ToolItem = Extract<ThreadItem, { type: "command_execution" | "mcp_tool_call" | "web_search" }>;

function toolStarted(item: ToolItem): SessionEvent {
  switch (item.type) {
    case "command_execution":
      return { type: "tool.started", callId: item.id, tool: "shell", input: { command: item.command }, raw: item };
    case "mcp_tool_call":
      // Same naming as Claude's MCP tools, so rules about them read the same.
      return { type: "tool.started", callId: item.id, tool: `mcp__${item.server}__${item.tool}`, input: item.arguments, raw: item };
    case "web_search":
      return { type: "tool.started", callId: item.id, tool: "web_search", input: { query: item.query }, raw: item };
  }
}

function toolCompleted(item: ToolItem): SessionEvent {
  switch (item.type) {
    case "command_execution":
      return {
        type: "tool.completed",
        callId: item.id,
        ok: item.status === "completed" && (item.exit_code ?? 0) === 0,
        output: item.aggregated_output ? truncate(item.aggregated_output) : undefined,
        raw: item,
      };
    case "mcp_tool_call": {
      const text = item.error
        ? item.error.message
        : (item.result?.content ?? [])
            .map((block) => (block.type === "text" ? block.text : ""))
            .filter(Boolean)
            .join("\n");
      return { type: "tool.completed", callId: item.id, ok: item.status === "completed", output: text ? truncate(text) : undefined, raw: item };
    }
    case "web_search":
      return { type: "tool.completed", callId: item.id, ok: true, raw: item };
  }
}

/**
 * Maps one turn's Codex thread events to bigtop session events. Codex reports
 * no final result of its own, so the last agent message becomes the turn's
 * result (and, with an output schema, its parsed structured output).
 */
export class TurnNormalizer {
  #structured: boolean;
  #started = new Set<string>();
  #lastMessage = "";

  constructor(options: { structured: boolean }) {
    this.#structured = options.structured;
  }

  *push(event: ThreadEvent): Generator<SessionEvent> {
    switch (event.type) {
      case "item.started": {
        const { item } = event;
        if (item.type === "command_execution" || item.type === "mcp_tool_call" || item.type === "web_search") {
          this.#started.add(item.id);
          yield toolStarted(item);
        }
        return;
      }
      case "item.completed": {
        const { item } = event;
        switch (item.type) {
          case "agent_message":
            this.#lastMessage = item.text;
            yield { type: "message", text: item.text, raw: item };
            return;
          case "reasoning":
            if (item.text) yield { type: "reasoning", text: item.text, raw: item };
            return;
          case "command_execution":
          case "mcp_tool_call":
          case "web_search":
            if (!this.#started.has(item.id)) yield toolStarted(item);
            yield toolCompleted(item);
            return;
          case "file_change":
            if (item.status === "completed") {
              for (const change of item.changes) yield { type: "file.changed", path: change.path, kind: change.kind, raw: item };
            } else {
              // A failed patch changed nothing; report it as a failed edit tool call.
              yield { type: "tool.started", callId: item.id, tool: "apply_patch", input: { changes: item.changes }, raw: item };
              yield { type: "tool.completed", callId: item.id, ok: false, raw: item };
            }
            return;
          // todo_list and non-fatal error items have no session event.
        }
        return;
      }
      case "turn.completed": {
        const { usage } = event;
        yield {
          type: "turn.completed",
          result: this.#lastMessage,
          structured: this.#structured ? parseJson(this.#lastMessage) : undefined,
          usage: {
            // Codex counts cached tokens as part of the input; bigtop does not.
            inputTokens: Math.max(0, usage.input_tokens - usage.cached_input_tokens),
            outputTokens: usage.output_tokens,
            cachedInputTokens: usage.cached_input_tokens,
          },
          raw: event,
        };
        return;
      }
      case "turn.failed":
        yield { type: "error", message: event.error.message, raw: event };
        return;
      case "error":
        yield { type: "error", message: event.message, raw: event };
        return;
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
