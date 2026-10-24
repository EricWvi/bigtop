import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { applyUpdate, createLocalSource, parseTaskFile } from "./index.ts";

function dir(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "bigtop-local-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(d, name), text);
  return d;
}

test("parses front matter and body", () => {
  assert.deepEqual(parseTaskFile("---\ntitle: \"Hi: there\"\nworkspace: demo\r\nnot a field\n---\n\nDo it.\n"), {
    fields: { title: "Hi: there", workspace: "demo" },
    body: "Do it.",
  });
  assert.deepEqual(parseTaskFile("# Just a body\n"), { fields: {}, body: "# Just a body" });
});

test("applyUpdate sets status and appends the note", () => {
  assert.equal(
    applyUpdate("---\ntitle: x\nstatus: open\n---\nBody\n", { status: "done", note: "All good." }),
    "---\ntitle: x\nstatus: done\n---\nBody\n\n## Result\n\nAll good.\n",
  );
  assert.equal(applyUpdate("---\ntitle: x\n---\nBody\n", { status: "failed" }), "---\ntitle: x\nstatus: failed\n---\nBody\n");
  assert.equal(applyUpdate("Body\n", { status: "done" }), "---\nstatus: done\n---\nBody\n");
});

test("lists tasks, skipping non-tasks and bad statuses", async () => {
  const d = dir({
    "b-task.md": "---\nstatus: done\n---\n# Heading title\n",
    "a-task.md": "---\ntitle: First\nworkspace: demo\n---\nDo the first thing.",
    "plain.md": "No front matter.",
    "README.md": "about this folder",
    "_draft.md": "---\ntitle: draft\n---\n",
    "weird.md": "---\nstatus: maybe\n---\n",
    "notes.txt": "ignored",
  });
  const errors: string[] = [];
  const source = createLocalSource({ name: "mine", dir: d, onError: (m) => errors.push(m) });
  const tasks = await source.list();
  assert.deepEqual(
    tasks.map((t) => [t.ref.id, t.ref.title, t.status]),
    [
      ["a-task", "First", "open"],
      ["b-task", "Heading title", "done"],
      ["plain", "plain", "open"],
    ],
  );
  assert.deepEqual(tasks[0], {
    ref: { source: "mine", id: "a-task", title: "First", url: pathToFileURL(join(d, "a-task.md")).href },
    status: "open",
    body: "Do the first thing.",
    fields: { title: "First", workspace: "demo" },
  });
  assert.deepEqual(errors, ['weird.md: unknown status "maybe"; skipped']);
});

test("update writes back and rejects ids outside the directory", async () => {
  const d = dir({ "t1.md": "---\ntitle: T\n---\nBody" });
  const source = createLocalSource({ dir: d });
  await source.update("t1", { status: "done", note: "Did it." });
  assert.equal(readFileSync(join(d, "t1.md"), "utf8"), "---\ntitle: T\nstatus: done\n---\nBody\n\n## Result\n\nDid it.\n");
  await assert.rejects(source.update("../escape", { status: "done" }), /invalid task id/);
});

test("watch reports changes and stops", async () => {
  const d = dir({});
  const source = createLocalSource({ dir: d, pollMs: 50 });
  let calls = 0;
  const stop = source.watch(() => calls++);
  writeFileSync(join(d, "new.md"), "x");
  await new Promise((r) => setTimeout(r, 200));
  stop();
  assert.ok(calls >= 1);
  const after = calls;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(calls, after);
});
