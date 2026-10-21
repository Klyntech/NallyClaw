# Nally Telegram runtime adapter

This package is the first runtime slice for the Telegram-first interface. It deliberately has no CLI/TUI imports and accepts an injected message handler so the transport can be tested separately from the agent runtime.

## Security and transport behavior

- Uses Telegram's webhook secret header and constant-time comparison.
- Accepts private-chat text messages only.
- Requires explicit numeric Telegram user IDs in an allowlist.
- Ignores bot messages, unsupported updates, and duplicate update IDs.
- Exposes `GET /healthz` for hosting health checks.
- Splits long replies into Telegram-sized chunks.
- Does not expose internal exception details in chat responses.

## Integration contract

The host must construct `createTelegramWebhook({ token, secret, allowedUserIDs, onMessage })` and forward requests to the returned `fetch(request)` method. The `onMessage` callback is the seam for the next phase: mapping an allowlisted Telegram user to a persistent Nally session and invoking the core agent without importing the CLI/TUI.

Required configuration:
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (Telegram webhook secret token)
- `TELEGRAM_ALLOWED_USER_IDS` (comma-separated numeric Telegram user IDs; fail closed when empty)

Do not expose the existing agent/server API directly to the public internet. Keep Telegram webhook authentication and user allowlisting enabled, and retain the agent's existing permission/approval behavior. Session durability on Render requires an external persistent store or a supported persistent disk; in-memory deduplication is only best-effort across process restarts.

## Verification

Run `bun test packages/nally-telegram/src/webhook.test.ts`. The adapter tests cover health, webhook authentication, allowlisting, and duplicate update handling. The package is transport groundwork, not yet a complete agent runtime: core-session mapping and Render startup wiring remain follow-up integration work.
