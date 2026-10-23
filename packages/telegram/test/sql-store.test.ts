import { describe, expect, test } from "bun:test"
import { SqlTelegramStore, type TelegramSqlExecutor } from "../src/sql-store.js"

function fakeSql(): TelegramSqlExecutor {
  const updates = new Map<string, { status: string }>()
  const sessions = new Map<string, string>()
  return {
    async query<Row>(sql: string, parameters: readonly unknown[] = []) {
      if (sql.includes("INSERT INTO telegram_updates")) {
        const id = String(parameters[0])
        const existing = updates.get(id)
        const leaseMs = Number(parameters[1])
        // The fake store models fresh claims and failed-claim retries; lease expiry is a DB-time behavior.
        if (!existing || existing.status === "failed") {
          updates.set(id, { status: "processing" })
          return { rows: [{ update_id: id }] as Row[] }
        }
        void leaseMs
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

  test("releases failed updates for retry and persists chat sessions", async () => {
    const store = new SqlTelegramStore({ sql: fakeSql() })
    expect(await store.begin(8)).toBe("acquired")
    await store.release(8)
    expect(await store.begin(8)).toBe("acquired")
    expect(await store.get(10)).toBeUndefined()
    await store.set(10, "ses_abc")
    expect(await store.get(10)).toBe("ses_abc")
  })

  test("validates lease configuration", () => {
    expect(() => new SqlTelegramStore({ sql: fakeSql(), leaseMs: 1 })).toThrow(RangeError)
  })
})
