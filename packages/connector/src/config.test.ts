import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseConfig } from "./config.ts";

const base = mkdtempSync(join(tmpdir(), "bigtop-config-"));
mkdirSync(join(base, "repo"));

const valid = { server: "wss://bigtop.example", connectorId: "alice-laptop", token: "t", workspaces: { demo: "repo" } };
const parse = (value: unknown, env: NodeJS.ProcessEnv = {}) => parseConfig(JSON.stringify(value), base, env);

test("parses a config, resolving workspaces against the config directory", () => {
  assert.deepEqual(parse({ ...valid, slots: 2, approvalTimeoutMs: 5000 }), {
    server: "wss://bigtop.example",
    connectorId: "alice-laptop",
    token: "t",
    slots: 2,
    workspaces: { demo: join(base, "repo") },
    approvalTimeoutMs: 5000,
  });
});

test("defaults slots to 1 and lets BIGTOP_TOKEN override the token", () => {
  const { token: _token, ...noToken } = valid;
  const config = parse(noToken, { BIGTOP_TOKEN: "from-env" });
  assert.equal(config.slots, 1);
  assert.equal(config.token, "from-env");
});

test("rejects invalid configs", () => {
  const { token: _token, ...noToken } = valid;
  const cases: [unknown, RegExp][] = [
    [{ ...valid, server: "https://x" }, /server/],
    [{ ...valid, connectorId: "" }, /connectorId/],
    [noToken, /token is missing/],
    [{ ...valid, slots: 0 }, /slots/],
    [{ ...valid, slots: 1.5 }, /slots/],
    [{ ...valid, workspaces: {} }, /at least one workspace/],
    [{ ...valid, workspaces: { demo: "missing" } }, /is not a directory/],
    [{ ...valid, approvalTimeoutMs: -1 }, /approvalTimeoutMs/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => parse(value), (err: unknown) => err instanceof ConfigError && message.test(err.message));
  }
  assert.throws(() => parseConfig("{", base, {}), /not valid JSON/);
});
