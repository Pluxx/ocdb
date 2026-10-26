export function locationKey(location: { directory: string; workspaceID?: string }): string {
  return `${location.directory}\0${location.workspaceID ?? ""}`
}

export interface PollingOptions<T> {
  load(signal: AbortSignal): Promise<T>
  update(value: T | null): void
  key?(): unknown
  intervalMs?: number
  timeoutMs?: number
  every?(callback: () => void, ms: number): ReturnType<typeof setInterval>
  cancelEvery?(timer: ReturnType<typeof setInterval>): void
  after?(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  cancelAfter?(timer: ReturnType<typeof setTimeout>): void
}

export function startPolling<T>(options: PollingOptions<T>): () => void {
  const every = options.every ?? setInterval
  const cancelEvery = options.cancelEvery ?? clearInterval
  const after = options.after ?? setTimeout
  const cancelAfter = options.cancelAfter ?? clearTimeout
  let active = true
  let pending: AbortController | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let lastKey = options.key?.()

  const refresh = async (force = false) => {
    if (!active || pending) return
    const key = options.key?.()
    if (!force && !Object.is(key, lastKey)) {
      lastKey = key
      options.update(null)
    }
    const controller = new AbortController()
    pending = controller
    timeout = after(() => {
      if (!active || pending !== controller) return
      controller.abort()
      pending = undefined
      timeout = undefined
      options.update(null)
    }, options.timeoutMs ?? 15_000)
    try {
      const result = await options.load(controller.signal)
      if (active && pending === controller && Object.is(options.key?.(), key)) options.update(result)
    } catch {
      if (active && pending === controller) options.update(null)
    } finally {
      if (pending === controller) {
        if (timeout !== undefined) cancelAfter(timeout)
        timeout = undefined
        pending = undefined
      }
    }
  }

  void refresh()
  const timer = every(() => {
    const key = options.key?.()
    if (!Object.is(key, lastKey)) {
      pending?.abort()
      if (timeout !== undefined) cancelAfter(timeout)
      timeout = undefined
      pending = undefined
      lastKey = key
      options.update(null)
      void refresh(true)
      return
    }
    void refresh()
  }, options.intervalMs ?? 60_000)
  return () => {
    active = false
    cancelEvery(timer)
    if (timeout !== undefined) cancelAfter(timeout)
    pending?.abort()
  }
}
