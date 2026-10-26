import type { UsageState } from "../contracts.ts";

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return isObject(value) ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function unavailable(now = Date.now(), message = "Usage data is unavailable."): UsageState {
  return { status: "unavailable", checkedAt: now, weekly: null, message };
}

export function statusState(
  status: UsageState["status"],
  message: string,
  now = Date.now(),
): UsageState {
  return { status, checkedAt: now, weekly: null, message };
}
