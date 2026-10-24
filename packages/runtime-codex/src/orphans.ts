import { readdir, readFile } from "node:fs/promises";

export interface OrphanOptions {
  procDir?: string;
  kill?: (pid: number) => void;
}

/**
 * Stops the commands a killed `codex exec` left behind. Codex runs each command
 * in its own session and does not stop it when it is itself killed, so an
 * interrupted turn would leave, say, a test run going. Those processes carry
 * `CODEX_THREAD_ID` in their environment. Linux only: elsewhere there is no
 * cheap way to read another process's environment, and this does nothing.
 * Returns the pids it signalled.
 */
export async function killThreadProcesses(threadId: string, options: OrphanOptions = {}): Promise<number[]> {
  const procDir = options.procDir ?? "/proc";
  const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGTERM"));
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return [];
  }
  const marker = `CODEX_THREAD_ID=${threadId}`;
  const killed: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let environ: string;
    try {
      environ = await readFile(`${procDir}/${entry}/environ`, "utf8");
    } catch {
      continue; // gone, or not ours to read
    }
    if (!environ.split("\0").includes(marker)) continue;
    try {
      kill(Number(entry));
      killed.push(Number(entry));
    } catch {}
  }
  return killed;
}
