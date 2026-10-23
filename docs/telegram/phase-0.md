# NallyClaw Telegram Adapter — Phase 0 Gate

**Status:** In progress — owner decisions partly recorded; workspace decision and runtime measurements remain pending.  
**Design source:** `DESIGN.pdf`, version 0.1 (2026-10-23).  
**Implementation branch:** `nallyclaw-scaffolding`  
**Rule:** Do not start Phase 1 feature code until all blocking decisions are recorded and the runtime verification checklist has a go/no-go result.

## Why Phase 0 comes first

The existing repository is a Bun/TypeScript AI coding-agent monorepo, not a generic personal-assistant CLI. Telegram should be an adapter over existing headless capabilities, not a second agent implementation. The design targets Render Free, which has no persistent disk and a 512 MB memory limit; filesystem-dependent coding tools cannot be assumed to work there.

## Owner decisions

- [x] **A1 — Product identity:** Expose the existing AI coding agent through Telegram. Do not create a separate general-purpose assistant or pivot away from the coding-agent product.
- [ ] **A2 — Workspace access (blocking):** **Not decided yet.** Determine whether Telegram must read/edit repository files or should initially support chat and document retrieval only. Hosting suitability depends on this decision.
- [x] **A3 — Existing data:** No existing SQLite data needs migration. Do not plan a legacy SQLite data migration unless new evidence changes this decision.
- [x] **A5 — Upstream policy:** Prefer an adapter package and preserve upstream compatibility; minimize changes to the agent core.
  
Decisions were recorded from the project owner's instruction on 2026-10-23. Revisit only if the owner changes them or verification reveals a material contradiction.

## Phase 0 verification checklist

These are still pending; no runtime measurement or integration test is claimed as complete.

- [x] Record the confirmed A1/A3/A5 owner decisions above.
- [ ] Resolve A2 — workspace/filesystem requirements.
- [ ] Deploy a trivial Bun service to Render Free; record cold-start duration, idle RSS, and RSS under one concurrent request.
- [ ] Verify Render-to-Neon connectivity using the pooled connection string; record latency and observed connection count without logging credentials.
- [ ] Run `opencode serve` headlessly and script one session creation plus session listing against the actual generated API.
- [ ] Enumerate the real routes in `packages/protocol/src/api` and add an adapter mapping table before implementing Telegram handlers.
- [ ] Freeze the `session_message.data` JSON shape that the renderer will consume.
- [ ] Confirm the pinned Bun version and compatible Effect SQL/Postgres driver versions.
- [ ] Record measurements and a go/no-go decision before Phase 1.

## Phase 0 exit criteria

Phase 0 is complete only when A2 is decided, the headless API spike works, Render/Neon connectivity is measured, and memory/cold-start measurements support the proposed hosting target. If Bun exceeds the 512 MB budget or Neon latency makes a turn unacceptable, stop and re-plan hosting before adding bot feature code.

## Phase 1 implementation order (not started)

1. Add a `packages/telegram` adapter following the repository's Effect service/layer and HTTP API conventions.
2. Implement and test the pure renderer first: normalization, safe Markdown subset conversion, HTML escaping/validation, and Telegram-safe chunking with plain-text fallback.
3. Add webhook secret validation and database-backed update deduplication.
4. Add durable turn lifecycle, resumable processing, and a boot-time sweeper.
5. Add edit-in-place streaming with rate limiting and `/healthz` plus structured correlation logs.

Memory, RAG, media, and the full Postgres storage cutover are later phases and are intentionally not part of the first vertical slice.
