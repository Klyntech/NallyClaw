# NallyClaw Telegram Adapter — Phase 0 Gate

**Status:** Phase 0 verification remains incomplete. Per the owner's explicit instruction, Phase 1 foundation work has started in parallel; this does not mean the runtime gates have passed.  
**Design source:** `DESIGN.pdf`, version 0.1 (2026-10-23).  
**Implementation branch:** `nallyclaw-scaffolding`  
**Sequencing note:** The original plan gated Phase 1 on runtime verification. The owner later explicitly instructed us to start implementation before those checks were complete. Continue implementation, but do not claim production readiness or deploy until the remaining architecture and runtime gates pass.

## Why Phase 0 comes first

The existing repository is a Bun/TypeScript AI coding-agent monorepo, not a generic personal-assistant CLI. Telegram should be an adapter over existing headless capabilities, not a second agent implementation. The owner has decided that **all existing NallyClaw tools must be available from Phase 1**, including tools that access or modify workspace files. The design targets Render Free, which has no persistent disk and a 512 MB memory limit; therefore, a durable and correctly scoped workspace cannot be assumed to be the service's local filesystem.

## Owner decisions

- [x] **A1 — Product identity:** Expose the existing AI coding agent through Telegram. Do not create a separate general-purpose assistant or pivot away from the coding-agent product.
- [x] **A2 — Workspace/tool scope:** All existing NallyClaw tools must be available through Telegram starting in Phase 1, including filesystem/workspace tools. A chat-only or reduced-tool first release is not acceptable. **Still an architecture gate:** choose and verify how the agent receives a durable, correctly scoped workspace; this is separate from the now-decided product requirement.
- [x] **A3 — Existing data:** No existing SQLite data needs migration. Do not plan a legacy SQLite data migration unless new evidence changes this decision.
- [x] **A5 — Upstream policy:** Prefer an adapter package and preserve upstream compatibility; minimize changes to the agent core.
  
Decisions were recorded from the project owner's instructions on 2026-10-23. The all-tools requirement resolves the scope question; workspace provisioning, isolation, persistence, and hosting feasibility remain unverified.


## Initial adapter route map (verified in protocol source)

Source files: `packages/protocol/src/groups/session.ts`, `packages/protocol/src/groups/message.ts`, and `packages/protocol/src/groups/event.ts`. This table records route candidates, not proof that the end-to-end headless spike has passed.

| Telegram adapter operation | Existing server route | Intended use | Status |
|---|---|---|---|
| List sessions | `GET /api/session` (`session.list`) | Find/select a conversation session | Candidate; contract test pending |
| Create session | `POST /api/session` (`session.create`) | Start a new conversation session | Candidate; contract test pending |
| Read message history | `GET /api/session/:sessionID/message` (`session.messages`) | Render existing session messages | Candidate; `session_message.data` projection still needs to be frozen |
| Send a user turn | `POST /api/session/:sessionID/prompt` (`session.prompt`) | Submit Telegram text to the existing agent | Candidate; payload/response and lifecycle need an integration spike |
| Interrupt a turn | `POST /api/session/:sessionID/interrupt` (`session.interrupt`) | Stop a running turn if supported by Telegram UX | Optional candidate |
| Observe server events | `GET /api/event` (`event.subscribe`, SSE) | Receive progress and completion events | Candidate; stream reconnect/loss semantics must be handled because the route is documented as volatile |
| Webhook ingress | Not part of the existing agent routes | Telegram update authentication, validation, and dispatch | New adapter route; design/implementation deferred until Phase 0 passes |

Do not call these routes directly from a public webhook without an explicit server-authentication and network-boundary design. The Telegram adapter must preserve the existing server's authorization model and must not expose the agent server to the public internet by accident.

## Phase 0 verification checklist

These are still pending; no runtime measurement or integration test is claimed as complete.

- [x] Record the confirmed A1/A3/A5 owner decisions above.
- [x] Record A2 — all existing tools, including filesystem/workspace tools, must be available in Phase 1.
- [ ] Design and verify durable workspace provisioning, per-user/session isolation, filesystem permissions, and safe tool execution; confirm this works with the chosen hosting target.
- [ ] Deploy a trivial Bun service to Render Free; record cold-start duration, idle RSS, and RSS under one concurrent request. Phase 1 coding has begun by owner instruction; this measurement remains a deployment gate.
- [ ] Verify Render-to-Neon connectivity using the pooled connection string; record latency and observed connection count without logging credentials.
- [ ] Run `opencode serve` headlessly and script one session creation plus session listing against the actual generated API.
- [x] Inspect the real session/message/event route definitions and record the initial adapter mapping table below. Full API-contract spike and request/response validation remain pending.
- [ ] Freeze the `session_message.data` JSON shape that the renderer will consume.
- [ ] Confirm the pinned Bun version and compatible Effect SQL/Postgres driver versions.
- [ ] Record measurements and a go/no-go decision before Phase 1.

## Phase 0 exit criteria

Phase 0 is complete only when the all-tools scope is recorded, the workspace architecture is defined and verified, the headless API spike works, Render/Neon connectivity is measured, and memory/cold-start measurements support the proposed hosting target. If the workspace cannot be made durable and isolated, Bun exceeds the 512 MB budget, or Neon latency makes a turn unacceptable, stop and re-plan hosting before adding bot feature code.

## Phase 1 implementation order (foundation started; integration incomplete)

1. **In progress:** establish the workspace/tool execution boundary so all existing agent tools are available with durable workspace access, per-session/user isolation, and least-privilege permissions.
2. **Foundation committed:** add the `packages/telegram` adapter modules for webhook validation/dispatch, plain-text rendering/chunking, Telegram Bot API calls, and a thin client for the existing agent session routes.
3. **Pending:** integrate the adapter into the existing server using repository conventions and the real headless agent session API.
4. **Pending:** implement durable update deduplication and durable chat-to-session mapping.
5. **Pending:** add durable turn lifecycle, resumable processing, and a boot-time sweeper.
6. **Pending:** add edit-in-place streaming with rate limiting and `/healthz` plus structured correlation logs.

Memory, RAG, media, and the full Postgres storage cutover are later phases and are intentionally not part of the first vertical slice.
