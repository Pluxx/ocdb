import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { OpenAIWeekly } from "./rpc.ts"
import type { UsageState } from "./src/contracts.ts"
import { formatReset, percent, statusCopy } from "./src/ui/format.ts"
import { locationKey, startPolling } from "./src/ui/polling.ts"

const initial: UsageState = {
  status: "unavailable",
  checkedAt: 0,
  weekly: null,
  message: null,
}

function isUsageState(value: unknown): value is UsageState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<UsageState>
  return ["ok", "disconnected", "unsupported", "auth_required", "rate_limited", "unavailable"].includes(String(state.status))
    && typeof state.checkedAt === "number"
    && (state.weekly === null || (typeof state.weekly === "object"
      && typeof state.weekly.usedPercent === "number"
      && typeof state.weekly.remainingPercent === "number"
      && (typeof state.weekly.resetAt === "number" || state.weekly.resetAt === null)))
    && (typeof state.message === "string" || state.message === null)
}

function WeeklyUsage(props: { state: () => UsageState | null; now: () => number; theme: Context["theme"] }) {
  const state = props.state
  const copy = () => state() ? statusCopy(state()!) : "Checking usage…"
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={props.theme.text.base} attributes={1}>OpenAI weekly</text>
      {state()?.status === "ok" && state()?.weekly ? (
        <>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={props.theme.text.base}>Used {percent(state()!.weekly!.usedPercent)}</text>
            <text fg={props.theme.text.muted}>Left {percent(state()!.weekly!.remainingPercent)}</text>
          </box>
          <text fg={props.theme.text.muted}>
            {state()!.weekly!.resetAt === null
              ? "Reset time not reported"
              : `Resets ${formatReset(state()!.weekly!.resetAt, props.now())}`}
          </text>
        </>
      ) : (
        <text fg={props.theme.text.muted}>{copy()}</text>
      )}
    </box>
  )
}

export default Plugin.define({
  id: "openai-weekly.tui",
  setup(context) {
    const [state, setState] = createSignal<UsageState | null>(null)
    const [now, setNow] = createSignal(Date.now())
    const stopPolling = startPolling<UsageState>({
      key: () => locationKey(context.location ?? context.data.location.default()),
      load: async (signal) => {
        const location = context.location ?? context.data.location.default()
        const result: unknown = await context.client.rpc(OpenAIWeekly).status({}, { location, signal })
        if (!isUsageState(result)) throw new Error("Invalid usage response")
        return result
      },
      update: (value) => setState(value ?? { ...initial, checkedAt: Date.now() }),
    })
    const clock = setInterval(() => setNow(Date.now()), 60_000)
    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => <WeeklyUsage state={state} now={now} theme={context.theme} />,
    })
    return () => {
      stopPolling()
      clearInterval(clock)
      removeSlot()
    }
  },
})
