# NallyClaw Telegram Adapter

This workspace package reserves the integration boundary for the planned Telegram adapter. It must be mounted into the existing server process and reuse NallyClaw's agent runtime rather than creating a second server or reimplementing the agent.

## Current scaffold

- Package/workspace metadata and TypeScript configuration.
- Phase 0 decision and verification checklist: [`docs/telegram/phase-0.md`](../../docs/telegram/phase-0.md).

## Why feature code is not wired yet

The design document explicitly makes Phase 0 a gate before Phase 1 feature implementation. The repository's product identity, workspace/filesystem requirements, existing SQLite data status, upstream-sync policy, real server API mapping, and Render/Neon runtime measurements must be confirmed first. This package is not deployable and currently contains no webhook, renderer, turn runner, database driver, or Telegram API client.

## Planned first vertical slice

After Phase 0 passes, implement and test the renderer first, then the authenticated webhook and durable update deduplication, then the turn lifecycle/streaming and health/observability surface. Memory, RAG, media, and full storage cutover belong to later phases.
