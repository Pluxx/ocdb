import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, createSignal, onCleanup, onMount } from "solid-js"
import { createSystemSampler } from "./metrics.mjs"
import { summarizeActivity } from "./activity.mjs"

type SystemMetrics = Awaited<ReturnType<ReturnType<typeof createSystemSampler>>>

const MAX_LISTED_SUBAGENTS = 5

function formatGiB(bytes: number | null): string {
  return bytes === null || !Number.isFinite(bytes)
    ? "—"
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

function shorten(text: string, max = 28): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function OcdbSection(props: { sessionID: string }) {
  const context = usePlugin()
  const [metrics, setMetrics] = createSignal<SystemMetrics | null>(null)
  const [failed, setFailed] = createSignal(false)
  // Re-read the session tree every second; the host stores are cheap to query.
  const [tick, setTick] = createSignal(0)
  const sample = createSystemSampler()
  let inFlight = false
  let disposed = false
  let metricsTimer: ReturnType<typeof setInterval> | undefined
  let activityTimer: ReturnType<typeof setInterval> | undefined

  const activity = () => {
    tick()
    return summarizeActivity(context.data.session, props.sessionID)
  }

  const refresh = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const next = await sample()
      if (disposed) return
      setMetrics(next)
      setFailed(false)
    } catch {
      // A transient platform/read error must not take down the OpenCode TUI.
      if (!disposed) setFailed(true)
    } finally {
      inFlight = false
    }
  }

  onMount(() => {
    void refresh()
    metricsTimer = setInterval(() => void refresh(), 2000)
    activityTimer = setInterval(() => setTick((value) => value + 1), 1000)
    // Node timers may be unref'ed so this display can never keep the process alive.
    for (const timer of [metricsTimer, activityTimer]) {
      ;(timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
    }
  })
  onCleanup(() => {
    disposed = true
    if (metricsTimer !== undefined) clearInterval(metricsTimer)
    if (activityTimer !== undefined) clearInterval(activityTimer)
  })

  const text = context.theme.text
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={text.base} attributes={1}>OCDB</text>
      {activity() ? (
        <box flexDirection="row">
          <text fg={text.base}>Agent  {activity()!.agent ?? "—"} </text>
          <text fg={text.muted}>{activity()!.running ? "· working" : "· idle"}</text>
        </box>
      ) : null}
      {failed() ? (
        <text fg={text.base}>System metrics unavailable</text>
      ) : metrics() ? (
        <>
          <text fg={text.base}>
            CPU  {metrics()!.cpuPercent === null ? "—" : `${metrics()!.cpuPercent!.toFixed(0)}%`}
          </text>
          <text fg={text.base}>
            RAM  {formatGiB(metrics()!.memory.usedBytes)} / {formatGiB(metrics()!.memory.totalBytes)}
          </text>
        </>
      ) : (
        <text fg={text.base}>Reading system metrics…</text>
      )}
      {activity() ? (
        <>
          <box flexDirection="row">
            <text fg={text.base}>Subagents  {activity()!.active.length} running </text>
            <text fg={text.muted}>· {activity()!.total} spawned</text>
          </box>
          <For each={activity()!.active.slice(0, MAX_LISTED_SUBAGENTS)}>
            {(child) => (
              <text fg={text.muted}>  ▸ {child.agent}{child.title ? `  ${shorten(child.title)}` : ""}</text>
            )}
          </For>
          {activity()!.active.length > MAX_LISTED_SUBAGENTS ? (
            <text fg={text.muted}>  +{activity()!.active.length - MAX_LISTED_SUBAGENTS} more</text>
          ) : null}
        </>
      ) : null}
    </box>
  )
}

export default Plugin.define({
  id: "ocdb.hardware.tui",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: (input) => <OcdbSection sessionID={input.sessionID} />,
    })
  },
})
