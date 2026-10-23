import { chunkTelegramText } from "./render.js"
import { parseTelegramUpdate, verifyWebhookSecret } from "./security.js"

export type UpdateClaim = "acquired" | "completed" | "busy"

export interface TelegramUpdateStore {
  /** Must be atomic and durable; duplicate update IDs must not be processed concurrently. */
  begin(updateId: number): Promise<UpdateClaim>
  complete(updateId: number): Promise<void>
  release(updateId: number): Promise<void>
}

export type TelegramInboundMessage = {
  updateId: number
  chatId: number
  userId: number
  messageId: number
  text: string
}

export type TelegramWebhookOptions = {
  secret: string | undefined
  allowedUserIds: ReadonlySet<number>
  updates: TelegramUpdateStore
  runTurn: (message: TelegramInboundMessage) => Promise<string | string[]>
  sendMessage: (chatId: number, text: string) => Promise<void>
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

/**
 * Create a Telegram webhook Request handler.
 *
 * This module deliberately receives a durable update store and an existing-agent turn
 * runner from the host application. It does not create a second agent or pretend that
 * an in-memory map is durable across restarts.
 */
export function createTelegramWebhook(options: TelegramWebhookOptions) {
  return async function handleTelegramWebhook(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405)
    if (!verifyWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"), options.secret)) {
      return json({ error: "unauthorized" }, 401)
    }

    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return json({ error: "invalid_json" }, 400)
    }

    const update = parseTelegramUpdate(payload)
    // Ignore non-text updates successfully so Telegram does not retry them forever.
    if (!update) return json({ ok: true, ignored: true })

    const { message } = update
    if (!options.allowedUserIds.has(message.userId)) {
      return json({ ok: true, ignored: true })
    }

    let claim: UpdateClaim
    try {
      claim = await options.updates.begin(update.updateId)
    } catch {
      return json({ error: "update_store_unavailable" }, 503)
    }

    if (claim !== "acquired") return json({ ok: true, duplicate: true })

    try {
      const response = await options.runTurn({
        updateId: update.updateId,
        chatId: message.chatId,
        userId: message.userId,
        messageId: message.messageId,
        text: message.text,
      })
      const replies = (Array.isArray(response) ? response : [response]).flatMap((text) => chunkTelegramText(text))

      for (const reply of replies) {
        await options.sendMessage(message.chatId, reply)
      }

      await options.updates.complete(update.updateId)
      return json({ ok: true })
    } catch {
      // Release the lease so Telegram's retry can safely attempt the turn again.
      try {
        await options.updates.release(update.updateId)
      } catch {
        // Preserve the generic error response; never leak credentials or internal details.
      }
      return json({ error: "processing_failed" }, 500)
    }
  }
}
