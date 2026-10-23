import { SQL } from "bun"
import { readFile } from "node:fs/promises"
import { TelegramClient } from "./client.js"
import { createTelegramBot } from "./bot.js"
import { OpenCodeClient } from "./opencode.js"
import { SqlTelegramStore, type TelegramSqlExecutor } from "./sql-store.js"

export type TelegramServerRuntime = {
  readonly path: string
  readonly handleWebhook: (request: Request) => Promise<Response>
  readonly runWorker: (signal: AbortSignal) => Promise<void>
  readonly close: () => Promise<void>
}

/**
 * Create the production Telegram runtime when Telegram environment variables are set.
 * The PostgreSQL schema is applied before the HTTP server starts, so a configured
 * deployment fails fast instead of accepting updates it cannot durably store.
 */
export async function createTelegramServerRuntime(options: {
  password: string
  port: number | undefined
  env?: NodeJS.ProcessEnv
}): Promise<TelegramServerRuntime | undefined> {
  const env = options.env ?? process.env
  const telegramConfigured = [
    env.TELEGRAM_BOT_TOKEN,
    env.TELEGRAM_WEBHOOK_SECRET,
    env.TELEGRAM_ALLOWED_USER_IDS,
  ].some((value) => value !== undefined && value.trim() !== "")

  if (!telegramConfigured) return undefined

  const token = env.TELEGRAM_BOT_TOKEN?.trim()
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim()
  const databaseUrl = env.DATABASE_URL?.trim()
  const allowedRaw = env.TELEGRAM_ALLOWED_USER_IDS?.trim()
  if (!token || !secret || !databaseUrl || !allowedRaw) {
    throw new Error(
      "Telegram requires TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_USER_IDS, and DATABASE_URL",
    )
  }

  const allowedUserIds = new Set<number>()
  for (const entry of allowedRaw.split(",")) {
    const value = Number(entry.trim())
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("TELEGRAM_ALLOWED_USER_IDS must be a comma-separated list of positive Telegram user IDs")
    }
    allowedUserIds.add(value)
  }
  if (allowedUserIds.size === 0) throw new Error("TELEGRAM_ALLOWED_USER_IDS cannot be empty")

  const path = env.TELEGRAM_WEBHOOK_PATH?.trim() || "/api/telegram/webhook"
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("TELEGRAM_WEBHOOK_PATH must be an absolute URL path without query or fragment")
  }

  const sql = new SQL(databaseUrl)
  try {
    await sql.unsafe("SELECT 1")
    const migration = await readFile(new URL("../migrations/001_telegram.sql", import.meta.url), "utf8")
    for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
      await sql.unsafe(statement)
    }
  } catch {
    await sql.close().catch(() => {})
    throw new Error("Telegram PostgreSQL connection or migration failed; check DATABASE_URL and database permissions")
  }

  const executor: TelegramSqlExecutor = {
    async query<Row>(statement: string, parameters: readonly unknown[] = []) {
      const rows = await sql.unsafe(statement, [...parameters])
      return { rows: rows as unknown as Row[] }
    },
  }
  const store = new SqlTelegramStore({ sql: executor })
  const port = options.port ?? 4096
  const baseUrl = env.OPENCODE_TELEGRAM_AGENT_URL?.trim() || `http://127.0.0.1:${port}`
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`
  const bot = createTelegramBot({
    secret,
    allowedUserIds,
    store,
    telegram: new TelegramClient(token),
    agent: new OpenCodeClient({ baseUrl, headers: { authorization } }),
  })

  return {
    path,
    handleWebhook: bot.handleWebhook,
    async runWorker(signal) {
      // Keep the managed worker alive across transient database/API failures.
      while (!signal.aborted) {
        try {
          await bot.runWorker(signal)
        } catch {
          if (signal.aborted) break
          await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
        }
      }
    },
    async close() {
      await sql.close()
    },
  }
}
