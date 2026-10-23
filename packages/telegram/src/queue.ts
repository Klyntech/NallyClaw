import { chunkTelegramText } from "./render.js"
import { parseTelegramUpdate, verifyWebhookSecret } from "./security.js"

export const TELEGRAM_WEBHOOK_MAX_BYTES = 64 * 1024

export type QueuedTelegramMessage = {
  updateId: number
  chatId: number
  userId: number
  messageId: number
  text: string
}

export type EnqueueResult = "queued" | "duplicate"

export interface TelegramQueueStore {
  enqueue(message: QueuedTelegramMessage): Promise<EnqueueResult>
  claimNext(): Promise<QueuedTelegramMessage | undefined>
  complete(updateId: number): Promise<void>
  release(updateId: number, reason?: string): Promise<void>
}

export type QueuedTelegramOptions = {
  secret: string | undefined
  allowedUserIds: ReadonlySet<number>
  queue: Pick<TelegramQueueStore, "enqueue">
}

type BodyReadResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "invalid_json" | "too_large" }

async function readJsonLimited(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null) {
    const length = Number(declaredLength)
    if (Number.isFinite(length) && length > maxBytes) return { ok: false, reason: "too_large" }
  }
  if (!request.body) return { ok: false, reason: "invalid_json" }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: "too_large" }
      }
      chunks.push(value)
    }
  } catch {
    return { ok: false, reason: "invalid_json" }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown }
  } catch {
    return { ok: false, reason: "invalid_json" }
  }
}

/** Acknowledge Telegram promptly after durably queuing the update. */
export function createQueuedTelegramWebhook(options: QueuedTelegramOptions) {
  return async function handleTelegramWebhook(request: Request): Promise<Response> {
    if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 })
    if (!verifyWebhookSecret(request.headers.get("x-telegram-bot-api-secret-token"), options.secret)) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }

    const parsed = await readJsonLimited(request, TELEGRAM_WEBHOOK_MAX_BYTES)
    if (!parsed.ok) {
      if (parsed.reason === "too_large") return Response.json({ error: "payload_too_large" }, { status: 413 })
      return Response.json({ error: "invalid_json" }, { status: 400 })
    }

    const update = parseTelegramUpdate(parsed.value)
    if (!update) return Response.json({ ok: true, ignored: true })
    if (!options.allowedUserIds.has(update.message.userId)) {
      return Response.json({ ok: true, ignored: true })
    }

    try {
      const result = await options.queue.enqueue({
        updateId: update.updateId,
        chatId: update.message.chatId,
        userId: update.message.userId,
        messageId: update.message.messageId,
        text: update.message.text,
      })
      return Response.json({ ok: true, duplicate: result === "duplicate" })
    } catch {
      // Return non-2xx so Telegram retries if durable enqueue did not succeed.
      return Response.json({ error: "queue_unavailable" }, { status: 503 })
    }
  }
}

export type TelegramWorkerOptions = {
  queue: Pick<TelegramQueueStore, "claimNext" | "complete" | "release">
  runTurn: (message: QueuedTelegramMessage) => Promise<string | string[]>
  sendMessage: (chatId: number, text: string) => Promise<void>
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Optional cooperative stop signal for graceful shutdown. */
  signal?: AbortSignal
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Process durable Telegram jobs until aborted. Delivery is at-least-once: a crash after
 * the agent executes a tool but before the result is persisted can cause a retry, so
 * production tool execution should use idempotency where supported.
 */
export async function runTelegramWorker(options: TelegramWorkerOptions): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const sleep = options.sleep ?? defaultSleep
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50) {
    throw new RangeError("pollIntervalMs must be an integer of at least 50ms")
  }

  while (!options.signal?.aborted) {
    const message = await options.queue.claimNext()
    if (!message) {
      await sleep(pollIntervalMs)
      continue
    }

    try {
      const response = await options.runTurn(message)
      const replies = (Array.isArray(response) ? response : [response]).flatMap((text) => chunkTelegramText(text))
      for (const reply of replies) await options.sendMessage(message.chatId, reply)
      await options.queue.complete(message.updateId)
    } catch (error) {
      // Log only safe error metadata, never arbitrary messages that may contain prompt data or secrets.
      const errorType = error instanceof Error ? error.name : typeof error
      const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : undefined
      const endpoint = typeof error === "object" && error !== null && "endpoint" in error && typeof error.endpoint === "string"
        ? error.endpoint
        : undefined
      console.error("[nally-telegram] queued message processing failed", {
        updateId: message.updateId,
        errorType,
        ...(status === undefined ? {} : { status }),
        ...(endpoint === undefined ? {} : { endpoint }),
      })
      try {
        await options.queue.release(message.updateId, "processing_failed")
      } catch {
        // A stale processing lease lets another worker recover the update.
      }
    }
  }
}
