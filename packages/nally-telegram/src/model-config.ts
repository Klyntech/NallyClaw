export type ModelSelection = {
  providerID: string
  id: string
}

type ModelEnvironment = {
  NALLY_DEFAULT_PROVIDER?: string
  NALLY_DEFAULT_MODEL?: string
  OPENCODE_MODEL?: string
}

/**
 * NALLY_DEFAULT_PROVIDER and NALLY_DEFAULT_MODEL mirror OpenCode's Session model
 * reference: provider ID and catalog model ID are separate fields. Preserve slashes
 * inside catalog IDs (for example, NVIDIA's "nvidia/..." IDs).
 *
 * OPENCODE_MODEL remains a legacy provider/model shorthand.
 */
export function selectedModel(env: ModelEnvironment = process.env): ModelSelection | undefined {
  const catalogModelID = env.NALLY_DEFAULT_MODEL?.trim()
  const providerOverride = env.NALLY_DEFAULT_PROVIDER?.trim()

  if (catalogModelID) {
    return {
      providerID: providerOverride || "opencode",
      id: catalogModelID,
    }
  }

  const legacy = env.OPENCODE_MODEL?.trim()
  if (!legacy) return undefined

  const slash = legacy.indexOf("/")
  const providerID = slash > 0 ? legacy.slice(0, slash) : providerOverride || "opencode"
  const id = slash > 0 ? legacy.slice(slash + 1) : legacy
  if (!providerID || !id) throw new Error("Invalid NALLY_DEFAULT_MODEL / OPENCODE_MODEL")
  return { providerID, id }
}
