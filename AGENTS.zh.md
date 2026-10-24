# bigtop

[English](AGENTS.md) | 简体中文

bigtop 自动启动 agent 执行任务：每个人运行一个 connector 连到 bigtop server，connector 为 server 派来的工作启动本地 agent 会话（Claude Agent SDK、Codex SDK、OpenCode SDK）。做任何结构性改动前先读 [docs/design.zh.md](docs/design.zh.md)，其中定义了核心概念（Source、Playbook、Role、Runtime、Connector、Server）和分期。

## 目录

```text
packages/
  protocol/        共享类型：Runtime 接口、会话事件、connector↔server 线上消息
  runtime-claude/  Claude Agent SDK 的 Runtime 适配器
  connector/       connector 进程和 `bigtop-connector` CLI
docs/              设计文档
```

设计里列出、但这里没有的包还不存在。

## 命令

Node ≥ 24 直接运行 TypeScript 源码，没有构建步骤。

```sh
npm install
npm test          # 对所有包运行 node --test
npm run typecheck # tsc --noEmit
```

## 约定

- **文档双语**：每份文档都有 `<name>.md`（英文）和 `<name>.zh.md`（简体中文），第二行互相链接。两份在同一个 commit 里一起改；不一致时以英文为准。
- **TypeScript**：只用可擦除的语法（不用 `enum`、`namespace`、参数属性），让 Node 能直接剥离类型。相对导入写 `.ts` 扩展名；包之间按包名导入（`@bigtop/protocol`）。
- **核心保持通用**：特定团队、任务源或 SDK 的内容不进 `protocol` 和 `connector`。SDK 细节放 `runtime-*`，任务源细节放 `source-*`，团队规则放 playbook。
- **测试**：用 `node:test`，与代码放在一起，命名为 `*.test.ts`。测试不调用真实模型或网络服务，一律注入替身（例如 `runtime-claude` 把 SDK 的 `query` 函数作为依赖传入）。
- **提交**：Conventional Commits，每个 commit 单一目的。
