import type { UsageState } from "../contracts.ts"

export function percent(value: number): string {
  if (!Number.isFinite(value)) return "—"
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}


export function formatReset(resetAt: number | null, now = Date.now()): string | null {
  if (resetAt === null || !Number.isFinite(resetAt)) return null
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return null
  const dateText = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date)
  const timeText = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
  const delta = Math.max(0, resetAt - now)
  const hours = Math.floor(delta / 3_600_000)
  const minutes = Math.floor((delta % 3_600_000) / 60_000)
  const countdown = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${minutes}m`
  return `${dateText}, ${timeText} · ${countdown}`
}

export function statusCopy(state: UsageState): string {
  switch (state.status) {
    case "ok": return state.weekly ? "" : "Weekly quota not reported"
    case "disconnected": return state.message?.trim() || "Not connected"
    case "unsupported": return state.message?.trim() || "Weekly quota unavailable for this sign-in"
    case "auth_required": return state.message?.trim() || "Sign in to check usage"
    case "rate_limited": return "Check delayed · try again shortly"
    case "unavailable": return "Usage temporarily unavailable"
  }
}
