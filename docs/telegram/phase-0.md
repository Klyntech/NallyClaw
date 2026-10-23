# NallyClaw Telegram Adapter — Phase 0 Gate

**Status:** In progress — owner decisions and runtime measurements are pending.  
**Design source:** `DESIGN.pdf`, version 0.1 (2026-10-23).  
**Implementation branch:** `nallyclaw-scaffolding`  
**Rule:** Do not start Phase 1 feature code until the blocking decisions below are recorded.

## Why Phase 0 comes first

The existing repository is a Bun/TypeScript AI coding-agent monorepo, not a generic personal-assistant CLI. The proposed Telegram integration should therefore be an adapter over existing headless capabilities, not a second agent implementation. The design also targets Render Free, which has no persistent disk and a 512 MB memory limit; filesystem-dependent coding tools cannot be assumed to work there.

## Blocking owner decisions

Record the decision, rationale, owner, and date for each item before Phase 1.

- [ ] **A1 — Product identity:** Is Telegram a chat surface for the existing coding agent (recommended default), a separate general-purpose assistant profile, or a full product pivot? The design assumes the existing coding agent plus session/project memory.
- [ ] **A2 — Workspace access:** Must the Telegram bot edit code in a repository? The Render Free design supports conversation, memory, and retrieval over ingested documents; filesystem-dependent coding tools require a mounted workspace and may require a different hosting plan.
- [ ] **A3 — Existing data:** Is there a live SQLite database to preserve? If yes, record the resolved DB path on the target machine, DB size, and row counts per table. Do not copy secrets or database contents into this decision note.
- [ ] **A5 — Upstream policy:** Confirm the adapter-package approach versus maintaining a deeper fork of core. The design recommends an adapter package to preserve upstream syncability.

## Phase 0 verification checklist

- [ ] Record the A1/A2/A3/A5 decisions above in this file.
- [ ] Deploy a trivial Bun service to Render Free; record cold-start duration, idle RSS, and RSS under one concurrent request.
- [ ] Verify a connection from Render to Neon using the pooled connection string; record latency and observed connection count without logging credentials.
- [ ] Run `opencode serve` headlessly and script one session creation plus session listing against the actual generated API.
- [ ] Enumerate the real routes in `packages/protocol/src/api` and add an adapter mapping table before implementing Telegram handlers.
- [ ] Freeze the `session_message.data` JSON shape that the renderer will consume.
- [ ] Confirm the pinned Bun version and compatible Effect SQL/Postgres driver versions.
- [ ] Record the measurements and a go/no-go decision before Phase 1.

## Phase 0 exit criteria

Phase 0 is complete only when the owner decisions are recorded, the headless API spike works, Render/Neon connectivity is measured, and memory/cold-start measurements support the proposed hosting target. If Bun exceeds the 512 MB budget or Neon latency makes a turn unacceptable, stop and re-plan hosting before adding bot feature code.

## Phase 1 implementation order (not started)

1. Add a `packages/telegram` adapter following the repository's Effect service/layer and HTTP API conventions.
2. Implement and test the pure renderer first: normalization, safe Markdown subset conversion, HTML escaping/validation, and Telegram-safe chunking with plain-text fallback.
3. Add webhook secret validation and database-backed update deduplication.
4. Add durable turn lifecycle, resumable processing, and a boot-time sweeper.
5. Add edit-in-place streaming with rate limiting and `/healthz` plus structured correlation logs.

Memory, RAG, media, and the full Postgres storage cutover are later phases and are intentionally not part of the first vertical slice.
