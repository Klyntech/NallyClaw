import { describe, expect, test } from "bun:test"
import { createTelegramWebhook, type TelegramUpdateStore } from "../src/webhook.js"

function makeStore(): TelegramUpdateStore {
  const state = new Set<number>()
  return {
    async begin(id) {
      if (state.has(id)) return "completed"
      state.add(id)
      return "acquired"
    },
    async complete() {},
    async release(id) {
      state.delete(id)
    },
  }
}

function update(updateId = 1, userId = 20) {
  return {
    update_id: updateId,
    message: {
      message_id: 3,
      text: "inspect the project",
      chat: { id: 10 },
      from: { id: userId },
    },
  }
}

describe("createTelegramWebhook", () => {
  test("rejects requests without the configured Telegram secret", async () => {
    const handler = createTelegramWebhook({
      secret: "expected",
      allowedUserIds: new Set([20]),
      updates: makeStore(),
      runTurn: async () => "ok",
      sendMessage: async () => {},
    })
    const response = await handler(new Request("https://example.test/webhook", { method: "POST", body: JSON.stringify(update()) }))
    expect(response.status).toBe(401)
  })

  test("ignores users outside the allowlist without running the agent", async () => {
    let called = false
    const handler = createTelegramWebhook({
      secret: "expected",
      allowedUserIds: new Set([20]),
      updates: makeStore(),
      runTurn: async () => {
        called = true
        return "ok"
      },
      sendMessage: async () => {},
    })
    const response = await handler(
      new Request("https://example.test/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "expected" },
        body: JSON.stringify(update(2, 999)),
      }),
    )
    expect(response.status).toBe(200)
    expect(called).toBe(false)
  })

  test("runs an allowed turn and sends its response", async () => {
    const sent: Array<{ chatId: number; text: string }> = []
    const handler = createTelegramWebhook({
      secret: "expected",
      allowedUserIds: new Set([20]),
      updates: makeStore(),
      runTurn: async (message) => {
        expect(message.text).toBe("inspect the project")
        return "Here is the result"
      },
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text })
      },
    })
    const response = await handler(
      new Request("https://example.test/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "expected" },
        body: JSON.stringify(update()),
      }),
    )
    expect(response.status).toBe(200)
    expect(sent).toEqual([{ chatId: 10, text: "Here is the result" }])
  })
})
