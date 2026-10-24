import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { LocalServer, parseServeLine } from "./server.ts";

test("parseServeLine reads the URL and password lines", () => {
  assert.deepEqual(parseServeLine("server listening on http://127.0.0.1:41234"), { url: "http://127.0.0.1:41234" });
  assert.deepEqual(parseServeLine("server password abc-123_x"), { password: "abc-123_x" });
  assert.deepEqual(parseServeLine("opencode server listening on http://h:1"), { url: "http://h:1" });
  assert.deepEqual(parseServeLine("loading plugins"), {});
});

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  killed = 0;
  kill() {
    this.killed++;
    this.signalCode = "SIGTERM";
    this.emit("exit", null, "SIGTERM");
    return true;
  }
  unref() {}
}

function spawner() {
  const procs: FakeProc[] = [];
  const calls: [string, string[]][] = [];
  const spawn = (command: string, args: string[]) => {
    calls.push([command, args]);
    const proc = new FakeProc();
    procs.push(proc);
    return proc as unknown as ChildProcess;
  };
  return { spawn, procs, calls };
}

test("starts one server for all sessions and stops it once idle", async () => {
  const s = spawner();
  const server = new LocalServer({ spawn: s.spawn, idleMs: 20 });
  const first = server.acquire();
  const second = server.acquire();
  s.procs[0]!.stdout.write("server listening on http://127.0.0.1:5000\nserver password pw\n");
  const expected = { url: "http://127.0.0.1:5000", username: "opencode", password: "pw" };
  assert.deepEqual(await first, expected);
  assert.deepEqual(await second, expected);
  assert.deepEqual(s.calls, [["opencode", ["serve", "--hostname=127.0.0.1", "--port=0"]]]);

  server.release();
  server.release();
  // Acquired again before the idle period ends: the same server stays.
  assert.deepEqual(await server.acquire(), expected);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.procs[0]!.killed, 0);
  server.release();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.procs[0]!.killed, 1);
  assert.equal(server.running, false);

  // The next session starts a new one.
  const again = server.acquire();
  s.procs[1]!.stdout.write("server listening on http://127.0.0.1:5001\nserver password pw2\n");
  assert.equal((await again).url, "http://127.0.0.1:5001");
  server.release();
});

test("reports a server that exits before it is ready, and retries on the next acquire", async () => {
  const s = spawner();
  const server = new LocalServer({ spawn: s.spawn });
  const failed = server.acquire();
  s.procs[0]!.stderr.write("no config\n");
  await new Promise((r) => setImmediate(r));
  s.procs[0]!.exitCode = 1;
  s.procs[0]!.emit("exit", 1, null);
  await assert.rejects(failed, /opencode serve exited \(code 1\)\nno config/);

  const ok = server.acquire();
  assert.equal(s.procs.length, 2);
  s.procs[1]!.stdout.write("server listening on http://127.0.0.1:5002\nserver password p\n");
  assert.equal((await ok).url, "http://127.0.0.1:5002");
  server.release();
});

test("times out a server that never says where it listens", async () => {
  const s = spawner();
  const server = new LocalServer({ spawn: s.spawn, startTimeoutMs: 20 });
  await assert.rejects(server.acquire(), /did not start within 20ms/);
  assert.equal(s.procs[0]!.killed, 1);
});
