# Getting started

English | [简体中文](getting-started.zh.md)

This walks through bigtop on one machine: a server watching a directory of Markdown tasks, and a connector that runs Claude, Codex or OpenCode sessions for them. Everything here also works with the server and connector on different machines; only the URL changes.

## Prerequisites

- Node.js 24 or later.
- Claude Code signed in (`claude` works in a terminal) or `ANTHROPIC_API_KEY` set. The connector uses whatever the Claude Agent SDK finds on its machine; the server never sees the credentials.
- Optional, for Codex tasks: Codex signed in (`codex login status` says so). The Codex SDK brings its own `codex` executable; the credentials come from `~/.codex`.
- Optional, for OpenCode tasks: OpenCode 2.x installed (`opencode --version` prints 2.0.x; the 1.x `opencode-ai` package does not work) with a provider signed in (`opencode auth list`).

```sh
git clone https://github.com/EricWvi/bigtop.git
cd bigtop
npm install
```

## Run the demo

[`examples/demo`](../examples/demo) has a server config, a connector config, one task and an empty workspace. Copy it somewhere so the agent's work does not land in your clone, and change the two tokens in both configs:

```sh
cp -r examples/demo /tmp/bigtop-demo
cd /tmp/bigtop-demo
```

Start the server in one terminal and the connector in another:

```sh
node ~/bigtop/packages/server/src/cli.ts start --config server.json
node ~/bigtop/packages/connector/src/cli.ts start --config connector.json
```

The connector logs which runtimes it found (`runtime claude … available`, `runtime codex … available`, `runtime opencode … available`) and offers only those to the server. The server prints one line per event. Within a few seconds the task `hello-world` is offered to the connector and a Claude session starts in `workspace/`. When the session wants to run a shell command, an `approval.requested` line appears with an approval id, and the session waits.

## Approve or deny

Phase 1 has no approver agent yet, so a person answers through the HTTP API. Every endpoint needs the server's `adminToken` as a bearer token:

```sh
TOKEN=change-me-admin
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7420/state            # pending approvals are listed under "approvals"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"behavior":"allow"}' \
  http://127.0.0.1:7420/approvals/<approval-id>
curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"behavior":"deny","message":"Use the Write tool instead."}' \
  http://127.0.0.1:7420/approvals/<approval-id>
```

A request nobody answers is denied after the connector's `approvalTimeoutMs` (10 minutes by default).

When the session ends, the server sets `status: done` (or `failed`) in `tasks/hello-world.md` and appends the agent's summary under `## Result`. Add another `.md` file to `tasks/` and it is picked up without a restart.

To follow the full event stream as JSON, use server-sent events (`after` replays from an event id):

```sh
curl -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7420/events?after=0"
```

## Task files

One file per task; the file name without `.md` is the task id. `README.md` and files starting with `_` or `.` are ignored.

```markdown
---
title: Write a hello world script
workspace: demo
role: implementer
max-turns: 10
---
What to do, in as much detail as the agent needs.
```

| Field | Meaning | Default |
|---|---|---|
| `title` | Shown in events and the prompt | first `#` heading, else the id |
| `status` | `open`, `done` or `failed`; only `open` tasks are dispatched | `open` |
| `workspace` | Name of a workspace in the connector config | `defaults.workspace` |
| `role` | `implementer` (may edit files), `reviewer` (read-only), or a role from the server config | `defaults.role`, else `implementer` |
| `runtime` | `claude`, `codex` or `opencode` | `defaults.runtime`, else `claude` |
| `max-turns`, `max-cost-usd` | Per-task limits | `defaults.limits` |

A failed task is not retried on its own; set `status: open` again to rerun it.

Codex differs from Claude in ways that matter for tasks:

- It never asks for approval. The role picks its sandbox (`reviewer` runs `read-only`, `implementer` runs `workspace-write`), and commands the sandbox refuses simply fail. Under `workspace-write` it can still write to `/tmp`, and it has no network.
- It ignores `max-turns` and `max-cost-usd` and reports tokens but no cost.
- It reads your `~/.codex/config.toml` and `~/.codex/AGENTS.md`, so personal instructions there reach bigtop sessions too.

OpenCode asks for approval like Claude does (shell commands and writes outside the workspace), with a few differences:

- Models are written `provider/model`, for example `deepseek/deepseek-flash`; set one in a role in the server config. Without one, OpenCode uses its default model.
- It has no structured output, so it cannot run turns that need one (the approver sessions of phase 3).
- The connector starts a private `opencode serve` for its sessions and stops it a minute after the last one ends; your own OpenCode service is not touched.

```json
"roles": { "oc-implementer": { "access": "workspace-write", "instructions": "You are an implementer.", "model": "deepseek/deepseek-flash" } }
```

## Server config

```json
{
  "host": "127.0.0.1",
  "port": 7420,
  "adminToken": "…",
  "connectors": { "alice-laptop": "…" },
  "sources": [{ "type": "local", "name": "local", "dir": "tasks" }],
  "roles": { "docs": { "access": "workspace-write", "instructions": "You write documentation.", "model": "…" } },
  "defaults": { "role": "implementer", "runtime": "claude", "workspace": "demo", "limits": { "maxTurns": 20, "maxCostUsd": 1 } }
}
```

- `connectors` lists every connector allowed to connect, with its token. `BIGTOP_ADMIN_TOKEN` overrides `adminToken`.
- Relative `dir` paths resolve against the config file.
- `roles` adds roles or replaces the built-in `implementer` and `reviewer`.
- The server listens on plain HTTP. Put it behind a TLS proxy (and use `wss://` on connectors) before exposing it beyond localhost.

## Connector config

```json
{
  "server": "ws://127.0.0.1:7420/connect",
  "connectorId": "alice-laptop",
  "token": "…",
  "slots": 1,
  "workspaces": { "demo": "/path/to/repo" },
  "approvalTimeoutMs": 600000
}
```

- The default location is `~/.config/bigtop/connector.json` (`%APPDATA%\bigtop\connector.json` on Windows). `BIGTOP_TOKEN` overrides `token`.
- `workspaces` names the directories this machine is willing to work in. The server only ever sends a name, so it cannot point an agent at any other path.
- `slots` is how many sessions may run at once.

To try a runtime without any server, `exec` runs one session and prints its events. `--runtime` picks `claude` (the default), `codex` or `opencode`:

```sh
node packages/connector/src/cli.ts exec --cwd /path/to/repo --access read-only "Summarize this repository"
node packages/connector/src/cli.ts exec --runtime codex --cwd /path/to/repo --access read-only "Summarize this repository"
node packages/connector/src/cli.ts exec --runtime opencode --model deepseek/deepseek-flash --cwd /path/to/repo --access read-only "Summarize this repository"
```
