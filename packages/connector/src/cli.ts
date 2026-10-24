#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { RoleAccess, SessionEvent } from "@bigtop/protocol";
import { createClaudeRuntime } from "@bigtop/runtime-claude";
import { ConnectorClient } from "./client.ts";
import { ConfigError, defaultConfigPath, loadConfig } from "./config.ts";
import { Connector } from "./connector.ts";

const USAGE = `Usage:
  bigtop-connector start [--config <file>]
      Connect to the bigtop server and run the sessions it dispatches.
      Default config: ${defaultConfigPath()}

  bigtop-connector exec [--cwd <dir>] [--access read-only|workspace-write]
                        [--model <id>] [--max-turns <n>] [--raw] <prompt>
      Run one Claude session locally and print its events as JSON lines.
      Tool calls that need approval are denied.`;

const log = (line: string) => process.stderr.write(`[bigtop] ${line}\n`);

async function start(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { config: { type: "string" } } });
  const config = loadConfig(values.config ?? defaultConfigPath());

  const client = new ConnectorClient({ url: config.server, log });
  const connector = new Connector({
    id: config.connectorId,
    token: config.token,
    slots: config.slots,
    workspaces: config.workspaces,
    runtimes: [createClaudeRuntime()],
    send: (msg) => client.send(msg),
    approvalTimeoutMs: config.approvalTimeoutMs,
    log,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) process.exit(130);
    stopping = true;
    log("stopping: interrupting running sessions (press Ctrl-C again to force)");
    await connector.shutdown();
    client.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  client.start(connector);
  await client.closed;
  // A fatal server error closes the client; let running sessions finish reporting nowhere.
  await connector.shutdown();
  return stopping ? 0 : 1;
}

async function exec(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      cwd: { type: "string", default: process.cwd() },
      access: { type: "string", default: "workspace-write" },
      model: { type: "string" },
      "max-turns": { type: "string" },
      raw: { type: "boolean", default: false },
    },
  });
  const prompt = positionals.join(" ").trim();
  if (!prompt) throw new UsageError("exec needs a prompt");
  if (values.access !== "read-only" && values.access !== "workspace-write") {
    throw new UsageError("--access must be read-only or workspace-write");
  }
  const maxTurns = values["max-turns"] === undefined ? undefined : Number(values["max-turns"]);
  if (maxTurns !== undefined && !(Number.isInteger(maxTurns) && maxTurns > 0)) {
    throw new UsageError("--max-turns must be a positive integer");
  }

  const session = await createClaudeRuntime().start({
    cwd: values.cwd,
    role: { name: "exec", access: values.access as RoleAccess, model: values.model },
    limits: { maxTurns },
    onToolApproval: async (request) => {
      log(`denied ${request.tool}: no approver in exec mode`);
      return { behavior: "deny", message: "No approver is available in exec mode." };
    },
  });
  log(`session ${session.id}`);
  process.on("SIGINT", () => {
    log("interrupting");
    session.interrupt().catch(() => {});
  });

  let last: SessionEvent | undefined;
  for await (const event of session.send(prompt)) {
    const { raw, ...rest } = event;
    process.stdout.write(`${JSON.stringify(values.raw ? { ...rest, raw } : rest)}\n`);
    last = event;
  }
  await session.close();
  return last?.type === "turn.completed" ? 0 : 1;
}

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "start":
        return await start(args);
      case "exec":
        return await exec(args);
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
