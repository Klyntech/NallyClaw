import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).toContain("You are Nally")
  expect(prompt).not.toContain("You are an AI agent running in OpenCode")
  expect(prompt).toContain("Use the edit tool for targeted changes to existing text files")
  expect(prompt).toContain("Use subtle, dry wit occasionally")
  expect(prompt).toContain("Do not use “Sir” or other honorifics in text replies")
  expect(prompt).toContain("For voice replies, use natural spoken sentences")
})
test("adds durable memory guidance when memory tools are available", () => {
  const prompt = SessionSystemPrompt.make(["memory_remember", "memory_recall"])
  expect(prompt).toContain("Save stable, useful user facts")
  expect(prompt).toContain("latest explicit correction as authoritative")
  expect(prompt).toContain("use its returned ID with memory_update")
  expect(prompt).toContain("forget only the clearly obsolete duplicates")
  expect(prompt).toContain("never claim an update succeeded unless the tool confirms it")
  expect(prompt).toContain("Never store passwords, API keys, access tokens")
  expect(prompt).toContain("check the current conversation and relevant memories")
  expect(prompt).toContain("ask one concise clarifying question")
  expect(prompt).toContain("changing information such as scores, lineups")
})

test("requires web search for current facts when the tool is available", () => {
  const prompt = SessionSystemPrompt.make(["websearch"])
  expect(prompt).toContain("call websearch before answering")
  expect(prompt).toContain("Never claim you lack live data")
  expect(prompt).toContain("Include the concrete calendar date")

  const memoryPrompt = SessionSystemPrompt.make(["websearch", "memory_recall"])
  expect(memoryPrompt).toContain("standing preference")
  expect(memoryPrompt).toContain("not as certainty")
})

test("does not add memory guidance when memory tools are unavailable", () => {
  const prompt = SessionSystemPrompt.make(["read", "edit"])
  expect(prompt).not.toContain("Nally's long-term memory is shared")
})
