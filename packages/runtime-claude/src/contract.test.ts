import type { PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolApprovalDecision } from "@bigtop/protocol";
import { runtimeContract, type ObservedTurn, type Step } from "@bigtop/runtime-contract";
import { createClaudeRuntime, type ClaudeQuery } from "./index.ts";

const msg = (value: unknown) => value as SDKMessage;
const assistant = (block: unknown) => msg({ type: "assistant", parent_tool_use_id: null, message: { content: [block] } });

runtimeContract({
  kind: "claude",
  shellTool: "Bash",
  create(script) {
    const turns: ObservedTurn[] = [];
    const decisions: ToolApprovalDecision[] = [];
    const query: ClaudeQuery = ({ prompt, options = {} }) => {
      const steps: Step[] = script[turns.length] ?? [];
      const system = options.systemPrompt;
      const append = system && !Array.isArray(system) && typeof system === "object" && system.type === "preset" ? system.append : undefined;
      turns.push({
        prompt,
        continues: options.resume,
        cwd: options.cwd!,
        model: options.model,
        instructions: append,
        access: options.disallowedTools?.includes("Write") ? "read-only" : "workspace-write",
        outputSchema: options.outputFormat?.schema,
      });
      const interrupted = Promise.withResolvers<void>();
      const gen = (async function* (): AsyncGenerator<SDKMessage> {
        for (const step of steps) {
          switch (step.kind) {
            case "message":
              yield assistant({ type: "text", text: step.text });
              break;
            case "reasoning":
              yield assistant({ type: "thinking", thinking: step.text });
              break;
            case "command":
              yield assistant({ type: "tool_use", id: step.callId, name: "Bash", input: { command: step.command } });
              yield msg({
                type: "user",
                parent_tool_use_id: null,
                message: { role: "user", content: [{ type: "tool_result", tool_use_id: step.callId, content: step.output, is_error: !step.ok }] },
              });
              break;
            case "approval": {
              const result: PermissionResult = (await options.canUseTool?.(
                "Bash",
                { command: step.command },
                { signal: new AbortController().signal, requestId: step.callId, toolUseID: step.callId },
              )) ?? { behavior: "deny", message: "no canUseTool" };
              decisions.push(result.behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: result.message });
              break;
            }
            case "complete":
              yield assistant({ type: "text", text: step.text });
              yield msg({
                type: "result",
                subtype: "success",
                is_error: false,
                result: step.text,
                structured_output: step.structured,
                num_turns: 1,
                total_cost_usd: step.usage.costUsd,
                usage: { input_tokens: step.usage.input, output_tokens: step.usage.output, cache_read_input_tokens: step.usage.cached },
              });
              break;
            case "fail":
              yield msg({ type: "result", subtype: "success", is_error: true, result: step.message, usage: {} });
              break;
            case "crash":
              throw new Error(step.message);
            case "hang": {
              const aborted = new Promise<"aborted">((resolve) =>
                options.abortController!.signal.addEventListener("abort", () => resolve("aborted")),
              );
              if ((await Promise.race([aborted, interrupted.promise])) === "aborted") throw new Error("aborted by user");
              // The SDK ends an interrupted query with an error result.
              yield msg({ type: "result", subtype: "error_during_execution", errors: [], usage: {} });
              break;
            }
          }
        }
      })();
      return Object.assign(gen, { interrupt: async () => interrupted.resolve() });
    };
    return { runtime: createClaudeRuntime({ query }), turns, decisions };
  },
});
