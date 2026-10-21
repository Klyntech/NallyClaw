import { describe, expect, test } from "bun:test"
import { selectedModel } from "./model-config"

describe("selectedModel", () => {
  test("preserves slash-containing catalog IDs while keeping provider separate", () => {
    expect(
      selectedModel({
        NALLY_DEFAULT_PROVIDER: "nvidia",
        NALLY_DEFAULT_MODEL: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      }),
    ).toEqual({
      providerID: "nvidia",
      id: "nvidia/nemotron-3.5-super-vl-120b-a12b",
    })
  })

  test("uses the same separate provider/model representation for OpenCode Zen", () => {
    expect(
      selectedModel({
        NALLY_DEFAULT_PROVIDER: "opencode",
        NALLY_DEFAULT_MODEL: "big-pickle",
      }),
    ).toEqual({ providerID: "opencode", id: "big-pickle" })
  })

  test("keeps supporting the legacy OPENCODE_MODEL provider/model shorthand", () => {
    expect(selectedModel({ OPENCODE_MODEL: "opencode/big-pickle" })).toEqual({
      providerID: "opencode",
      id: "big-pickle",
    })
  })

  test("uses the provider override for a bare legacy model ID", () => {
    expect(
      selectedModel({
        NALLY_DEFAULT_PROVIDER: "nvidia",
        OPENCODE_MODEL: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      }),
    ).toEqual({ providerID: "nvidia", id: "nemotron-3.5-super-vl-120b-a12b" })
  })

  test("returns undefined when no model is configured", () => {
    expect(selectedModel({})).toBeUndefined()
  })
})
