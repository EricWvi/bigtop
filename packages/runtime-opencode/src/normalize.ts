import { resolve } from "node:path";
import type { V2Event } from "@opencode/client";
import type { SessionEvent, Usage } from "@bigtop/protocol";

const MAX_TOOL_OUTPUT = 4000;

function truncate(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}…` : text;
}

function textOf(content: readonly { type: string; text?: string }[] | undefined): string | undefined {
  const text = (content ?? [])
    .map((part) => (part.type === "text" && part.text ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  return text ? truncate(text) : undefined;
}

/** What a finished step tells the session, so it can enforce limits. */
export interface StepEnd {
  steps: number;
  costUsd: number;
  /** More steps follow (the model called tools). */
  continues: boolean;
}

export type NormalizedOutput =
  | { kind: "event"; event: SessionEvent }
  | { kind: "step"; step: StepEnd }
  /** The turn ended; `event` is its terminal session event. */
  | { kind: "end"; event: SessionEvent };

/**
 * Maps one turn's OpenCode v2 events, already filtered to the session, to bigtop
 * session events. OpenCode reports tool names when the model starts writing the
 * call and the input when it is complete, so both are remembered per call.
 */
export class TurnNormalizer {
  #cwd: string;
  #toolNames = new Map<string, string>();
  #toolInputs = new Map<string, unknown>();
  #lastText: { message: string; texts: string[] } | undefined;
  #usage: Required<Pick<Usage, "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd" | "turns">> = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    turns: 0,
  };

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  /** The input of a tool call seen so far, for approval requests. */
  toolInput(callId: string): unknown {
    return this.#toolInputs.get(callId);
  }

  *push(event: V2Event): Generator<NormalizedOutput> {
    switch (event.type) {
      case "session.text.ended": {
        const { assistantMessageID, text } = event.data;
        if (!text) return;
        if (this.#lastText?.message !== assistantMessageID) this.#lastText = { message: assistantMessageID, texts: [] };
        this.#lastText.texts.push(text);
        yield { kind: "event", event: { type: "message", text, raw: event } };
        return;
      }
      case "session.reasoning.ended":
        if (event.data.text) yield { kind: "event", event: { type: "reasoning", text: event.data.text, raw: event } };
        return;
      case "session.tool.input.started":
        this.#toolNames.set(event.data.id, event.data.name);
        return;
      case "session.tool.called": {
        const { id, input } = event.data;
        this.#toolInputs.set(id, input);
        yield { kind: "event", event: { type: "tool.started", callId: id, tool: this.#toolNames.get(id) ?? "unknown", input, raw: event } };
        return;
      }
      case "session.tool.success":
        yield { kind: "event", event: { type: "tool.completed", callId: event.data.id, ok: true, output: textOf(event.data.content), raw: event } };
        return;
      case "session.tool.failed":
        yield {
          kind: "event",
          event: { type: "tool.completed", callId: event.data.id, ok: false, output: truncate(event.data.error.message), raw: event },
        };
        return;
      case "session.step.ended":
      case "session.step.failed": {
        const { tokens, cost, files } = event.data;
        this.#usage.turns += 1;
        this.#usage.costUsd += cost ?? 0;
        if (tokens) {
          this.#usage.inputTokens += tokens.input;
          this.#usage.outputTokens += tokens.output;
          this.#usage.cachedInputTokens += tokens.cache.read;
        }
        // OpenCode names the files a step changed but not how.
        for (const file of files ?? []) {
          yield { kind: "event", event: { type: "file.changed", path: resolve(this.#cwd, file), kind: "update", raw: event } };
        }
        const continues = event.type === "session.step.ended" && event.data.finish === "tool-calls";
        yield { kind: "step", step: { steps: this.#usage.turns, costUsd: this.#usage.costUsd, continues } };
        return;
      }
      case "session.execution.succeeded":
        yield {
          kind: "end",
          event: { type: "turn.completed", result: this.#lastText?.texts.join("\n") ?? "", usage: { ...this.#usage }, raw: event },
        };
        return;
      case "session.execution.failed":
        yield { kind: "end", event: { type: "error", message: event.data.error.message, raw: event } };
        return;
      case "session.execution.interrupted":
        yield { kind: "end", event: { type: "error", message: `interrupted (${event.data.reason})`, raw: event } };
        return;
    }
  }
}
