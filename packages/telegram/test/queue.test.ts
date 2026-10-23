import { describe, expect, test } from "bun:test"
import {
  createQueuedTelegramWebhook,
  runTelegramWorker,
  type QueuedTelegramMessage,
  type TelegramQueueStore,
} from "../src/queue.js"

function telegramUpdate(updateId = 1) {
  return {
    update_id: updateId,
    message: {
      message_id: 4,
      text: "inspect files",
      chat: { id: 100 },
      from: { id: 200 },
    },
  }
}

describe("createQueuedTelegramWebhook", () => {
  test("persists an allowed update and acknowledges without running the agent", async () => {
    let queued: QueuedTelegramMessage | undefined
    const handler = createQueuedTelegramWebhook({
      secret: "secret",
      allowedUserIds: new Set([200]),
      queue: {
        async enqueue(message) {
          queued = message
          return "queued"
        },
      },
    })
    const response = await handler(new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      body: JSON.stringify(telegramUpdate()),
    }))
    expect(response.status).toBe(200)
    expect(queued).toEqual({
      updateId: 1,
      chatId: 100,
      userId: 200,
      messageId: 4,
      text: "inspect files",
    })
  })

  test("returns 503 if the durable queue is unavailable", async () => {
    const handler = createQueuedTelegramWebhook({
      secret: "secret",
      allowedUserIds: new Set([200]),
      queue: { async enqueue() { throw new Error("database down") } },
    })
    const response = await handler(new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
      body: JSON.stringify(telegramUpdate()),
    }))
    expect(response.status).toBe(503)
  })
})

describe("runTelegramWorker", () => {
  test("processes queued messages and completes the durable job", async () => {
    const controller = new AbortController()
    let claimed = false
    let completed = false
    let released = false
    const sent: string[] = []
    const message: QueuedTelegramMessage = {
      updateId: 9,
      chatId: 100,
      userId: 200,
      messageId: 4,
      text: "inspect files",
    }
    const queue: Pick<TelegramQueueStore, "claimNext" | "complete" | "release"> = {
      async claimNext() {
        if (claimed) {
          controller.abort()
          return undefined
        }
        claimed = true
        return message
      },
      async complete(id) {
        expect(id).toBe(9)
        completed = true
      },
      async release() {
        released = true
      },
    }

    await runTelegramWorker({
      queue,
      runTurn: async (input) => {
        expect(input.text).toBe("inspect files")
        return "agent result"
      },
      sendMessage: async (_chatId, text) => { sent.push(text) },
      pollIntervalMs: 50,
      signal: controller.signal,
      sleep: async () => {},
    })

    expect(sent).toEqual(["agent result"])
    expect(completed).toBe(true)
    expect(released).toBe(false)
  })
})
