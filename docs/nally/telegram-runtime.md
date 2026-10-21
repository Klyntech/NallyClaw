# NallyClaw Telegram runtime

The Render entry point is `packages/nally-telegram/src/server.ts`. It exposes only `GET /healthz` and `POST /telegram/webhook` on the public port. The OpenCode agent HTTP API runs on a separate loopback-only port, so the public service does not proxy arbitrary API routes.

## Security and transport behavior

- Validates Telegram's webhook secret header with a constant-time comparison.
- Accepts private-chat text messages only.
- Requires explicit numeric Telegram user IDs in an allowlist; an empty list disables the webhook.
- Ignores bot messages, unsupported updates, and duplicate update IDs.
- Splits long replies into Telegram-sized chunks and does not send internal exception details to chat.
- Automatically calls Telegram `setWebhook` at startup when the required Telegram variables and `RENDER_EXTERNAL_URL` are available.
- Uses the existing OpenCode session/prompt API internally; the internal API listener binds to loopback only.

## Required Render environment

- `TELEGRAM_BOT_TOKEN`: BotFather token.
- `TELEGRAM_WEBHOOK_SECRET`: secret token configured on Telegram's webhook.
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric Telegram user IDs; do not leave empty.
- `OPENCODE_SERVER_PASSWORD`: server API credential. Set as a Render secret; never commit or log it.
- `PORT`: supplied by Render.
- `RENDER_EXTERNAL_URL`: supplied by Render and used to register the public webhook.

Do not expose the existing agent/server API directly to the public internet. Keep webhook authentication and user allowlisting enabled, and retain the agent's existing permission/approval behavior.

## Known limitations

- Text-only Telegram updates are currently supported; voice notes and hosted voice APIs are not wired into this entry point yet.
- Chat-to-session mapping and duplicate-update tracking are in memory. A process restart loses these maps; durable session mapping needs persistent storage before treating the runtime as production-ready.
- The upstream dependency install currently uses a non-frozen install as a temporary workaround for the checked-in workspace lockfile mismatch. Reconcile and commit the lockfile before relying on reproducible builds.
- Render reports the service as live only when its process starts; this does not by itself prove that an agent reply completes successfully or that memory stays below the Free-tier limit.

## Verification

Run `bun test packages/nally-telegram/src/webhook.test.ts`. After deployment, verify `/healthz`, then send a private text message from an allowlisted Telegram account and confirm an agent response.
