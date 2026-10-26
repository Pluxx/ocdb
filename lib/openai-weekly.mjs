import { access, lstat, mkdir, readFile, realpath, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The add-on keeps its own node_modules (Codex runtime, OpenCode SDK), so it is
// linked into the OpenCode config rather than copied like the managed assets.
export const ADDON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'addons', 'openai-weekly');
const PACKAGE_NAME = 'opencode-openai-weekly';
const fail = (message) => { throw new Error(message); };

export const addonLink = (dest) => path.join(dest, 'plugins', 'openai-weekly');

async function packageName(dir) {
  try { return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).name; } catch { return null; }
}

/** 'installed' | 'absent' | 'legacy' (link to another checkout of this add-on) | 'foreign' */
export async function addonState(dest, root = ADDON_ROOT) {
  const link = addonLink(dest);
  let info;
  try { info = await lstat(link); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (!info.isSymbolicLink()) return 'foreign';
  let target;
  try { target = await realpath(link); } catch { return 'foreign'; }
  if (target === await realpath(root)) return 'installed';
  return await packageName(target) === PACKAGE_NAME ? 'legacy' : 'foreign';
}

async function dependenciesInstalled(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try { await access(path.join(root, 'node_modules', ...name.split('/'), 'package.json')); } catch { return false; }
  }
  return true;
}

export async function installAddon(dest, { mode = 'dry-run', log = console, root = ADDON_ROOT, npm = 'npm' } = {}) {
  const state = await addonState(dest, root);
  const link = addonLink(dest);
  if (state === 'foreign') fail(`refusing to replace ${link}: it is not an OpenAI weekly add-on link`);
  const needsDeps = !await dependenciesInstalled(root);
  if (mode !== 'apply') {
    if (state === 'installed' && !needsDeps) log.log('OpenAI weekly quota: already installed');
    else log.log(`OpenAI weekly quota: would ${needsDeps ? 'run npm ci in addons/openai-weekly and ' : ''}${state === 'legacy' ? 'replace the old add-on link at' : 'link'} ${link}`);
    return;
  }
  if (needsDeps) {
    log.log('Installing OpenAI weekly add-on dependencies (npm ci)...');
    const result = spawnSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) fail('npm ci failed in addons/openai-weekly');
  }
  if (state === 'installed') { log.log('OpenAI weekly quota: already installed'); return; }
  if (state === 'legacy') { await unlink(link); log.log(`Replaced old add-on link at ${link}`); }
  await mkdir(path.dirname(link), { recursive: true });
  await symlink(root, link, 'dir');
  log.log(`OpenAI weekly quota: linked ${link} -> ${root}`);
}

export async function uninstallAddon(dest, { mode = 'dry-run', log = console, root = ADDON_ROOT } = {}) {
  if (await addonState(dest, root) !== 'installed') return false;
  if (mode !== 'apply') { log.log(`OpenAI weekly quota: would remove ${addonLink(dest)}`); return true; }
  await unlink(addonLink(dest));
  log.log(`OpenAI weekly quota: removed ${addonLink(dest)}`);
  return true;
}

/** Runs the add-on's quota script: enable | disable | login [codex login args]. Returns the exit code. */
export function runQuota(action, args = [], { root = ADDON_ROOT } = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'quota.mjs'), action, ...args], { cwd: root, stdio: 'inherit' });
  return result.status ?? 1;
}
