import { runtimeContract } from "@bigtop/runtime-contract";
import { fakeServer } from "./fake.ts";
import { createOpencodeRuntime } from "./index.ts";

runtimeContract({
  kind: "opencode",
  shellTool: "shell",
  model: "acme/model-x",
  create(script) {
    const fake = fakeServer(script);
    const runtime = createOpencodeRuntime({ endpoint: { url: "http://fake" }, client: () => fake.client });
    return { runtime, turns: fake.turns, decisions: fake.decisions };
  },
});
