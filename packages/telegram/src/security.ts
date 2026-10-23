import { timingSafeEqual } from "node:crypto"

export type TelegramMessage = {
  chatId: number
  userId: number
  text: string
  messageId: number
}

export type TelegramUpdate = {
  updateId: number
  message: TelegramMessage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Compare Telegram's configured webhook secret using a constant-time byte comparison.
 * Missing configuration is a closed gate: the webhook must not be enabled without a secret.
 */
export function verifyWebhookSecret(actual: string | null, expected: string | undefined): boolean {
  if (!actual || !expected) return false
  const actualBytes = Buffer.from(actual, "utf8")
  const expectedBytes = Buffer.from(expected, "utf8")
  if (actualBytes.length !== expectedBytes.length) return false
  return timingSafeEqual(actualBytes, expectedBytes)
}

/**
 * Parse only ordinary text messages from private chats. Shared group chats would otherwise
 * map multiple allowed users onto the same durable agent session and workspace context.
 */
export function parseTelegramUpdate(value: unknown): TelegramUpdate | undefined {
  if (!isRecord(value)) return
  if (!Number.isSafeInteger(value.update_id) || (value.update_id as number) < 0) return

  const message = isRecord(value.message) ? value.message : undefined
  if (!message || !isRecord(message.chat) || !isRecord(message.from)) return
  if (message.chat.type !== "private") return
  if (!Number.isSafeInteger(message.message_id) || !Number.isSafeInteger(message.chat.id)) return
  if (!Number.isSafeInteger(message.from.id) || typeof message.text !== "string") return

  const text = message.text.trim()
  if (!text) return

  return {
    updateId: value.update_id as number,
    message: {
      chatId: message.chat.id as number,
      userId: message.from.id as number,
      messageId: message.message_id as number,
      text,
    },
  }
}
