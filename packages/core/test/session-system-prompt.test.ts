import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("You are Nally")
  expect(prompt).not.toContain("You are an AI agent running in OpenCode")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
})
test("adds durable memory guidance when memory tools are available", () => {
  const prompt = SessionSystemPrompt.make(["memory_remember", "memory_recall"])
  expect(prompt).toContain("Save stable, useful user facts")
  expect(prompt).toContain("latest explicit correction as authoritative")
  expect(prompt).toContain("Never store passwords, API keys, access tokens")
})

test("does not add memory guidance when memory tools are unavailable", () => {
  const prompt = SessionSystemPrompt.make(["read", "edit"])
  expect(prompt).not.toContain("Nally's long-term memory is shared")
})
