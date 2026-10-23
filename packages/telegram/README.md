# NallyClaw Telegram Adapter

This workspace package is the Telegram boundary for the existing NallyClaw/OpenCode agent. It must reuse the existing agent runtime so Phase 1 exposes the full configured toolset, including workspace and filesystem tools.

## Phase 1 foundation now present

- `src/security.ts` validates Telegram's webhook secret and parses ordinary text updates.
- `src/render.ts` extracts plain text from common message shapes and chunks output below Telegram's message limit.
- `src/client.ts` provides a minimal Telegram Bot API client without exposing the bot token in error messages.
- `src/webhook.ts` provides an injectable Request handler with sender allowlisting and a durable-update-store contract.
- `test/` contains unit tests for validation, rendering/chunking, and webhook flow.

## Important integration boundary

The webhook handler intentionally requires two host-provided dependencies:

1. `TelegramUpdateStore` must implement atomic, durable update claims and completion/release semantics. An in-memory map is not a production substitute.
2. `runTurn` must call the existing headless NallyClaw agent session in the correct workspace. It must preserve the existing tool registry and permission behavior rather than reimplementing or silently narrowing tools.

These files are the first implementation slice; they are **not yet wired into the existing server**, and no test/typecheck run is claimed. Do not deploy the webhook until the persistent store, agent session mapping, workspace isolation, authentication/network boundary, and host route registration are implemented and verified.

## Next steps

1. Implement durable Telegram update and chat-to-session storage.
2. Implement the headless agent adapter and ensure every existing tool is available through the same agent configuration.
3. Mount the webhook into the existing server with secret validation and a private/authenticated boundary.
4. Add turn lifecycle/recovery, edit-in-place progress updates, rate limits, health checks, and structured correlation logs.

Memory, RAG, media, and full storage cutover remain later phases.
