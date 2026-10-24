# bigtop design

English | [简体中文](design.zh.md)

bigtop lets a crew of agents pick up work on their own. Everyone runs a connector on their own machine and connects it to a bigtop server. The server discovers work in task sources, dispatches it to a suitable connector, and the connector starts a local agent session to do it. Actions that need approval go to an independent approver session first; only uncertain cases reach a human.

## Goals

- **Automatic dispatch**: nobody opens a session and pastes a task number. When a task source has something to handle, an agent wakes up.
- **Agent approval**: the routine "yes", "merge it", "go with your recommendation" come from an approver session; humans handle only the few escalations.
- **Runtime-agnostic**: the first release supports Claude Agent SDK, Codex SDK and OpenCode SDK.
- **Source-agnostic**: GitHub Issues, local files and bigtop's own task table are pluggable task sources. A team's collaboration rules (for example the circus protocol) are a playbook, not part of the core.
- **Observable**: every state change is an event. Chat, the approval inbox and the future town visualization all read the event stream.

## Non-goals

- Replacing task sources: for a team on GitHub Issues, GitHub stays the source of truth; bigtop keeps no second copy of task state.
- Holding credentials: model API keys, `gh` logins and SSH keys stay on the connector's machine; the server never sees them.
- Running agents on the server: agents only run on connectors.

## Concepts

| Concept | What it is | Where it runs |
|---|---|---|
| **Source** | Task source adapter: lists tasks, subscribes to changes, performs write-backs (comment, transition, merge) | server (read and schedule), connector (write back with local credentials) |
| **Playbook** | Workflow rules: which event dispatches which role, which actions need approval, what counts as done | server |
| **Role** | Role configuration: system prompt, tools, allowed actions, default runtime | defined on the server, executed by connectors |
| **Runtime** | Agent SDK adapter that puts the three SDKs behind one interface | connector |
| **Connector** | Long-running local process: registers capabilities, accepts work, manages workspaces and concurrency, runs runtimes | each person's machine |
| **Server** | Connector registry, scheduling, chat channels, approval brokering, event log | one server |
| **Session** | One agent session, owned by one connector, one role and one task | connector |
| **Approval** | One approval: the request, the approver session's verdict, and possibly a human ruling | brokered by the server |

```text
                ┌──────────────── server ────────────────┐
  Source ──────►│ Scheduler ◄── Playbook / Roles         │
 (GitHub …)     │ Approval broker   Channels   Event log │──► UI (inbox, chat, town)
                └────▲───────────────────────▲───────────┘
                     │ WebSocket (opened by the connector)
          ┌──────────┴─────────┐   ┌─────────┴──────────┐
          │ connector (alice)  │   │ connector (bob)    │
          │  runtime-claude    │   │  runtime-codex     │
          │  runtime-opencode  │   │  workspaces/       │
          └────────────────────┘   └────────────────────┘
```

## Runtime: one interface over three SDKs

### What the SDKs actually offer

Checked against the type definitions of the versions installed from npm: `@anthropic-ai/claude-agent-sdk` 0.3.310 and `@openai/codex-sdk` 0.164.0 on 2026-10-24, `@opencode/client` 2.0.28 on 2026-10-25.

OpenCode ships two lines. bigtop targets 2.x (`@opencode/cli`), whose `opencode serve` offers only a v2 HttpApi under `/api`, behind basic auth with a password it prints on startup; `@opencode/client` is its generated client and must match the server's version. The 1.x line (`opencode-ai`, `@opencode-ai/sdk` 1.19.4) has a different API and is not supported.

| Capability | Claude Agent SDK | Codex SDK | OpenCode 2.x |
|---|---|---|---|
| Shape | In-process `query()`, driving Claude Code | `Codex.startThread()`, driving `codex exec` and reading JSONL events | Client/server: `opencode serve` (HTTP + SSE `/api/event`) and `@opencode/client` |
| Multi-turn | `streamInput()`, or a new query with `resume` | Repeated `run()` / `runStreamed()` on one `Thread` | Repeated `session.prompt()` on one session; it returns once the prompt is queued |
| Resume | `resume: sessionId`, `forkSession` | `resumeThread(id)`, stored in `~/.codex/sessions` | Sessions persist in OpenCode's database; `session.fork()` |
| Interrupt | `Query.interrupt()`, `abortController` | `TurnOptions.signal` (AbortSignal) | `session.interrupt()` |
| Per-tool approval | **Yes**: async callback `canUseTool(toolName, input, …)` returning allow/deny | **No**: only preset `approvalPolicy` and `sandboxMode` | **Yes**: event `permission.asked`, answered with `permission.reply({ decision: "once" \| "always" \| "reject" })` |
| Permission presets | `permissionMode` (including `auto`), allow/deny rules | `sandboxMode`: `read-only` / `workspace-write` / `danger-full-access` | Session `permissions`: `{ action, resource, effect }` rules, the last match wins |
| Structured output | `outputFormat` | `TurnOptions.outputSchema` | **None** |
| Usage | `total_cost_usd`, `maxBudgetUsd`, `maxTurns` | Tokens per turn, no cost | Cost and tokens per step (`session.step.ended`) |

### Interface

The interface covers only what all three can do; differences are declared in `capabilities`, and scheduling and approval decide what to use from them:

```ts
interface Runtime {
  readonly kind: "claude" | "codex" | "opencode";
  readonly capabilities: {
    toolApproval: boolean;   // can intercept individual tool calls (false for Codex)
    costUsd: boolean;        // reports cost
    maxTurns: boolean;       // enforces limits.maxTurns (false for Codex)
    maxCostUsd: boolean;     // enforces limits.maxCostUsd (false for Codex)
    structuredOutput: boolean; // honours outputSchema (false for OpenCode)
    fork: boolean;
  };
  start(spec: SessionSpec): Promise<RuntimeSession>;
  resume(id: string, spec: SessionSpec): Promise<RuntimeSession>;
}

interface SessionSpec {
  cwd: string;
  role: ResolvedRole;            // system prompt, model, tool and permission presets
  limits: { maxTurns?: number; maxCostUsd?: number; deadline?: string }; // ISO time
  onToolApproval?: (req: ToolApprovalRequest) => Promise<ToolApprovalDecision>;
}

interface RuntimeSession {
  readonly id: string | undefined; // used for resume; Codex assigns it during the first turn
  send(input: string, opts?: { outputSchema?: JsonSchema }): AsyncIterable<SessionEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}
```

`SessionEvent` normalizes the three SDKs' events: `message`, `reasoning`, `tool.started`, `tool.completed`, `file.changed`, `turn.completed` (with usage), `error`. The original event is kept in a `raw` field for debugging. Approval requests are not session events: the connector sends them to the server as their own messages and waits for the decision.

Rules every runtime follows:

- A turn ends with exactly one `turn.completed` or `error`; a turn stopped by `interrupt()` ends with the error `interrupted`, one past its deadline with `session deadline passed`.
- `usage.inputTokens` excludes tokens read from the prompt cache; those are `cachedInputTokens`. (Codex counts them as input; its adapter subtracts them.)
- A session may have no id until its first turn. `dispatch.accept` then omits the session id and `session.ended` carries it.

The `runtime-contract` package checks these rules, plus event normalization, role mapping, multi-turn and resume, structured output, errors and tool approval, against every runtime: each runtime package runs the same suite with a harness that plays SDK-neutral steps on its fake SDK.

### Codex has no per-tool approval

Codex sessions always run with `approvalPolicy: "never"`; the safety boundary comes entirely from presets:

- A role's permissions map to `sandboxMode`: read-only roles (reviewer, approver) use `read-only`, implementers use `workspace-write`, and `danger-full-access` is never allowed. The flags override `sandbox_mode` and `approval_policy` in the person's `~/.codex/config.toml`.
- Role instructions are passed as `developer_instructions`.
- Network access stays at Codex's default, off under `workspace-write`; setting it per role through `networkAccessEnabled` is not wired up yet.
- High-risk actions that need approval (push, merge, writing to the task source) are not executed by the agent directly; it calls the action tools the connector provides (see "Actions") and approval happens at the workflow level.

This gives all three runtimes the same approval semantics: workflow-level approval applies to every runtime, and tool-level approval is an extra that only Claude and OpenCode have.

Measured with codex-cli 0.164.0 on Linux:

- Out-of-bounds operations under `workspace-write` with `approvalPolicy: "never"` fail inside the sandbox without asking anyone: writing to `$HOME` outside the workspace fails, writing into `.git` fails, and network connections fail. The turn does not fail; the agent sees failed commands and carries on.
- `/tmp` and `$TMPDIR` are writable under `workspace-write`: they are among Codex's default writable roots, so the sandbox is not "workspace only". bigtop keeps it that way; tools need a scratch directory.
- Commands the sandbox refuses produce no `command_execution` item, so they never appear as tool events. Ordinary failing commands do appear, with `status: "failed"`. bigtop therefore cannot audit sandbox denials from Codex.
- Killing `codex exec`, which is how a turn is aborted, leaves the command it was running alive, because Codex runs commands in their own session. After an aborted turn the adapter stops processes whose environment carries the thread's `CODEX_THREAD_ID`. This works on Linux only; elsewhere such commands keep running.
- Codex reads the person's `~/.codex/config.toml` and `~/.codex/AGENTS.md`, where its credentials also live, whereas Claude sessions load project settings only. Instructions in the personal `AGENTS.md` reach the session. bigtop does not isolate `~/.codex`.
- Codex enforces neither `maxTurns` nor `maxCostUsd` (its capabilities say so); `deadline` works.

### OpenCode

- **Server**: by default the runtime starts a private `opencode serve --port=0` with the first session, stops it once the last session has been closed for a minute, and kills it when the connector exits. It never uses the person's background `opencode service`. It can be pointed at an existing server instead.
- **Roles**: each session gets `permissions` on top of the `build` agent, which allows everything: `shell` and `external_directory` ask, `question` is denied (nobody is there to answer), and read-only roles also deny `edit`. Instructions go into the session's instruction entry `bigtop` (an experimental endpoint); models are written `provider/model`. Resuming re-applies the role.
- **Turns**: the adapter subscribes to events before prompting and waits for the stream's first event, since the subscription connects lazily. A turn ends on `session.execution.succeeded`, `failed` or `interrupted`; `session.idle` does not come reliably. Permission requests from subagent sessions the session started go through the same approval path.
- **Limits**: OpenCode has no turn or budget limit of its own, so the adapter interrupts the session when a step ends past `maxTurns` or `maxCostUsd`.
- **Files**: a step names the files it changed but not how, so `file.changed` always says `update`.

Measured with opencode 2.0.28 and `deepseek/deepseek-flash`: read-only sessions do not get the write and edit tools at all; under `workspace-write` writes in the workspace go through without asking and writes outside it ask; `shell` asks; interrupting stops a running shell command too; `maxTurns` stops the session after the step that reached it.

## Actions: high-risk operations go through the connector

Writes with external effects are not run by the agent from a shell. The agent calls **action tools** the connector exposes over MCP: `task.comment`, `task.transition`, `vcs.push`, `pr.open`, `pr.merge`, … When the connector receives a call it:

1. asks the playbook whether the action needs approval;
2. if so, opens an Approval through the server and waits for the verdict;
3. once approved, executes it with local credentials and writes the result to the event log.

The approval point is therefore fixed and does not rely on the agent's discipline, and Source write-backs have a single entry point. Role permission presets forbid `git push` and `gh pr merge` from the shell (deny rules for Claude and OpenCode; the sandbox and withheld credentials for Codex).

## Approval

### Two layers

| Layer | Trigger | Runtimes |
|---|---|---|
| Tool | Tool calls intercepted by the runtime (dangerous commands, writes outside the workspace) | Claude (`canUseTool`), OpenCode (`permission.asked`) |
| Workflow | Action tools and gates declared by the playbook (merge, close a task, make a decision) | All |

### Flow

```text
requesting session ──action/tool call──► connector ──► server: Approval(pending)
                                                          │
                                                          ▼
                                          approver session (independent)
                                          input: request + context + policy
                                          output: approve / reject / escalate + reason
                                                          │
                      ┌───────────────────────────────────┼──────────────────────┐
                   approve                             reject                escalate
                      │                                   │                      │
              connector executes          reason returned to the requester   human inbox decides
```

### Constraints

- **Independent**: the approver session never reuses the requester's context; it is opened fresh for each request or is a dedicated long-lived approver session, and may be configured to use a different runtime or model from the requester.
- **Read-only**: the approver role has read access only (Codex `read-only`; Claude and OpenCode deny every write tool). It can read diffs, tasks and code but cannot change them.
- **Structured verdict**: the runtime's structured output constrains the verdict to `{ verdict, reason, conditions? }`, so approver sessions run on a runtime with `structuredOutput` (Claude or Codex, not OpenCode); a verdict that fails to parse counts as `escalate`.
- **Policy file**: each playbook ships an approval policy (natural language plus hard rules). Hard rules are evaluated in code before any approver session runs:
  - `deny`: always rejected; the approver cannot override (for example force-pushing the default branch, changing credentials, deleting a repository);
  - `escalate`: always goes to a human;
  - `auto`: no approval needed (for example read-only queries).
- **Timeout**: an approval that times out counts as `escalate`; the requesting session waits or is suspended.
- **Audit**: the request, the full approver session, the verdict and the execution result all go into the event log.

## Connector

- **Connection**: the connector opens a WebSocket to the server and listens on no local port; it reconnects automatically and restores subscriptions with a resume token.
- **Identity**: each connector has its own ID and secret and belongs to one person; a person may run several connectors (several machines). Agents write back to task sources with that person's credentials.
- **Capabilities**: installed runtimes and versions, available models, concurrency slots, operating system, reachable repositories.
- **Workspaces**: one isolated workspace per session (a git worktree or a temporary directory); the playbook decides how to prepare and clean it up.
- **Limits**: local configuration caps concurrency, per-session cost and daily cost; past a cap the connector declines work and reports why.
- **Cross-platform**: Linux, macOS, Windows.

## Server

- **Scheduler**: subscribes to each Source's changes, lets the playbook work out "who should do what", and dispatches to a connector that has the capability, a free slot and the permissions. A dispatch is a lease: the connector acknowledges and starts, heartbeats renew it, and an expired lease is reclaimed and redispatched.
- **Orchestrator role**: the global orchestrator is also an agent session (running on some connector) with scheduling tools only: view global state, `dispatch(role, task)`, post in channels. It does not change code or decide on anyone's behalf; a playbook can skip it entirely and schedule by rules.
- **Channels**: chat channels are a kind of message in the event stream. Agents subscribe to channels and @-mention other agents or people; a mentioned agent session is woken up (one is started for the role if none is running). Whether conclusions reached in a channel are written back to the task source is up to the playbook.
- **Event log**: append-only; every other view is derived from it.

## Event model

All events share an envelope:

```ts
interface Envelope<T> {
  id: number;            // increases monotonically within one server
  at: string;            // ISO time
  actor: { kind: "human" | "agent" | "connector" | "system"; id: string };
  subject?: { task?: string; dispatch?: string; session?: string; approval?: string; connector?: string };
  type: string;
  data: T;
}
```

Main types: `connector.online` / `offline`, `task.discovered` / `updated`, `dispatch.offered` / `accepted` / `expired`, `session.started` / `event` / `ended`, `approval.requested` / `decided` / `escalated` / `resolved`, `channel.message`, `action.executed`.

The town visualization only needs to derive each agent's current state from these events: idle, working on a task, waiting for approval, approving, talking in a channel.

## Repository layout (TypeScript monorepo)

```text
packages/
  protocol/          shared types: events, messages, the Runtime interface
  server/
  connector/         CLI and long-running process
  runtime-claude/
  runtime-codex/
  runtime-opencode/
  runtime-contract/  contract tests every runtime runs
  source-github/
  source-local/      local Markdown tasks, for development and demos
  playbooks/         built-in playbooks (including circus)
```

Why TypeScript: all three SDKs are first-class in TS, and the connector has to run on Node; writing the server in the same language lets both share protocol types.

## Phases

1. **Dispatch one task**: protocol, server (single process, in-memory storage), connector, `runtime-claude`, `source-local`. Done when a task written in local Markdown makes the connector start a Claude session that completes it, with the event stream visible.
2. **All three runtimes**: add `runtime-codex` and `runtime-opencode`, cover all three with one integration test suite, and revise the interface to match the real differences. Done: all three runtimes pass the shared contract suite and have been run for real.
3. **Approval**: action tools, policy files, approver sessions, the human inbox. Done when an implementer requests a merge and an approver session returns a verdict, and requests matching a `deny` hard rule never reach an approver session.
4. **GitHub + circus playbook**: `source-github`, running "discover → implement → review → approve merge" end to end on a real circus-style repository.
5. **Channels and multiple roles**: channels, @-mention wake-ups, the orchestrator role.
6. **Visualization**: a town UI that reads the event stream.

## Open questions

- Server persistence (in memory for phase 1; SQLite or Postgres afterwards).
- How people sign in: GitHub OAuth, or bigtop accounts linked to each Source's identity.
- Deduplicating a task mirrored in several Sources (for example a GitHub issue and a local task).
- Whether the approver is a long-lived session (cheaper context loading) or opened fresh each time (more independent).
