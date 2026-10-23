import { TelegramClient } from "./client.js"
import type { OpenCodeClient } from "./opencode.js"
import type { SqlTelegramStore } from "./sql-store.js"
import { createAgentTurnRunner } from "./turn.js"
import { createTelegramWebhook } from "./webhook.js"

export type TelegramBotOptions = {
  secret: string | undefined
  allowedUserIds: ReadonlySet<number>
  store: SqlTelegramStore
  telegram: TelegramClient
  agent: OpenCodeClient
  pollIntervalMs?: number
  timeoutMs?: number
}

/**
 * Compose the Telegram webhook with the durable SQL store and existing agent API.
 * The host application still owns HTTP route registration, SQL-driver creation,
 * migration execution, and server authentication/network policy.
 */
export function createTelegramBot(options: TelegramBotOptions) {
  const runTurn = createAgentTurnRunner({
    client: options.agent,
    sessions: options.store,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })

  return createTelegramWebhook({
    secret: options.secret,
    allowedUserIds: options.allowedUserIds,
    updates: options.store,
    runTurn,
    sendMessage: (chatId, text) => options.telegram.sendMessage({ chat_id: chatId, text }),
  })
}
