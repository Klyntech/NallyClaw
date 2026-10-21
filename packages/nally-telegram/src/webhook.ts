import { timingSafeEqual } from "node:crypto"
import { renderTelegramMarkdown, splitTelegramRichMarkdown } from "./markdown"

const TELEGRAM_API = "https://api.telegram.org"
const MAX_UPDATE_IDS = 2_000

export type TelegramTextMessage = {
  updateID: number
  chatID: number
  userID: number
  text: string
  username?: string
}

export type TelegramProgressReporter = (status: string) => Promise<void>

export type TelegramWebhookOptions = {
  token: string
  secret: string
  allowedUserIDs: ReadonlySet<number>
  onMessage: (message: TelegramTextMessage, reportProgress: TelegramProgressReporter) => Promise<string | void>
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

export function createTelegramWebhook(options: TelegramWebhookOptions) {
  if (!options.token.trim()) throw new Error("TELEGRAM_BOT_TOKEN is required")
  if (!options.secret.trim()) throw new Error("TELEGRAM_WEBHOOK_SECRET is required")
  if (options.secret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(options.secret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must use only letters, numbers, underscores, or hyphens (max 256 characters)")
  }
  if (options.allowedUserIDs.size === 0) throw new Error("At least one Telegram user ID must be allowlisted")

  const request = options.fetch ?? fetch
  const seen = new Map<number, true>()

  async function telegramCall(method: string, body: Record<string, unknown>) {
    const response = await request(`${TELEGRAM_API}/bot${options.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    let payload: {
      ok?: boolean
      description?: string
      result?: { message_id?: number }
    } | undefined
    try {
      payload = (await response.json()) as typeof payload
    } catch {
      payload = undefined
    }
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}` + (payload?.description ? `: ${payload.description}` : ""))
    }
    if (!payload?.ok) throw new Error(payload?.description ?? `Telegram ${method} failed`)
    return payload.result
  }

  async function sendMessage(chatID: number, markdown: string) {
    for (const chunk of renderTelegramMarkdown(markdown)) {
      await telegramCall("sendMessage", {
        chat_id: chatID,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      })
    }
  }

  function richMethodUnavailable(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return /HTTP (404|405)|unknown method|method.{0,40}(not found|not supported|unsupported)/i.test(message)
  }

  async function sendRichMessage(chatID: number, markdown: string) {
    for (const chunk of splitTelegramRichMarkdown(markdown)) {
      try {
        await telegramCall("sendRichMessage", {
          chat_id: chatID,
          rich_message: { markdown: chunk },
        })
      } catch (error) {
        if (!richMethodUnavailable(error)) throw error
        // Older Bot API installations can still receive the readable HTML fallback.
        await sendMessage(chatID, chunk)
      }
    }
  }

  async function deleteProgressMessage(chatID: number, messageID: number | undefined) {
    if (messageID === undefined) return
    try {
      await telegramCall("deleteMessage", { chat_id: chatID, message_id: messageID })
    } catch {
      // Progress cleanup is best-effort; it must not hide the final reply.
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

      // Acknowledge Telegram immediately. Model/provider calls can take longer than
      // Telegram's webhook delivery window; doing the work in the request path
      // causes retries and duplicate processing while the model is still running.
      void Promise.resolve().then(async () => {
        let progressMessageID: number | undefined
        let progressAvailable = true
        let lastProgress = ""
        const reportProgress: TelegramProgressReporter = async (status) => {
          const normalized = status.trim().slice(0, 180)
          if (!normalized || normalized === lastProgress || !progressAvailable) return
          try {
            if (progressMessageID === undefined) {
              const created = await telegramCall("sendMessage", {
                chat_id: chatID!,
                text: normalized,
                disable_web_page_preview: true,
              })
              if (typeof created?.message_id === "number") progressMessageID = created.message_id
              else progressAvailable = false
            } else {
              await telegramCall("editMessageText", {
                chat_id: chatID!,
                message_id: progressMessageID,
                text: normalized,
                disable_web_page_preview: true,
              })
            }
            lastProgress = normalized
          } catch (progressError) {
            progressAvailable = false
            console.error("Telegram progress update failed", progressError instanceof Error ? progressError.message : String(progressError))
          }
        }

        try {
          const reply = await options.onMessage({
            updateID: updateID!,
            chatID: chatID!,
            userID: userID!,
            text,
            username: message?.from?.username,
          }, reportProgress)
          await deleteProgressMessage(chatID!, progressMessageID)
          if (reply?.trim()) await sendRichMessage(chatID!, reply)
        } catch (error) {
          // Keep internal exception details out of Telegram and HTTP responses.
          console.error("Telegram message handling failed", error instanceof Error ? `${error.name}: ${error.message}` : String(error))
          await deleteProgressMessage(chatID!, progressMessageID)
          try {
            await sendMessage(chatID!, "I couldn't complete that request. Please try again.")
          } catch (sendError) {
            console.error("Telegram error reply failed", sendError instanceof Error ? sendError.message : String(sendError))
          }
        }
      })
      return Response.json({ ok: true, accepted: true })
    },
  }
}
