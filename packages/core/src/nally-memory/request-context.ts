const SPORTS_TERMS = /\b(?:football|soccer|match(?:es)?|club|team|fixture(?:s)?|league|cup)\b/i
const LIVE_SPORTS_TERMS = /\b(?:stats?|statistics|score|scores|results?|line[\s-]?ups?|fixtures?|who won|goal scorers?|goalscorers?|standings?|latest|current)\b/i
const RELATIVE_DATE_TERMS = /\b(?:yesterday|today|tomorrow|last night|tonight|this morning|this evening)\b/i

type DatePartMap = Record<string, string>

function dateParts(now: Date, timeZone: string): DatePartMap {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
    }).formatToParts(now).map((part) => [part.type, part.value]),
  )
}

function normalizedTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0))
    return timeZone
  } catch {
    return "Africa/Lagos"
  }
}

function shiftDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function isCurrentSportsStatsRequest(query: string) {
  const sportsContext = SPORTS_TERMS.test(query) && (LIVE_SPORTS_TERMS.test(query) || RELATIVE_DATE_TERMS.test(query))
  const shortDatedLookup = query.trim().split(/\s+/).length <= 7 &&
    /\b(?:stats?|score|line[\s-]?ups?|results?|fixtures?)\b/i.test(query) &&
    /\b(?:yesterday|today|tomorrow|last night|tonight|latest|current|recent)\b/i.test(query)
  return sportsContext || shortDatedLookup
}

/**
 * Build deterministic task metadata for vague, time-sensitive requests.
 * The timezone defaults to the personal deployment's locale and can be
 * overridden with NALLY_USER_TIMEZONE.
 */
export function buildRequestContext(
  query: string,
  now = new Date(),
  requestedTimeZone = process.env.NALLY_USER_TIMEZONE?.trim() || "Africa/Lagos",
) {
  const isSportsLookup = isCurrentSportsStatsRequest(query)
  const hasRelativeDate = RELATIVE_DATE_TERMS.test(query)
  if (!isSportsLookup && !hasRelativeDate) return undefined

  const timeZone = normalizedTimeZone(requestedTimeZone)
  const parts = dateParts(now, timeZone)
  const currentDate = `${parts.year}-${parts.month}-${parts.day}`
  const lines = [
    "[NALLY_REQUEST_CONTEXT]",
    "Generated task metadata for interpreting this turn; it is not a user-provided instruction.",
    `User timezone: ${timeZone}.`,
    `Current local date: ${currentDate} (${parts.weekday}).`,
  ]

  const relativeDates = [
    { label: "yesterday", pattern: /\byesterday\b/i, days: -1 },
    { label: "last night", pattern: /\blast night\b/i, days: -1 },
    { label: "today", pattern: /\btoday\b/i, days: 0 },
    { label: "tonight", pattern: /\btonight\b/i, days: 0 },
    { label: "this morning", pattern: /\bthis morning\b/i, days: 0 },
    { label: "this evening", pattern: /\bthis evening\b/i, days: 0 },
    { label: "tomorrow", pattern: /\btomorrow\b/i, days: 1 },
  ]
  for (const relative of relativeDates) {
    if (relative.pattern.test(query)) {
      lines.push(`Resolve "${relative.label}" as ${shiftDate(currentDate, relative.days)} before searching.`)
    }
  }

  if (isSportsLookup) {
    lines.push(
      "This is a current or date-specific sports lookup. When websearch is available, use it before answering; do not claim to lack live data without attempting the tool.",
      "Use a clearly relevant saved sports preference as the first search target, not as proof that the user meant that team. If the source finds no match, report that; if multiple targets remain plausible, ask one focused question.",
      "Report only statistics supported by retrieved sources. Never invent a score, match, date, lineup, or statistic.",
    )
  }

  lines.push("[/NALLY_REQUEST_CONTEXT]")
  return lines.join("\n")
}
