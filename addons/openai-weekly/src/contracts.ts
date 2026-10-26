export interface UsageState {
  status:
    | "ok"
    | "disconnected"
    | "unsupported"
    | "auth_required"
    | "rate_limited"
    | "unavailable";
  checkedAt: number;
  weekly: {
    usedPercent: number;
    remainingPercent: number;
    resetAt: number | null;
  } | null;
  message: string | null;
}
