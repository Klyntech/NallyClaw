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
    const admitted = await client.sendPrompt(session.id, "hello")

    expect(session.id).toBe("ses_123")
    expect(admitted.id).toBe("msg_123")
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/session")
    const requestHeaders = new Headers(calls[1].init?.headers)
    expect(requestHeaders.get("authorization")).toBe("Basic test")
    expect(requestHeaders.get("accept")).toBe("application/json")
    expect(requestHeaders.get("content-type")).toBe("application/json")
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ text: "hello" })
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
