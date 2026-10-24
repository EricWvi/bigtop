#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { Source } from "@bigtop/protocol";
import { createLocalSource } from "@bigtop/source-local";
import { ConfigError, loadConfig, type SourceConfig } from "./config.ts";
import { formatEvent } from "./format.ts";
import { createHttpServer } from "./http.ts";
import { Hub } from "./hub.ts";
import { createDefaultPlaybook } from "./playbook.ts";

const USAGE = `Usage:
  bigtop-server start [--config <file>] [--json]
      Serve connectors and dispatch tasks. Default config: ./bigtop-server.json
      Events print one line each; --json prints them as JSON lines instead.`;

const log = (line: string) => process.stderr.write(`[bigtop] ${line}\n`);

function createSource(config: SourceConfig): Source {
  switch (config.type) {
    case "local":
      return createLocalSource({ name: config.name, dir: config.dir, onError: (m) => log(`${config.name}: ${m}`) });
  }
}

async function start(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { config: { type: "string", default: "bigtop-server.json" }, json: { type: "boolean", default: false } },
  });
  const config = loadConfig(values.config);

  const hub = new Hub({
    sources: config.sources.map(createSource),
    playbook: createDefaultPlaybook({ roles: config.roles, defaults: config.defaults }),
    connectorTokens: config.connectors,
    heartbeatMs: config.heartbeatMs,
    log,
  });
  hub.events.subscribe((e) => process.stdout.write(`${values.json ? JSON.stringify(e) : formatEvent(e)}\n`));

  const server = createHttpServer(hub, { adminToken: config.adminToken, log });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const address = server.address();
  const where = typeof address === "object" && address ? `${address.address}:${address.port}` : String(address);
  log(`listening on ${where}; connectors connect to ws://${where}/connect`);
  await hub.start();

  await new Promise<void>((resolve) => {
    const stop = () => {
      log("stopping");
      hub.stop();
      server.close(() => resolve());
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "start":
        return await start(args);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(`${USAGE}\n`);
        return command === undefined ? 1 : 0;
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError || (err as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      process.stderr.write(`${(err as Error).message}\n\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }
}

process.exitCode = await main(process.argv.slice(2));
