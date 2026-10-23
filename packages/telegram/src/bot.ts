import { TelegramClient } from "./client.js"
import type { OpenCodeClient } from "./opencode.js"
import type { SqlTelegramStore } from "./sql-store.js"
import { createAgentTurnRunner } from "./turn.js"
import { createQueuedTelegramWebhook, runTelegramWorker } from "./queue.js"

export type TelegramBotOptions = {
  secret: string | undefined
  allowedUserIds: ReadonlySet<number>
  store: SqlTelegramStore
  telegram: TelegramClient
  agent: OpenCodeClient
  pollIntervalMs?: number
  timeoutMs?: number
  queuePollIntervalMs?: number
}

/**
 * Compose a prompt-queueing webhook and a separate durable worker.
 * The host must register handleWebhook as an HTTP route and start runWorker during
 * server startup. The webhook acknowledges only after the update has been stored.
 */
export function createTelegramBot(options: TelegramBotOptions) {
  const runTurn = createAgentTurnRunner({
    client: options.agent,
    sessions: options.store,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })

  const handleWebhook = createQueuedTelegramWebhook({
    secret: options.secret,
    allowedUserIds: options.allowedUserIds,
    queue: options.store,
  })

  return {
    handleWebhook,
    runWorker: (signal?: AbortSignal) =>
      runTelegramWorker({
        queue: options.store,
        runTurn,
        sendMessage: (chatId, text) => options.telegram.sendMessage({ chat_id: chatId, text }),
        ...(options.queuePollIntervalMs === undefined ? {} : { pollIntervalMs: options.queuePollIntervalMs }),
        ...(signal === undefined ? {} : { signal }),
      }),
  }
}
