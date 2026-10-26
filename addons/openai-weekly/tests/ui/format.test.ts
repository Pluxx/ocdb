import assert from "node:assert/strict"
import test from "node:test"
import { formatReset, percent, statusCopy } from "../../src/ui/format.ts"
import type { UsageState } from "../../src/contracts.ts"

test("percentages and bars clamp bounds and handle invalid values", () => {
  assert.equal(percent(0), "0%")
  assert.equal(percent(100), "100%")
  assert.equal(percent(142), "100%")
  assert.equal(percent(Number.NaN), "—")
})

test("reset shows local date, time, and remaining duration", () => {
  const now = new Date(2026, 0, 2, 10, 0).getTime()
  const reset = new Date(2026, 0, 3, 12, 30).getTime()
  const rendered = formatReset(reset, now) ?? ""
  const expectedDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(reset)
  const expectedTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(reset)
  assert.equal(rendered, `${expectedDate}, ${expectedTime} · 1d 2h`)
  assert.equal(formatReset(null, now), null)
  assert.equal(formatReset(Number.NaN, now), null)
})

test("status copy never presents a missing quota as zero", () => {
  const missing: UsageState = { status: "ok", checkedAt: 1, weekly: null, message: null }
  assert.equal(statusCopy(missing), "Weekly quota not reported")
  assert.notEqual(statusCopy({ ...missing, status: "disconnected" }), "0%")
})

test("unsupported sign-in uses its sanitized explanation or a neutral fallback", () => {
  const unsupported: UsageState = {
    status: "unsupported", checkedAt: 1, weekly: null,
    message: "Weekly quota is not exposed by this ChatGPT sign-in. Check ChatGPT Settings → Usage.",
  }
  assert.equal(statusCopy(unsupported), unsupported.message)
  assert.equal(statusCopy({ ...unsupported, message: null }), "Weekly quota unavailable for this sign-in")
})

test("Codex native quota shows explicit provenance and connection instructions", () => {
  const nativeOk: UsageState = {
    status: "ok", checkedAt: 1,
    weekly: { usedPercent: 23, remainingPercent: 77, resetAt: null },
    message: "Source: Codex sign-in",
  }
  assert.equal(statusCopy({
    status: "disconnected", checkedAt: 1, weekly: null,
    message: "Connect Codex for quota: ocdb quota login.",
  }), "Connect Codex for quota: ocdb quota login.")
  assert.equal(statusCopy({
    status: "auth_required", checkedAt: 1, weekly: null,
    message: "Codex sign-in could not be read. Connect Codex for quota: ocdb quota login.",
  }), "Codex sign-in could not be read. Connect Codex for quota: ocdb quota login.")
})
