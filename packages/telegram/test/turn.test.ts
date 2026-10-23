import { describe, expect, test } from "bun:test"
import { createAgentTurnRunner, type TelegramSessionMap } from "../src/turn.js"
import type { OpenCodeMessage } from "../src/opencode.js"

function sessionMap(initial?: string): TelegramSessionMap {
  let value = initial
  return {
    async get() { return value },
    async set(_chatId, sessionId) { value = sessionId },
  }
}

const assistant = (id: string, text: string, created: string): OpenCodeMessage => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
  time: { created, completed: created },
})

describe("createAgentTurnRunner", () => {
  test("creates a session once and waits for the assistant idle marker", async () => {
    const calls: string[] = []
    let poll = 0
    const client = {
      async createSession(title: string) {
        calls.push("create:" + title)
        return { id: "ses_1" }
      },
      async getMessage() { return undefined },
      async sendPrompt(sessionId: string, text: string) {
        calls.push("prompt:" + sessionId + ":" + text)
        return { id: "msg_user", type: "user", text, time: { created: "2026-01-01T00:00:00.000Z" } }
      },
      async listMessages() {
        poll++
        if (poll === 1) return [{ id: "msg_user", type: "user" }]
        return [
          { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: "2026-01-01T00:00:03.000Z" } },
          assistant("msg_assistant", "The answer", "2026-01-01T00:00:02.000Z"),
          { id: "msg_user", type: "user", time: { created: "2026-01-01T00:00:00.000Z" } },
        ]
      },
    }

    let clock = 100
    const run = createAgentTurnRunner({
      client,
      sessions: sessionMap(),
      pollIntervalMs: 50,
      timeoutMs: 500,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
    })

    await expect(run({ chatId: 55, text: "hello" })).resolves.toBe("The answer")
    expect(calls).toEqual(["create:Telegram chat", "prompt:ses_1:hello"])
    expect(poll).toBe(2)
  })

  test("reuses the saved session and returns a safe message for failed runs", async () => {
    const client = {
      async createSession() { throw new Error("should not create") },
      async getMessage() { return undefined },
      async sendPrompt() { return { id: "msg_user", type: "user" } },
      async listMessages() {
        return [
          { id: "msg_idle", type: "idle", outcome: "failed" },
          { id: "msg_user", type: "user" },
        ]
      },
    }
    const run = createAgentTurnRunner({
      client,
      sessions: sessionMap("ses_existing"),
      pollIntervalMs: 50,
      timeoutMs: 500,
      now: () => 100,
      sleep: async () => {},
    })
    await expect(run({ chatId: 55, text: "hello" })).resolves.toContain("couldn't complete")
  })

  test("reuses an already-admitted deterministic prompt after a worker retry", async () => {
    let promptCalls = 0
    const client = {
      async createSession() { throw new Error("should not create") },
      async getMessage(_sessionId: string, id: string) {
        expect(id).toBe("msg_tg_42")
        return { id, type: "user", time: { created: "2026-01-01T00:00:00.000Z" } }
      },
      async sendPrompt() { promptCalls++; throw new Error("must not duplicate prompt") },
      async listMessages() {
        return [
          { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: "2026-01-01T00:00:03.000Z" } },
          assistant("msg_assistant", "Recovered answer", "2026-01-01T00:00:02.000Z"),
          { id: "msg_tg_42", type: "user", time: { created: "2026-01-01T00:00:00.000Z" } },
        ]
      },
    }
    const run = createAgentTurnRunner({
      client,
      sessions: sessionMap("ses_existing"),
      pollIntervalMs: 50,
      timeoutMs: 500,
      now: () => 100,
      sleep: async () => {},
    })
    await expect(run({ chatId: 55, text: "hello", updateId: 42 })).resolves.toBe("Recovered answer")
    expect(promptCalls).toBe(0)
  })
  test("rejects invalid polling configuration", () => {
    const client = {
      async createSession() { return { id: "ses_1" } },
      async getMessage() { return undefined },
      async sendPrompt() { return { id: "msg_1" } },
      async listMessages() { return [] },
    }
    expect(() => createAgentTurnRunner({ client, sessions: sessionMap(), pollIntervalMs: 1 })).toThrow(RangeError)
  })
})
