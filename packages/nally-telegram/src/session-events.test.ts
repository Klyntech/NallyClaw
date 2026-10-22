import { describe, expect, test } from "bun:test"
import { createSessionEventSignal } from "./session-events"

const encoder = new TextEncoder()

describe("createSessionEventSignal", () => {
  test("wakes only for events that belong to the selected session", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const request = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof fetch

    const signal = await createSessionEventSignal({
      url: "http://127.0.0.1:3001/api/event",
      sessionID: "session-target",
      authorization: "Basic test",
      request,
    })
    expect(signal).toBeDefined()

    let woke = false
    const waiting = signal!.wait(1_000).then(() => { woke = true })
    streamController!.enqueue(encoder.encode('data: {"data":{"sessionID":"session-other"}}\n\n'))
    await Bun.sleep(15)
    expect(woke).toBe(false)

    streamController!.enqueue(encoder.encode('data: {"data":{"sessionID":"session-target"},"type":"session.execution.succeeded"}\n\n'))
    await waiting
    expect(woke).toBe(true)
    await signal!.close()
  })

  test("falls back when the event endpoint cannot be opened", async () => {
    const signal = await createSessionEventSignal({
      url: "http://127.0.0.1:3001/api/event",
      sessionID: "session-target",
      authorization: "Basic test",
      request: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    })
    expect(signal).toBeUndefined()
  })
})
