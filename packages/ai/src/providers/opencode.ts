import { HttpOptions, ProviderID, type ModelID } from "../schema/index.js"
import { AuthOptions, type ProviderAuthOption } from "../route/auth-options.js"
import { OpenAICompatibleChat } from "../protocols/openai-compatible-chat.js"
import { SystemOne } from "../experimental/system-one.js"

export const id = ProviderID.make("opencode")
const baseURL = "https://opencode.ai/zen/v1"

export type Options = ProviderAuthOption<"optional"> & {
  readonly baseURL?: string
  readonly headers?: Record<string, string>
  readonly http?: HttpOptions.Input
}

export const configure = (input: Options = {}) => {
  const endpointBaseURL = input.baseURL ?? baseURL
  const auth = AuthOptions.bearer(input, "OPENCODE_API_KEY")

  // OpenCode Zen's chat models (including Big Pickle) use the OpenAI-compatible
  // /chat/completions API. The System One route below is only for evaluations.
  const chat = OpenAICompatibleChat.route
    .with({
      provider: id,
      providerMetadataKey: "opencode",
      endpoint: { baseURL: endpointBaseURL },
      auth,
      headers: input.headers,
      http: input.http,
    })
  const model = (modelID: string | ModelID) => chat.model({ id: modelID, provider: id })

  const evaluation = (modelID: string | ModelID) =>
    SystemOne.model({
      id: modelID,
      provider: id,
      providerMetadataKey: "opencode",
      auth,
      baseURL: endpointBaseURL,
      headers: input.headers,
      http: HttpOptions.make(input.http),
    })
  return { id, model, chat: model, experimental: { evaluation }, configure }
}

export const provider = configure()
export const experimental = provider.experimental

export * as OpenCode from "./opencode.js"
