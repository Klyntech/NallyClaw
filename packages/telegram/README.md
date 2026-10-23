# NallyClaw Telegram Adapter

This workspace package is the Telegram boundary for the existing NallyClaw/OpenCode agent. It must reuse the existing agent runtime so Phase 1 exposes the full configured toolset, including workspace and filesystem tools.

## Phase 1 foundation now present

- `src/security.ts` validates Telegram's webhook secret and parses ordinary text updates.
- `src/render.ts` extracts plain text from common message shapes and chunks output below Telegram's message limit.
- `src/client.ts` provides a minimal Telegram Bot API client without exposing the bot token in error messages.
- `src/opencode.ts` provides a thin client for the existing session/create, session/prompt, message-list, and interrupt routes. Prompt execution stays in the existing agent process and uses its configured tool registry.
- `src/turn.ts` connects a Telegram chat to a saved agent session, submits a prompt, polls until the session emits an idle marker, and returns assistant text rather than echoing the admitted user message.
- `src/sql-store.ts` implements durable update claims and chat-to-session mapping through an injected SQL executor. `migrations/001_telegram.sql` defines the PostgreSQL tables.
- `src/bot.ts` composes the webhook, SQL store, Telegram client, and existing agent API client into one handler.
- The turn runner serializes messages per chat within a single process; multi-instance deployments still require a database-backed per-chat lock.
- `src/webhook.ts` provides an injectable Request handler with sender allowlisting and a durable-update-store contract.
- `test/` contains unit tests for validation, rendering/chunking, webhook flow, turn polling, and the SQL-store contract.

## Important integration boundary

The webhook handler intentionally requires two host-provided dependencies:

1. `TelegramUpdateStore` must implement atomic, durable update claims and completion/release semantics. An in-memory map is not a production substitute.
2. `runTurn` must call the existing headless NallyClaw agent session in the correct workspace. It must preserve the existing tool registry and permission behavior rather than reimplementing or silently narrowing tools.

These files are the first implementation slice; they are **not yet wired into the existing server**, and no test/typecheck run is claimed. The SQL store's behavior is covered by a fake-executor unit test; real PostgreSQL concurrency and lease-recovery behavior still need integration testing. Do not deploy the webhook until the persistent store, agent session mapping, workspace isolation, authentication/network boundary, and host route registration are implemented and verified.

## Next steps

1. Wire `SqlTelegramStore` to a real PostgreSQL executor and apply the migration; test concurrent claims and stale lease recovery against PostgreSQL.
2. Mount the composed bot handler in the existing server and ensure the webhook responds within Telegram's delivery timeout; long-running turns need a durable worker/queue before production use.
3. Mount the webhook into the existing server with secret validation and a private/authenticated boundary.
4. Add turn lifecycle/recovery, edit-in-place progress updates, rate limits, health checks, and structured correlation logs.

Memory, RAG, media, and full storage cutover remain later phases.
