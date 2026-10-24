import assert from "node:assert/strict";
import { test } from "node:test";
import type { Runtime } from "@bigtop/protocol";
import { detectRuntimes } from "./runtimes.ts";

test("detectRuntimes keeps the runtimes that load and logs the rest", async () => {
  const claude = { kind: "claude", version: "1" } as Runtime;
  const lines: string[] = [];
  const runtimes = await detectRuntimes((line) => lines.push(line), [
    { kind: "claude", load: async () => claude },
    {
      kind: "codex",
      load: async () => {
        throw new Error("Unable to locate Codex CLI binaries");
      },
    },
  ]);
  assert.deepEqual(runtimes, [claude]);
  assert.deepEqual(lines, ["runtime claude 1 available", "runtime codex unavailable: Unable to locate Codex CLI binaries"]);
});
