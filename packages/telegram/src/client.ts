export type TelegramSendMessage = {
  chat_id: number
  text: string
  disable_web_page_preview?: boolean
}

type TelegramApiResponse<T> = {
  ok: boolean
  result?: T
  description?: string
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
  ) {
    super(message)
    this.name = "TelegramApiError"
  }
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!token.trim()) throw new Error("Telegram bot token is required")
  }

  async sendMessage(message: TelegramSendMessage): Promise<void> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    })

    let body: TelegramApiResponse<unknown>
    try {
      body = (await response.json()) as TelegramApiResponse<unknown>
    } catch {
      throw new TelegramApiError(`Telegram API returned non-JSON response (HTTP ${response.status})`)
    }

    if (!response.ok || body.ok !== true) {
      // Do not include the request URL: it contains the bot token.
      throw new TelegramApiError(body.description ?? `Telegram API request failed (HTTP ${response.status})`, response.status)
    }
  }
}
