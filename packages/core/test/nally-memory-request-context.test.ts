import { describe, expect, test } from "bun:test"
import { buildRequestContext, isCurrentSportsStatsRequest } from "../src/nally-memory/request-context.js"

describe("isCurrentSportsStatsRequest", () => {
  test("recognizes short, date-specific requests that need a live lookup", () => {
    expect(isCurrentSportsStatsRequest("Yesterday Match Stats")).toBe(true)
    expect(isCurrentSportsStatsRequest("latest Real Madrid score")).toBe(true)
    expect(isCurrentSportsStatsRequest("lineups for today's match")).toBe(true)
  })

  test("does not treat general sports discussion as a live stats request", () => {
    expect(isCurrentSportsStatsRequest("Explain how a football 4-3-3 formation works")).toBe(false)
    expect(isCurrentSportsStatsRequest("Tell me about the history of the World Cup")).toBe(false)
  })
})

describe("buildRequestContext", () => {
  test("resolves yesterday using the requested local timezone and requires sourced stats", () => {
    const context = buildRequestContext(
      "Yesterday Match Stats",
      new Date("2026-10-22T23:30:00.000Z"),
      "Africa/Lagos",
    )

    expect(context).toContain("User timezone: Africa/Lagos.")
    // 23:30 UTC on Oct 22 is already Oct 23 in Lagos.
    expect(context).toContain("Current local date: 2026-10-23")
    expect(context).toContain('Resolve "yesterday" as 2026-10-22')
    expect(context).toContain("use it before answering")
    expect(context).toContain("Never invent a score")
  })

  test("uses UTC correctly when the user configured UTC", () => {
    const context = buildRequestContext("Yesterday Match Stats", new Date("2026-10-22T23:30:00.000Z"), "UTC")
    expect(context).toContain("Current local date: 2026-10-22")
    expect(context).toContain('Resolve "yesterday" as 2026-10-21')
  })

  test("leaves unrelated requests without relative dates unchanged", () => {
    expect(buildRequestContext("Hello Nally", new Date("2026-10-23T10:00:00.000Z"), "Africa/Lagos")).toBeUndefined()
  })
})
