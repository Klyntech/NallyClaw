export type OpenCodeMessage = {
  id?: string
  type?: string
  text?: string
  parts?: unknown[]
  [key: string]: unknown
}

export type OpenCodeSession = {
  id: string
  title?: string
  [key: string]: unknown
}

export type OpenCodeClientOptions = {
  /** Private/internal URL of the existing OpenCode/NallyClaw server. */
  baseUrl: string
  /** Optional authorization headers for the server's configured auth mechanism. */
  headers?: HeadersInit
  fetch?: typeof fetch
}

export class OpenCodeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "OpenCodeApiError"
  }
}

/**
 * Thin client for the existing agent API. Prompt execution stays inside the original
 * server, so its configured agent, tool registry, and permission rules remain in effect.
 */
export class OpenCodeClient {
  private readonly baseUrl: string
  private readonly headers: Headers
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenCodeClientOptions) {
    const base = new URL(options.baseUrl)
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new Error("OpenCode baseUrl must use HTTP or HTTPS")
    }
    this.baseUrl = base.toString().replace(/\/$/u, "")
    this.headers = new Headers(options.headers)
    this.fetchImpl = options.fetch ?? fetch
  }

  async createSession(title: string): Promise<OpenCodeSession> {
    const response = await this.request<{ data: OpenCodeSession }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    })
    if (!response.data?.id) throw new Error("OpenCode session response did not include a session ID")
    return response.data
  }

  async sendPrompt(sessionId: string, text: string): Promise<OpenCodeMessage> {
    const response = await this.request<{ data: OpenCodeMessage }>(
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    )
    if (!response.data) throw new Error("OpenCode prompt response did not include the admitted message")
    return response.data
  }

  async listMessages(sessionId: string, limit = 50): Promise<OpenCodeMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new RangeError("limit must be an integer between 1 and 200")
    }
    const query = new URLSearchParams({ limit: String(limit), order: "desc" })
    const response = await this.request<{ data: OpenCodeMessage[] }>(
      `/api/session/${encodeURIComponent(sessionId)}/message?${query.toString()}`,
    )
    if (!Array.isArray(response.data)) throw new Error("OpenCode message response was invalid")
    return response.data
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request<void>(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      body: JSON.stringify({}),
    })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(this.headers)
    headers.set("accept", "application/json")
    if (init.body !== undefined) headers.set("content-type", "application/json")

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    })

    if (!response.ok) {
      // Do not include request URLs or arbitrary response bodies in errors.
      throw new OpenCodeApiError(`OpenCode API request failed (HTTP ${response.status})`, response.status)
    }

    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch {
      throw new Error("OpenCode API returned invalid JSON")
    }
  }
}
