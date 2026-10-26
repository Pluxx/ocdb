import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, getNodeValue, modify, parse, parseTree, printParseErrorCode } from 'jsonc-parser';

const LEDGER = '.vc-ocdb';
const ACT_FILE = `${LEDGER}/activation.json`;
const LOCK_FILE = `${LEDGER}/lock`;
const CORE_NAMES = new Set(['opencode.json', 'opencode.jsonc']);
// OMO-Slim also registers a TUI entrypoint; the cutover must remove it there too.
const TUI_NAMES = ['tui.json', 'tui.jsonc'];
const HASH_RE = /^[a-f0-9]{64}$/;
// Hidden built-in agents that otherwise run on the expensive default model.
const HELPER_AGENTS = ['title', 'summary'];
const PROFILE_IDS = new Set(['openai', 'opencode-go', 'opencode-zen', 'deepseek']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };

async function statOrNull(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function inspectLedgerPath(dest, relative) {
  const rootStat = await statOrNull(dest);
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) fail('config destination must be a real directory, not a symlink');
  let cursor = dest;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    const st = await statOrNull(cursor);
    if (!st) return null;
    if (st.isSymbolicLink()) fail(`symlink in activation path: ${relative}`);
    if (cursor !== path.join(dest, relative) && !st.isDirectory()) fail(`invalid activation path component: ${relative}`);
  }
  return await statOrNull(cursor);
}
function isOmo(value) {
  const ref = typeof value === 'string' ? value : value && typeof value === 'object' ? (value.package ?? value.name ?? value.id) : '';
  return typeof ref === 'string' && /^oh-my-opencode-slim(?:@[^/]+)?$/.test(ref);
}
function parseConfig(text) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid OpenCode config JSONC: ${errors.map((e) => printParseErrorCode(e.error)).join(', ')}`);
  const treeErrors = [];
  const tree = parseTree(text, treeErrors, { allowTrailingComma: true, disallowComments: false });
  if (treeErrors.length || !tree) fail(`invalid OpenCode config JSONC: ${treeErrors.map((e) => printParseErrorCode(e.error)).join(', ')}`);
  const checkKeys = (node) => {
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children || []) {
        const key = property.children?.[0]?.value;
        if (seen.has(key)) fail(`duplicate JSONC key is ambiguous: ${key}`);
        seen.add(key);
        if (property.children?.[1]) checkKeys(property.children[1]);
      }
    } else if (node.type === 'array') for (const child of node.children || []) checkKeys(child);
  };
  checkKeys(tree);
  return getNodeValue(tree);
}
function edit(text, jsonPath, value) {
  return applyEdits(text, modify(text, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
}
function removeOmoRegistrations(text, config) {
  for (const key of ['plugins']) {
    const registrations = config[key];
    if (Array.isArray(registrations)) {
      for (let index = registrations.length - 1; index >= 0; index--) if (isOmo(registrations[index])) {
        text = edit(text, [key, index], undefined);
        config[key].splice(index, 1);
      }
    }
  }
  const legacy = config.plugin;
  if (Array.isArray(legacy)) {
    for (let index = legacy.length - 1; index >= 0; index--) if (isOmo(legacy[index])) {
      text = edit(text, ['plugin', index], undefined);
      config.plugin.splice(index, 1);
    }
    if (!config.plugin.length) { text = edit(text, ['plugin'], undefined); delete config.plugin; }
  } else if (isOmo(legacy)) { text = edit(text, ['plugin'], undefined); delete config.plugin; }
  return text;
}
function noVariant(model) { return model.split('#')[0]; }
function jsonText(text) { parseConfig(text); return text.endsWith('\n') ? text : `${text}\n`; }
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function safeCore(dest) {
  const destStat = await statOrNull(dest);
  if (destStat && (destStat.isSymbolicLink() || !destStat.isDirectory())) fail('config destination must be a real directory, not a symlink');
  const existing = [];
  for (const name of CORE_NAMES) {
    const st = await statOrNull(path.join(dest, name));
    if (st) {
      if (st.isSymbolicLink() || !st.isFile()) fail(`OpenCode core config must be a regular file: ${name}`);
      existing.push(name);
    }
  }
  if (existing.length > 1) fail('both opencode.json and opencode.jsonc exist; refusing ambiguous activation');
  return existing[0] || 'opencode.jsonc';
}
async function preflightTui(dest) {
  const existing = [];
  for (const name of TUI_NAMES) {
    const st = await statOrNull(path.join(dest, name));
    if (st) {
      if (st.isSymbolicLink() || !st.isFile()) fail(`OpenCode TUI config must be a regular file: ${name}`);
      existing.push(name);
    }
  }
  if (existing.length > 1) fail('both tui.json and tui.jsonc exist; refusing ambiguous OMO cutover');
  if (!existing.length) return null;
  const old = await readFile(path.join(dest, existing[0]));
  const text = old.toString('utf8');
  const removed = removeOmoRegistrations(text, parseConfig(text));
  return removed === text ? null : { file: existing[0], old, rendered: Buffer.from(jsonText(removed)) };
}
// Returns the TUI bytes to restore on deactivation, or null when nothing needs restoring.
async function tuiRestorePlan(dest, state) {
  if (!state.tui) return null;
  const file = path.join(dest, state.tui.file);
  const st = await statOrNull(file);
  if (!st || st.isSymbolicLink() || !st.isFile()) fail(`${state.tui.file} is missing or unsafe after activation; refusing to restore it`);
  const currentHash = hash(await readFile(file));
  if (currentHash === state.tui.originalHash) return null;
  if (currentHash !== state.tui.activatedHash) fail(`${state.tui.file} was edited after activation; refusing to overwrite user changes`);
  return { file, original: await readFile(path.join(dest, state.tui.backupPath)) };
}
async function readActivation(dest) {
  const st = await inspectLedgerPath(dest, ACT_FILE);
  if (!st) return null;
  if (st.isSymbolicLink() || !st.isFile()) fail('activation ledger is not a regular file');
  let state;
  try { state = JSON.parse(await readFile(path.join(dest, ACT_FILE), 'utf8')); } catch { fail('activation ledger is corrupt'); }
  if (!state || state.version !== 1 || !CORE_NAMES.has(state.coreFile) || !PROFILE_IDS.has(state.profile) || typeof state.activatedHash !== 'string' || !/^[a-f0-9]{64}$/.test(state.activatedHash) || typeof state.originalExists !== 'boolean' || (state.disableOmo !== undefined && typeof state.disableOmo !== 'boolean') || (state.phase !== undefined && !['pending', 'active'].includes(state.phase))) fail('activation ledger has an unsupported format');
  if (state.originalExists) {
    if (typeof state.backupPath !== 'string' || !/^\.vc-ocdb\/backups\/activation\/[A-Za-z0-9-]+\/original\.(?:json|jsonc)$/.test(state.backupPath) || !/^[a-f0-9]{64}$/.test(state.originalHash)) fail('activation ledger contains an unsafe backup path');
    const fileStat = await inspectLedgerPath(dest, state.backupPath);
    if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile()) fail('activation recovery backup is missing or unsafe');
    if (hash(await readFile(path.join(dest, state.backupPath))) !== state.originalHash) fail('activation recovery backup hash does not match');
  } else if (state.backupPath !== null || state.originalHash !== null) fail('activation ledger has invalid original-file metadata');
  if (state.tui !== undefined) {
    const tui = state.tui;
    if (!tui || !TUI_NAMES.includes(tui.file) || typeof tui.backupPath !== 'string' || !/^\.vc-ocdb\/backups\/activation\/[A-Za-z0-9-]+\/tui\.(?:json|jsonc)$/.test(tui.backupPath) || !HASH_RE.test(tui.originalHash) || !HASH_RE.test(tui.activatedHash)) fail('activation ledger has invalid TUI metadata');
    const fileStat = await inspectLedgerPath(dest, tui.backupPath);
    if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isFile() || hash(await readFile(path.join(dest, tui.backupPath))) !== tui.originalHash) fail('activation TUI backup is missing or does not match');
  }
  return state;
}
async function atomicWrite(file, bytes) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
}
async function ensurePrivateDirs(dest, relative) {
  let cursor = dest;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    const st = await statOrNull(cursor);
    if (st) {
      if (st.isSymbolicLink() || !st.isDirectory()) fail(`unsafe activation directory: ${path.relative(dest, cursor)}`);
    } else await mkdir(cursor, { mode: 0o700 });
  }
}
async function backupBytes(dest, bytes, filename) {
  const dir = `${LEDGER}/backups/activation/${Date.now()}-${randomUUID()}`;
  await ensurePrivateDirs(dest, dir);
  const rel = `${dir}/${filename}`;
  await atomicWrite(path.join(dest, rel), bytes);
  return { path: rel, hash: hash(bytes) };
}
async function withLock(dest, callback) {
  await mkdir(dest, { recursive: true });
  const dst = await lstat(dest);
  if (dst.isSymbolicLink() || !dst.isDirectory()) fail('config destination must be a real directory, not a symlink');
  await ensurePrivateDirs(dest, LEDGER);
  const handle = await open(path.join(dest, LOCK_FILE), 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') fail('another vc-ocdb operation holds the lock');
    throw error;
  });
  try { return await callback(); }
  finally { await handle.close(); await rm(path.join(dest, LOCK_FILE), { force: true }); }
}

export async function preflightActivation(dest, profileId, profile, { disableOmo = false } = {}) {
  const active = await readActivation(dest);
  if (active) {
    if (active.phase === 'pending') fail('activation recovery is pending; run deactivate to recover before activating');
    if (active.profile !== profileId) fail(`profile ${active.profile} is already active; deactivate before switching profiles`);
    if (Boolean(active.disableOmo) !== Boolean(disableOmo)) fail('activation options changed; deactivate before applying a different cutover');
    const activeFile = path.join(dest, active.coreFile);
    const activeStat = await statOrNull(activeFile);
    if (!activeStat || activeStat.isSymbolicLink() || !activeStat.isFile() || hash(await readFile(activeFile)) !== active.activatedHash) fail('core config was edited after activation; refusing to continue');
  }
  const coreFile = await safeCore(dest);
  const currentPath = path.join(dest, coreFile);
  const old = await statOrNull(currentPath) ? await readFile(currentPath) : null;
  const before = old ? parseConfig(old.toString('utf8')) : {};
  let text = old ? old.toString('utf8') : '{}\n';
  const providers = profile.providers || {};
  if (before.providers !== undefined && (!before.providers || typeof before.providers !== 'object' || Array.isArray(before.providers))) fail('existing native providers config must be an object');
  if (before.provider !== undefined && (!before.provider || typeof before.provider !== 'object' || Array.isArray(before.provider))) fail('existing legacy provider config must be an object');
  if (before.agents !== undefined && (!before.agents || typeof before.agents !== 'object' || Array.isArray(before.agents))) fail('existing native agents config must be an object');
  const nativeProviders = before.providers || {};
  const legacyProviders = before.provider || {};
  for (const [id, provider] of Object.entries(providers)) {
    if (Object.hasOwn(nativeProviders, id) && canonical(nativeProviders[id]) !== canonical(provider)) fail(`native provider ${id} already has a different configuration; refusing activation`);
    if (Object.hasOwn(legacyProviders, id) && canonical(legacyProviders[id]) !== canonical(provider)) fail(`legacy provider ${id} conflicts with the selected native configuration; refusing activation`);
  }
  if (disableOmo) text = removeOmoRegistrations(text, before);
  text = edit(text, ['default_agent'], 'VC-Orchestrator');
  text = edit(text, ['model'], noVariant(profile.lead));
  // Native `agents` merges with a legacy `agent` block; respect any model the user already chose.
  for (const id of HELPER_AGENTS) if (before.agents?.[id]?.model === undefined) text = edit(text, ['agents', id, 'model'], profile.helper);
  for (const [id, provider] of Object.entries(providers)) text = edit(text, ['providers', id], provider);
  const rendered = jsonText(text);
  const tui = disableOmo ? await preflightTui(dest) : null;
  return { coreFile, old, rendered: Buffer.from(rendered), tui, profileId, disableOmo };
}

export async function activate(dest, profileId, profile, options = {}) {
  return withLock(dest, async () => {
    if (typeof options.validateInstalled !== 'function') fail('activation requires locked installed-profile validation');
    await options.validateInstalled();
    const state = await readActivation(dest);
    if (state) {
      if (state.phase === 'pending') fail('activation recovery is pending; run deactivate to recover before activating');
      if (state.profile !== profileId) fail(`profile ${state.profile} is already active; deactivate before switching profiles`);
      await preflightDeactivation(dest);
      if (Boolean(state.disableOmo) !== Boolean(options.disableOmo)) fail('activation options changed; deactivate before applying a different cutover');
      return 'already active';
    }
    const activation = await preflightActivation(dest, profileId, profile, options);
    const original = activation.old;
    const backup = original ? await backupBytes(dest, original, `original.${activation.coreFile.endsWith('.jsonc') ? 'jsonc' : 'json'}`) : null;
    const tui = activation.tui;
    const tuiBackup = tui ? await backupBytes(dest, tui.old, `tui.${tui.file.endsWith('.jsonc') ? 'jsonc' : 'json'}`) : null;
    const tuiPath = tui ? path.join(dest, tui.file) : null;
    const nextState = {
      version: 1,
      phase: 'pending',
      coreFile: activation.coreFile,
      profile: profileId,
      disableOmo: Boolean(options.disableOmo),
      originalExists: Boolean(original),
      backupPath: backup?.path ?? null,
      originalHash: backup?.hash ?? null,
      activatedHash: hash(activation.rendered),
      ...(tui ? { tui: { file: tui.file, backupPath: tuiBackup.path, originalHash: tuiBackup.hash, activatedHash: hash(tui.rendered) } } : {}),
    };
    const corePath = path.join(dest, activation.coreFile);
    // Establish an authoritative baseline before any core-config mutation.
    await atomicWrite(path.join(dest, ACT_FILE), Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`));
    try {
      await atomicWrite(corePath, activation.rendered);
      if (tui) await atomicWrite(tuiPath, tui.rendered);
      await options.onActivationMutation?.();
      nextState.phase = 'active';
      await atomicWrite(path.join(dest, ACT_FILE), Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`));
    }
    catch (error) {
      let rollbackError;
      let rollbackVerified = false;
      try {
        if (tui) {
          await atomicWrite(tuiPath, tui.old);
          if (hash(await readFile(tuiPath)) !== tuiBackup.hash) throw new Error('restored TUI bytes did not match the original baseline');
        }
        if (original) await atomicWrite(corePath, original);
        else await rm(corePath, { force: true });
        const currentStat = await statOrNull(corePath);
        rollbackVerified = original ? Boolean(currentStat && hash(await readFile(corePath)) === backup.hash) : !currentStat;
        if (!rollbackVerified) throw new Error('restored bytes did not match the original baseline');
      } catch (failure) { rollbackError = failure; }
      if (rollbackVerified) await rm(path.join(dest, ACT_FILE), { force: true }).catch((failure) => { rollbackError = failure; rollbackVerified = false; });
      throw new Error(`activation commit failed${rollbackVerified ? '; config rollback succeeded and pending record cleared' : `; recovery required${rollbackError ? `: ${rollbackError.message}` : ''}; pending record and original backup retained`}: ${error.message}`);
    }
    return 'activated';
  });
}

export async function deactivate(dest) {
  return withLock(dest, async () => {
    const state = await readActivation(dest);
    if (!state) fail('no OCDB activation is recorded');
    const selectedCore = await safeCore(dest);
    if (selectedCore !== state.coreFile) fail('core config selection changed or became ambiguous; refusing deactivation');
    const corePath = path.join(dest, state.coreFile);
    const currentStat = await statOrNull(corePath);
    if (currentStat && (currentStat.isSymbolicLink() || !currentStat.isFile())) fail('active core config is unsafe');
    const current = currentStat ? await readFile(corePath) : null;
    const currentHash = current ? hash(current) : null;
    if (state.phase === 'pending') {
      const isOriginal = state.originalExists ? currentHash === state.originalHash : currentHash === null;
      if (isOriginal) { await rm(path.join(dest, ACT_FILE)); return 'pending activation already rolled back; recovery record cleared'; }
      if (currentHash !== state.activatedHash) fail('pending activation core config differs from both original and activated bytes; refusing recovery');
    } else if (!current || currentHash !== state.activatedHash) fail('core config was edited after activation; refusing to overwrite user changes');
    const tuiRestore = await tuiRestorePlan(dest, state);
    const original = state.originalExists ? await readFile(path.join(dest, state.backupPath)) : null;
    // Preserve the active bytes as a recovery archive before restoring/removing.
    if (current) await backupBytes(dest, current, `before-deactivate.${state.coreFile.endsWith('.jsonc') ? 'jsonc' : 'json'}`);
    if (original) await atomicWrite(corePath, original);
    else if (currentStat) await rm(corePath);
    if (tuiRestore) await atomicWrite(tuiRestore.file, tuiRestore.original);
    try { await rm(path.join(dest, ACT_FILE)); }
    catch (error) {
      if (original) await atomicWrite(corePath, current).catch(() => {});
      else await atomicWrite(corePath, current).catch(() => {});
      throw new Error(`activation ledger removal failed; config rollback attempted: ${error.message}`);
    }
    return 'deactivated';
  });
}

export async function preflightDeactivation(dest) {
  const state = await readActivation(dest);
  if (!state) fail('no OCDB activation is recorded');
  const selectedCore = await safeCore(dest);
  if (selectedCore !== state.coreFile) fail('core config selection changed or became ambiguous; refusing deactivation');
  const file = path.join(dest, state.coreFile);
  const st = await statOrNull(file);
  if (st && (st.isSymbolicLink() || !st.isFile())) fail('active core config is missing or unsafe');
  const currentHash = st ? hash(await readFile(file)) : null;
  if (state.phase === 'pending') {
    if (currentHash !== state.activatedHash && !(state.originalExists ? currentHash === state.originalHash : currentHash === null)) fail('pending activation core config differs from both original and activated bytes; refusing recovery');
  } else if (!st || currentHash !== state.activatedHash) fail('core config was edited after activation; refusing to overwrite user changes');
  await tuiRestorePlan(dest, state);
  return state;
}

export { readActivation, safeCore };
