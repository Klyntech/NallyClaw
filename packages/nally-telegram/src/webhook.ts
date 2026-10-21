import { timingSafeEqual } from "node:crypto"

const TELEGRAM_API = "https://api.telegram.org"
const MAX_UPDATE_IDS = 2_000
const MAX_MESSAGE_LENGTH = 4_000

export type TelegramTextMessage = {
  updateID: number
  chatID: number
  userID: number
  text: string
  username?: string
}

export type TelegramWebhookOptions = {
  token: string
  secret: string
  allowedUserIDs: ReadonlySet<number>
  onMessage: (message: TelegramTextMessage) => Promise<string | void>
  fetch?: typeof fetch
}

type TelegramUpdate = {
  update_id?: number
  message?: {
    message_id?: number
    text?: string
    from?: { id?: number; username?: string; is_bot?: boolean }
    chat?: { id?: number; type?: string }
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && timingSafeEqual(a, b)
}

function splitMessage(text: string) {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > MAX_MESSAGE_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH)
    if (splitAt < MAX_MESSAGE_LENGTH / 2) splitAt = MAX_MESSAGE_LENGTH
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function createTelegramWebhook(options: TelegramWebhookOptions) {
  if (!options.token.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required")
  if (!options.secret.trim()) throw new Error("TELEGRAM_WEBHOOK_SECRET is required")
  if (options.secret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(options.secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must use only letters, numbers, underscores, or hyphens (max 256 characters)")
  }
  if (options.allowedUserIDs.size === 0) throw new Error("At least one Telegram user ID must be allowlisted")

  const request = options.fetch ?? fetch
  const seen = new Map<number, true>()

  async function sendMessage(chatID: number, text: string) {
    for (const chunk of splitMessage(text)) {
      const response = await request(`${TELEGRAM_API}/bot${options.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatID, text: chunk, disable_web_page_preview: true }),
      })
      if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`)
      const payload = (await response.json()) as { ok?: boolean; description?: string }
      if (!payload.ok) throw new Error(payload.description ?? "Telegram sendMessage failed")
    }
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true })
      }
      if (request.method !== "POST" || url.pathname !== "/telegram/webhook") {
        return Response.json({ error: "not_found" }, { status: 404 })
      }

      const suppliedSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? ""
      if (!safeEqual(suppliedSecret, options.secret)) {
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }

      const contentLength = Number(request.headers.get("content-length") ?? 0)
      if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
        return Response.json({ error: "payload_too_large" }, { status: 413 })
      }

      let update: TelegramUpdate
      try {
        update = (await request.json()) as TelegramUpdate
      } catch {
        return Response.json({ error: "invalid_json" }, { status: 400 })
      }

      const updateID = update.update_id
      const message = update.message
      const userID = message?.from?.id
      const chatID = message?.chat?.id
      const text = message?.text?.trim()

      if (
        !Number.isSafeInteger(updateID) ||
        !Number.isSafeInteger(userID) ||
        !Number.isSafeInteger(chatID) ||
        !text ||
        message?.from?.is_bot ||
        message?.chat?.type !== "private"
      ) {
        return Response.json({ ok: true, ignored: true })
      }

      if (!options.allowedUserIDs.has(userID!)) {
        return Response.json({ ok: true, ignored: true })
      }
      if (seen.has(updateID!)) return Response.json({ ok: true, duplicate: true })

      seen.set(updateID!, true)
      if (seen.size > MAX_UPDATE_IDS) {
        const oldest = seen.keys().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }

      try {
        const reply = await options.onMessage({
          updateID: updateID!,
          chatID: chatID!,
          userID: userID!,
          text,
          username: message?.from?.username,
        })
        if (reply?.trim()) await sendMessage(chatID!, reply)
        return Response.json({ ok: true })
      } catch (error) {
        // Keep internal exception details out of Telegram and HTTP responses.
        console.error("Telegram message handling failed", error instanceof Error ? `${error.name}: ${error.message}` : String(error))
        try {
          await sendMessage(chatID!, "I couldn't complete that request. Please try again.")
        } catch (sendError) {
          console.error("Telegram error reply failed", sendError instanceof Error ? `${sendError.name}: ${sendError.message}` : String(sendError))
        }
        return Response.json({ ok: true })
      }
    },
  }
}
