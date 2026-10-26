import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SETTINGS_FILE = "settings.json";
const OPT_IN_KEY = "codexQuotaOptIn";

function configRoot(configHome = process.env.XDG_CONFIG_HOME): string {
  return configHome && path.isAbsolute(configHome)
    ? configHome
    : path.join(homedir(), ".config");
}

export function nativeQuotaSettingsPath(configHome?: string): string {
  return path.join(configRoot(configHome), "opencode-openai-weekly", SETTINGS_FILE);
}

export async function readNativeQuotaOptIn(configHome?: string): Promise<boolean> {
  try {
    const contents = await readFile(nativeQuotaSettingsPath(configHome), "utf8");
    const value: unknown = JSON.parse(contents);
    return value !== null && typeof value === "object" &&
      !Array.isArray(value) && (value as Record<string, unknown>)[OPT_IN_KEY] === true;
  } catch {
    return false;
  }
}

export async function setNativeQuotaOptIn(enabled: boolean, configHome?: string): Promise<void> {
  const file = nativeQuotaSettingsPath(configHome);
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let settings: Record<string, unknown> = {};
  try {
    const current: unknown = JSON.parse(await readFile(file, "utf8"));
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      settings = current as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed addon settings are replaced with a minimal valid document.
  }
  settings[OPT_IN_KEY] = enabled;

  const temporary = path.join(directory, `.settings-${process.pid}-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
