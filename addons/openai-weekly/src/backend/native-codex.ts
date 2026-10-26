import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { UsageState } from "../contracts.ts";
import { finiteNumber, isObject, object, statusState, unavailable } from "./usage.ts";
import { withNativeCodexLock } from "./native-lock.ts";
import { readNativeQuotaOptIn } from "./native-settings.ts";

const APP_SERVER_TIMEOUT_MS = 10_000;
const TOTAL_OUTPUT_LIMIT = 256 * 1024;
const LINE_LIMIT = 64 * 1024;
const STDERR_LIMIT = 16 * 1024;
const CACHE_MS = 60_000;
const LOGIN_MESSAGE = "Connect Codex for quota: ocdb quota login.";
const DISABLED_MESSAGE = "Native Codex quota is off. Run ocdb quota enable to opt in.";
const SOURCE_MESSAGE = "Source: Codex sign-in";

const require = createRequire(import.meta.url);
const CODEX_TARGETS: Record<string, { packageName: string; triple: string; executable: string }> = {
  "linux:x64": { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl", executable: "codex" },
  "linux:arm64": { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl", executable: "codex" },
  "darwin:x64": { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin", executable: "codex" },
  "darwin:arm64": { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin", executable: "codex" },
  "win32:x64": { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc", executable: "codex.exe" },
  "win32:arm64": { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc", executable: "codex.exe" },
};

function codexBinaryPath(): string {
  const target = CODEX_TARGETS[`${process.platform}:${process.arch}`];
  if (!target) throw new Error("Pinned Codex CLI does not support this platform.");
  try {
    const packageRoot = path.dirname(require.resolve(`${target.packageName}/package.json`));
    const binary = path.join(packageRoot, "vendor", target.triple, "bin", target.executable);
    if (existsSync(binary)) return binary;
  } catch {
    // Optional platform package may be absent on unsupported or incomplete installs.
  }
  throw new Error("Pinned Codex native executable is unavailable.");
}

function cleanCodexEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "CODEX_BASE_URL",
  ]) delete env[key];
  return env;
}

export function parseCodexRateLimits(payload: unknown, now = Date.now()): UsageState {
  if (!isObject(payload)) return unavailable(now, "Codex quota is unavailable.");
  let bucket: Record<string, unknown> | undefined;
  const byLimit = object(payload.rateLimitsByLimitId);
  if (byLimit) {
    bucket = object(byLimit.codex);
  } else {
    const candidate = object(payload.rateLimits);
    if (candidate?.limitId === "codex") bucket = candidate;
  }

  if (!bucket) return unavailable(now, "Codex weekly quota is unavailable.");
  const weekly = [bucket.primary, bucket.secondary]
    .map(object)
    .filter((window) => window && window.windowDurationMins === 10_080);
  if (weekly.length !== 1) return unavailable(now, "Codex weekly quota is unavailable.");

  const window = weekly[0];
  const usedPercent = finiteNumber(window?.usedPercent);
  if (usedPercent === undefined || usedPercent < 0 || usedPercent > 100) {
    return unavailable(now, "Codex weekly quota is unavailable.");
  }
  const resetSeconds = finiteNumber(window?.resetsAt);
  const resetAt = resetSeconds !== undefined && resetSeconds >= 0 && Number.isFinite(resetSeconds * 1000)
    ? resetSeconds * 1000
    : null;
  return {
    status: "ok",
    checkedAt: now,
    weekly: { usedPercent, remainingPercent: 100 - usedPercent, resetAt },
    message: SOURCE_MESSAGE,
  };
}

type PendingResponse = {
  resolve(value: unknown): void;
  reject(): void;
  timeout: ReturnType<typeof setTimeout>;
};

/** Owns a direct child process and does not settle termination until its close event. */
export class OwnedChildProcess {
  readonly closed: Promise<void>;
  readonly child: ChildProcess;
  private closeResolve!: () => void;
  private closedValue = false;
  private stopping?: Promise<void>;

  constructor(child: ChildProcess) {
    this.child = child;
    this.closed = new Promise((resolve) => { this.closeResolve = resolve; });
    child.once("close", () => {
      this.closedValue = true;
      this.closeResolve();
    });
  }

  get isClosed(): boolean { return this.closedValue; }

  async wait(timeoutMs: number): Promise<boolean> {
    if (this.closedValue) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
    return this.closedValue;
  }

  terminate(graceMs = 500): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.closedValue) return;
      try { this.child.kill("SIGTERM"); } catch { /* Escalate to SIGKILL below. */ }
      if (await this.wait(graceMs)) return;
      try { this.child.kill("SIGKILL"); } catch { /* Await the OS close event regardless. */ }
      if (!this.closedValue) await this.closed;
    })();
    return this.stopping;
  }
}

class AppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly owned: OwnedChildProcess;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingResponse>();
  private readonly closed: Promise<void>;
  private output = "";
  private outputBytes = 0;
  private stderrBytes = 0;
  private ended = false;

  constructor(signal: AbortSignal, spawnProcess: typeof spawn = spawn) {
    const options: SpawnOptions = {
      cwd: homedir(),
      env: cleanCodexEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };
    this.child = spawnProcess(codexBinaryPath(), ["app-server", "--listen", "stdio://"], options) as ChildProcessWithoutNullStreams;
    this.owned = new OwnedChildProcess(this.child);
    this.closed = this.owned.closed;
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.child.stdin.on("error", () => this.failAll());
    this.child.stdout.on("error", () => this.failAll());
    this.child.stderr.on("error", () => this.failAll());
    this.child.on("error", () => this.failAll());
    this.child.on("close", () => {
      this.ended = true;
      this.failAll();
    });
    signal.addEventListener("abort", this.onAbort, { once: true });
    this.signal = signal;
  }

  private readonly signal: AbortSignal;
  private readonly onAbort = () => this.failAll();

  async request(id: number, method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.signal.aborted || this.ended) throw new Error("Native Codex request failed.");
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Native Codex request timed out."));
        this.failAll();
      }, APP_SERVER_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: () => { clearTimeout(timeout); reject(new Error("Native Codex request failed.")); },
        timeout,
      });
    });
    try {
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch {
      this.failAll();
    }
    return result;
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.signal.aborted || this.ended) throw new Error("Native Codex request failed.");
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close(): Promise<void> {
    this.signal.removeEventListener("abort", this.onAbort);
    if (!this.ended) {
      try { this.child.stdin.end(); } catch { /* Kill below if graceful shutdown stalls. */ }
      await this.waitForClose(400);
      if (!this.ended) await this.owned.terminate(500);
    }
  }

  private async waitForClose(timeoutMs: number): Promise<void> {
    if (this.ended) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private onStdout(chunk: Buffer): void {
    this.outputBytes += chunk.length;
    if (this.outputBytes > TOTAL_OUTPUT_LIMIT) return this.failAll();
    this.output += this.decoder.write(chunk);
    if (this.output.length > LINE_LIMIT && !this.output.includes("\n")) return this.failAll();
    let newline = this.output.indexOf("\n");
    while (newline >= 0) {
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (line.length > LINE_LIMIT) return this.failAll();
      if (line) this.onLine(line);
      newline = this.output.indexOf("\n");
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > STDERR_LIMIT) this.failAll();
  }

  private onLine(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); } catch { return this.failAll(); }
    if (!isObject(message) || typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (!request) return; // Notifications and unmatched response IDs are ignored.
    this.pending.delete(message.id);
    if (Object.hasOwn(message, "error")) request.reject();
    else request.resolve(message.result);
  }

  private failAll(): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timeout);
      request.reject();
      this.pending.delete(id);
    }
  }
}

export async function queryCodexAppServer(
  signal: AbortSignal,
  spawnProcess: typeof spawn = spawn,
): Promise<UsageState> {
  if (signal.aborted) throw new Error("Native Codex request cancelled.");
  const client = new AppServerClient(signal, spawnProcess);
  try {
    await client.request(0, "initialize", {
      clientInfo: {
        name: "opencode_openai_weekly",
        title: "OpenAI weekly quota",
        version: "0.1.0",
      },
    });
    client.notify("initialized", {});
    const accountResult = await client.request(1, "account/read", { refreshToken: false });
    const account = object(accountResult)?.account;
    if (account === null) return statusState("disconnected", LOGIN_MESSAGE);
    if (!isObject(account)) return unavailable(Date.now(), "Codex account status is unavailable.");
    if (account.type !== "chatgpt") {
      return statusState("unsupported", "Sign in to Codex with ChatGPT to view weekly quota.");
    }

    const quotaResult = await client.request(2, "account/rateLimits/read", { excludeResetCreditDetails: true });
    return parseCodexRateLimits(quotaResult);
  } finally {
    await client.close();
  }
}

type Cache = { expiresAt: number; value: UsageState };

export class NativeCodexQuotaService {
  private cache?: Cache;
  private pending?: Promise<UsageState>;
  private controller?: AbortController;
  private disposed = false;
  private readonly clock: () => number;
  private readonly query: (signal: AbortSignal) => Promise<UsageState>;
  private readonly enabled: () => Promise<boolean>;

  constructor(
    clock: () => number = Date.now,
    query?: (signal: AbortSignal) => Promise<UsageState>,
    enabled: () => Promise<boolean> = () => readNativeQuotaOptIn(),
  ) {
    this.clock = clock;
    this.enabled = enabled;
    this.query = query ?? ((signal) => withNativeCodexLock(async (lockSignal) => {
      if (!await this.isEnabled()) return statusState("disconnected", DISABLED_MESSAGE, this.clock());
      return queryCodexAppServer(lockSignal);
    }, 2_500, undefined, signal));
  }

  async status(): Promise<UsageState> {
    if (this.disposed) return Promise.resolve(unavailable(this.clock()));
    if (!await this.isEnabled()) {
      this.cancelPending();
      this.cache = undefined;
      return statusState("disconnected", DISABLED_MESSAGE, this.clock());
    }
    if (this.disposed) return unavailable(this.clock());
    const now = this.clock();
    if (this.cache && this.cache.expiresAt > now) return this.cache.value;
    if (this.pending) return this.pending;

    const controller = new AbortController();
    this.controller = controller;
    let task: Promise<UsageState>;
    task = this.query(controller.signal)
      .catch(() => unavailable(this.clock(), "Codex quota is unavailable."))
      .then((value) => {
        if (this.pending === task) {
          this.pending = undefined;
          this.controller = undefined;
          if (!this.disposed && value.status === "ok") {
            const expiresAt = Math.min(
              this.clock() + CACHE_MS,
              value.weekly?.resetAt ?? Number.POSITIVE_INFINITY,
            );
            if (expiresAt > this.clock()) this.cache = { expiresAt, value };
          }
        }
        return value;
      });
    this.pending = task;
    return task;
  }

  cleanup(): void {
    this.disposed = true;
    this.cancelPending();
    this.cache = undefined;
  }

  private async isEnabled(): Promise<boolean> {
    try { return await this.enabled(); } catch { return false; }
  }

  private cancelPending(): void {
    this.controller?.abort();
    this.controller = undefined;
    this.pending = undefined;
  }
}

export function codexCliArguments(args: string[]): string[] {
  return [codexBinaryPath(), ...args];
}

export function codexCliEnvironment(): NodeJS.ProcessEnv {
  return cleanCodexEnvironment();
}

export async function runCodexLogin(args: string[]): Promise<number> {
  const processAbort = new AbortController();
  const abortOnInterrupt = () => processAbort.abort();
  process.once("SIGINT", abortOnInterrupt);
  process.once("SIGTERM", abortOnInterrupt);
  let code: number;
  try {
    code = await withNativeCodexLock((lockSignal) => new Promise<number>((resolve, reject) => {
      const [binary, ...loginArgs] = codexCliArguments(["login", ...args]);
      const child = spawn(binary!, loginArgs, {
        cwd: homedir(),
        env: codexCliEnvironment(),
        stdio: "inherit",
        windowsHide: true,
      });
      const owned = new OwnedChildProcess(child);
      const abortChild = () => { void owned.terminate(500); };
      lockSignal.addEventListener("abort", abortChild, { once: true });
      const login = new Promise<number>((resolve, reject) => {
        child.once("error", () => reject(new Error("Unable to start native Codex login.")));
        child.once("close", (code) => resolve(code ?? 1));
      });
      return login.finally(async () => {
        lockSignal.removeEventListener("abort", abortChild);
        if (!owned.isClosed) await owned.terminate(500);
      });
    }), 30_000, undefined, processAbort.signal);
  } finally {
    process.removeListener("SIGINT", abortOnInterrupt);
    process.removeListener("SIGTERM", abortOnInterrupt);
  }
  if (code === 0) {
    const { setNativeQuotaOptIn } = await import("./native-settings.ts");
    await setNativeQuotaOptIn(true);
  }
  return code;
}
