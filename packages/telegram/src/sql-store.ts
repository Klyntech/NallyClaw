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
export class SqlTelegramStore {
  private readonly sql: TelegramSqlExecutor
  private readonly leaseMs: number

  constructor(options: SqlTelegramStoreOptions) {
    this.sql = options.sql
    this.leaseMs = options.leaseMs ?? 120_000
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1_000) {
      throw new RangeError("leaseMs must be an integer of at least 1000ms")
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
                AND telegram_updates.updated_at < NOW() - ($2 * INTERVAL '1 millisecond'))
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
    const result = await this.sql.query(
      `UPDATE telegram_updates
       SET status = 'completed', updated_at = NOW(), error = NULL
       WHERE update_id = $1 AND status = 'processing'`,
      [String(updateId)],
    )
    // Drivers vary in row-count reporting; a subsequent lookup is portable.
    if ("rowCount" in result && typeof (result as { rowCount?: unknown }).rowCount === "number" && (result as { rowCount: number }).rowCount > 0) return
    const state = await this.sql.query<{ status: string }>(
      "SELECT status FROM telegram_updates WHERE update_id = $1",
      [String(updateId)],
    )
    if (state.rows[0]?.status !== "completed") throw new Error("Telegram update claim was not active")
  }

  async release(updateId: number): Promise<void> {
    await this.sql.query(
      `UPDATE telegram_updates
       SET status = 'failed', updated_at = NOW()
       WHERE update_id = $1 AND status = 'processing'`,
      [String(updateId)],
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
