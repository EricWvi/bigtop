import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { RUNTIME_KINDS, type ResolvedRole, type RuntimeKind, type SessionLimits } from "@bigtop/protocol";

export interface LocalSourceConfig {
  type: "local";
  name: string;
  /** Absolute directory of task files. */
  dir: string;
}

export type SourceConfig = LocalSourceConfig;

export interface ServerConfig {
  host: string;
  port: number;
  adminToken: string;
  /** Connector id → shared secret. */
  connectors: Record<string, string>;
  sources: SourceConfig[];
  roles: Record<string, ResolvedRole>;
  defaults: { role?: string; runtime?: RuntimeKind; workspace?: string; limits?: SessionLimits };
  heartbeatMs?: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== "string" || !value) throw new ConfigError(`${what} must be a non-empty string`);
  return value;
}

function limits(value: unknown, what: string): SessionLimits | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new ConfigError(`${what} must be an object`);
  const out: SessionLimits = {};
  if (value.maxTurns !== undefined) {
    if (!Number.isInteger(value.maxTurns) || (value.maxTurns as number) < 1) throw new ConfigError(`${what}.maxTurns must be a positive integer`);
    out.maxTurns = value.maxTurns as number;
  }
  if (value.maxCostUsd !== undefined) {
    if (typeof value.maxCostUsd !== "number" || !(value.maxCostUsd > 0)) throw new ConfigError(`${what}.maxCostUsd must be a positive number`);
    out.maxCostUsd = value.maxCostUsd;
  }
  return out;
}

/**
 * Parses a server config. Relative source directories resolve against
 * `baseDir`. `BIGTOP_ADMIN_TOKEN` in `env` overrides `adminToken`.
 */
export function parseConfig(text: string, baseDir: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("config is not valid JSON");
  }
  if (!isObject(raw)) throw new ConfigError("config must be an object");

  const host = raw.host === undefined ? "127.0.0.1" : nonEmpty(raw.host, "host");
  const port = raw.port ?? 7420;
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) throw new ConfigError("port must be 0–65535");
  const adminToken = nonEmpty(env.BIGTOP_ADMIN_TOKEN || raw.adminToken, "adminToken (or BIGTOP_ADMIN_TOKEN)");

  if (!isObject(raw.connectors) || Object.keys(raw.connectors).length === 0) {
    throw new ConfigError("connectors must map at least one connector id to its token");
  }
  const connectors: Record<string, string> = {};
  for (const [id, token] of Object.entries(raw.connectors)) connectors[id] = nonEmpty(token, `connectors.${id}`);

  if (!Array.isArray(raw.sources) || raw.sources.length === 0) throw new ConfigError("sources must list at least one source");
  const sources: SourceConfig[] = raw.sources.map((s, i) => {
    if (!isObject(s)) throw new ConfigError(`sources[${i}] must be an object`);
    if (s.type !== "local") throw new ConfigError(`sources[${i}].type must be "local"`);
    return {
      type: "local",
      name: s.name === undefined ? "local" : nonEmpty(s.name, `sources[${i}].name`),
      dir: resolve(baseDir, nonEmpty(s.dir, `sources[${i}].dir`)),
    };
  });
  if (new Set(sources.map((s) => s.name)).size !== sources.length) throw new ConfigError("source names must be unique");

  const roles: Record<string, ResolvedRole> = {};
  if (raw.roles !== undefined) {
    if (!isObject(raw.roles)) throw new ConfigError("roles must be an object");
    for (const [name, r] of Object.entries(raw.roles)) {
      if (!isObject(r)) throw new ConfigError(`roles.${name} must be an object`);
      if (r.access !== "read-only" && r.access !== "workspace-write") {
        throw new ConfigError(`roles.${name}.access must be "read-only" or "workspace-write"`);
      }
      roles[name] = {
        name,
        access: r.access,
        ...(r.instructions !== undefined ? { instructions: nonEmpty(r.instructions, `roles.${name}.instructions`) } : {}),
        ...(r.model !== undefined ? { model: nonEmpty(r.model, `roles.${name}.model`) } : {}),
      };
    }
  }

  const d = raw.defaults ?? {};
  if (!isObject(d)) throw new ConfigError("defaults must be an object");
  if (d.runtime !== undefined && !RUNTIME_KINDS.includes(d.runtime as RuntimeKind)) {
    throw new ConfigError(`defaults.runtime must be one of ${RUNTIME_KINDS.join(", ")}`);
  }
  const defaults: ServerConfig["defaults"] = {
    ...(d.role !== undefined ? { role: nonEmpty(d.role, "defaults.role") } : {}),
    ...(d.runtime !== undefined ? { runtime: d.runtime as RuntimeKind } : {}),
    ...(d.workspace !== undefined ? { workspace: nonEmpty(d.workspace, "defaults.workspace") } : {}),
    ...(d.limits !== undefined ? { limits: limits(d.limits, "defaults.limits") } : {}),
  };

  const heartbeatMs = raw.heartbeatMs;
  if (heartbeatMs !== undefined && !(typeof heartbeatMs === "number" && heartbeatMs > 0)) {
    throw new ConfigError("heartbeatMs must be a positive number");
  }

  return {
    host,
    port: port as number,
    adminToken,
    connectors,
    sources,
    roles,
    defaults,
    ...(heartbeatMs !== undefined ? { heartbeatMs: heartbeatMs as number } : {}),
  };
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): ServerConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseConfig(text, dirname(resolve(path)), env);
}
