import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import { createSystemSampler } from "./metrics.mjs"
import { summarizeActivity } from "./activity.mjs"
import { OcdbProfiles } from "./rpc.ts"

type SystemMetrics = Awaited<ReturnType<ReturnType<typeof createSystemSampler>>>
type ProfileStatus = {
  installed: string
  selected: string
  profiles: { id: string; label: string; description: string; requires: string[]; available: boolean; missing: string[] }[]
}

const MAX_LISTED_SUBAGENTS = 5

function formatGiB(bytes: number | null): string {
  return bytes === null || !Number.isFinite(bytes)
    ? "—"
    : `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

function shorten(text: string, max = 28): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function OcdbSection(props: { sessionID: string; profiles: Accessor<ProfileStatus | null>; onPickProfile: () => void }) {
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
  const profile = () => {
    const status = props.profiles()
    return status?.profiles.find((candidate) => candidate.id === status.selected) ?? null
  }
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={text.base} attributes={1}>OCDB</text>
      {profile() ? (
        <box flexDirection="row" onMouseUp={() => props.onPickProfile()}>
          <text fg={text.base}>Profile  {profile()!.label} </text>
          <text fg={text.muted}>· switch</text>
        </box>
      ) : null}
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

function createProfileSwitcher(context: Context) {
  const [profiles, setProfiles] = createSignal<ProfileStatus | null>(null)
  const location = () => context.location ?? context.data.location.default()
  const rpc = () => context.client.rpc(OcdbProfiles)

  const refresh = async () => {
    try {
      setProfiles((await rpc().status({}, { location: location() })) as ProfileStatus)
    } catch {
      // An older or missing server part just hides the profile line.
      setProfiles(null)
    }
  }

  const pick = async () => {
    await refresh()
    const status = profiles()
    if (!status) {
      context.ui.toast.show({ title: "OCDB", message: "Profile switching is unavailable; restart the OpenCode service", variant: "error" })
      return
    }
    const choice = await context.ui.dialog.select({
      title: "OCDB model profile",
      current: status.selected,
      options: status.profiles.map((profile) => ({
        title: `${profile.label}${profile.id === status.installed ? "  (installed)" : ""}`,
        value: profile.id,
        description: profile.available ? profile.description : `Not available: ${profile.missing.join(", ")}`,
        disabled: !profile.available && profile.id !== status.installed,
        category: profile.requires.join(" + "),
      })),
    })
    if (!choice || choice === status.selected) return
    try {
      const next = (await rpc().select({ profile: choice }, { location: location() })) as ProfileStatus
      setProfiles(next)
      const label = next.profiles.find((profile) => profile.id === choice)?.label ?? choice
      context.ui.toast.show({ title: "OCDB", message: `Switched to ${label}; applies to the next request`, variant: "success" })
    } catch (error) {
      context.ui.toast.show({ title: "OCDB", message: `Could not switch profile: ${(error as Error).message}`, variant: "error" })
    }
  }

  return { profiles, refresh, pick }
}

export default Plugin.define({
  id: "ocdb.hardware.tui",
  setup(context) {
    const switcher = createProfileSwitcher(context)
    void switcher.refresh()
    // Picks up switches made from another TUI or project.
    const poll = setInterval(() => void switcher.refresh(), 30_000)
    ;(poll as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "ocdb.profile",
          title: "Switch OCDB model profile",
          group: "OCDB",
          palette: true,
          slash: { name: "ocdb-profile" },
          run: () => void switcher.pick(),
        },
      ],
    }))
    const removeSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <OcdbSection sessionID={input.sessionID} profiles={switcher.profiles} onPickProfile={() => void switcher.pick()} />
      ),
    })
    return () => {
      clearInterval(poll)
      removeSlot()
    }
  },
})
