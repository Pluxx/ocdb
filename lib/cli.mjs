import { readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { activate as activateConfig, deactivate as deactivateConfig, previewActivation, previewDeactivation, readActivation } from './activation.mjs';
import { LEDGER, atomicWrite, backup, ensureDir, fail, hash, inspectPath, readIfExists, withLock } from './fs-safe.mjs';
import { PLUGIN_CATALOG, PROFILE_IDS, chooseProfile, deriveSolverMax, loadProfiles, normalizeProfileId, renderProfileAsset } from './model-profiles.mjs';
import { addonState, installAddon, runQuota, uninstallAddon } from './openai-weekly.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(ROOT, 'profiles', 'web');
const MODELS_FILE = path.join(ROOT, 'profiles', 'models.json');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'ocdb-hw');
const STATE_FILE = `${LEDGER}/state.json`;
const HASH_RE = /^[a-f0-9]{64}$/;

export const AGENTS = new Set(['VC-Orchestrator', 'VC-Symfony', 'VC-DDEV', 'VC-Design', 'VC-Frontend', 'VC-Reviewer', 'VC-Tester', 'VC-Solver', 'VC-Solver-Max', 'VC-Explorer', 'VC-Librarian']);
export const SKILLS = new Set(['vc-symfony', 'vc-ddev', 'vc-web-design', 'vc-tailwind', 'vc-solving', 'vc-TYPO3', 'vc-TYPO3-upgrade']);
export const COMMANDS = new Set(['vc-web', 'vc-plan', 'vc-check', 'vc-solve', 'vc-solve-max', 'vc-t3u']);
const PLUGIN_FILES = ['package.json', 'index.ts', 'tui.tsx', 'rpc.ts', 'profiles.mjs', 'metrics.mjs', 'activity.mjs', 'catalog.json'];
// Installed files built from other sources rather than copied: rel -> (source asset bytes) -> bytes.
const DERIVED_ASSETS = {
  'agents/VC-Solver-Max.md': (assets) => deriveSolverMax(assets.get('agents/VC-Solver.md')),
  [PLUGIN_CATALOG]: () => Buffer.from('{}\n'), // filled in per profile by renderProfileAsset
};
const EXPECTED_ASSETS = new Set([
  ...[...AGENTS].map((id) => `agents/${id}.md`),
  ...[...SKILLS].map((id) => `skills/${id}/SKILL.md`),
  ...[...COMMANDS].map((id) => `commands/${id}.md`),
  ...PLUGIN_FILES.map((file) => `plugins/ocdb-hw/${file}`),
]);
// Paths earlier versions installed; an update removes them if they are unmodified.
const RETIRED_ASSETS = new Set([
  'agents/vc-web.md',
  ...['explorer', 'design', 'frontend', 'symfony', 'ddev', 'reviewer', 'tester', 'solver'].map((id) => `agents/vc-${id}.md`),
  'skills/vc-typo3/SKILL.md',
  'skills/vc-typo3-upgrade/SKILL.md',
]);

// ---- Arguments

const BOOLEAN_FLAGS = { '--activate': 'activate', '--openai-quota': 'openaiQuota', '--codex-quota': 'codexQuota' };
const VALUE_FLAGS = { '--config-dir': 'configDir', '--profile': 'profile', '--providers': 'providers' };
const SETUP_OPTIONS = ['mode', 'configDir', 'profile', 'providers', 'activate', 'openaiQuota', 'codexQuota'];
const ALLOWED_OPTIONS = {
  plan: [], profiles: [], doctor: [], status: ['configDir'],
  setup: SETUP_OPTIONS, install: SETUP_OPTIONS,
  uninstall: ['mode', 'configDir'], deactivate: ['mode', 'configDir'],
  activate: ['mode', 'configDir', 'profile'],
};
const FLAG_OF = { mode: '--apply/--dry-run', ...Object.fromEntries(Object.entries({ ...BOOLEAN_FLAGS, ...VALUE_FLAGS }).map(([flag, key]) => [key, flag])) };

export function parseArgs(args) {
  const result = { command: 'plan', mode: 'dry-run', configDir: null, profile: null, providers: null, activate: false, openaiQuota: false, codexQuota: false };
  const given = new Set();
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') return { ...result, command: 'help' };
    const key = arg === '--apply' || arg === '--dry-run' ? 'mode' : BOOLEAN_FLAGS[arg] ?? VALUE_FLAGS[arg];
    if (!key) {
      if (arg.startsWith('-')) fail(`unknown option: ${arg}`);
      positional.push(arg);
      continue;
    }
    if (given.has(key)) fail(`${FLAG_OF[key]} may be given only once`);
    given.add(key);
    if (key === 'mode') result.mode = arg === '--apply' ? 'apply' : 'dry-run';
    else if (VALUE_FLAGS[arg]) {
      const value = args[++i];
      if (!value || value.startsWith('-')) fail(`${arg} requires a value`);
      result[key] = key === 'providers' ? value.split(',').filter(Boolean) : value;
    } else result[key] = true;
  }
  if (positional.length > 1) fail('unexpected extra arguments');
  if (positional.length) result.command = positional[0];
  const allowed = ALLOWED_OPTIONS[result.command];
  if (!allowed) fail(`unknown command: ${result.command}`);
  for (const key of given) if (!allowed.includes(key)) fail(`${result.command} does not accept ${FLAG_OF[key]}`);
  if (result.providers && (!result.providers.length || new Set(result.providers).size !== result.providers.length)) fail('--providers requires a comma-separated list of unique provider IDs');
  if (result.codexQuota && !result.openaiQuota) fail('--codex-quota requires --openai-quota');
  return result;
}

// ---- Managed assets

function defaultConfigDir() {
  return path.resolve(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
}

function prerequisites() {
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 22;
  const opencode = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: 1500 });
  const output = opencode.error ? 'not found' : `${opencode.stdout || opencode.stderr}`.trim();
  const major = Number(output.match(/(?:^|\s)v?(\d+)\.\d+\.\d+/)?.[1]);
  return { node: process.versions.node, nodeOk, opencode: output, opencodeOk: opencode.status === 0 && major >= 2 };
}

async function sourceAssets(sourceDir, pluginDir) {
  const assets = new Map();
  const missing = [];
  for (const rel of EXPECTED_ASSETS) {
    if (DERIVED_ASSETS[rel]) continue;
    const file = rel.startsWith('plugins/ocdb-hw/') ? path.join(pluginDir, path.basename(rel)) : path.join(sourceDir, rel);
    try { assets.set(rel, await readFile(file)); } catch (error) {
      if (!['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw error;
      missing.push(rel);
    }
  }
  if (missing.length) fail(`profile source inventory is incomplete (missing: ${missing.join(', ')})`);
  for (const [rel, derive] of Object.entries(DERIVED_ASSETS)) assets.set(rel, derive(assets));
  return assets;
}

async function readState(dest) {
  const raw = await readIfExists(dest, STATE_FILE);
  if (!raw) return { version: 1, profile: 'oai-hq', assets: {} };
  let state;
  try { state = JSON.parse(raw); } catch { fail('state ledger is corrupt or unreadable'); }
  if (state?.version !== 1 || !state.assets || typeof state.assets !== 'object' || Array.isArray(state.assets)) fail('state ledger has an unsupported or malformed format');
  state.profile = normalizeProfileId(state.profile ?? 'oai-hq');
  if (!PROFILE_IDS.has(state.profile)) fail('state ledger contains an unsupported model profile');
  for (const [rel, digest] of Object.entries(state.assets)) {
    if (!EXPECTED_ASSETS.has(rel) && !RETIRED_ASSETS.has(rel)) fail(`unsafe managed path: ${rel}`);
    if (!HASH_RE.test(digest)) fail(`invalid digest in state ledger for ${rel}`);
  }
  return state;
}

/**
 * Refuses unless every recorded file still has its recorded hash, or is byte for byte one of the
 * renders in `ownRenders` (Maps of rel -> bytes): content OCDB itself writes is not a user edit,
 * even when the ledger's hash for it went stale.
 */
async function verifyOwned(dest, assets, { missing, modified }, ownRenders = []) {
  for (const [rel, digest] of Object.entries(assets)) {
    const bytes = await readIfExists(dest, rel).catch(() => null);
    if (!bytes) fail(`${missing}: ${rel}`);
    if (hash(bytes) !== digest && !ownRenders.some((render) => render?.get(rel)?.equals(bytes))) fail(`${modified}: ${rel}`);
  }
}

/** Every asset as rendered for `profileId`. */
async function renderAssets(sourceDir, pluginDir, profileId, catalog) {
  const rendered = new Map();
  for (const [rel, bytes] of await sourceAssets(sourceDir, pluginDir)) rendered.set(rel, renderProfileAsset(rel, bytes, profileId, catalog));
  return rendered;
}

/**
 * add/update/remove actions for an install (`desired` = rendered assets) or uninstall (`desired` = null).
 * `recorded` is the render for the profile the ledger records, so stale hashes on untouched files pass.
 */
async function planActions(dest, state, desired, recorded) {
  await verifyOwned(dest, state.assets, { missing: 'owned file is missing', modified: 'owned file was locally modified; refusing changes' }, [desired, recorded]);
  if (!desired) return Object.keys(state.assets).map((rel) => ({ type: 'remove', rel }));
  const actions = [];
  for (const [rel, bytes] of desired) {
    const prior = state.assets[rel];
    if (!prior && await inspectPath(dest, rel)) fail(`unowned destination collision: ${rel}`);
    if (!prior) actions.push({ type: 'add', rel });
    else if (hash(bytes) !== prior) actions.push({ type: 'update', rel });
  }
  // readState only admits current or retired paths, so anything not desired is retired.
  for (const rel of Object.keys(state.assets)) if (!desired.has(rel)) actions.push({ type: 'remove', rel });
  return actions;
}

/** Applies actions with a journal; any failure restores every touched file. Replaced files are also backed up for good. */
async function applyPlan(dest, desired, actions, profileId, onMutation = async () => {}) {
  const journal = [];
  const createdDirs = [];
  const emptiedSkillDirs = new Set();
  const write = async (file, bytes) => {
    journal.push({ file, before: await readFile(file).catch((error) => { if (error.code === 'ENOENT') return null; throw error; }) });
    await atomicWrite(file, bytes);
  };
  try {
    await ensureDir(dest, LEDGER, createdDirs);
    for (const action of actions) {
      const file = path.join(dest, action.rel);
      await ensureDir(dest, path.posix.dirname(action.rel), createdDirs);
      if (action.type === 'add') await write(file, desired.get(action.rel));
      else {
        const previous = await readFile(file);
        await backup(dest, action.rel, previous);
        if (action.type === 'update') await write(file, desired.get(action.rel));
        else {
          journal.push({ file, before: previous });
          await rm(file);
          if (action.rel.startsWith('skills/')) emptiedSkillDirs.add(path.dirname(file));
        }
      }
      await onMutation(action);
    }
    const assets = desired ? Object.fromEntries([...desired].map(([rel, bytes]) => [rel, hash(bytes)])) : {};
    await write(path.join(dest, STATE_FILE), Buffer.from(`${JSON.stringify({ version: 1, ...(desired && { profile: profileId }), assets }, null, 2)}\n`));
    // Only once committed, so a rollback could still restore removed files; rmdir skips non-empty dirs.
    for (const dir of emptiedSkillDirs) await rmdir(dir).catch(() => {});
  } catch (error) {
    const failures = [];
    for (const { file, before } of journal.reverse()) {
      try { if (before === null) await rm(file, { force: true }); else await atomicWrite(file, before); }
      catch (rollbackError) { failures.push(`${file}: ${rollbackError.message}`); }
    }
    for (const dir of createdDirs.reverse()) await rmdir(dir).catch(() => {});
    if (failures.length) fail(`${error.message}; rollback incomplete: ${failures.join('; ')}`);
    throw error;
  }
}

/** Activation only proceeds on a complete, unmodified install of the selected profile. */
async function validateInstalled(dest, profileId, profile) {
  const state = await readState(dest);
  if (state.profile !== profileId) fail(`installed profile is ${state.profile}; refusing activation for ${profileId}`);
  const installed = Object.keys(state.assets);
  if (installed.length !== EXPECTED_ASSETS.size || installed.some((rel) => !EXPECTED_ASSETS.has(rel))) fail('installed profile inventory is incomplete; refusing activation');
  await verifyOwned(dest, state.assets, { missing: 'installed profile asset is missing or unsafe', modified: 'installed profile asset was modified' });
  let routed;
  try { routed = JSON.parse(await readFile(path.join(dest, PLUGIN_CATALOG), 'utf8')); } catch { routed = null; }
  if (routed?.installed !== profileId || routed.profiles?.[profileId]?.lead !== profile.lead) fail('installed model routing does not match the selected profile; reinstall before activation');
}

// ---- Commands

export async function executeCommand(command, options = {}) {
  const {
    configDir, sourceDir = WEB_ROOT, pluginDir = PLUGIN_ROOT, modelsFile = MODELS_FILE, mode = 'dry-run',
    profile: requestedProfile, providers, activate = false, openaiQuota = false, codexQuota = false,
    log = console, onMutation, onActivationMutation,
  } = options;
  const dest = path.resolve(configDir || defaultConfigDir());
  const apply = mode === 'apply';
  const catalog = ['install', 'setup', 'uninstall', 'plan', 'profiles', 'activate', 'deactivate'].includes(command) ? await loadProfiles(modelsFile) : null;

  if (command === 'profiles') {
    for (const id of catalog.preferenceOrder) {
      const p = catalog.profiles[id];
      log.log(`${id} (${p.label}, needs ${p.requires.join(' + ')}): ${p.description}`);
      log.log(`  lead ${p.lead}; implementation ${p.implementation}; design ${p.design}; explore ${p.explore}; tester ${p.tester}; review ${p.review}; helpers ${p.helper}; compaction ${p.compaction}; solver ${p.solver} (max ${p.solverMax})`);
    }
    return;
  }
  if (command === 'doctor') {
    const check = prerequisites();
    log.log(`Node.js: ${check.node} ${check.nodeOk ? '(supported)' : '(requires >=22)'}`);
    log.log(`OpenCode: ${check.opencode} ${check.opencodeOk ? '(V2)' : '(OpenCode V2 required)'}`);
    log.log('Next: ocdb setup. Sign in to providers in OpenCode itself (/connect); OCDB never handles credentials.');
    return;
  }
  if (command === 'plan') {
    for (const rel of (await sourceAssets(sourceDir, pluginDir)).keys()) log.log(`would install: ${rel}`);
    return;
  }
  if (command === 'status') {
    const state = await readState(dest);
    const active = await readActivation(dest);
    log.log(`managed assets: ${Object.keys(state.assets).length}; profile: ${state.profile}; activation: ${active ? `active ${active.profile} (${active.files.map((f) => f.file).join(', ')})` : 'inactive'}`);
    for (const rel of Object.keys(state.assets)) log.log(`managed: ${rel}`);
    log.log(`OpenAI weekly quota: ${await addonState(dest)}`);
    return;
  }
  if (command === 'deactivate') {
    const { restores } = await previewDeactivation(dest, catalog.profiles);
    if (!apply) { log.log(`deactivate preview: restore ${restores.map((r) => r.file).join(', ') || 'nothing (already original)'} in ${dest}`); return; }
    log.log(await deactivateConfig(dest, catalog.profiles));
    return;
  }
  if (command === 'activate') {
    const state = await readState(dest);
    if (!Object.keys(state.assets).length) fail('install the profile before activation');
    const profileId = normalizeProfileId(requestedProfile) || state.profile;
    if (profileId !== state.profile) fail(`selected profile is ${state.profile}; install it before activation`);
    const selected = catalog.profiles[profileId] ?? fail(`unknown model profile: ${profileId}`);
    await previewActivation(dest, profileId, selected);
    if (!apply) { log.log(`activation preview: default_agent VC-Orchestrator, model ${selected.lead.split('#')[0]} (${dest})`); return; }
    log.log(await activateConfig(dest, profileId, selected, { onActivationMutation, validateInstalled: () => validateInstalled(dest, profileId, selected) }));
    return;
  }
  if (!['install', 'setup', 'uninstall'].includes(command)) fail(`unsupported command: ${command}`);

  const uninstall = command === 'uninstall';
  if (command === 'setup' && !requestedProfile && !providers) fail('non-interactive setup requires --profile or --providers');
  const state = await readState(dest);
  const active = await readActivation(dest);
  if (uninstall && active) fail('deactivate first; uninstall will not remove assets during an active profile cutover');
  const profileId = uninstall ? state.profile : chooseProfile(catalog, { profile: requestedProfile, providers }) ?? state.profile;
  if (active && active.profile !== profileId) fail(`profile ${active.profile} is active; deactivate before switching profiles`);
  const selected = catalog?.profiles[profileId];
  const desired = uninstall ? null : await renderAssets(sourceDir, pluginDir, profileId, catalog);
  const recorded = Object.keys(state.assets).length ? await renderAssets(sourceDir, pluginDir, state.profile, catalog) : null;
  if (activate) await previewActivation(dest, profileId, selected);

  if (!apply) {
    const actions = await planActions(dest, state, desired, recorded);
    log.log(`${command === 'setup' ? `setup (${profileId})` : command} ${actions.length ? 'plan' : 'plan: no changes'} (${dest})`);
    for (const action of actions) log.log(`${action.type}: ${action.rel}`);
    if (activate) log.log(`would activate ${profileId}`);
    if (openaiQuota) await installAddon(dest, { log });
    if (codexQuota) log.log('would enable Codex quota (Codex may renew its saved credentials)');
    if (uninstall) await uninstallAddon(dest, { log });
    return;
  }

  await withLock(dest, async () => {
    if (uninstall && await readActivation(dest)) fail('deactivate first; uninstall will not remove assets during an active profile cutover');
    const actions = await planActions(dest, await readState(dest), desired, recorded);
    await applyPlan(dest, desired, actions, profileId, onMutation);
    log.log(`${command} applied (${actions.length} asset changes; profile ${profileId})`);
  });
  if (activate) {
    try { log.log(await activateConfig(dest, profileId, selected, { onActivationMutation, validateInstalled: () => validateInstalled(dest, profileId, selected) })); }
    catch (error) { throw new Error(`assets installed, but activation did not complete: ${error.message}`); }
  } else if (selected?.providers?.['ocdb-deepseek']) log.log('Next: run `ocdb activate --apply` to register the DeepSeek provider (or configure it yourself).');
  if (uninstall) await uninstallAddon(dest, { mode, log });
  if (openaiQuota) await installAddon(dest, { mode, log });
  if (codexQuota && runQuota('enable') !== 0) fail('could not enable Codex quota');
}

// ---- Interactive setup and entry point

async function ask(question, fallback = '') {
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim() || fallback; } finally { rl.close(); }
}
async function confirm(question, fallback = false) {
  const answer = (await ask(question)).toLowerCase();
  return answer ? answer === 'y' || answer === 'yes' : fallback;
}

async function guidedSetup(options, catalog) {
  if (!options.profile && !options.providers) {
    const declared = [];
    for (const [id, provider] of Object.entries(catalog.providers)) if (await confirm(`Do you have ${provider.label}? [y/N] `)) declared.push(id);
    if (!declared.length) fail('declare at least one provider you can use');
    options.providers = declared;
  }
  if (!options.profile) {
    const runnable = catalog.preferenceOrder.filter((id) => catalog.profiles[id].requires.every((p) => options.providers.includes(p)));
    if (!runnable.length) fail('no profile can run with the providers you have');
    for (const id of runnable) console.log(`  ${id.padEnd(13)} ${catalog.profiles[id].description}`);
    options.profile = await ask(`Choose a profile [${runnable[0]}]: `, runnable[0]);
  }
  options.activate ||= await confirm('Make OCDB the OpenCode default agent? [y/N] ');
  if (catalog.profiles[chooseProfile(catalog, options)].requires.includes('openai')) {
    options.openaiQuota ||= await confirm('Show your ChatGPT/Codex weekly quota in the OpenCode sidebar? [Y/n] ', true);
    if (options.openaiQuota) options.codexQuota ||= await confirm('Read the quota through your Codex sign-in? Codex may renew its saved credentials. [y/N] ');
    if (options.codexQuota) options.codexLogin = await confirm('Sign in to Codex now? (skip if already signed in) [y/N] ');
  }
}

export async function runCli(args) {
  if (args[0] === 'quota') {
    const [action, ...rest] = args.slice(1);
    if (!['enable', 'disable', 'login'].includes(action)) fail('usage: ocdb quota enable|disable|login [codex login options, e.g. --device-auth]');
    return runQuota(action, action === 'login' ? rest : []);
  }
  const options = parseArgs(args);
  if (options.command === 'help') {
    console.log('Usage: ocdb [setup|install|uninstall|activate|deactivate|status|profiles|doctor|plan] [--profile ID] [--providers ID,...] [--dry-run|--apply] [--activate] [--openai-quota [--codex-quota]] [--config-dir PATH]\n       ocdb quota enable|disable|login [--device-auth]');
    console.log('Changes are only written with --apply (interactive setup asks first).');
    return 0;
  }
  if (options.command === 'setup') {
    const check = prerequisites();
    console.log(`Prerequisites: Node.js ${check.node} ${check.nodeOk ? 'OK' : 'requires >=22'}; OpenCode ${check.opencode} ${check.opencodeOk ? 'V2' : 'not V2'}.`);
    if (!check.nodeOk || !check.opencodeOk) fail('setup requires Node.js >=22 and OpenCode V2');
    const tty = stdin.isTTY && stdout.isTTY;
    if (tty) {
      await guidedSetup(options, await loadProfiles(MODELS_FILE));
      await executeCommand('setup', { ...options, mode: 'dry-run' });
      if (args.includes('--dry-run')) return 0;
      if (!await confirm('Apply this setup? [y/N] ')) { console.log('No changes made.'); return 0; }
      options.mode = 'apply';
    }
  }
  await executeCommand(options.command, options);
  if (options.codexLogin && runQuota('login') !== 0) console.log('Codex sign-in did not complete; retry later with: ocdb quota login');
  return 0;
}
