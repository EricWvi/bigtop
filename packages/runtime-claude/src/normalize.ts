import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent } from "@bigtop/protocol";

const MAX_TOOL_OUTPUT = 4000;

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}…` : text;
}

function toolOutput(content: unknown): string | undefined {
  if (typeof content === "string") return truncate(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => (part && typeof part === "object" && part.type === "text" ? String(part.text) : ""))
    .filter(Boolean)
    .join("\n");
  return text ? truncate(text) : undefined;
}

/**
 * Maps one SDK message to bigtop session events. Messages from subagents
 * (`parent_tool_use_id` set) are skipped; only the main conversation is reported.
 */
export function* normalize(msg: SDKMessage): Generator<SessionEvent> {
  switch (msg.type) {
    case "assistant": {
      if (msg.parent_tool_use_id) return;
      for (const block of msg.message.content) {
        if (block.type === "text") {
          yield { type: "message", text: block.text, raw: block };
        } else if (block.type === "thinking" && block.thinking) {
          // Empty when the thinking is redacted or only a signature is returned.
          yield { type: "reasoning", text: block.thinking, raw: block };
        } else if (block.type === "tool_use") {
          yield { type: "tool.started", callId: block.id, tool: block.name, input: block.input, raw: block };
        }
      }
      return;
    }
    case "user": {
      if (msg.parent_tool_use_id || typeof msg.message.content === "string") return;
      for (const block of msg.message.content) {
        if (block.type === "tool_result") {
          yield {
            type: "tool.completed",
            callId: block.tool_use_id,
            ok: !block.is_error,
            output: toolOutput(block.content),
            raw: block,
          };
        }
      }
      return;
    }
    case "result": {
      if (msg.subtype === "success" && !msg.is_error) {
        yield {
          type: "turn.completed",
          result: msg.result,
          structured: msg.structured_output,
          usage: {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cachedInputTokens: msg.usage.cache_read_input_tokens,
            costUsd: msg.total_cost_usd,
            turns: msg.num_turns,
          },
          raw: msg,
        };
      } else if (msg.subtype === "success") {
        yield { type: "error", message: msg.result || "turn failed", raw: msg };
      } else {
        const detail = msg.errors.length ? `: ${msg.errors.join("; ")}` : "";
        yield { type: "error", message: `${msg.subtype}${detail}`, raw: msg };
      }
      return;
    }
  }
}
