import { describe, expect, test } from "bun:test"
import { parseTelegramUpdate, verifyWebhookSecret } from "../src/security.js"

describe("verifyWebhookSecret", () => {
  test("requires both configured and presented secrets", () => {
    expect(verifyWebhookSecret(null, "secret")).toBe(false)
    expect(verifyWebhookSecret("secret", undefined)).toBe(false)
    expect(verifyWebhookSecret("secret", "secret")).toBe(true)
    expect(verifyWebhookSecret("wrong", "secret")).toBe(false)
  })
})

describe("parseTelegramUpdate", () => {
  test("extracts a regular text message from a private chat", () => {
    expect(
      parseTelegramUpdate({
        update_id: 42,
        message: {
          message_id: 7,
          text: "  hello NallyClaw  ",
          chat: { id: 123, type: "private" },
          from: { id: 456 },
        },
      }),
    ).toEqual({
      updateId: 42,
      message: { chatId: 123, userId: 456, messageId: 7, text: "hello NallyClaw" },
    })
  })

  test("ignores group chats to prevent multiple users sharing one agent session", () => {
    expect(
      parseTelegramUpdate({
        update_id: 44,
        message: {
          message_id: 8,
          text: "private workspace",
          chat: { id: -123, type: "group" },
          from: { id: 456 },
        },
      }),
    ).toBeUndefined()
  })

  test("ignores malformed, empty, and non-text updates", () => {
    expect(parseTelegramUpdate(null)).toBeUndefined()
    expect(parseTelegramUpdate({ update_id: "42" })).toBeUndefined()
    expect(parseTelegramUpdate({ update_id: 42, message: { text: "photo" } })).toBeUndefined()
    expect(
      parseTelegramUpdate({
        update_id: 43,
        message: { message_id: 1, text: "   ", chat: { id: 1, type: "private" }, from: { id: 2 } },
      }),
    ).toBeUndefined()
  })
})
