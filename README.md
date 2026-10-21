# NallyClaw

**Nally** is a Telegram-first conversational AI agent designed to help with everyday questions and technical work through one chat interface.

This repository contains NallyClaw, the runtime and deployment project for Nally. It currently uses an adapted open-source agent runtime as its execution foundation while the product identity, behavior, Telegram interface, and deployment are developed for Nally.

## Current status

- Telegram webhook deployment on Render
- One conversational interface, with internal tool use and agent execution
- Configurable AI provider and model through environment variables
- Session-based conversation context
- Authorized Telegram-user allowlist and webhook-secret validation

## How it works

Telegram delivers a message to the NallyClaw webhook. The adapter passes it into the agent session, waits for the completed assistant response, and sends the result back to Telegram. The agent runtime handles model requests and available tools.

## Deployment

See [the Telegram runtime guide](docs/nally/telegram-runtime.md) for required environment variables and security boundaries, and the [memory and RAG guide](docs/nally/memory-and-rag.md) for Neon persistence, memory tools, and NVIDIA embedding configuration.

The implementation plan and remaining product work are tracked in [the Nally implementation plan](docs/nally/implementation-plan.md).

## Important limitations

Nally is under active development. The new Neon-backed Telegram session mapping, long-term memory tools, automatic retrieval, and text-ingestion RAG path are implemented in the current branch but require a successful Render build and live Telegram verification. The runtime's primary session/history database still uses its existing SQLite backend; it has not been migrated wholesale to Neon. Voice-message input, hosted voice integrations, memory-budget measurements, and full CI verification remain outstanding.

## Upstream attribution

NallyClaw is an independent adaptation of the open-source OpenCode codebase. Upstream license and copyright notices are preserved in the repository. Nally's product identity and Telegram runtime are being developed separately.
