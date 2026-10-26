import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";
import {
  codexCliArguments,
  codexCliEnvironment,
  NativeCodexQuotaService,
  OwnedChildProcess,
  parseCodexRateLimits,
  queryCodexAppServer,
} from "../../src/backend/native-codex.ts";
import { withNativeCodexLock } from "../../src/backend/native-lock.ts";
import { readNativeQuotaOptIn, setNativeQuotaOptIn } from "../../src/backend/native-settings.ts";
import type { UsageState } from "../../src/contracts.ts";

test("selects only the codex bucket and its unique seven-day window", () => {
  const state = parseCodexRateLimits({
    rateLimits: {
      limitId: "other-model",
      primary: { windowDurationMins: 10080, usedPercent: 99 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { windowDurationMins: 300, usedPercent: 81 },
        secondary: { windowDurationMins: 10080, usedPercent: 37.5, resetsAt: 1_800_000_000 },
      },
    },
    accountId: "private-account-id",
  }, 1234);
  assert.deepEqual(state, {
    status: "ok",
    checkedAt: 1234,
    weekly: { usedPercent: 37.5, remainingPercent: 62.5, resetAt: 1_800_000_000_000 },
    message: "Source: Codex sign-in",
  });
  assert.equal(JSON.stringify(state).includes("private-account-id"), false);
});

test("accepts the direct codex limit form and uses null when reset is absent", () => {
  const state = parseCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { windowDurationMins: 10080, usedPercent: 0 },
    },
  }, 20);
  assert.equal(state.status, "ok");
  assert.deepEqual(state.weekly, { usedPercent: 0, remainingPercent: 100, resetAt: null });
});

test("malformed, non-codex, missing, and ambiguous weekly rate limits stay unavailable", () => {
  const invalid = [
    null,
    {},
    { rateLimits: { limitId: "chatgpt", primary: { windowDurationMins: 10080, usedPercent: 10 } } },
    { rateLimitsByLimitId: { chatgpt: { primary: { windowDurationMins: 10080, usedPercent: 10 } } } },
    { rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 300, usedPercent: 10 } } } },
    { rateLimitsByLimitId: { codex: {
      primary: { windowDurationMins: 10080, usedPercent: 10 },
      secondary: { windowDurationMins: 10080, usedPercent: 20 },
    } } },
    { rateLimitsByLimitId: { codex: { primary: { windowDurationMins: 10080, usedPercent: 101 } } } },
  ];
  for (const value of invalid) {
    const state = parseCodexRateLimits(value, 42);
    assert.equal(state.status, "unavailable");
    assert.equal(state.weekly, null);
  }
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  closed = false;
  requests: Record<string, unknown>[] = [];
  private readonly account: unknown;
  private readonly respond: boolean;

  constructor(account: unknown = {
    type: "chatgpt", email: "private@example.test", accountId: "private-id",
  }, respond = true) {
    super();
    this.account = account;
    this.respond = respond;
    this.stdin.on("data", (chunk: Buffer) => {
      this.input += chunk.toString();
      let newline = this.input.indexOf("\n");
      while (newline >= 0) {
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        this.onRequest(JSON.parse(line) as Record<string, unknown>);
        newline = this.input.indexOf("\n");
      }
    });
    this.stdin.on("finish", () => this.finishClose());
  }

  private input = "";

  kill(): boolean {
    this.killed = true;
    this.finishClose();
    return true;
  }

  private onRequest(request: Record<string, unknown>): void {
    this.requests.push(request);
    if (request.id === undefined) return;
    let result: unknown = {};
    if (request.method === "account/read") {
      result = { account: this.account };
    }
    if (!this.respond) return;
    if (request.method === "account/rateLimits/read") {
      result = { rateLimitsByLimitId: { codex: {
        limitId: "codex",
        primary: { windowDurationMins: 10080, usedPercent: 23, resetsAt: 1_800_000_000 },
      } } };
    }
    const response = `${JSON.stringify({ id: request.id, result })}\n`;
    if (request.id === 0) {
      this.stdout.write('{"method":"server/ready"}\n');
      this.stdout.write('{"id":999,"result":{}}\n');
      this.stdout.write(response.slice(0, 5));
      setImmediate(() => this.stdout.write(response.slice(5)));
      return;
    }
    this.stdout.write(response);
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }
}

test("speaks newline JSON app-server protocol and keeps account data private", async () => {
  let child: FakeChild | undefined;
  let invocation: { command: string; args: string[]; options: SpawnOptions } | undefined;
  const spawner = ((command: string, args: string[], options: SpawnOptions) => {
    invocation = { command, args, options };
    child = new FakeChild();
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof import("node:child_process").spawn;

  const state = await queryCodexAppServer(new AbortController().signal, spawner);
  assert.match(invocation?.command ?? "", /vendor[/\\].+[/\\]bin[/\\]codex(?:\.exe)?$/);
  assert.deepEqual(invocation?.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(invocation?.options.cwd, homedir());
  assert.deepEqual(child?.requests.map((request) => request.method), [
    "initialize", "initialized", "account/read", "account/rateLimits/read",
  ]);
  assert.deepEqual(child?.requests[0]?.params, {
    clientInfo: { name: "opencode_openai_weekly", title: "OpenAI weekly quota", version: "0.1.0" },
  });
  assert.deepEqual(child?.requests[2]?.params, { refreshToken: false });
  assert.deepEqual(child?.requests[3]?.params, { excludeResetCreditDetails: true });
  assert.equal(state.status, "ok");
  assert.equal(state.message, "Source: Codex sign-in");
  assert.equal(JSON.stringify(state).includes("private@example.test"), false);
  assert.equal(JSON.stringify(state).includes("private-id"), false);

  const enabledService = new NativeCodexQuotaService(
    Date.now,
    (signal) => queryCodexAppServer(signal, spawner),
    async () => true,
  );
  assert.equal((await enabledService.status()).message, "Source: Codex sign-in");
  enabledService.cleanup();
});

test("native account absence prompts explicit login without exposing account details", async () => {
  let child: FakeChild | undefined;
  const spawner = ((command: string, args: string[], options: SpawnOptions) => {
    child = new FakeChild(null);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof import("node:child_process").spawn;
  const state = await queryCodexAppServer(new AbortController().signal, spawner);
  assert.equal(state.status, "disconnected");
  assert.equal(state.weekly, null);
  assert.equal(state.message, "Connect Codex for quota: ocdb quota login.");
  assert.deepEqual(child?.requests.map((request) => request.method), [
    "initialize", "initialized", "account/read",
  ]);
});

test("native CLI wrapper targets the pinned package and strips inherited API credential overrides", () => {
  const env = codexCliEnvironment();
  const command = codexCliArguments(["login", "--device-auth"]);
  assert.match(command[0] ?? "", /vendor[/\\].+[/\\]bin[/\\]codex(?:\.exe)?$/);
  assert.deepEqual(command.slice(1), ["login", "--device-auth"]);
  for (const key of ["OPENAI_API_KEY", "OPENAI_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) {
    assert.equal(env[key], undefined);
  }
  assert.equal(env.CODEX_HOME, process.env.CODEX_HOME);
});

test("native quota calls deduplicate and cache successful results, then cleanup aborts work", async () => {
  let now = 1000;
  let calls = 0;
  let finish!: (value: UsageState) => void;
  let queryStarted!: () => void;
  const started = new Promise<void>((resolve) => { queryStarted = resolve; });
  const service = new NativeCodexQuotaService(() => now, () => {
    calls++;
    queryStarted();
    return new Promise((resolve) => { finish = resolve; });
  }, async () => true);
  const one = service.status();
  const two = service.status();
  await started;
  assert.equal(calls, 1);
  finish(parseCodexRateLimits({ rateLimitsByLimitId: { codex: {
    primary: { windowDurationMins: 10080, usedPercent: 44 },
  } } }, now));
  assert.deepEqual(await one, await two);
  assert.equal((await service.status()).weekly?.usedPercent, 44);
  assert.equal(calls, 1);
  service.cleanup();
  assert.equal((await service.status()).status, "unavailable");

  const abortService = new NativeCodexQuotaService(() => now, (signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({
      status: "unavailable", checkedAt: now, weekly: null, message: null,
    }), { once: true });
  }), async () => true);
  const pending = abortService.status();
  abortService.cleanup();
  assert.equal((await pending).status, "unavailable");
});

test("native success cache ends at the reported weekly reset", async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const service = new NativeCodexQuotaService(() => now, async () => {
    calls++;
    return parseCodexRateLimits({ rateLimitsByLimitId: { codex: {
      primary: { windowDurationMins: 10080, usedPercent: calls * 10, resetsAt: 1_700_000_030 },
    } } }, now);
  }, async () => true);
  assert.equal((await service.status()).weekly?.usedPercent, 10);
  now += 30_000;
  assert.equal((await service.status()).weekly?.usedPercent, 20);
  assert.equal(calls, 2);
  service.cleanup();
});

test("native quota is opt-in: disabled status does not invoke the app-server query", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quota-settings-test-"));
  let queries = 0;
  try {
    assert.equal(await readNativeQuotaOptIn(root), false);
    const service = new NativeCodexQuotaService(Date.now, async () => {
      queries++;
      return parseCodexRateLimits({});
    }, () => readNativeQuotaOptIn(root));
    const disabled = await service.status();
    assert.equal(disabled.status, "disconnected");
    assert.equal(disabled.message, "Native Codex quota is off. Run ocdb quota enable to opt in.");
    assert.equal(queries, 0);

    await setNativeQuotaOptIn(true, root);
    assert.equal(await readNativeQuotaOptIn(root), true);
    const enabled = await service.status();
    assert.equal(enabled.status, "unavailable");
    assert.equal(queries, 1);
    service.cleanup();
    await setNativeQuotaOptIn(false, root);
    assert.equal(await readNativeQuotaOptIn(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default opt-in check uses only the addon settings file and never invokes Codex by default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quota-default-off-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  let calls = 0;
  try {
    const service = new NativeCodexQuotaService(Date.now, async () => {
      calls++;
      return parseCodexRateLimits({});
    });
    const result = await service.status();
    assert.equal(result.status, "disconnected");
    assert.match(result.message ?? "", /quota enable/);
    assert.equal(calls, 0);
    service.cleanup();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("native app-server abort kills its child and reaps the transaction", async () => {
  let child: FakeChild | undefined;
  const spawner = (() => {
    child = new FakeChild(undefined, false);
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof import("node:child_process").spawn;
  const controller = new AbortController();
  const pending = queryCodexAppServer(controller.signal, spawner);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending);
  assert.equal(child?.closed, true);
});

test("proper-lockfile serializes addon transactions in an isolated temporary cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quota-lock-test-"));
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, () => withNativeCodexLock(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
    }, 1_000, root)));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compromised lock aborts and reaps its owned child before sanitized rejection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "quota-lock-compromise-"));
  const lockDir = path.join(root, "opencode-openai-weekly", "codex-lock-target.lock");
  let child: ReturnType<typeof spawn> | undefined;
  let owner: OwnedChildProcess | undefined;
  let closed = false;
  let operationResolvedAfterClose = false;
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => { childStarted = resolve; });

  const transaction = withNativeCodexLock((signal) => new Promise<string>((resolve, reject) => {
    child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { stdio: "ignore" });
    owner = new OwnedChildProcess(child);
    child.once("close", () => { closed = true; });
    signal.addEventListener("abort", () => {
      void owner!.terminate(75).then(() => {
        operationResolvedAfterClose = closed && owner!.isClosed;
        resolve("closed");
      }, reject);
    }, { once: true });
    child.once("spawn", childStarted);
  }), 1_000, root, undefined, { staleMs: 2_000, updateMs: 1_000 });

  try {
    await started;
    await rm(lockDir, { recursive: true, force: true });
    await assert.rejects(transaction, { message: "Native Codex lock was compromised." });
    assert.equal(closed, true);
    assert.equal(operationResolvedAfterClose, true);
    assert.equal(child?.signalCode, "SIGKILL");
  } finally {
    if (child && owner && !owner.isClosed) await owner.terminate(75);
    await rm(root, { recursive: true, force: true });
  }
});
