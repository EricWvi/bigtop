# 快速上手

[English](getting-started.md) | 简体中文

本文在一台机器上走一遍 bigtop 的完整流程：server 监视一个存放 Markdown 任务的目录，connector 为这些任务启动 Claude、Codex 或 OpenCode 会话。server 和 connector 放在不同机器上也一样能用，只要改 URL。

## 准备

- Node.js 24 或更高版本。
- 已登录 Claude Code（终端里能运行 `claude`），或者设置了 `ANTHROPIC_API_KEY`。connector 使用 Claude Agent SDK 在本机找到的凭据，server 永远看不到它们。
- 可选，用于 Codex 任务：已登录 Codex（`codex login status` 显示已登录）。Codex SDK 自带 `codex` 可执行文件，凭据来自 `~/.codex`。
- 可选，用于 OpenCode 任务：已安装 OpenCode 2.x（`opencode --version` 显示 2.0.x；1.x 的 `opencode-ai` 包不能用），并登录了某个 provider（`opencode auth list`）。

```sh
git clone https://github.com/EricWvi/bigtop.git
cd bigtop
npm install
```

## 运行演示

[`examples/demo`](../examples/demo) 里有一份 server 配置、一份 connector 配置、一个任务和一个空的工作区。先复制到别处，免得 agent 的产出落进你的 clone 里；再把两份配置里的两个 token 改掉：

```sh
cp -r examples/demo /tmp/bigtop-demo
cd /tmp/bigtop-demo
```

在一个终端里启动 server，另一个终端里启动 connector：

```sh
node ~/bigtop/packages/server/src/cli.ts start --config server.json
node ~/bigtop/packages/connector/src/cli.ts start --config connector.json
```

connector 会在日志里列出找到的运行时（`runtime claude … available`、`runtime codex … available`、`runtime opencode … available`），并且只向 server 登记这些。server 每个事件打印一行。几秒内，任务 `hello-world` 会派给 connector，并在 `workspace/` 里启动一个 Claude 会话。会话要执行 shell 命令时，会出现一行带审批 id 的 `approval.requested`，会话随之等待。

## 批准或拒绝

第一期还没有审批代理，由人通过 HTTP 接口回答。所有接口都要把 server 的 `adminToken` 作为 bearer token：

```sh
TOKEN=change-me-admin
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7420/state            # 待审批的请求列在 "approvals" 下
curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"behavior":"allow"}' \
  http://127.0.0.1:7420/approvals/<approval-id>
curl -s -X POST -H "Authorization: Bearer $TOKEN" -d '{"behavior":"deny","message":"Use the Write tool instead."}' \
  http://127.0.0.1:7420/approvals/<approval-id>
```

没人回答的请求，在 connector 的 `approvalTimeoutMs`（默认 10 分钟）之后按拒绝处理。

会话结束后，server 把 `tasks/hello-world.md` 里的 `status` 改成 `done`（或 `failed`），并在 `## Result` 下追加 agent 的总结。往 `tasks/` 里再放一个 `.md` 文件，不用重启就会被接走。

要以 JSON 形式跟踪完整的事件流，用 server-sent events（`after` 从某个事件 id 之后开始回放）：

```sh
curl -N -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:7420/events?after=0"
```

## 任务文件

一个文件一个任务，文件名去掉 `.md` 就是任务 id。`README.md` 以及以 `_` 或 `.` 开头的文件会被忽略。

```markdown
---
title: Write a hello world script
workspace: demo
role: implementer
max-turns: 10
---
要做什么，写到 agent 需要的详细程度。
```

| 字段 | 含义 | 默认值 |
|---|---|---|
| `title` | 显示在事件和提示词里 | 第一个 `#` 标题，没有就用 id |
| `status` | `open`、`done` 或 `failed`；只有 `open` 的任务会被派发 | `open` |
| `workspace` | connector 配置里某个工作区的名字 | `defaults.workspace` |
| `role` | `implementer`（可以改文件）、`reviewer`（只读），或 server 配置里定义的角色 | `defaults.role`，没有就是 `implementer` |
| `runtime` | `claude`、`codex` 或 `opencode` | `defaults.runtime`，没有就是 `claude` |
| `max-turns`、`max-cost-usd` | 单个任务的限额 | `defaults.limits` |

失败的任务不会自动重试；要重跑，把 `status` 改回 `open`。

Codex 和 Claude 有几处会影响任务的差别：

- 它从不请求审批。角色决定它的沙箱（`reviewer` 用 `read-only`，`implementer` 用 `workspace-write`），被沙箱拒绝的命令直接失败。在 `workspace-write` 下它仍然可以写 `/tmp`，并且不能联网。
- 它忽略 `max-turns` 和 `max-cost-usd`，只报告 token 数，不报告费用。
- 它会读取你的 `~/.codex/config.toml` 和 `~/.codex/AGENTS.md`，所以那里的个人指示也会进入 bigtop 会话。

OpenCode 和 Claude 一样会请求审批（shell 命令和写入工作区以外的路径），另有几处差别：

- 模型写成 `provider/model`，例如 `deepseek/deepseek-flash`，在 server 配置的角色里设置。不设置时使用 OpenCode 的默认模型。
- 它没有结构化输出，所以跑不了需要结构化输出的轮次（第三期的审批会话）。
- connector 会为它的会话拉起一个私有的 `opencode serve`，最后一个会话结束一分钟后停掉，不会动你自己的 OpenCode 服务。

```json
"roles": { "oc-implementer": { "access": "workspace-write", "instructions": "You are an implementer.", "model": "deepseek/deepseek-flash" } }
```

## server 配置

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

- `connectors` 列出所有允许连接的 connector 及其 token。`BIGTOP_ADMIN_TOKEN` 会覆盖 `adminToken`。
- 相对的 `dir` 路径按配置文件所在目录解析。
- `roles` 用来新增角色，或替换内置的 `implementer` 和 `reviewer`。
- server 监听的是明文 HTTP。要在本机以外开放，先放到 TLS 反向代理后面，并让 connector 改用 `wss://`。

## connector 配置

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

- 默认位置是 `~/.config/bigtop/connector.json`（Windows 上是 `%APPDATA%\bigtop\connector.json`）。`BIGTOP_TOKEN` 会覆盖 `token`。
- `workspaces` 列出这台机器愿意在其中工作的目录。server 只会发来名字，因此无法让 agent 去碰其他路径。
- `slots` 是同时运行的会话数上限。

不连 server、只想试一下运行时，可以用 `exec` 跑一次会话并打印事件。`--runtime` 选择 `claude`（默认）、`codex` 或 `opencode`：

```sh
node packages/connector/src/cli.ts exec --cwd /path/to/repo --access read-only "Summarize this repository"
node packages/connector/src/cli.ts exec --runtime codex --cwd /path/to/repo --access read-only "Summarize this repository"
node packages/connector/src/cli.ts exec --runtime opencode --model deepseek/deepseek-flash --cwd /path/to/repo --access read-only "Summarize this repository"
```
