// Usage: node scripts/quota.mjs enable|disable|login [codex login args...]
import { setNativeQuotaOptIn } from "../src/backend/native-settings.ts";

const [action, ...args] = process.argv.slice(2);
try {
  if (action === "enable" || action === "disable") {
    await setNativeQuotaOptIn(action === "enable");
    console.log(action === "enable"
      ? "Codex quota enabled. Codex may renew its saved credentials when quota is checked."
      : "Codex quota disabled. Codex credentials were not changed.");
  } else if (action === "login") {
    const { runCodexLogin } = await import("../src/backend/native-codex.ts");
    process.exitCode = await runCodexLogin(args);
    if (process.exitCode === 0) console.log("Codex signed in; Codex quota enabled.");
  } else {
    console.error("Usage: quota.mjs enable|disable|login [args...]");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Codex quota ${action} failed: ${error.message}`);
  process.exitCode = 1;
}
