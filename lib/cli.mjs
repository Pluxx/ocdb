import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { activate as activateCore, deactivate as deactivateCore, preflightActivation, preflightDeactivation, readActivation } from './activation.mjs';
import { chooseProfile, loadProfiles, renderProfileAsset } from './model-profiles.mjs';
import { addonState, installAddon, runQuota, uninstallAddon } from './openai-weekly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_DIR = '.vc-ocdb';
const STATE_FILE = `${LEDGER_DIR}/state.json`;
const LOCK_FILE = `${LEDGER_DIR}/lock`;
const WEB_ROOT = path.join(ROOT, 'profiles', 'web');
const MODELS_FILE = path.join(ROOT, 'profiles', 'models.json');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'ocdb-hw');
const PLUGIN_FILES = ['package.json', 'index.ts', 'tui.tsx', 'metrics.mjs', 'activity.mjs'];
const PROFILE_IDS = new Set(['openai', 'opencode-go', 'opencode-zen', 'deepseek']);
const AGENTS = new Set(['VC-Orchestrator', 'VC-Symfony', 'VC-DDEV', 'VC-Design', 'VC-Frontend', 'VC-Reviewer', 'VC-Tester', 'VC-Solver', 'VC-Explorer']);
const SKILLS = new Set(['vc-symfony', 'vc-ddev', 'vc-web-design', 'vc-tailwind', 'vc-solving', 'vc-typo3', 'vc-typo3-upgrade']);
const COMMANDS = new Set(['vc-web', 'vc-plan', 'vc-check', 'vc-solve', 'vc-solve-max']);
const HASH_RE = /^[a-f0-9]{64}$/;
// Paths earlier versions installed; an update removes them if they are unmodified.
const RETIRED_ASSETS = new Set(['agents/vc-web.md', ...['explorer', 'design', 'frontend', 'symfony', 'ddev', 'reviewer', 'tester', 'solver'].map((id) => `agents/vc-${id}.md`)]);
const EXPECTED_ASSETS = new Set([
  ...[...AGENTS].map((id) => `agents/${id}.md`),
  ...[...SKILLS].map((id) => `skills/${id}/SKILL.md`),
  ...[...COMMANDS].map((id) => `commands/${id}.md`),
  ...PLUGIN_FILES.map((file) => `plugins/ocdb-hw/${file}`),
]);

export class CliError extends Error {}
const fail = (message) => { throw new CliError(message); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function parseArgs(args) {
  const result = { command: 'plan', mode: 'dry-run', configDir: null, profile: null, providers: null, activate: false, disableOmo: false, openaiQuota: false, codexQuota: false };
  const positional = [];
  let modeSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { positional.push('--help'); continue; }
    if (arg === '--apply' || arg === '--dry-run') {
      if (modeSeen) fail('choose only one of --apply and --dry-run');
      modeSeen = true;
      if (arg === '--apply') result.mode = 'apply';
      continue;
    }
    if (arg === '--config-dir') {
      if (result.configDir !== null || !args[i + 1] || args[i + 1].startsWith('--')) fail('--config-dir requires one path and may be specified once');
      result.configDir = args[++i];
      continue;
    }
    if (arg === '--profile' || arg === '--providers') {
      const key = arg === '--profile' ? 'profile' : 'providers';
      if (result[key] !== null || !args[i + 1] || args[i + 1].startsWith('--')) fail(`${arg} requires one value and may be specified once`);
      result[key] = key === 'providers' ? args[++i].split(',').filter(Boolean) : args[++i];
      if (key === 'providers' && (!result.providers.length || new Set(result.providers).size !== result.providers.length)) fail('--providers requires a comma-separated list of unique provider IDs');
      continue;
    }
    if (arg === '--activate') { result.activate = true; continue; }
    if (arg === '--disable-omo') { result.disableOmo = true; continue; }
    if (arg === '--openai-quota') { result.openaiQuota = true; continue; }
    if (arg === '--codex-quota') { result.codexQuota = true; continue; }
    if (arg.startsWith('--')) fail(`unknown option: ${arg}`);
    positional.push(arg);
  }
  if (positional.includes('--help')) {
    if (positional.length > 1) fail('--help cannot be combined with a command');
    result.command = 'help';
    return result;
  }
  if (positional.length > 1) fail('unexpected extra arguments');
  if (positional.length) result.command = positional[0];
  if (!['plan', 'install', 'uninstall', 'status', 'profiles', 'setup', 'doctor', 'activate', 'deactivate'].includes(result.command)) fail(`unknown command: ${result.command}`);
  if (result.command === 'plan' && (result.mode === 'apply' || result.configDir !== null || result.profile || result.providers)) fail('plan accepts no options');
  if (result.command === 'status' && (result.mode === 'apply' || result.profile || result.providers || result.activate || result.disableOmo)) fail('status is read-only');
  if (['profiles', 'doctor'].includes(result.command) && (result.mode === 'apply' || result.profile || result.providers || result.activate || result.disableOmo || result.configDir)) fail(`${result.command} is read-only and accepts no options`);
  if (result.command === 'deactivate' && (result.profile || result.providers || result.activate || result.disableOmo)) fail('deactivate accepts no profile or activation options');
  if (result.command === 'uninstall' && (result.profile || result.providers || result.activate || result.disableOmo)) fail('uninstall accepts no profile or activation options');
  if (result.command === 'activate' && (result.providers || result.activate)) fail('activate accepts --profile, --disable-omo, and --config-dir');
  if (!['setup', 'install'].includes(result.command) && result.providers) fail('--providers is supported only by setup and install');
  if (!['setup', 'install', 'activate'].includes(result.command) && (result.activate || result.disableOmo)) fail('--activate and --disable-omo are supported only by setup/install or activate');
  if (result.disableOmo && !result.activate && result.command !== 'activate') fail('--disable-omo requires --activate or the activate command');
  if (!['setup', 'install'].includes(result.command) && (result.openaiQuota || result.codexQuota)) fail('--openai-quota and --codex-quota are supported only by setup and install');
  if (result.codexQuota && !result.openaiQuota) fail('--codex-quota requires --openai-quota');
  if (result.command === 'activate' && result.mode === 'dry-run' && !args.includes('--dry-run') && !args.includes('--apply')) result.mode = 'dry-run';
  return result;
}

function defaultConfigDir() {
  return path.resolve(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
}

function prerequisiteReport() {
  const nodeVersion = process.versions.node;
  const opencode = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 1500 });
  const text = opencode.error ? '' : `${opencode.stdout || ''} ${opencode.stderr || ''}`;
  const match = text.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)/);
  return {
    nodeVersion,
    nodeOk: Number(nodeVersion.split('.')[0]) >= 22,
    opencodeOutput: opencode.error ? 'not found or unavailable' : (opencode.stdout || opencode.stderr).trim() || `exit ${opencode.status}`,
    opencodeV2: Boolean(match && Number(match[1]) >= 2 && opencode.status === 0),
  };
}

function validateRelative(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\\') || path.posix.isAbsolute(rel) || rel.split('/').some((part) => !part || part === '.' || part === '..')) fail(`unsafe managed path: ${String(rel)}`);
  const parts = rel.split('/');
  const ok = (parts[0] === 'agents' && parts.length === 2 && AGENTS.has(parts[1].replace(/\.md$/, '')) && parts[1].endsWith('.md'))
    || (parts[0] === 'commands' && parts.length === 2 && COMMANDS.has(parts[1].replace(/\.md$/, '')) && parts[1].endsWith('.md'))
    || (parts[0] === 'skills' && parts.length >= 3 && SKILLS.has(parts[1]) && parts.slice(2).every((part) => part.endsWith('.md')))
    || (parts.length === 3 && parts[0] === 'plugins' && parts[1] === 'ocdb-hw' && PLUGIN_FILES.includes(parts[2]));
  if (!ok && !RETIRED_ASSETS.has(rel)) fail(`path is outside the allowed namespaced assets: ${rel}`);
  return rel;
}

async function sourceAssets(sourceDir, pluginDir) {
  const assets = new Map();
  const rootStat = await maybeStat(sourceDir);
  if (!rootStat) fail(`profile source directory does not exist: ${sourceDir}`);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('profile source must be a real directory, not a symlink');
  async function walk(dir, prefix = '') {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) fail(`source symlink is not allowed: ${rel}`);
      if (ent.isDirectory()) { await walk(path.join(dir, ent.name), rel); continue; }
      if (!ent.isFile()) fail(`unsupported source entry: ${rel}`);
      validateRelative(rel);
      if (assets.has(rel)) fail(`duplicate source asset: ${rel}`);
      assets.set(rel, await readFile(path.join(dir, ent.name)));
    }
  }
  await walk(sourceDir);
  const pluginStat = await maybeStat(pluginDir);
  if (!pluginStat || pluginStat.isSymbolicLink() || !pluginStat.isDirectory()) fail(`hardware plugin source is missing or unsafe: ${pluginDir}`);
  for (const filename of PLUGIN_FILES) {
    const file = path.join(pluginDir, filename);
    const st = await maybeStat(file);
    if (!st || st.isSymbolicLink() || !st.isFile()) fail(`hardware plugin asset is missing or unsafe: ${filename}`);
    const rel = `plugins/ocdb-hw/${filename}`;
    if (assets.has(rel)) fail(`duplicate source asset: ${rel}`);
    assets.set(rel, await readFile(file));
  }
  const missing = [...EXPECTED_ASSETS].filter((rel) => !assets.has(rel));
  const unexpected = [...assets.keys()].filter((rel) => !EXPECTED_ASSETS.has(rel));
  if (missing.length || unexpected.length) {
    const details = [missing.length && `missing: ${missing.join(', ')}`, unexpected.length && `unexpected: ${unexpected.join(', ')}`].filter(Boolean).join('; ');
    fail(`profile source inventory is incomplete or unsupported (${details})`);
  }
  return assets;
}

async function maybeStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Managed paths must never traverse symlinks, whether or not their final file exists.
async function inspectPath(root, rel, includeLeaf = true) {
  const rootStat = await maybeStat(root);
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) fail('config destination must be a real directory, not a symlink');
  const parts = rel.split('/');
  let cursor = root;
  const count = includeLeaf ? parts.length : parts.length - 1;
  for (let i = 0; i < count; i++) {
    cursor = path.join(cursor, parts[i]);
    const st = await maybeStat(cursor);
    if (!st) continue;
    if (st.isSymbolicLink()) fail(`symlink in managed path: ${path.relative(root, cursor)}`);
    if (i < count - 1 && !st.isDirectory()) fail(`managed path component is not a directory: ${path.relative(root, cursor)}`);
  }
  return await maybeStat(path.join(root, rel));
}

async function readState(dest) {
  const st = await inspectPath(dest, STATE_FILE);
  if (!st) return { version: 1, profile: 'openai', assets: {} };
  if (!st.isFile()) fail('state ledger is not a regular file');
  let state;
  try { state = JSON.parse(await readFile(path.join(dest, STATE_FILE), 'utf8')); }
  catch { fail('state ledger is corrupt or unreadable'); }
  if (!state || state.version !== 1 || !state.assets || Array.isArray(state.assets) || typeof state.assets !== 'object') fail('state ledger has an unsupported or malformed format');
  if (state.profile !== undefined && !PROFILE_IDS.has(state.profile)) fail('state ledger contains an unsupported model profile');
  if (state.profile === undefined) state.profile = 'openai';
  for (const [rel, digest] of Object.entries(state.assets)) {
    validateRelative(rel);
    if (!HASH_RE.test(digest)) fail(`invalid digest in state ledger for ${rel}`);
  }
  return state;
}

async function checkManagedFiles(dest, state, desired, operation) {
  const actions = [];
  for (const [rel, digest] of Object.entries(state.assets)) {
    const st = await inspectPath(dest, rel);
    if (!st) fail(`owned file is missing: ${rel}`);
    if (!st.isFile()) fail(`owned path is not a regular file: ${rel}`);
    const current = await readFile(path.join(dest, rel));
    if (hash(current) !== digest) fail(`owned file was locally modified; refusing ${operation}: ${rel}`);
  }
  if (operation === 'install') {
    for (const [rel, bytes] of desired) {
      const st = await inspectPath(dest, rel);
      const prior = state.assets[rel];
      if (!prior && st) fail(`unowned destination collision: ${rel}`);
      if (prior && hash(bytes) !== prior) actions.push({ type: 'update', rel });
      else if (!prior) actions.push({ type: 'add', rel });
    }
    const obsolete = Object.keys(state.assets).filter((rel) => !desired.has(rel));
    for (const rel of obsolete.filter((rel) => RETIRED_ASSETS.has(rel))) actions.push({ type: 'remove', rel });
    if (obsolete.some((rel) => !RETIRED_ASSETS.has(rel))) fail(`managed files are absent from this profile; uninstall or perform an explicit version transition: ${obsolete.filter((rel) => !RETIRED_ASSETS.has(rel)).join(', ')}`);
  } else {
    for (const rel of Object.keys(state.assets)) actions.push({ type: 'remove', rel });
  }
  return actions;
}

async function validateInstalledProfile(dest, profileId, profile) {
  const state = await readState(dest);
  if (state.profile !== profileId) fail(`installed profile is ${state.profile}; refusing activation for ${profileId}`);
  const installedPaths = Object.keys(state.assets);
  if (installedPaths.length !== EXPECTED_ASSETS.size || installedPaths.some((rel) => !EXPECTED_ASSETS.has(rel))) fail('installed profile inventory is incomplete; refusing activation');
  for (const [rel, digest] of Object.entries(state.assets)) {
    const st = await inspectPath(dest, rel);
    if (!st || !st.isFile()) fail(`installed profile asset is missing or unsafe: ${rel}`);
    if (hash(await readFile(path.join(dest, rel))) !== digest) fail(`installed profile asset was modified: ${rel}`);
  }
  const lead = (await readFile(path.join(dest, 'agents/VC-Orchestrator.md'), 'utf8')).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const model = lead?.[1].match(/^model:\s*(.+)$/m)?.[1].trim();
  if (model !== profile.lead) fail('installed VC-Orchestrator lead route does not match the selected profile; reinstall before activation');
}

function outputActions(command, actions, dest) {
  console.log(`${command} ${actions.length ? 'plan' : 'plan: no changes'} (${dest})`);
  for (const action of actions) console.log(`${action.type}: ${action.rel}`);
}

async function ensureDirSafe(root, rel, created = []) {
  const parts = rel ? rel.split('/') : [];
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const st = await maybeStat(cursor);
    if (st) {
      if (st.isSymbolicLink()) fail(`symlink in managed directory: ${path.relative(root, cursor)}`);
      if (!st.isDirectory()) fail(`managed directory is not a directory: ${path.relative(root, cursor)}`);
    } else {
      await mkdir(cursor);
      created.push(cursor);
    }
  }
}

async function atomicWrite(file, bytes) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
}

async function applyPlan(dest, command, state, desired, actions, profileId, onMutation = async () => {}) {
  const createdDirs = [];
  const journal = [];
  const rollback = async () => {
    const failures = [];
    for (const entry of journal.reverse()) {
      try {
        if (entry.before === null) await rm(entry.file, { force: true });
        else await atomicWrite(entry.file, entry.before);
      } catch (error) { failures.push(`${entry.file}: ${error.message}`); }
    }
    for (const dir of createdDirs.reverse()) await rmdir(dir).catch(() => {});
    return failures;
  };
  const writeJournaled = async (file, bytes) => {
    const st = await maybeStat(file);
    const before = st ? await readFile(file) : null;
    journal.push({ file, before });
    await atomicWrite(file, bytes);
  };
  try {
    await mkdir(dest, { recursive: true });
    const rootStat = await lstat(dest);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('config destination must be a real directory, not a symlink');
    await ensureDirSafe(dest, LEDGER_DIR, createdDirs);
    for (const action of actions) {
      const file = path.join(dest, action.rel);
      await ensureDirSafe(dest, path.posix.dirname(action.rel), createdDirs);
      if (action.type === 'add') {
        await writeJournaled(file, desired.get(action.rel));
      } else {
        const previous = await readFile(file);
        const backupRel = `${LEDGER_DIR}/backups/${Date.now()}-${randomUUID()}/${action.rel}`;
        await ensureDirSafe(dest, path.posix.dirname(backupRel), createdDirs);
        // Recovery archives are deliberately durable, even when later rollback fails.
        await atomicWrite(path.join(dest, backupRel), previous);
        if (action.type === 'update') await writeJournaled(file, desired.get(action.rel));
        else {
          journal.push({ file, before: previous });
          await rm(file);
        }
      }
      await onMutation(action);
    }
    const assets = {};
    if (command === 'install') for (const [rel, bytes] of desired) assets[rel] = hash(bytes);
    const nextState = command === 'install' ? { version: 1, profile: profileId, assets } : { version: 1, assets };
    await writeJournaled(path.join(dest, STATE_FILE), Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`));
  } catch (error) {
    const failures = await rollback();
    if (failures.length) fail(`${error.message}; rollback incomplete: ${failures.join('; ')}`);
    throw error;
  }
}

export async function executeCommand(command, { configDir, sourceDir = WEB_ROOT, pluginDir = PLUGIN_ROOT, modelsFile = MODELS_FILE, mode = 'dry-run', profile: requestedProfile, providers, activate = false, disableOmo = false, openaiQuota = false, codexQuota = false, log = console, onMutation, onActivationMutation } = {}) {
  const dest = path.resolve(configDir || defaultConfigDir());
  const catalog = ['install', 'setup', 'plan', 'profiles', 'activate'].includes(command) ? await loadProfiles(modelsFile) : null;
  if (command === 'profiles') {
    for (const id of catalog.preferenceOrder) {
      const item = catalog.profiles[id];
      if (item) log.log(`${id}: ${item.label} — ${item.lead} (implementation ${item.implementation}; design ${item.design}; explore ${item.explore}; tester ${item.tester}; helpers ${item.helper}; solver ${item.solver}; max ${item.solverMax})`);
    }
    return;
  }
  if (command === 'doctor') {
    const check = prerequisiteReport();
    log.log(`Node.js: ${check.nodeVersion} ${check.nodeOk ? '(supported)' : '(requires >=22)'}`);
    log.log(`OpenCode: ${check.opencodeOutput} ${check.opencodeV2 ? '(V2)' : '(check that this is OpenCode V2)'}`);
    log.log('Next: declare only subscriptions/providers you can use, then run ocdb setup; authenticate with the provider/OpenCode tools yourself. Direct DeepSeek requires activation to register its provider (or configure it yourself first). Entitlement and model generation are not tested.');
    return;
  }
  if (command === 'plan') {
    const assets = await sourceAssets(sourceDir, pluginDir);
    log.log(`install preview (${assets.size} assets; select providers with setup)`);
    for (const rel of assets.keys()) log.log(`would install: ${rel}`);
    return;
  }
  if (command === 'status') {
    const state = await readState(dest);
    const active = await readActivation(dest);
    log.log(`managed assets: ${Object.keys(state.assets).length}; selected profile: ${state.profile || 'openai'}; activation: ${active ? `${active.phase === 'pending' ? 'PENDING RECOVERY' : 'active'} ${active.profile} (${active.coreFile})` : 'inactive'}`);
    for (const rel of Object.keys(state.assets)) log.log(`managed: ${rel}`);
    log.log(`OpenAI weekly quota: ${await addonState(dest)}`);
    return;
  }
  if (command === 'deactivate') {
    const active = await preflightDeactivation(dest);
    if (mode !== 'apply') { log.log(`deactivate preview: restore original ${active.coreFile} state (${dest})`); return; }
    log.log(await deactivateCore(dest));
    return;
  }
  if (command === 'activate') {
    const state = await readState(dest);
    const profileId = requestedProfile || state.profile || 'openai';
    if (!state.assets || !Object.keys(state.assets).length) fail('install the profile before activation');
    if (profileId !== (state.profile || 'openai')) fail(`selected profile is ${state.profile || 'openai'}; install it before activation`);
    const selected = catalog.profiles[profileId];
    if (!selected) fail(`unknown model profile: ${profileId}`);
    await preflightActivation(dest, profileId, selected, { disableOmo });
    if (mode !== 'apply') { log.log(`activation preview: default_agent VC-Orchestrator, model ${selected.lead.split('#')[0]} (${dest})`); return; }
    log.log(await activateCore(dest, profileId, selected, { disableOmo, onActivationMutation, validateInstalled: () => validateInstalledProfile(dest, profileId, selected) }));
    return;
  }
  if (!['install', 'uninstall', 'setup'].includes(command)) fail(`unsupported command: ${command}`);
  const previous = await readState(dest);
  const active = await readActivation(dest);
  if (active?.phase === 'pending') fail('activation recovery is pending; run deactivate before install/update/uninstall');
  if (command === 'uninstall' && active) fail('deactivate first; uninstall will not remove assets during an active profile cutover');
  let profileId;
  if (command === 'uninstall') profileId = previous.profile || 'openai';
  else if (requestedProfile || providers) profileId = chooseProfile(catalog, { profile: requestedProfile, providers });
  else profileId = previous.profile || 'openai';
  if (command === 'setup' && !profileId) fail('non-interactive setup requires --profile or --providers; use the guided TTY setup to declare access');
  profileId ||= 'openai';
  const selected = catalog ? catalog.profiles[profileId] : null;
  if (!selected && command !== 'uninstall') fail(`unknown model profile: ${profileId}`);
  if (active && active.profile !== profileId) fail(`profile ${active.profile} is active; deactivate before switching profiles`);
  let assets = new Map();
  if (command !== 'uninstall') {
    const source = await sourceAssets(sourceDir, pluginDir);
    for (const [rel, bytes] of source) assets.set(rel, rel.startsWith('plugins/') ? bytes : renderProfileAsset(rel, bytes, profileId, catalog));
  }
  const actions = await checkManagedFiles(dest, previous, assets, command === 'uninstall' ? 'uninstall' : 'install');
  if (activate && selected) await preflightActivation(dest, profileId, selected, { disableOmo });
  if (mode !== 'apply') {
    outputActions(command === 'setup' ? `setup (${profileId})` : command, actions, dest);
    if (activate) log.log(`would activate ${profileId}${disableOmo ? ' and disable OMO registration' : ''}`);
    if (openaiQuota) await installAddon(dest, { log });
    if (codexQuota) log.log('would enable Codex quota (Codex may renew its saved credentials)');
    if (command === 'uninstall') await uninstallAddon(dest, { log });
    else if (selected?.provider === 'ocdb-deepseek') log.log('Next step: activate with `ocdb activate --apply` to register the Direct DeepSeek provider, or configure it yourself first; authenticate separately.');
    return;
  }
  await mkdir(dest, { recursive: true });
  const dstStat = await lstat(dest);
  if (dstStat.isSymbolicLink() || !dstStat.isDirectory()) fail('config destination must be a real directory, not a symlink');
  await ensureDirSafe(dest, LEDGER_DIR);
  const lock = path.join(dest, LOCK_FILE);
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('another vc-ocdb operation holds the lock'); throw error; }
  try {
    const lockedState = await readState(dest);
    const lockedActive = await readActivation(dest);
    if (command === 'uninstall' && lockedActive) fail('deactivate first; uninstall will not remove assets during an active profile cutover');
    if (lockedActive && lockedActive.profile !== profileId) fail(`profile ${lockedActive.profile} is active; deactivate before switching profiles`);
    const lockedActions = await checkManagedFiles(dest, lockedState, assets, command === 'uninstall' ? 'uninstall' : 'install');
    await applyPlan(dest, command === 'setup' ? 'install' : command, lockedState, assets, lockedActions, profileId, onMutation);
    log.log(`${command} applied (${lockedActions.length} asset changes; profile ${profileId})`);
  } finally {
    await handle.close();
    await rm(lock, { force: true });
  }
  if (activate && selected) {
    try { log.log(await activateCore(dest, profileId, selected, { disableOmo, onActivationMutation, validateInstalled: () => validateInstalledProfile(dest, profileId, selected) })); }
    catch (error) { throw new Error(`assets installed, but activation did not complete: ${error.message}`); }
  } else if (selected?.provider === 'ocdb-deepseek') log.log('Next step: run `ocdb activate --apply` to register the Direct DeepSeek provider, or configure it yourself first; authenticate separately.');
  if (command === 'uninstall') await uninstallAddon(dest, { mode, log });
  if (openaiQuota) await installAddon(dest, { mode, log });
  if (codexQuota && runQuota('enable') !== 0) fail('could not enable Codex quota');
}

async function guidedQuota(options) {
  const rl = createInterface({ input: stdin, output: stdout });
  const yes = async (question, fallback) => {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer ? answer === 'y' || answer === 'yes' : fallback;
  };
  try {
    if (!options.openaiQuota) options.openaiQuota = await yes('Show your ChatGPT/Codex weekly quota in the OpenCode sidebar? [Y/n] ', true);
    if (options.openaiQuota && !options.codexQuota) options.codexQuota = await yes('Read the quota through your Codex sign-in? Codex may renew its saved credentials. [y/N] ', false);
    if (options.codexQuota) options.codexLogin = await yes('Sign in to Codex now? (skip if already signed in) [y/N] ', false);
  } finally { rl.close(); }
}
async function guidedSelection(catalog) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const declared = [];
    for (const id of catalog.preferenceOrder) if (catalog.profiles[id]) {
      const answer = (await rl.question(`Do you have access to ${catalog.profiles[id].label}? [y/N] `)).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') declared.push(id);
    }
    if (!declared.length) fail('declare at least one provider subscription; no credentials or entitlement were inspected');
    if (declared.length === 1) return declared[0];
    const preferred = declared[0];
    const answer = (await rl.question(`Selected by preference order: ${preferred}. Enter another declared profile ID or press Enter: `)).trim();
    if (answer && !declared.includes(answer)) fail(`profile ${answer} was not declared available`);
    return answer || preferred;
  } finally { rl.close(); }
}
async function guidedCutover(options) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    if (!options.activate) {
      const answer = (await rl.question('Set OCDB as the OpenCode default and register its selected provider? [y/N] ')).trim().toLowerCase();
      options.activate = answer === 'y' || answer === 'yes';
    }
    if (options.activate && !options.disableOmo) {
      const answer = (await rl.question('Also disable oh-my-opencode-slim registrations in this config? [y/N] ')).trim().toLowerCase();
      options.disableOmo = answer === 'y' || answer === 'yes';
    }
  } finally { rl.close(); }
}
async function guidedChoice(catalog, ids) {
  const preferred = catalog.preferenceOrder.find((id) => ids.includes(id));
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`Declared choices: ${ids.join(', ')}. Select profile [${preferred}]: `)).trim();
    const selected = answer || preferred;
    if (!ids.includes(selected)) fail(`profile ${selected} was not declared in --providers`);
    return selected;
  } finally { rl.close(); }
}

export async function runCli(args) {
  if (args[0] === 'quota') {
    const [action, ...rest] = args.slice(1);
    if (!['enable', 'disable', 'login'].includes(action)) fail('usage: ocdb quota enable|disable|login [codex login options, e.g. --device-auth]');
    return runQuota(action, action === 'login' ? rest : []);
  }
  const options = parseArgs(args);
  if (options.command === 'help') {
    console.log('Usage: ocdb [setup|profiles|doctor|plan|install|uninstall|status|activate|deactivate] [--profile ID] [--providers ID,...] [--dry-run|--apply] [--activate] [--disable-omo] [--openai-quota [--codex-quota]] [--config-dir PATH]\n       ocdb quota enable|disable|login [--device-auth]');
    console.log('Mutations require --apply (TTY setup also asks for confirmation); --dry-run never writes.');
    return 0;
  }
  if (options.command === 'setup') {
    const check = prerequisiteReport();
    console.log(`Prerequisites: Node.js ${check.nodeVersion} ${check.nodeOk ? 'OK' : 'requires >=22'}; OpenCode ${check.opencodeOutput} ${check.opencodeV2 ? 'V2' : 'not V2'}.`);
    if (!check.nodeOk || !check.opencodeV2) fail('setup requires Node.js >=22 and OpenCode V2; no install or authentication was attempted');
    const catalog = await loadProfiles(MODELS_FILE);
    if (!options.profile && !options.providers) {
      if (!stdin.isTTY || !stdout.isTTY) fail('non-interactive setup requires --profile or --providers');
      options.profile = await guidedSelection(catalog);
    }
    if (options.providers?.some((id) => !catalog.profiles[id])) fail('providers contains an unsupported profile');
    if (!options.profile && options.providers && stdin.isTTY && stdout.isTTY) options.profile = await guidedChoice(catalog, options.providers);
    if (stdin.isTTY && stdout.isTTY) await guidedCutover(options);
    if (stdin.isTTY && stdout.isTTY && options.profile === 'openai') await guidedQuota(options);
    if (options.providers) options.profile = chooseProfile(catalog, { profile: options.profile, providers: options.providers });
    if (!options.profile) fail('setup requires an explicitly declared provider/profile');
    if (stdin.isTTY && stdout.isTTY) {
      await executeCommand('setup', { ...options, mode: 'dry-run' });
      if (args.includes('--dry-run')) return 0;
      const rl = createInterface({ input: stdin, output: stdout });
      let confirmed;
      try { confirmed = (await rl.question('Apply this setup? [y/N] ')).trim().toLowerCase(); } finally { rl.close(); }
      if (confirmed !== 'y' && confirmed !== 'yes') { console.log('No changes made.'); return 0; }
      options.mode = 'apply';
    }
  }
  await executeCommand(options.command, options);
  if (options.codexLogin && runQuota('login') !== 0) console.log('Codex sign-in did not complete; retry later with: ocdb quota login');
  return 0;
}
