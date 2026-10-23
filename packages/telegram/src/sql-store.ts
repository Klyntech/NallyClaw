import type { QueuedTelegramMessage, TelegramQueueStore } from "./queue.js"

export type SqlResult<Row> = { rows: Row[] }

/** Small adapter shape so the Telegram package does not couple to a specific SQL driver. */
export interface TelegramSqlExecutor {
  query<Row = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>>
}

export type SqlTelegramStoreOptions = {
  sql: TelegramSqlExecutor
  /** A crashed worker's processing claim becomes reclaimable after this many milliseconds. */
  leaseMs?: number
}

/**
 * PostgreSQL-backed durable update/session store.
 *
 * Run migrations/001_telegram.sql before constructing this store. Claims are acquired
 * atomically in SQL, so duplicate Telegram deliveries cannot start the same update twice
 * while its lease is valid. The executor must target the same durable database used by
 * every app instance.
 */
export class SqlTelegramStore implements TelegramQueueStore {
  private readonly sql: TelegramSqlExecutor
  private readonly leaseMs: number

  constructor(options: SqlTelegramStoreOptions) {
    this.sql = options.sql
    this.leaseMs = options.leaseMs ?? 120_000
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000) {
      throw new RangeError("leaseMs must be an integer of at least 1000ms")
    }
  }

  async enqueue(message: QueuedTelegramMessage): Promise<"queued" | "duplicate"> {
    const result = await this.sql.query<{ update_id: string | number }>(
      `INSERT INTO telegram_updates
        (update_id, status, chat_id, user_id, message_id, text, updated_at)
       VALUES ($1, 'queued', $2, $3, $4, $5, NOW())
       ON CONFLICT (update_id) DO NOTHING
       RETURNING update_id`,
      [String(message.updateId), String(message.chatId), String(message.userId), String(message.messageId), message.text],
    )
    return result.rows.length > 0 ? "queued" : "duplicate"
  }

  async claimNext(): Promise<QueuedTelegramMessage | undefined> {
    await this.sql.query(
      `UPDATE telegram_updates
       SET status = 'failed', updated_at = NOW(), error = 'max_attempts_exceeded'
       WHERE status = 'processing' AND attempts >= 5
         AND updated_at < NOW() - ($1::double precision * INTERVAL '1 millisecond')`,
      [this.leaseMs],
    )
    const result = await this.sql.query<{
      update_id: string | number
      chat_id: string | number | null
      user_id: string | number | null
      message_id: string | number | null
      text: string | null
    }>(
      `WITH candidate AS (
         SELECT update_id
         FROM telegram_updates
         WHERE chat_id IS NOT NULL AND user_id IS NOT NULL AND message_id IS NOT NULL AND text IS NOT NULL
           AND (
             status = 'queued'
             OR (status = 'failed' AND attempts < 5 AND updated_at < NOW() - ($1::double precision * INTERVAL '1 millisecond'))
             OR (status = 'processing' AND attempts < 5 AND updated_at < NOW() - ($1::double precision * INTERVAL '1 millisecond'))
           )
         ORDER BY updated_at, update_id
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE telegram_updates AS updates
       SET status = 'processing', updated_at = NOW(), attempts = updates.attempts + 1, error = NULL
       FROM candidate
       WHERE updates.update_id = candidate.update_id
       RETURNING updates.update_id, updates.chat_id, updates.user_id, updates.message_id, updates.text`,
      [this.leaseMs],
    )
    const row = result.rows[0]
    if (!row || row.chat_id === null || row.user_id === null || row.message_id === null || row.text === null) return
    return {
      updateId: Number(row.update_id),
      chatId: Number(row.chat_id),
      userId: Number(row.user_id),
      messageId: Number(row.message_id),
      text: row.text,
    }
  }
  async begin(updateId: number): Promise<"acquired" | "completed" | "busy"> {
    const claimed = await this.sql.query<{ update_id: string | number }>(
      `INSERT INTO telegram_updates (update_id, status, updated_at)
       VALUES ($1, 'processing', NOW())
       ON CONFLICT (update_id) DO UPDATE
         SET status = 'processing', updated_at = NOW(), error = NULL
         WHERE telegram_updates.status = 'failed'
            OR (telegram_updates.status = 'processing'
                AND telegram_updates.updated_at < NOW() - ($2::double precision * INTERVAL '1 millisecond'))
       RETURNING update_id`,
      [String(updateId), this.leaseMs],
    )
    if (claimed.rows.length > 0) return "acquired"

    const existing = await this.sql.query<{ status: string }>(
      "SELECT status FROM telegram_updates WHERE update_id = $1",
      [String(updateId)],
    )
    if (existing.rows[0]?.status === "completed") return "completed"
    return "busy"
  }

  async complete(updateId: number): Promise<void> {
    await this.sql.query(
      `UPDATE telegram_updates
       SET status = 'completed', updated_at = NOW(), error = NULL
       WHERE update_id = $1 AND status = 'processing'`,
      [String(updateId)],
    )
    const state = await this.sql.query<{ status: string }>(
      "SELECT status FROM telegram_updates WHERE update_id = $1",
      [String(updateId)],
    )
    if (state.rows[0]?.status !== "completed") throw new Error("Telegram update claim was not active")
  }

  async release(updateId: number, reason = "processing_failed"): Promise<void> {
    await this.sql.query(
      `UPDATE telegram_updates
       SET status = 'failed', updated_at = NOW(), error = $2
       WHERE update_id = $1 AND status = 'processing'`,
      [String(updateId), reason],
    )
  }

  async get(chatId: number): Promise<string | undefined> {
    const result = await this.sql.query<{ session_id: string }>(
      "SELECT session_id FROM telegram_chat_sessions WHERE chat_id = $1",
      [String(chatId)],
    )
    return result.rows[0]?.session_id
  }

  async set(chatId: number, sessionId: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO telegram_chat_sessions (chat_id, session_id, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (chat_id) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = NOW()`,
      [String(chatId), sessionId],
    )
  }
}
