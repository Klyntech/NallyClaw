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

  test("waits past a completed tool-call iteration until the final assistant response", async () => {
    let calls = 0
    let clock = 0
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        if (calls === 1) {
          return {
            data: [
              {
                id: "msg-assistant-tool-call",
                type: "assistant",
                finish: "tool-calls",
                time: { completed: "2026-10-21T16:00:00.000Z" },
                content: [
                  { type: "text", text: "I'll search for the answer now." },
                  { type: "tool", tool: "websearch", state: { status: "completed" } },
                ],
              },
              { id: "msg-user", type: "user" },
            ],
          }
        }
        return {
          data: [
            {
              id: "msg-assistant-final",
              type: "assistant",
              finish: "stop",
              time: { completed: "2026-10-21T16:00:02.000Z" },
              content: [{ type: "text", text: "Here is the completed comparison table." }],
            },
            {
              id: "msg-assistant-tool-call",
              type: "assistant",
              finish: "tool-calls",
              time: { completed: "2026-10-21T16:00:00.000Z" },
              content: [
                { type: "text", text: "I'll search for the answer now." },
                { type: "tool", tool: "websearch", state: { status: "completed" } },
              ],
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
        sleep: async (ms) => { clock += ms },
      },
    )

    expect(calls).toBe(2)
    expect(result.messages[0]?.id).toBe("msg-assistant-final")
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

  test("extends the deadline while an active tool keeps progressing", async () => {
    let clock = 0
    let calls = 0
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        // Base timeout is 300ms; without grace this would fail before completion.
        if (calls < 5) {
          return {
            data: [
              {
                id: "msg-assistant",
                type: "assistant",
                content: [
                  {
                    type: "tool",
                    tool: "websearch",
                    state: { status: "running", title: `pass-${calls}` },
                  },
                ],
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
              finish: "stop",
              time: { completed: "2026-10-22T21:00:00.000Z" },
              content: [{ type: "text", text: "Match stats ready" }],
            },
            { id: "msg-user", type: "user" },
          ],
        }
      },
      "msg-user",
      {
        timeoutMs: 300,
        hardCapMs: 5_000,
        toolGraceMs: 400,
        stagnationMs: 2_000,
        pollIntervalMs: 100,
        now: () => clock,
        sleep: async (ms) => { clock += ms },
      },
    )
    expect(result.messages[0]?.id).toBe("msg-assistant")
    expect(calls).toBeGreaterThanOrEqual(5)
  })

  test("does not treat an unchanged Thinking label as stalled while assistant content is progressing", async () => {
    let clock = 0
    let calls = 0
    const progress: string[] = []
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        if (calls === 1) {
          return {
            data: [
              { id: "msg-assistant", type: "assistant", content: [{ type: "text", text: "Working" }] },
              { id: "msg-user", type: "user" },
            ],
          }
        }
        if (calls === 2) {
          return {
            data: [
              { id: "msg-assistant", type: "assistant", content: [{ type: "text", text: "Working on the answer" }] },
              { id: "msg-user", type: "user" },
            ],
          }
        }
        return {
          data: [
            {
              id: "msg-assistant",
              type: "assistant",
              finish: "stop",
              time: { completed: "2026-10-22T19:00:00.000Z" },
              content: [{ type: "text", text: "Done" }],
            },
            { id: "msg-user", type: "user" },
          ],
        }
      },
      "msg-user",
      {
        timeoutMs: 2_000,
        stagnationMs: 200,
        pollIntervalMs: 100,
        now: () => clock,
        sleep: async (ms) => { clock += ms },
        onProgress: (status) => { progress.push(status) },
      },
    )

    expect(result.messages[0]?.id).toBe("msg-assistant")
    expect(progress).toContain("✍️ Drafting response…")
  })

  test("still times out when the assistant snapshot genuinely stops changing", async () => {
    let clock = 0
    await expect(
      waitForAssistantMessage(
        async () => ({
          data: [
            { id: "msg-assistant", type: "assistant", content: [{ type: "text", text: "Still working" }] },
            { id: "msg-user", type: "user" },
          ],
        }),
        "msg-user",
        {
          timeoutMs: 2_000,
          stagnationMs: 200,
          pollIntervalMs: 100,
          now: () => clock,
          sleep: async (ms) => { clock += ms },
        },
      ),
    ).rejects.toThrow("no progress for too long")
  })

  test("retries transient message-list errors instead of failing the whole turn", async () => {
    let calls = 0
    let clock = 0
    const pollErrors: number[] = []
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        if (calls === 1) throw new Error("temporary local API timeout")
        return {
          data: [
            {
              id: "msg-assistant-final",
              type: "assistant",
              finish: "stop",
              time: { completed: "2026-10-22T19:00:02.000Z" },
              content: [{ type: "text", text: "Recovered" }],
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
        sleep: async (ms) => { clock += ms },
        onPollError: (_error, count) => { pollErrors.push(count) },
      },
    )
    expect(result.messages[0]?.id).toBe("msg-assistant-final")
    expect(calls).toBe(2)
    expect(pollErrors).toEqual([1])
  })

  test("returns a failed terminal execution instead of waiting until timeout", async () => {
    const result = await waitForAssistantMessage(
      async () => ({
        data: [
          { id: "msg-idle", type: "idle", outcome: "failed" },
          { id: "msg-user", type: "user" },
        ],
      }),
      "msg-user",
      { timeoutMs: 1_000, pollIntervalMs: 100 },
    )
    expect(result.terminalOutcome).toBe("failed")
  })

  test("reports when the admitted user message is not yet projected into history", async () => {
    let calls = 0
    let clock = 0
    const pending: number[] = []
    const result = await waitForAssistantMessage(
      async () => {
        calls++
        if (calls < 4) return { data: [] }
        return {
          data: [
            {
              id: "msg-assistant",
              type: "assistant",
              finish: "stop",
              time: { completed: "2026-10-22T19:00:02.000Z" },
              content: [{ type: "text", text: "Ready" }],
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
        sleep: async (ms) => { clock += ms },
        onUserMessagePending: (elapsedMs) => { pending.push(elapsedMs) },
      },
    )
    expect(result.messages[0]?.id).toBe("msg-assistant")
    expect(pending).toHaveLength(1)
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
