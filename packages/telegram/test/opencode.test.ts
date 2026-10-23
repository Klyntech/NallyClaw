import { describe, expect, test } from "bun:test"
import { OpenCodeApiError, OpenCodeClient } from "../src/opencode.js"

describe("OpenCodeClient", () => {
  test("creates a session and submits prompts to the existing agent API", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/api/session")) {
        return Response.json({ data: { id: "ses_123", title: "Telegram chat" } })
      }
      if (url.endsWith("/api/session/ses_123/prompt")) {
        return Response.json({ data: { id: "msg_123", type: "user", text: "hello" } })
      }
      return new Response(null, { status: 404 })
    }

    const client = new OpenCodeClient({
      baseUrl: "http://127.0.0.1:4096/",
      headers: { authorization: "Basic test" },
      fetch: fetchImpl,
    })

    const session = await client.createSession("Telegram chat")
    const admitted = await client.sendPrompt(session.id, "hello", "msg_tg_42")

    expect(session.id).toBe("ses_123")
    expect(admitted.id).toBe("msg_123")
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/session")
    const requestHeaders = new Headers(calls[1].init?.headers)
    expect(requestHeaders.get("authorization")).toBe("Basic test")
    expect(requestHeaders.get("accept")).toBe("application/json")
    expect(requestHeaders.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ text: "hello", id: "msg_tg_42" })
  })

  test("recovers an admitted message through the documented single-message route", async () => {
    const calls: string[] = []
    const client = new OpenCodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: async (input) => {
        const url = new URL(String(input))
        calls.push(url.toString())
        if (url.pathname === "/api/session/ses_123/message/msg_tg_42") {
          return Response.json({ data: { id: "msg_tg_42", type: "user", text: "already admitted" } })
        }
        return new Response(null, { status: 404 })
      },
    })

    const message = await client.getMessage("ses_123", "msg_tg_42")

    expect(message?.id).toBe("msg_tg_42")
    expect(calls).toEqual(["http://127.0.0.1:4096/api/session/ses_123/message/msg_tg_42"])
  })

  test("treats a missing message as not yet admitted", async () => {
    const client = new OpenCodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: async () => new Response(null, { status: 404 }),
    })

    await expect(client.getMessage("ses_123", "msg_tg_42")).resolves.toBeUndefined()
  })

  test("does not include response bodies or URLs in HTTP errors", async () => {
    const client = new OpenCodeClient({
      baseUrl: "http://127.0.0.1:4096",
      fetch: async () => new Response("sensitive internal error", { status: 500 }),
    })

    await expect(client.createSession("test")).rejects.toBeInstanceOf(OpenCodeApiError)
    await expect(client.createSession("test")).rejects.toThrow("HTTP 500")
  })

  test("validates message pagination bounds", async () => {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096" })
    await expect(client.listMessages("ses_123", 0)).rejects.toThrow(RangeError)
  })
})
