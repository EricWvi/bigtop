# bigtop

English | [简体中文](AGENTS.zh.md)

bigtop starts agents automatically to work on tasks: each person runs a connector that connects to a bigtop server, and the connector runs local agent sessions (Claude Agent SDK, Codex SDK, OpenCode SDK) for the work the server dispatches. Read [docs/design.md](docs/design.md) before changing anything structural; it defines the concepts (Source, Playbook, Role, Runtime, Connector, Server) and the phases.

## Layout

```text
packages/
  protocol/         shared types: Runtime and Source interfaces, session events, event envelope, connector↔server wire messages
  runtime-claude/   Runtime adapter for the Claude Agent SDK
  runtime-codex/    Runtime adapter for the Codex SDK
  runtime-contract/ contract test suite every runtime runs from its `contract.test.ts`
  connector/        connector process and the `bigtop-connector` CLI
  server/           hub (scheduling, leases, event log), default playbook, HTTP/WebSocket server, `bigtop-server` CLI
  source-local/     Source backed by a directory of Markdown task files
docs/               design and getting-started documents
examples/demo/      configs and a task for running server and connector locally
```

Packages listed in the design but not here do not exist yet.

## Commands

Node ≥ 24 runs the TypeScript sources directly; there is no build step.

```sh
npm install
npm test          # node --test over every package
npm run typecheck # tsc --noEmit
```

## Conventions

- **Bilingual docs**: every document exists as `<name>.md` (English) and `<name>.zh.md` (Simplified Chinese), each linking to the other on its second line. Change both in the same commit; English is the reference when they disagree.
- **TypeScript**: erasable syntax only (no `enum`, `namespace` or parameter properties), so Node can strip types. Relative imports include the `.ts` extension; packages import each other by package name (`@bigtop/protocol`).
- **Core stays generic**: nothing specific to one team, task source or SDK goes into `protocol` or `connector`. SDK details belong in `runtime-*`, task-source details in `source-*`, team rules in playbooks.
- **Tests**: `node:test` next to the code as `*.test.ts`. Tests never call a real model or network service; inject fakes (for example `runtime-claude` takes the SDK's `query` function as a dependency).
- **Runtimes**: a new runtime runs the `@bigtop/runtime-contract` suite with a harness for its fake SDK, and declares in `capabilities` what it cannot do instead of faking it. Check the SDK's installed type definitions before relying on an API; design.md records what was verified and when.
- **Commits**: Conventional Commits, one purpose per commit.
