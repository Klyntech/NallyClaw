import { describe, expect, test } from "bun:test"
import { describeToolProgress, waitForAssistantMessage } from "./wait-for-response"

describe("waitForAssistantMessage", () => {
  test("does not mistake an idle snapshot for a completed turn", async () => {
    let calls = 0
    let clock = 0
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        if (calls === 1) {
          return { data: [{ id: "msg-user", type: "user" }, { type: "idle" }] }
        }
        return {
          data: [
            {
              id: "msg-assistant",
              type: "assistant",
              content: [{ type: "text", text: "Hello from the model" }],
              time: { completed: "2026-10-21T16:00:00.000Z" },
            },
            { id: "msg-user", type: "user" },
            { type: "idle" },
          ],
        }
      },
      "msg-user",
      {
        timeoutMs: 1_000,
        pollIntervalMs: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
      },
    )

    expect(calls).toBe(2)
    expect(result.userIndex).toBe(1)
    expect(result.messages[0]?.type).toBe("assistant")
  })

  test("emits a readable tool progress status while the assistant is working", async () => {
    let calls = 0
    let clock = 0
    const progress: string[] = []
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        if (calls === 1) {
          return {
            data: [
              {
                id: "msg-assistant",
                type: "assistant",
                content: [{ type: "tool", tool: "webfetch", state: { status: "running" } }],
              },
              { id: "msg-user", type: "user" },
            ],
          }
        }
        return {
          data: [
            {
              id: "msg-assistant",
              type: "assistant",
              content: [{ type: "text", text: "Fetched page" }],
              time: { completed: "2026-10-21T16:00:00.000Z" },
            },
            { id: "msg-user", type: "user" },
          ],
        }
      },
      "msg-user",
      {
        timeoutMs: 1_000,
        pollIntervalMs: 100,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms
        },
        onProgress: (status) => { progress.push(status) },
      },
    )

    expect(result.messages[0]?.type).toBe("assistant")
    expect(progress).toContain("🌐 Fetching page…")
  })

  test("maps common tools to user-readable status labels", () => {
    expect(describeToolProgress("websearch")).toBe("🔎 Searching the web…")
    expect(describeToolProgress("read")).toBe("📄 Reading file…")
    expect(describeToolProgress("mcp__custom__unknown_action")).toContain("Using")
  })

  test("times out if no completed assistant message appears", async () => {
    let clock = 0
    await expect(
      waitForAssistantMessage(
        async () => ({ data: [{ id: "msg-user", type: "user" }, { type: "idle" }] }),
        "msg-user",
        {
          timeoutMs: 200,
          pollIntervalMs: 100,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms
          },
        },
      ),
    ).rejects.toThrow("Timed out waiting for a completed assistant message")
  })
})
