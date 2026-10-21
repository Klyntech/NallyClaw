# NallyClaw environment configuration

All credentials are supplied at runtime through the host's secret environment settings. Never commit real tokens, API keys, or populated `.env` files.

## Telegram transport

| Variable | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | BotFather token used for Telegram Bot API calls |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | Secret token configured on Telegram's webhook |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | Comma-separated numeric Telegram user IDs; empty or invalid values must fail closed |
| `PORT` | Render | HTTP listener port provided by Render |

## AI providers and model selection

NallyClaw retains the upstream OpenCode provider/model system, including OpenCode Zen and NVIDIA NIM. Do not replace this with a custom one-provider client.

Provider credentials must use the exact environment-variable names already recognized by the upstream provider implementation or its supported auth flow. Confirm those names against the provider source/version in this repository before wiring deployment. Do not guess a key name and silently assume it is recognized.

Nally-specific model selectors can be supplied independently of secrets:

| Variable | Meaning |
| --- | --- |
| `NALLY_DEFAULT_PROVIDER` | Default provider ID selected by the Telegram runtime |
| `NALLY_DEFAULT_MODEL` | Default model ID, in the format expected by the existing OpenCode model registry |
| `NALLY_ZEN_MODEL` | Optional explicit model ID to prefer for OpenCode Zen |
| `NALLY_NIM_MODEL` | Optional explicit model ID to prefer for NVIDIA NIM |

These selectors must be validated against the runtime's discovered provider/model registry at startup. If a configured provider/model is unavailable, fail with a clear sanitized startup error rather than silently falling back to a different model. The final runtime integration must confirm that these selectors are actually consumed; documentation alone does not implement model selection.

## Deployment/security notes

- Configure credentials in Render's Environment / Secret Files UI, not in source control.
- Never log environment values, authorization headers, or provider API keys.
- Do not expose the upstream server API publicly as a substitute for the authenticated Telegram adapter.
- Restrict Telegram requests to private chats and explicitly allowlisted user IDs.
- Render's local filesystem may be ephemeral. Persistent conversation history must use the repository's supported database/persistence configuration or an explicitly chosen durable external store.
- Do not mark deployment ready until a startup test verifies provider/model selection, a Telegram webhook smoke test passes, and memory usage has been measured.
