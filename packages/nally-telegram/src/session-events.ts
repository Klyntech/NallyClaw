export type SessionEventSignal = {
  /** Wait for a matching session event, or return when the fallback poll interval expires. */
  wait(timeoutMs: number): Promise<void>
  /** Close the volatile SSE stream and release any waiter. */
  close(): Promise<void>
}

type Options = {
  url: string
  sessionID: string
  authorization: string
  request?: typeof fetch
  connectTimeoutMs?: number
}

/**
 * Subscribe before admitting a prompt so events cannot be missed between submission and wait.
 * SSE is a wake-up signal, not a source of truth: message snapshots still decide completion.
 */
export async function createSessionEventSignal(options: Options): Promise<SessionEventSignal | undefined> {
  const request = options.request ?? fetch
  const controller = new AbortController()
  let connectTimer: ReturnType<typeof setTimeout> | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let closed = false
  let hasSignal = false
  let waiter: (() => void) | undefined

  const wake = () => {
    if (waiter) {
      const current = waiter
      waiter = undefined
      current()
      return
    }
    hasSignal = true
  }

  let response: Response
  try {
    response = await Promise.race([
      request(options.url, {
        method: "GET",
        headers: { authorization: options.authorization, accept: "text/event-stream" },
        signal: controller.signal,
      }),
      new Promise<Response>((_, reject) => {
        connectTimer = setTimeout(
          () => reject(new Error("session event stream connection timed out")),
          options.connectTimeoutMs ?? 4_000,
        )
      }),
    ])
  } catch {
    controller.abort()
    return undefined
  } finally {
    if (connectTimer !== undefined) clearTimeout(connectTimer)
  }

  if (!response.ok || !response.body) {
    controller.abort()
    return undefined
  }

  reader = response.body.getReader()
  const decoder = new TextDecoder()

  const consume = async () => {
    let buffer = ""
    try {
      while (!closed) {
        const next = await reader!.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() ?? ""
        for (const frame of frames) {
          if (closed) break
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) continue
          try {
            const event = JSON.parse(data) as { data?: { sessionID?: unknown } }
            if (event.data?.sessionID === options.sessionID) wake()
          } catch {
            // Malformed/unknown frames are ignored. Snapshot polling remains authoritative.
          }
        }
      }
    } catch {
      // The stream is volatile by design. Wake the caller and let snapshot polling recover.
    } finally {
      wake()
    }
  }

  void consume().catch(() => {
    wake()
  })

  return {
    wait(timeoutMs) {
      if (hasSignal) {
        hasSignal = false
        return Promise.resolve()
      }
      if (closed) return Promise.resolve()
      return new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          if (waiter === finish) waiter = undefined
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, Math.max(0, timeoutMs))
        waiter = finish
      })
    },
    async close() {
      if (closed) return
      closed = true
      controller.abort()
      const pending = waiter
      waiter = undefined
      pending?.()
      try {
        await reader?.cancel()
      } catch {
        // Best-effort cleanup of a disconnected SSE stream.
      }
    },
  }
}
