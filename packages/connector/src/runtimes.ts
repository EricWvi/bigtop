import type { Runtime, RuntimeKind } from "@bigtop/protocol";

export interface RuntimeLoader {
  kind: RuntimeKind;
  /** Creates the runtime; throws if its SDK or executable is missing on this machine. */
  load(): Promise<Runtime>;
}

/**
 * The runtimes the connector knows about. Each is imported only when loaded, so
 * a runtime whose package or executable is missing does not stop the others.
 */
export const RUNTIME_LOADERS: RuntimeLoader[] = [
  { kind: "claude", load: async () => (await import("@bigtop/runtime-claude")).createClaudeRuntime() },
  { kind: "codex", load: async () => (await import("@bigtop/runtime-codex")).createCodexRuntime() },
  { kind: "opencode", load: async () => (await import("@bigtop/runtime-opencode")).createOpencodeRuntime() },
];

/** Loads every runtime that works on this machine, logging why the others do not. */
export async function detectRuntimes(
  log: (line: string) => void,
  loaders: RuntimeLoader[] = RUNTIME_LOADERS,
): Promise<Runtime[]> {
  const runtimes: Runtime[] = [];
  for (const loader of loaders) {
    try {
      const runtime = await loader.load();
      runtimes.push(runtime);
      log(`runtime ${runtime.kind} ${runtime.version} available`);
    } catch (err) {
      log(`runtime ${loader.kind} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return runtimes;
}
