// A Source backed by a directory of Markdown files, one task per file:
//
//   ---
//   title: Add a README
//   workspace: demo
//   status: open
//   ---
//   What to do, in as much detail as the agent needs.
//
// The file name without `.md` is the task id. Every front matter key is passed
// to the playbook as a field; `status` (open, done, failed; default open) and
// `title` have fixed meanings. Updates rewrite `status` and append the note
// under a `## Result` heading.

import { watch as fsWatch } from "node:fs";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Source, Task, TaskStatus, TaskUpdate } from "@bigtop/protocol";

export interface LocalSourceOptions {
  name?: string;
  dir: string;
  /** Polling interval backing up `fs.watch`, which misses changes on some file systems. */
  pollMs?: number;
  /** Told about files that cannot be read as tasks. */
  onError?: (message: string) => void;
}

const STATUSES: readonly TaskStatus[] = ["open", "done", "failed"];
const ID = /^[A-Za-z0-9][\w.-]*$/;

interface Parsed {
  fields: Record<string, string>;
  body: string;
}

export function parseTaskFile(text: string): Parsed {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) return { fields: {}, body: normalized.trim() };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[kv[1]!] = value;
  }
  return { fields, body: normalized.slice(match[0].length).trim() };
}

/** Sets `status` in the front matter (adding one if needed) and appends the note. */
export function applyUpdate(text: string, update: TaskUpdate): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  let out: string;
  if (match) {
    const lines = match[1]!.split("\n");
    const at = lines.findIndex((l) => /^status:/.test(l));
    if (at >= 0) lines[at] = `status: ${update.status}`;
    else lines.push(`status: ${update.status}`);
    out = `---\n${lines.join("\n")}\n---\n${normalized.slice(match[0].length)}`;
  } else {
    out = `---\nstatus: ${update.status}\n---\n${normalized}`;
  }
  if (update.note) out = `${out.trimEnd()}\n\n## Result\n\n${update.note.trim()}\n`;
  return out;
}

function firstHeading(body: string): string | undefined {
  return /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
}

export function createLocalSource(options: LocalSourceOptions): Source {
  const name = options.name ?? "local";
  const dir = resolve(options.dir);
  const onError = options.onError ?? (() => {});

  const fileOf = (id: string) => {
    if (!ID.test(id)) throw new Error(`invalid task id ${JSON.stringify(id)}`);
    return join(dir, `${id}.md`);
  };

  return {
    name,

    async list() {
      const entries = await readdir(dir, { withFileTypes: true });
      const tasks: Task[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const id = entry.name.slice(0, -3);
        if (!ID.test(id) || id.toLowerCase() === "readme") continue;
        const path = join(dir, entry.name);
        const { fields, body } = parseTaskFile(await readFile(path, "utf8"));
        const status = (fields.status ?? "open") as TaskStatus;
        if (!STATUSES.includes(status)) {
          onError(`${entry.name}: unknown status ${JSON.stringify(fields.status)}; skipped`);
          continue;
        }
        tasks.push({
          ref: { source: name, id, title: fields.title || firstHeading(body) || id, url: pathToFileURL(path).href },
          status,
          body,
          fields,
        });
      }
      return tasks.sort((a, b) => a.ref.id.localeCompare(b.ref.id));
    },

    watch(onChange) {
      let timer: NodeJS.Timeout | undefined;
      const changed = () => {
        clearTimeout(timer);
        timer = setTimeout(onChange, 100);
      };
      let watcher: ReturnType<typeof fsWatch> | undefined;
      try {
        watcher = fsWatch(dir, changed);
        watcher.on("error", (err) => onError(`watch failed: ${err.message}`));
      } catch (err) {
        onError(`watch unavailable, polling only: ${(err as Error).message}`);
      }
      const poll = setInterval(onChange, options.pollMs ?? 5_000);
      return () => {
        clearTimeout(timer);
        clearInterval(poll);
        watcher?.close();
      };
    },

    async update(id, update) {
      const path = fileOf(id);
      const next = applyUpdate(await readFile(path, "utf8"), update);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, next, "utf8");
      await rename(tmp, path);
    },
  };
}
