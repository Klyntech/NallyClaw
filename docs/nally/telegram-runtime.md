# NallyClaw Telegram runtime

The Render entry point is `packages/nally-telegram/src/server.ts`. The public port exposes `GET /healthz`, `GET /` and `GET /voice` for the voice UI, the authenticated `/api/voice/*` endpoints, and `POST /telegram/webhook`. The underlying adapted agent server runs on a separate loopback-only port; the public service does not proxy arbitrary agent API routes. User-facing identity and behavior are defined by Nally's system prompt.

## Security and transport behavior

- Validates Telegram's webhook secret header with a constant-time comparison.
- Accepts private-chat text messages only.
- Requires explicit numeric Telegram user IDs in an allowlist; an empty list disables the webhook.
- Ignores bot messages, unsupported updates, and duplicate update IDs.
- Shows one editable progress message (thinking, tool usage, page/file reads, and response preparation), then removes it after the reply is ready.
- Sends final replies through Telegram Rich Messages, preserving Markdown headings and **bold** text and allowing native rich tables; uses an HTML fallback if the Rich Messages method is unavailable.
- Splits long replies within Telegram Rich Messages limits and does not send internal exception details to chat.
- Automatically calls Telegram `setWebhook` at startup when the required Telegram variables and `RENDER_EXTERNAL_URL` are available.
- Uses the adapted agent session/prompt API internally; the internal API listener binds to loopback only. This is an implementation detail, not the agent's user-facing identity.

## Required Render environment

- `TELEGRAM_BOT_TOKEN`: BotFather token.
- `TELEGRAM_WEBHOOK_SECRET`: secret token configured on Telegram's webhook.
- `TELEGRAM_ALLOWED_USER_IDS`: comma-separated numeric Telegram user IDs; for the personal cross-platform identity, configure exactly your own Telegram user ID.
- Optional `NALLY_PERSONAL_OWNER_ID`: stable owner key for a single-user deployment. If omitted and exactly one Telegram user ID is allowlisted, Nally automatically uses `telegram:<id>` for every session, preserving existing Telegram memories. If set, use `telegram:<your-numeric-id>` to keep existing memory ownership or a unique private label such as `personal:clinton`. Never use a shared personal owner key for a multi-user deployment.
- `OPENCODE_SERVER_PASSWORD`: server API credential. Set as a Render secret; never commit or log it.
- `PORT`: supplied by Render.
- `RENDER_EXTERNAL_URL`: supplied by Render and used to register the public webhook.
- `DATABASE_URL`: your existing Neon PostgreSQL connection string, set as a secret in Render. This enables durable Telegram session mappings, long-term memory, and the RAG store; see [memory and RAG](memory-and-rag.md). The runtime's main session/history database remains SQLite at this stage.
- Optional voice MVP: `NALLY_VOICE_ACCESS_TOKEN`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, and `ELEVENLABS_VOICE_ID`. Optional model override: `ELEVENLABS_TTS_MODEL`. These are documented in [voice-first web](voice-first-web.md).

Do not expose the existing agent/server API directly to the public internet. Keep webhook authentication and user allowlisting enabled, and retain the agent's existing permission/approval behavior.

## Known limitations

- Text-only Telegram updates are currently supported; voice notes and hosted voice APIs are not wired into this entry point yet.
- The session cache and duplicate-update tracker are in memory. User-to-session mappings are persisted in Neon, but the main agent session/history database remains SQLite; if that database is not on persistent storage, a container replacement can remove the associated conversation history.
- The upstream dependency install currently uses a non-frozen install as a temporary workaround for the checked-in workspace lockfile mismatch. Reconcile and commit the lockfile before relying on reproducible builds.
- Render reports the service as live only when its process starts; this does not by itself prove that an agent reply completes successfully or that memory stays below the Free-tier limit.

## Verification

Run `bun test packages/nally-telegram/src/*.test.ts` to cover the webhook, rich Markdown splitting, and tool progress labels. After deployment, verify `/healthz`, then send a private text message from an allowlisted Telegram account and confirm an agent response.
