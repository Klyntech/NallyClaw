# NallyClaw Telegram Adapter

This package is the planned Telegram edge adapter for NallyClaw. It is intentionally a small workspace package and does not create a second server process or reimplement the agent runtime.

## Current scaffold

- `src/security.ts` — constant-time comparison helper and webhook-secret validation.
- `src/render.ts` — HTML escaping and conservative message chunking primitives.
- `test/` — unit tests for security and rendering primitives.
- `../../docs/telegram/phase-0.md` — blocking decisions and runtime verification checklist.

## Not wired yet

The webhook route, Effect service/layer registration, durable update deduplication, turn runner, Telegram API client, and Neon schema are intentionally not wired until Phase 0 confirms the product/workspace decisions and the actual server API contract. Do not deploy this package as a standalone service.

## Checks

From the repository root:

```sh
bun test packages/telegram/test
```

The repository's root typecheck is a monorepo-wide command; use it after integrating this package into the server layer.
