import { describe, expect, test } from "bun:test"
import { SqlTelegramStore, type TelegramSqlExecutor } from "../src/sql-store.js"

type FakeUpdate = {
  status: string
  chat_id?: string
  user_id?: string
  message_id?: string
  text?: string
  attempts: number
}

function fakeSql(): TelegramSqlExecutor {
  const updates = new Map<string, FakeUpdate>()
  const sessions = new Map<string, string>()
  return {
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      if (sql.includes("WITH candidate AS")) {
        const candidate = [...updates.entries()].find(([, value]) => value.status === "queued")
        if (!candidate) return { rows: [] as Row[] }
        const [id, value] = candidate
        value.status = "processing"
        value.attempts++
        return {
          rows: [{
            update_id: id,
            chat_id: value.chat_id ?? null,
            user_id: value.user_id ?? null,
            message_id: value.message_id ?? null,
            text: value.text ?? null,
          }] as Row[],
        }
      }
      if (sql.includes("INSERT INTO telegram_updates") && sql.includes("chat_id, user_id")) {
        const id = String(parameters[0])
        if (updates.has(id)) return { rows: [] as Row[] }
        updates.set(id, {
          status: "queued",
          chat_id: String(parameters[1]),
          user_id: String(parameters[2]),
          message_id: String(parameters[3]),
          text: String(parameters[4]),
          attempts: 0,
        })
        return { rows: [{ update_id: id }] as Row[] }
      }
      if (sql.includes("INSERT INTO telegram_updates")) {
        const id = String(parameters[0])
        const existing = updates.get(id)
        if (!existing || existing.status === "failed") {
          updates.set(id, { status: "processing", attempts: existing?.attempts ?? 0 })
          return { rows: [{ update_id: id }] as Row[] }
        }
        return { rows: [] as Row[] }
      }
      if (sql.includes("SELECT status FROM telegram_updates")) {
        const existing = updates.get(String(parameters[0]))
        return { rows: (existing ? [{ status: existing.status }] : []) as Row[] }
      }
      if (sql.includes("UPDATE telegram_updates") && sql.includes("status = 'completed'")) {
        const existing = updates.get(String(parameters[0]))
        if (existing?.status === "processing") existing.status = "completed"
        return { rows: [] as Row[] }
      }
      if (sql.includes("UPDATE telegram_updates") && sql.includes("status = 'failed'")) {
        const existing = updates.get(String(parameters[0]))
        if (existing?.status === "processing") existing.status = "failed"
        return { rows: [] as Row[] }
      }
      if (sql.includes("SELECT session_id FROM telegram_chat_sessions")) {
        const session = sessions.get(String(parameters[0]))
        return { rows: (session ? [{ session_id: session }] : []) as Row[] }
      }
      if (sql.includes("INSERT INTO telegram_chat_sessions")) {
        sessions.set(String(parameters[0]), String(parameters[1]))
        return { rows: [] as Row[] }
      }
      throw new Error("Unexpected SQL in test: " + sql)
    },
  }
}

describe("SqlTelegramStore", () => {
  test("claims updates, suppresses duplicates, and records completion", async () => {
    const store = new SqlTelegramStore({ sql: fakeSql() })
    expect(await store.begin(7)).toBe("acquired")
    expect(await store.begin(7)).toBe("busy")
    await store.complete(7)
    expect(await store.begin(7)).toBe("completed")
  })

  test("enqueues durable messages once and claims their payload", async () => {
    const store = new SqlTelegramStore({ sql: fakeSql() })
    const message = { updateId: 21, chatId: 10, userId: 11, messageId: 12, text: "read the project" }
    expect(await store.enqueue(message)).toBe("queued")
    expect(await store.enqueue(message)).toBe("duplicate")
    expect(await store.claimNext()).toEqual(message)
    await store.complete(message.updateId)
  })

  test("persists chat sessions and validates lease configuration", async () => {
    const store = new SqlTelegramStore({ sql: fakeSql() })
    expect(await store.get(10)).toBeUndefined()
    await store.set(10, "ses_abc")
    expect(await store.get(10)).toBe("ses_abc")
    expect(() => new SqlTelegramStore({ sql: fakeSql(), leaseMs: 1 })).toThrow(RangeError)
  })
})
