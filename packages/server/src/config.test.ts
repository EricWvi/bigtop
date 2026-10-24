import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigError, parseConfig } from "./config.ts";

const valid = {
  adminToken: "admin",
  connectors: { alice: "secret" },
  sources: [{ type: "local", dir: "tasks" }],
};
const parse = (value: unknown, env: NodeJS.ProcessEnv = {}) => parseConfig(JSON.stringify(value), "/srv", env);

test("fills defaults and resolves source directories", () => {
  assert.deepEqual(parse(valid), {
    host: "127.0.0.1",
    port: 7420,
    adminToken: "admin",
    connectors: { alice: "secret" },
    sources: [{ type: "local", name: "local", dir: join("/srv", "tasks") }],
    roles: {},
    defaults: {},
  });
});

test("reads roles, defaults and the admin token from the environment", () => {
  const config = parse(
    {
      ...valid,
      port: 0,
      roles: { docs: { access: "workspace-write", instructions: "Write docs.", model: "m" } },
      defaults: { role: "docs", runtime: "claude", workspace: "demo", limits: { maxTurns: 20, maxCostUsd: 1.5 } },
      heartbeatMs: 1000,
    },
    { BIGTOP_ADMIN_TOKEN: "env" },
  );
  assert.equal(config.adminToken, "env");
  assert.equal(config.port, 0);
  assert.deepEqual(config.roles, { docs: { name: "docs", access: "workspace-write", instructions: "Write docs.", model: "m" } });
  assert.deepEqual(config.defaults, { role: "docs", runtime: "claude", workspace: "demo", limits: { maxTurns: 20, maxCostUsd: 1.5 } });
  assert.equal(config.heartbeatMs, 1000);
});

test("rejects invalid configs", () => {
  const { adminToken: _a, ...noAdmin } = valid;
  const cases: [unknown, RegExp][] = [
    [noAdmin, /adminToken/],
    [{ ...valid, port: 70000 }, /port/],
    [{ ...valid, connectors: {} }, /connectors/],
    [{ ...valid, connectors: { alice: "" } }, /connectors.alice/],
    [{ ...valid, sources: [] }, /sources/],
    [{ ...valid, sources: [{ type: "github" }] }, /type must be "local"/],
    [{ ...valid, sources: [{ type: "local", dir: "a" }, { type: "local", dir: "b" }] }, /unique/],
    [{ ...valid, roles: { x: { access: "root" } } }, /roles.x.access/],
    [{ ...valid, defaults: { runtime: "gpt" } }, /defaults.runtime/],
    [{ ...valid, defaults: { limits: { maxTurns: 0 } } }, /maxTurns/],
  ];
  for (const [value, message] of cases) {
    assert.throws(() => parse(value), (err: unknown) => err instanceof ConfigError && message.test(err.message));
  }
});
