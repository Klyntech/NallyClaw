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

function makeWebhook(onMessage: (message: { text: string; userID: number }, reportProgress: (status: string) => Promise<void>) => Promise<string | void>) {
  const sent: string[] = []
  const methods: string[] = []
  let nextMessageID = 100
  const webhook = createTelegramWebhook({
    token: "test-token",
    secret: SECRET,
    allowedUserIDs: new Set([42]),
    onMessage,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""))
      methods.push(String(input).split("/").pop() ?? "")
      return Response.json({ ok: true, result: { message_id: nextMessageID++ } })
    }) as typeof fetch,
  })
  return { webhook, sent, methods }
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

  test("edits one progress message and sends a rich final reply", async () => {
    const { webhook, sent, methods } = makeWebhook(async (_message, reportProgress) => {
      await reportProgress("🤔 Thinking…")
      await reportProgress("📄 Reading file…")
      await reportProgress("📄 Reading file…")
      return "## Result\n\n**Done**"
    })
    const response = await webhook.fetch(
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify(update(22)),
      }),
    )
    expect(response.status).toBe(200)
    await Bun.sleep(20)

    expect(methods).toEqual(["sendMessage", "editMessageText", "deleteMessage", "sendRichMessage"])
    const finalPayload = JSON.parse(sent[sent.length - 1]!)
    expect(finalPayload.rich_message.markdown).toContain("## Result")
    expect(finalPayload.rich_message.markdown).toContain("**Done**")
  })

  test("handles allowed messages and ignores duplicate update IDs", async () => {
    const { webhook, sent } = makeWebhook(async (message) => `reply: ${message.text}`)
    const makeRequest = () =>
      new Request("https://example.test/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": SECRET },
        body: JSON.stringify(update(10)),
      })
    const first = await webhook.fetch(makeRequest())
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, accepted: true })
    const duplicate = await webhook.fetch(makeRequest())
    expect(duplicate.status).toBe(200)
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true })

    // Processing and Telegram sendMessage happen after the webhook is acknowledged.
    await Bun.sleep(10)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]!).chat_id).toBe(42)
    expect(JSON.parse(sent[0]!).rich_message.markdown).toBe("reply: hello")
  })
})
