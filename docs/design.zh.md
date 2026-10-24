# bigtop 设计

[English](design.md) | 简体中文

bigtop 让一群 agent 自动接活：每个人在自己机器上运行 connector，连接 bigtop server；server 从任务源里发现该做的事，派给合适的 connector，由 connector 在本地启动 agent 会话完成。需要批准的动作先交给一个独立的审批会话判断，拿不准才找人。

## 目标

- **自动派活**：人不再开会话、贴任务号。任务源里出现该处理的事，就有 agent 被唤醒。
- **agent 审批**：常规的"可以""合并吧""按你推荐的来"由审批会话给出，人只处理被升级的少数。
- **运行时无关**：第一期同时支持 Claude Agent SDK、Codex SDK、OpenCode SDK。
- **数据源无关**：GitHub Issues、本地文件、bigtop 自带任务表等都是可插拔的任务源；某个团队的协作规则（比如 circus 协议）是一份 playbook，不写进核心。
- **全程可观察**：所有状态变化都是事件，聊天、审批收件箱和以后的小镇可视化都从事件流读。

## 不做

- 不替代任务源：用了 GitHub Issues 的团队，事实来源仍是 GitHub，bigtop 不另存一份任务状态。
- 不托管凭据：模型 API key、`gh` 登录、SSH key 都留在 connector 所在机器上，server 永远拿不到。
- 不在 server 上运行 agent：agent 只在 connector 上运行。

## 概念

| 概念 | 是什么 | 在哪运行 |
|---|---|---|
| **Source** | 任务源适配器：列出任务、订阅变化、执行写回动作（评论、改状态、合并） | server（只读和调度）、connector（用本地凭据写回） |
| **Playbook** | 工作流规则：什么事件派什么角色、哪些动作要审批、完成的标准 | server |
| **Role** | 角色配置：系统提示、可用工具、允许的动作、默认 runtime | server 定义，connector 执行 |
| **Runtime** | agent SDK 适配器，把三家 SDK 统一成同一接口 | connector |
| **Connector** | 本地常驻进程：登记能力、接任务、管理工作目录和并发、跑 runtime | 每个人的机器 |
| **Server** | 登记 connector、调度、聊天频道、审批中转、事件日志 | 一台服务器 |
| **Session** | 一次 agent 会话，属于某个 connector、某个角色、某个任务 | connector |
| **Approval** | 一次审批：申请、审批会话的结论、可能的人工裁决 | server 中转 |

```text
                ┌──────────────── server ────────────────┐
  Source ──────►│ Scheduler ◄── Playbook / Roles         │
 (GitHub …)     │ Approval broker   Channels   Event log │──► UI（收件箱、聊天、小镇）
                └────▲───────────────────────▲───────────┘
                     │ WebSocket（connector 主动连）
          ┌──────────┴─────────┐   ┌─────────┴──────────┐
          │ connector (alice)  │   │ connector (bob)    │
          │  runtime-claude    │   │  runtime-codex     │
          │  runtime-opencode  │   │  workspaces/       │
          └────────────────────┘   └────────────────────┘
```

## Runtime：统一三家 SDK

### 三家 SDK 的实际能力

依据 2026-10-24 从 npm 安装的版本核对类型定义：`@anthropic-ai/claude-agent-sdk` 0.3.310、`@openai/codex-sdk` 0.164.0、`@opencode-ai/sdk` 1.19.4（v2 入口）。

| 能力 | Claude Agent SDK | Codex SDK | OpenCode SDK |
|---|---|---|---|
| 形态 | 进程内 `query()`，底层驱动 Claude Code | `Codex.startThread()`，底层驱动 `codex exec`，读 JSONL 事件 | client/server：`createOpencode()` 拉起 `opencode serve`，HTTP + SSE |
| 多轮 | `streamInput()` 或 `resume` 新开 query | 同一 `Thread` 多次 `run()` / `runStreamed()` | 同一 session 多次 `session.prompt()` / `promptAsync()` |
| 恢复 | `resume: sessionId`，`forkSession` | `resumeThread(id)`，存于 `~/.codex/sessions` | session 持久在 server，`session.fork()` |
| 中断 | `Query.interrupt()`、`abortController` | `TurnOptions.signal`（AbortSignal） | `session.abort()` |
| 逐次工具审批 | **有**：异步回调 `canUseTool(toolName, input, …)` 返回 allow/deny | **无**：只能预设 `approvalPolicy` 和 `sandboxMode` | **有**：SSE 事件 `permission.asked`，用 `permission.reply(requestID, "once" \| "always" \| "reject")` 回复 |
| 权限预设 | `permissionMode`（含 `auto`）、allow/deny 规则 | `sandboxMode`：`read-only` / `workspace-write` / `danger-full-access` | 配置里的 `permission` 规则 |
| 结构化输出 | `outputFormat` | `TurnOptions.outputSchema` | `format`（json_schema） |
| 用量 | `total_cost_usd`、`maxBudgetUsd`、`maxTurns` | 每轮 token 数，无费用 | 消息上有 `cost` |

### 接口

接口只覆盖三家都能做到的部分，差异通过 `capabilities` 声明，调度和审批按能力决定怎么用：

```ts
interface Runtime {
  readonly kind: "claude" | "codex" | "opencode";
  readonly capabilities: {
    toolApproval: boolean;   // 能否逐次拦截工具调用（Codex 为 false）
    costUsd: boolean;        // 能否报告费用
    fork: boolean;
  };
  start(spec: SessionSpec): Promise<RuntimeSession>;
  resume(id: string, spec: SessionSpec): Promise<RuntimeSession>;
}

interface SessionSpec {
  cwd: string;
  role: ResolvedRole;            // 系统提示、模型、工具与权限预设
  limits: { maxTurns?: number; maxCostUsd?: number; deadline?: string }; // ISO 时间
  onToolApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

interface RuntimeSession {
  readonly id: string;           // 用于 resume
  send(input: string, opts?: { outputSchema?: JsonSchema }): AsyncIterable<SessionEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
```

`SessionEvent` 是三家事件的归一化结果：`message`、`reasoning`、`tool.started`、`tool.completed`、`file.changed`、`turn.completed`（带用量）、`error`。原始事件保留在 `raw` 字段里，便于排查问题。审批请求不算会话事件：connector 把它作为单独的消息发给 server，并等待结论。

### Codex 没有逐次审批时怎么办

Codex 会话一律以 `approvalPolicy: "never"` 运行，安全边界完全靠预设：

- 角色声明的权限映射到 `sandboxMode`：只读角色（reviewer、approver）用 `read-only`，implementer 用 `workspace-write`，不允许 `danger-full-access`。
- 网络按角色设置 `networkAccessEnabled`。
- 需要审批的高风险动作（push、合并、写任务源）不让 agent 直接执行，改为调用 connector 提供的动作工具（见"动作"一节），在工作流层审批。

这样三家的审批语义一致：工作流层审批对所有 runtime 生效；工具级审批是锦上添花，只有 Claude 和 OpenCode 有。

## 动作：高风险操作经 connector 执行

agent 对外部世界有影响的写操作，不直接用 shell 执行，而是调用 connector 通过 MCP 暴露的**动作工具**：`task.comment`、`task.transition`、`vcs.push`、`pr.open`、`pr.merge`……connector 收到调用后：

1. 按 playbook 判断这个动作是否需要审批；
2. 需要审批的，经 server 发起 Approval，等结论；
3. 通过后用本地凭据执行，结果写进事件日志。

这样审批点是确定的，不依赖 agent 自觉；同一套动作也让 Source 适配器的写回只有一个入口。shell 里的 `git push`、`gh pr merge` 由角色的权限预设禁止（Claude、OpenCode 用 deny 规则，Codex 靠 sandbox 和不给凭据）。

## 审批

### 两层

| 层 | 触发 | 能用的 runtime |
|---|---|---|
| 工具级 | runtime 拦下的工具调用（危险命令、越界写文件） | Claude（`canUseTool`）、OpenCode（`permission.asked`） |
| 工作流级 | 动作工具 + playbook 声明的关口（合并、关闭任务、做决策） | 全部 |

### 流程

```text
申请会话 ──动作/工具调用──► connector ──► server: Approval(pending)
                                              │
                                              ▼
                                  审批会话（独立 session）
                                  输入：申请 + 上下文 + 策略
                                  输出：approve / reject / escalate + 理由
                                              │
                      ┌───────────────────────┼──────────────────────┐
                   approve                 reject                escalate
                      │                       │                      │
              connector 执行          拒绝理由回给申请会话     进人工收件箱，人裁决
```

### 约束

- **独立**：审批会话不复用申请会话的上下文，每次新开或使用专用的长期审批会话；可以配置为与申请方不同的 runtime 或模型。
- **只读**：审批角色只有读权限（Codex `read-only`；Claude 和 OpenCode 禁止所有写入类工具），它能读 diff、任务和代码，但不能改。
- **结构化结论**：用各家的结构化输出约束结论为 `{ verdict, reason, conditions? }`，解析失败按 `escalate` 处理。
- **策略文件**：每个 playbook 附一份审批策略（自然语言 + 硬规则）。硬规则在调用审批会话之前由代码判定：
  - `deny`：永远拒绝，审批会话无权覆盖（比如 force push 到默认分支、改凭据、删仓库）；
  - `escalate`：永远交给人；
  - `auto`：不需要审批，直接放行（比如只读查询）。
- **超时**：审批超时按 `escalate` 处理，申请会话保持等待或挂起。
- **审计**：申请、审批会话的完整记录、结论和执行结果都进事件日志。

## Connector

- **连接**：connector 主动建立到 server 的 WebSocket 连接，本地不开端口；断线后自动重连，用 resume token 恢复订阅。
- **身份**：每个 connector 有自己的 ID 和密钥，归属于一个人；同一个人可以有多个 connector（多台机器）。agent 在任务源上写回时用这个人的凭据。
- **登记能力**：已安装的 runtime 及版本、可用模型、并发槽位、操作系统、可访问的仓库。
- **工作目录**：每个 session 一个独立工作目录（git worktree 或临时目录），由 playbook 决定怎么准备、怎么清理。
- **限额**：本地配置并发上限、单会话和每日费用上限；超出时拒绝接活并上报。
- **跨平台**：Linux、macOS、Windows。

## Server

- **Scheduler**：订阅各 Source 的变化，交给 playbook 算出"该派谁做什么"，挑选满足能力、空闲、有权限的 connector 派发。派发是租约：connector 确认后开始，心跳续约，超时回收重派。
- **Orchestrator 角色**：全局 orchestrator 也是一个 agent 会话（运行在某个 connector 上），只有调度类工具：查看全局状态、`dispatch(role, task)`、在频道发言。它不改代码，也不替人做决定；playbook 可以完全不用它，只用规则调度。
- **Channels**：聊天频道是事件流里的一类消息。agent 可以订阅频道、@ 其他 agent 或人；被 @ 的 agent 会话会被唤醒（未运行的就按角色新开）。频道里的结论是否要写回任务源，由 playbook 决定。
- **Event log**：追加式记录，所有其他视图都由它派生。

## 事件模型

所有事件共用信封：

```ts
interface Envelope<T> {
  id: string;            // 全局唯一、单调
  at: string;            // ISO 时间
  actor: { kind: "human" | "agent" | "connector" | "system"; id: string };
  subject?: { task?: string; session?: string; approval?: string };
  type: string;
  data: T;
}
```

主要类型：`connector.online` / `offline`、`task.discovered` / `updated`、`dispatch.offered` / `accepted` / `expired`、`session.started` / `event` / `ended`、`approval.requested` / `decided` / `escalated` / `resolved`、`channel.message`、`action.executed`。

小镇可视化只需要从这些事件推出每个 agent 当前的状态：空闲、在做某个任务、等审批、在审批、在频道里说话。

## 仓库结构（TypeScript monorepo）

```text
packages/
  protocol/          事件、消息、Runtime 接口等共享类型
  server/
  connector/         CLI 与常驻进程
  runtime-claude/
  runtime-codex/
  runtime-opencode/
  source-github/
  source-local/      本地 Markdown 任务，用于开发和演示
  playbooks/         内置 playbook（含 circus）
```

选 TypeScript 的原因：三家 SDK 都以 TS 为一等实现，connector 只能用 Node；server 用同一种语言，可以共享协议类型。

## 分期

1. **能派一个任务**：protocol、server（单进程，内存存储）、connector、`runtime-claude`、`source-local`。完成标准：在本地 Markdown 里写一个任务，connector 自动启动 Claude 会话完成，事件流可见。
2. **三家 runtime**：补齐 `runtime-codex`、`runtime-opencode`，用同一组集成测试覆盖三家，按实际差异修正接口。
3. **审批**：动作工具、策略文件、审批会话、人工收件箱。完成标准：implementer 申请合并，审批会话给出结论；命中 `deny` 硬规则的申请不会进入审批会话。
4. **GitHub + circus playbook**：`source-github`，在一个真实的 circus 风格仓库上跑通"发现 → 实现 → review → 审批合并"。
5. **频道与多角色**：频道、@ 唤醒、orchestrator 角色。
6. **可视化**：只读消费事件流的小镇界面。

## 待决问题

- server 的持久化选型（第一期内存，之后 SQLite 还是 Postgres）。
- 人的登录方式：GitHub OAuth，还是 bigtop 自建账号再绑定各 Source 的身份。
- 同一任务被多个 Source 镜像时（比如 GitHub issue 和本地任务）如何去重。
- 审批会话用长期会话（省上下文加载）还是每次新开（更独立）。
- Codex 的 `approvalPolicy: "never"` 在 `workspace-write` 下遇到越权操作时的实际表现，需要第二期实测确认。
