import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface ConnectorConfig {
  /** `ws://` or `wss://` URL of the bigtop server. */
  server: string;
  connectorId: string;
  token: string;
  slots: number;
  /** Workspace name → absolute directory. */
  workspaces: Record<string, string>;
  approvalTimeoutMs?: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "bigtop", "connector.json");
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "bigtop", "connector.json");
}

/**
 * Parses a connector config. Workspace paths are resolved against `baseDir` and
 * must be existing directories. `BIGTOP_TOKEN` in `env` overrides `token`.
 */
export function parseConfig(text: string, baseDir: string, env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConfigError("config is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new ConfigError("config must be an object");
  const raw = data as Record<string, unknown>;

  const server = raw.server;
  if (typeof server !== "string" || !/^wss?:\/\//.test(server)) throw new ConfigError("server must be a ws:// or wss:// URL");
  const connectorId = raw.connectorId;
  if (typeof connectorId !== "string" || !connectorId) throw new ConfigError("connectorId must be a non-empty string");
  const token = env.BIGTOP_TOKEN || raw.token;
  if (typeof token !== "string" || !token) throw new ConfigError("token is missing: set token in the config or BIGTOP_TOKEN");
  const slots = raw.slots ?? 1;
  if (!Number.isInteger(slots) || (slots as number) < 1) throw new ConfigError("slots must be a positive integer");
  const approvalTimeoutMs = raw.approvalTimeoutMs;
  if (approvalTimeoutMs !== undefined && !(typeof approvalTimeoutMs === "number" && approvalTimeoutMs > 0)) {
    throw new ConfigError("approvalTimeoutMs must be a positive number");
  }

  const rawWorkspaces = raw.workspaces;
  if (typeof rawWorkspaces !== "object" || rawWorkspaces === null || Array.isArray(rawWorkspaces)) {
    throw new ConfigError("workspaces must be an object of name → directory");
  }
  const workspaces: Record<string, string> = {};
  for (const [name, path] of Object.entries(rawWorkspaces)) {
    if (typeof path !== "string" || !path) throw new ConfigError(`workspaces.${name} must be a directory path`);
    const dir = resolve(baseDir, path);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {}
    if (!isDir) throw new ConfigError(`workspaces.${name}: ${dir} is not a directory`);
    workspaces[name] = dir;
  }
  if (Object.keys(workspaces).length === 0) throw new ConfigError("configure at least one workspace");

  return {
    server,
    connectorId,
    token,
    slots: slots as number,
    workspaces,
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs: approvalTimeoutMs as number } : {}),
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text, dirname(resolve(path)), env);
}
