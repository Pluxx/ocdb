import { open, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { lock } from "proper-lockfile";

const LOCK_STALE_MS = 60_000;
const LOCK_UPDATE_MS = 10_000;

function nativeLockTarget(cacheRootOverride?: string): string {
  if (cacheRootOverride) return path.join(cacheRootOverride, "opencode-openai-weekly", "codex-lock-target");
  const configuredCache = process.env.XDG_CACHE_HOME;
  const cacheRoot = configuredCache && path.isAbsolute(configuredCache)
    ? configuredCache
    : path.join(homedir(), ".cache");
  return path.join(cacheRoot, "opencode-openai-weekly", "codex-lock-target");
}

/** Serialize only this addon's app-server and explicit login subprocesses. */
export async function withNativeCodexLock<T>(
  work: (signal: AbortSignal) => Promise<T>,
  waitMs = 2_500,
  cacheRootOverride?: string,
  callerSignal?: AbortSignal,
  testTiming?: { staleMs: number; updateMs: number },
): Promise<T> {
  if (callerSignal?.aborted) throw new Error("Native Codex operation cancelled.");
  const target = nativeLockTarget(cacheRootOverride);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const marker = await open(target, "a", 0o600);
  await marker.close();

  const lockAbort = new AbortController();
  const operationSignal = callerSignal
    ? AbortSignal.any([callerSignal, lockAbort.signal])
    : lockAbort.signal;
  let release: (() => Promise<void>) | undefined;
  let compromised = false;
  try {
    release = await lock(target, {
      realpath: false,
      stale: testTiming?.staleMs ?? LOCK_STALE_MS,
      update: testTiming?.updateMs ?? LOCK_UPDATE_MS,
      onCompromised: () => {
        compromised = true;
        lockAbort.abort();
      },
      retries: {
        retries: Math.max(0, Math.ceil(waitMs / 150)),
        factor: 1,
        minTimeout: 100,
        maxTimeout: 200,
        randomize: false,
      },
    });
  } catch {
    throw new Error("Native Codex is busy.");
  }

  let value: T | undefined;
  let failure: unknown;
  let releaseFailed = false;
  try {
    if (operationSignal.aborted) failure = new Error("Native Codex operation cancelled.");
    else value = await work(operationSignal);
  } catch (error) {
    failure = error;
  } finally {
    if (!compromised) {
      try {
        await release();
      } catch {
        releaseFailed = true;
      }
    }
  }

  if (compromised) throw new Error("Native Codex lock was compromised.");
  if (callerSignal?.aborted) throw new Error("Native Codex operation cancelled.");
  if (releaseFailed) throw new Error("Native Codex lock could not be released.");
  if (failure) throw failure;
  return value as T;
}
