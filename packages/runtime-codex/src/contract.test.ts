import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { runtimeContract, type ObservedTurn, type Step } from "@bigtop/runtime-contract";
import { createCodexRuntime } from "./index.ts";

runtimeContract({
  kind: "codex",
  shellTool: "shell",
  create(script) {
    const turns: ObservedTurn[] = [];
    let threads = 0;
    const runtime = createCodexRuntime({
      killOrphans: async () => {},
      codex: (codexOptions) => {
        const instructions = codexOptions.config?.developer_instructions as string | undefined;
        const thread = (resumeId: string | null, threadOptions: ThreadOptions = {}) => {
          let id = resumeId;
          return {
            get id() {
              return id;
            },
            async runStreamed(input: string, turnOptions: { signal?: AbortSignal; outputSchema?: unknown } = {}) {
              const steps: Step[] = script[turns.length] ?? [];
              const o = threadOptions;
              turns.push({
                prompt: input,
                continues: id ?? undefined,
                cwd: o.workingDirectory!,
                model: o.model,
                instructions,
                access: o.sandboxMode === "read-only" ? "read-only" : "workspace-write",
                outputSchema: turnOptions.outputSchema as ObservedTurn["outputSchema"],
              });
              const events = (async function* (): AsyncGenerator<ThreadEvent> {
                if (!id) {
                  id = `thread-${++threads}`;
                  yield { type: "thread.started", thread_id: id };
                }
                yield { type: "turn.started" };
                for (const step of steps) {
                  switch (step.kind) {
                    case "message":
                      yield { type: "item.completed", item: { id: "m", type: "agent_message", text: step.text } };
                      break;
                    case "reasoning":
                      yield { type: "item.completed", item: { id: "r", type: "reasoning", text: step.text } };
                      break;
                    case "command": {
                      const base = { id: step.callId, type: "command_execution" as const, command: step.command };
                      yield { type: "item.started", item: { ...base, aggregated_output: "", status: "in_progress" } };
                      yield {
                        type: "item.completed",
                        item: { ...base, aggregated_output: step.output, exit_code: step.ok ? 0 : 1, status: step.ok ? "completed" : "failed" },
                      };
                      break;
                    }
                    case "approval":
                      throw new Error("Codex has no per-tool approval");
                    case "complete":
                      yield { type: "item.completed", item: { id: "f", type: "agent_message", text: step.text } };
                      yield {
                        type: "turn.completed",
                        usage: {
                          input_tokens: step.usage.input + step.usage.cached,
                          cached_input_tokens: step.usage.cached,
                          cache_write_input_tokens: 0,
                          output_tokens: step.usage.output,
                          reasoning_output_tokens: 0,
                        },
                      };
                      break;
                    case "fail":
                      yield { type: "turn.failed", error: { message: step.message } };
                      // codex exec then exits non-zero, which the SDK throws.
                      throw new Error("Codex Exec exited with code 1: ");
                    case "crash":
                      throw new Error(step.message);
                    case "hang":
                      await new Promise((resolve) => turnOptions.signal!.addEventListener("abort", resolve));
                      throw new DOMException("The operation was aborted", "AbortError");
                  }
                }
              })();
              return { events };
            },
          };
        };
        return {
          startThread: (o) => thread(null, o),
          resumeThread: (id, o) => thread(id, o),
        };
      },
    });
    return { runtime, turns, decisions: [] };
  },
});
