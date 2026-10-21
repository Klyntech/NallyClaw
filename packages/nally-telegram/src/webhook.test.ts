import { describe, expect, test } from "bun:test"
import { createTelegramWebhook } from "./webhook"

const SECRET = "test-webhook-secret"

function update(updateID: number, userID = 42, text = "hello") {
  return {
    update_id: updateID,
    message: {
      message_id: updateID,
      text,
      from: { id: userID, username: "tester", is_bot: false },
      chat: { id: userID, type: "private" },
    },
  }
}

function makeWebhook(onMessage: (message: { text: string; userID: number }) => Promise<string | void>) {
  const sent: string[] = []
  const webhook = createTelegramWebhook({
    token: "test-token",
    secret: SECRET,
    allowedUserIDs: new Set([42]),
    onMessage,
    fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""))
      return Response.json({ ok: true })
    }) as typeof fetch,
  })
  return { webhook, sent }
}

describe("Telegram webhook", () => {
  test("exposes health without requiring a webhook secret", async () => {
    const { webhook } = makeWebhook(async () => "unused")
    const response = await webhook.fetch(new Request("https://example.test/healthz"))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  test("rejects an invalid secret", async () => {
    const { webhook } = makeWebhook(async () => "unused")
    const response = await webhook.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "wrong" },
        body: JSON.stringify(update(1)),
      }),
    )
    expect(response.status).toBe(401)
  })

  test("ignores users not on the allowlist", async () => {
    let called = false
    const { webhook } = makeWebhook(async () => {
      called = true
      return "no"
    })
    const response = await webhook.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify(update(1, 99)),
      }),
    )
    expect(response.status).toBe(200)
    expect(called).toBe(false)
  })

  test("handles allowed messages and ignores duplicate update IDs", async () => {
    const { webhook, sent } = makeWebhook(async (message) => `reply: ${message.text}`)
    const makeRequest = () =>
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify(update(10)),
      })
    expect((await webhook.fetch(makeRequest())).status).toBe(200)
    expect((await webhook.fetch(makeRequest())).status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!).chat_id).toBe(42)
    expect(JSON.parse(sent[0]!).text).toBe("reply: hello")
  })
})
