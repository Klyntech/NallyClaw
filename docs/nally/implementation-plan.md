# NallyClaw: Telegram-first Nally runtime

## Goal
Turn this OpenCode fork into Nally: a Telegram-first conversational coding agent deployable as a single Render web service targeting the 512 MB free-instance memory budget.

## Baseline
- Repository: Klyntech/NallyClaw
- Base branch: `dev`
- Baseline commit: `681156c82fcdd02a64dee0e81967ea35e5c8b886`
- Working branch: `nally/telegram-runtime`
- This plan is intentionally committed before runtime changes. The upstream `dev` branch remains untouched.

## Product decisions
1. Telegram is the primary user interface; remove CLI/TUI from the production runtime, not necessarily from source control in the first pass.
2. One conversational user-facing mode. Internal planning, tool selection, permission checks, and verification remain available to the agent.
3. Preserve the existing model/agent engine where practical instead of duplicating it.
4. Render deployment must expose an HTTP port. Prefer Telegram webhooks over a separate long-running polling worker.
5. Voice support includes Telegram voice-message input and hosted voice APIs where practical; measure their memory/dependency cost before enabling by default.
6. Do not delete code until import/call-site analysis and tests establish it is unused.

## Initial audit observations
- Root `package.json` is a large Bun workspace; its `dev` script starts `packages/cli/src/index.ts`.
- `packages/cli/package.json` pulls in TUI packages, prompt packages, PTY support, syntax/tree-sitter packages, and CLI-only dependencies. It is not an appropriate production entry point for the Telegram service.
- `packages/server` exposes an Effect-based HTTP API and composes a broad service graph. Its `routes.ts` currently wires project/worktree/session services, persistent PTY, MCP, watchers, jobs, plugins, and more. Reusing it unchanged may exceed the memory budget.
- `packages/core/src/agent.ts` defines selectable agents and defaults to the `build` agent; README describes separate `build` and read-only `plan` agents. We must unify the user experience without stripping permission and execution safeguards.
- README and package metadata still describe OpenCode. Branding/docs cleanup is required, but only after the runtime entry path is clear.
- No Telegram implementation was confirmed by the initial repository-scoped code search. Continue with directory/import-level inspection before concluding none exists.

## Work plan
### Phase 1 — Runtime and dependency audit
- Trace non-interactive agent execution from the CLI run handler into core session/prompt/tool execution.
- Identify the smallest supported core/service graph that can run without TUI, desktop, updater, analytics/observability exporters, and unnecessary background services.
- Inspect session/database persistence and file/workspace requirements on Render.
- Inspect existing tests and CI to establish commands and baseline failures.

### Phase 2 — Telegram adapter
- Add a Telegram webhook endpoint to the HTTP service.
- Verify Telegram webhook secret and restrict commands to explicitly authorized Telegram user/chat IDs.
- Map Telegram chat IDs to persistent agent sessions.
- Handle text, attachments, bounded message splitting, tool-progress/error replies, and safe voice-message handling.
- Add tests for auth, duplicate webhook deliveries, malformed updates, and session mapping.

### Phase 3 — One conversational mode
- Remove mode-switch UI and mode-specific user instructions from the Telegram surface.
- Retain internal planning, tool permissions, approval gates, and verification.
- Test chat, code-editing/tool execution, errors, and follow-up context.

### Phase 4 — Render and memory
- Add a minimal production container/start command that binds to Render's `PORT`.
- Prefer webhooks; avoid a second worker.
- Avoid loading desktop/TUI and unused provider integrations in the production entry path.
- Document required secrets and storage behavior. Do not claim durable memory on ephemeral disk; select external persistence or explicitly document limits.
- Measure peak RSS under normal chat, tool execution, and voice paths. The 512 MB target is a measured acceptance criterion, not an assumption.

### Phase 5 — Verification and cleanup
- Run focused tests, typecheck, build, webhook integration tests, and smoke tests.
- Remove CLI/TUI packages from production packaging only after dependency checks confirm they are not imported by the runtime.
- Update README, Render configuration, environment-variable docs, and license/attribution notices.
- Open a PR; do not merge or deploy without a green verification report.

## Acceptance criteria
- Telegram text conversation works end-to-end using the existing agent engine.
- Only authorized Telegram identities can invoke the agent.
- Follow-up messages preserve the correct session context.
- Agent can use the supported coding tools with existing permission safeguards.
- Voice input works when enabled and does not force unnecessary heavyweight dependencies into the base runtime.
- Render web service binds to `PORT`, responds to health checks, and handles webhook requests.
- Peak memory remains below the instance limit with safety margin under representative workloads.
- CI/typecheck/tests pass, or every remaining failure is documented and attributable.
