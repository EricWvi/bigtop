import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Where an OpenCode server listens and how to authenticate to it. */
export interface Endpoint {
  url: string;
  /** Basic-auth credentials; `opencode serve` prints a password and expects the user "opencode". */
  username?: string;
  password?: string;
}

export type Spawn = (command: string, args: string[]) => ChildProcess;

export interface LocalServerOptions {
  /** The `opencode` executable. */
  command?: string;
  spawn?: Spawn;
  startTimeoutMs?: number;
  /** How long the server stays up after its last session closes. */
  idleMs?: number;
  log?: (line: string) => void;
}

/** Recognizes the lines `opencode serve` prints on startup. */
export function parseServeLine(line: string): { url?: string; password?: string } {
  const listening = /server listening on (https?:\/\/\S+)/.exec(line);
  if (listening) return { url: listening[1] };
  const password = /server password (\S+)/.exec(line);
  if (password) return { password: password[1] };
  return {};
}

/** How long to wait for the password line once the URL is known; servers without auth print none. */
const PASSWORD_GRACE_MS = 2000;

/**
 * A private `opencode serve` shared by this runtime's sessions. It starts with
 * the first session, stops once the last one has been closed for `idleMs`, and
 * is killed when the connector process exits.
 */
export class LocalServer {
  #o: Required<Omit<LocalServerOptions, "log">> & Pick<LocalServerOptions, "log">;
  #proc: ChildProcess | undefined;
  #ready: Promise<Endpoint> | undefined;
  #users = 0;
  #idle: NodeJS.Timeout | undefined;
  #onExit = () => this.#kill();

  constructor(options: LocalServerOptions = {}) {
    this.#o = {
      command: options.command ?? "opencode",
      spawn: options.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })),
      startTimeoutMs: options.startTimeoutMs ?? 30_000,
      idleMs: options.idleMs ?? 60_000,
      log: options.log,
    };
  }

  get running(): boolean {
    return this.#proc !== undefined;
  }

  async acquire(): Promise<Endpoint> {
    this.#users++;
    clearTimeout(this.#idle);
    try {
      this.#ready ??= this.#start();
      return await this.#ready;
    } catch (err) {
      this.#users--;
      throw err;
    }
  }

  release(): void {
    this.#users = Math.max(0, this.#users - 1);
    if (this.#users > 0 || !this.#proc) return;
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#kill(), this.#o.idleMs);
    this.#idle.unref();
  }

  #start(): Promise<Endpoint> {
    const proc = this.#o.spawn(this.#o.command, ["serve", "--hostname=127.0.0.1", "--port=0"]);
    this.#proc = proc;
    process.once("exit", this.#onExit);
    let output = "";
    return new Promise<Endpoint>((resolve, reject) => {
      let url: string | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      const fail = (message: string) => {
        cleanup();
        this.#kill();
        reject(new Error(`${message}${output.trim() ? `\n${output.trim()}` : ""}`));
      };
      const done = (password?: string) => {
        cleanup();
        // From here on the server must not keep this process alive on its own.
        proc.stdout?.resume();
        proc.stderr?.resume();
        for (const stream of [proc.stdout, proc.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
        proc.unref();
        this.#o.log?.(`opencode server listening on ${url}`);
        resolve({ url: url!, ...(password ? { username: "opencode", password } : {}) });
      };
      const timer = setTimeout(() => fail(`opencode serve did not start within ${this.#o.startTimeoutMs}ms`), this.#o.startTimeoutMs);
      const onExit = (code: number | null, signal: string | null) => fail(`opencode serve exited (${signal ?? `code ${code}`})`);
      const onError = (err: Error) => fail(`cannot start ${this.#o.command}: ${err.message}`);
      const lines = createInterface({ input: proc.stdout! });
      const onLine = (line: string) => {
        output += `${line}\n`;
        const parsed = parseServeLine(line);
        if (parsed.url) {
          url = parsed.url;
          graceTimer = setTimeout(() => done(), PASSWORD_GRACE_MS);
        } else if (parsed.password && url) {
          done(parsed.password);
        }
      };
      proc.stderr?.on("data", (chunk) => (output += String(chunk)));
      lines.on("line", onLine);
      proc.once("exit", onExit);
      proc.once("error", onError);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(graceTimer);
        lines.off("line", onLine);
        lines.close();
        proc.off("exit", onExit);
        proc.off("error", onError);
      };
      // A server that dies later is started afresh by the next session.
      proc.once("exit", () => {
        if (this.#proc === proc) this.#forget();
      });
    });
  }

  #kill(): void {
    const proc = this.#proc;
    this.#forget();
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill();
  }

  #forget(): void {
    clearTimeout(this.#idle);
    process.off("exit", this.#onExit);
    this.#proc = undefined;
    this.#ready = undefined;
  }
}
