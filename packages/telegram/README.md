# NallyClaw Telegram Adapter

This workspace package is the Telegram boundary for the existing NallyClaw/OpenCode agent. It must reuse the existing agent runtime so Phase 1 exposes the full configured toolset, including workspace and filesystem tools.

## Phase 1 foundation now present

- `src/security.ts` validates Telegram's webhook secret and parses ordinary text updates from private chats only. Group chats are ignored so multiple people cannot accidentally share one agent session/workspace.
- `src/queue.ts` caps webhook request bodies at 64 KiB before JSON parsing, limiting memory exposure to oversized requests.
- `src/render.ts` extracts user-facing text, excludes agent reasoning and tool content, and chunks output below Telegram's message limit.
- `src/client.ts` provides a minimal Telegram Bot API client without exposing the bot token in error messages.
- `src/opencode.ts` provides a thin client for the existing session/create, session/prompt, message-list, and interrupt routes. Prompt execution stays in the existing agent process and uses its configured tool registry.
- `src/turn.ts` connects a Telegram chat to a saved agent session, submits a prompt with a deterministic Telegram-update-derived message ID, polls until the session emits an idle marker, and returns assistant text rather than echoing the admitted user message. Retries look up that prompt before resubmitting it to reduce duplicate tool execution.
- `src/sql-store.ts` implements durable update claims and chat-to-session mapping through an injected SQL executor. `migrations/001_telegram.sql` defines the PostgreSQL tables.
- `src/bot.ts` composes the webhook, SQL store, Telegram client, and existing agent API client into one handler.
- The turn runner serializes messages per chat within a single process; multi-instance deployments still require a database-backed per-chat lock.
- `src/webhook.ts` provides an inline handler useful for tests and short-lived flows. Production should use `src/queue.ts`: it validates the webhook, durably enqueues updates, and responds promptly.
- `src/queue.ts` provides a durable queue webhook and worker loop. The worker claims jobs with lease/retry support, invokes the existing agent turn runner, and sends the response.
- `src/bot.ts` composes the queued webhook and worker. The host must mount `handleWebhook` and start `runWorker` during server startup.
- `test/` contains unit tests for validation, rendering/chunking, webhook flow, turn polling, and the SQL-store contract.

## Important integration boundary

The webhook handler intentionally requires two host-provided dependencies:

1. `TelegramUpdateStore` must implement atomic, durable update claims and completion/release semantics. An in-memory map is not a production substitute.
2. `runTurn` must call the existing headless NallyClaw agent session in the correct workspace. It must preserve the existing tool registry and permission behavior rather than reimplementing or silently narrowing tools.

The CLI server now mounts the webhook before normal API authentication and starts the worker as a managed background task. Test/typecheck and live PostgreSQL/deployment verification are still required. SQL and queue behavior have fake-executor/unit coverage, but real PostgreSQL concurrency, lease recovery, and worker shutdown still need integration testing. Queue processing is at-least-once: a crash after agent-side tool execution can lead to a retry, so tool effects may need idempotency protection. Do not deploy the webhook until the persistent store, agent session mapping, workspace isolation, authentication/network boundary, and host route registration are implemented and verified.

## Next steps

1. Test concurrent claims, stale lease recovery, and graceful shutdown against a real PostgreSQL instance.
2. Add cross-instance per-chat locking and protect against duplicate agent-side effects after worker crashes. Deterministic prompt IDs prevent many duplicate admissions, but Telegram reply delivery itself is not exactly-once.
3. Add turn lifecycle/recovery, edit-in-place progress updates, rate limits, health checks, and structured correlation logs.

Memory, RAG, media, and full storage cutover remain later phases.


## Render deployment

The repository includes a root `Dockerfile` and `render.yaml`. Configure these environment variables in Render:

- `DATABASE_URL`: PostgreSQL connection URL (use the provider's TLS-enabled URL).
- `TELEGRAM_BOT_TOKEN`: bot token.
- `TELEGRAM_WEBHOOK_SECRET`: secret configured in Telegram's webhook registration.
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric Telegram user IDs allowed to use the bot.
- `TELEGRAM_WEBHOOK_PATH` (optional): defaults to `/api/telegram/webhook`.

The database migration is applied during startup. If all Telegram-specific variables are absent, the Telegram runtime stays disabled; if only some are present, startup fails fast. After deployment, register the public Render URL with Telegram using the same webhook secret.

**Persistence caveat:** PostgreSQL stores queued updates and chat-to-session mappings, not the existing OpenCode session database or workspace files. On a host with an ephemeral filesystem, those local files may be lost on restart or redeploy. Keep the service at one instance until cross-instance per-chat locking is implemented and tested. Queue processing is at-least-once, not exactly-once.
