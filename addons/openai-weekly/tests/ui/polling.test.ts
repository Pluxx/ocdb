import assert from "node:assert/strict"
import test from "node:test"
import { locationKey, startPolling } from "../../src/ui/polling.ts"


test("polls immediately and on cadence without overlapping requests", async () => {
  let tick!: () => void
  let calls = 0
  let resolve!: (value: number) => void
  const updates: Array<number | null> = []
  const stop = startPolling({
    load: () => { calls++; return new Promise<number>((done) => { resolve = done }) },
    update: (value) => updates.push(value),
    every: (callback) => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval> },
    cancelEvery: () => {}, after: () => 1 as unknown as ReturnType<typeof setTimeout>, cancelAfter: () => {},
  })
  assert.equal(calls, 1)
  tick()
  assert.equal(calls, 1)
  resolve(7)
  await new Promise((done) => setImmediate(done))
  tick()
  assert.equal(calls, 2)
  resolve(8)
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [7, 8])
  stop()
})

test("reports failures as unavailable and aborts/ignores results after cleanup", async () => {
  let tick!: () => void
  let reject!: (error: Error) => void
  let signal!: AbortSignal
  const updates: Array<number | null> = []
  const stop = startPolling({
    load: (requestSignal) => { signal = requestSignal; return new Promise<number>((_resolve, fail) => { reject = fail }) },
    update: (value) => updates.push(value),
    every: (callback) => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval> },
    cancelEvery: () => {}, after: () => 1 as unknown as ReturnType<typeof setTimeout>, cancelAfter: () => {},
  })
  tick()
  reject(new Error("network"))
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [null])

  tick()
  stop()
  assert.equal(signal.aborted, true)
  reject(new Error("aborted"))
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [null])
})

test("ignores a successful response that resolves after cleanup", async () => {
  let resolve!: (value: string) => void
  let signal!: AbortSignal
  const updates: Array<string | null> = []
  const stop = startPolling({
    load: (requestSignal) => { signal = requestSignal; return new Promise<string>((done) => { resolve = done }) },
    update: (value) => updates.push(value),
    every: () => 1 as unknown as ReturnType<typeof setInterval>, cancelEvery: () => {},
    after: () => 1 as unknown as ReturnType<typeof setTimeout>, cancelAfter: () => {},
  })
  stop()
  assert.equal(signal.aborted, true)
  resolve("stale")
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [])
})

test("times out a stuck request, permits the next poll, and ignores the late success", async () => {
  let tick!: () => void
  let expire!: () => void
  const pending: Array<(value: string) => void> = []
  const signals: AbortSignal[] = []
  const updates: Array<string | null> = []
  const stop = startPolling({
    load: (signal) => {
      signals.push(signal)
      return new Promise<string>((resolve) => pending.push(resolve))
    },
    update: (value) => updates.push(value),
    every: (callback) => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval> },
    cancelEvery: () => {},
    after: (callback) => { expire = callback; return 1 as unknown as ReturnType<typeof setTimeout> },
    cancelAfter: () => {},
  })
  expire()
  assert.equal(signals[0].aborted, true)
  assert.deepEqual(updates, [null])
  tick()
  assert.equal(signals.length, 2)
  pending[0]("late")
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [null])
  pending[1]("fresh")
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [null, "fresh"])
  stop()
})

test("location key change aborts the old request and ignores its result", async () => {
  let tick!: () => void
  let location = { directory: "/project-a" }
  const signals: AbortSignal[] = []
  const resolve: Array<(value: string) => void> = []
  const updates: Array<string | null> = []
  const stop = startPolling({
    key: () => locationKey(location),
    load: (signal) => {
      signals.push(signal)
      return new Promise<string>((done) => resolve.push(done))
    },
    update: (value) => updates.push(value),
    every: (callback) => { tick = callback; return 1 as unknown as ReturnType<typeof setInterval> },
    cancelEvery: () => {}, after: () => 1 as unknown as ReturnType<typeof setTimeout>, cancelAfter: () => {},
  })
  // The host can return a fresh but equivalent object on each read.
  assert.equal(locationKey({ directory: "/project-a" }), locationKey({ directory: "/project-a" }))
  tick()
  assert.equal(signals.length, 1)
  location = { directory: "/project-b" }
  tick()
  assert.equal(signals[0].aborted, true)
  assert.equal(signals.length, 2)
  resolve[0]("project-a usage")
  resolve[1]("project-b usage")
  await new Promise((done) => setImmediate(done))
  assert.deepEqual(updates, [null, "project-b usage"])
  stop()
})
