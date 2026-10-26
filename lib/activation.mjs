// Activation: a reversible edit of the user's OpenCode config files. Every file is
// backed up first, and deactivation restores it byte for byte, unless the user
// has edited it since. The ledger lives in .vc-ocdb/activation.json.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode } from 'jsonc-parser';
import { LEDGER, atomicWrite, backup, fail, hash, inspectPath, readIfExists, withLock } from './fs-safe.mjs';
import { PROFILE_IDS } from './model-profiles.mjs';

const ACT_FILE = `${LEDGER}/activation.json`;
const CORE_NAMES = ['opencode.json', 'opencode.jsonc'];
// OMO-Slim also registers a TUI entrypoint; the cutover must remove it there too.
const TUI_NAMES = ['tui.json', 'tui.jsonc'];
// Hidden built-in agents that otherwise run on the expensive default model.
const HELPER_AGENTS = ['title', 'summary'];
const HASH_RE = /^[a-f0-9]{64}$/;

function parseConfig(text) {
  const errors = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length || tree?.type !== 'object') fail(`invalid OpenCode config JSONC: ${errors.map((e) => printParseErrorCode(e.error)).join(', ') || 'not an object'}`);
  // jsonc-parser keeps the last duplicate; an edit could then target the wrong one.
  (function checkKeys(node) {
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]?.value;
        if (seen.has(key)) fail(`duplicate JSONC key is ambiguous: ${key}`);
        seen.add(key);
        if (property.children?.[1]) checkKeys(property.children[1]);
      }
    } else if (node.type === 'array') node.children?.forEach(checkKeys);
  })(tree);
  return getNodeValue(tree);
}

const edit = (text, jsonPath, value) => applyEdits(text, modify(text, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }));
const withNewline = (text) => Buffer.from(text.endsWith('\n') ? text : `${text}\n`);
const canonical = (value) => JSON.stringify(value, (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

function isOmo(entry) {
  const ref = typeof entry === 'string' ? entry : entry?.package ?? entry?.name ?? entry?.id;
  return typeof ref === 'string' && /^oh-my-opencode-slim(?:@[^/]+)?$/.test(ref);
}

/** Removes OMO-Slim from native `plugins` and legacy `plugin`; drops a legacy key left empty. */
function withoutOmo(text) {
  const config = parseConfig(text);
  for (const key of ['plugins', 'plugin']) {
    const value = config[key];
    if (key === 'plugin' && (isOmo(value) || (Array.isArray(value) && value.length && value.every(isOmo)))) { text = edit(text, [key], undefined); continue; }
    if (Array.isArray(value)) for (let i = value.length - 1; i >= 0; i--) if (isOmo(value[i])) text = edit(text, [key, i], undefined);
  }
  return text;
}

/** The existing one of `names`, null if neither exists; refuses when both do. */
async function pickFile(dest, names) {
  const existing = [];
  for (const name of names) if (await inspectPath(dest, name)) existing.push(name);
  if (existing.length > 1) fail(`both ${names.join(' and ')} exist; refusing ambiguous activation`);
  return existing[0] ?? null;
}

/** The config edits activation would make: [{ file, old: Buffer|null, next: Buffer }]. */
async function planEdits(dest, profile, disableOmo) {
  const coreFile = await pickFile(dest, CORE_NAMES) ?? 'opencode.jsonc';
  const old = await readIfExists(dest, coreFile);
  let text = old?.toString('utf8') ?? '{}\n';
  const before = parseConfig(text);
  for (const key of ['providers', 'provider', 'agents']) {
    if (before[key] !== undefined && (!before[key] || typeof before[key] !== 'object' || Array.isArray(before[key]))) fail(`existing ${key} config must be an object`);
  }
  for (const [id, provider] of Object.entries(profile.providers ?? {})) {
    if (before.providers?.[id] && canonical(before.providers[id]) !== canonical(provider)) fail(`native provider ${id} already has a different configuration; refusing activation`);
    if (before.provider?.[id] && canonical(before.provider[id]) !== canonical(provider)) fail(`legacy provider ${id} conflicts with the selected native configuration; refusing activation`);
  }
  if (disableOmo) text = withoutOmo(text);
  text = edit(text, ['default_agent'], 'VC-Orchestrator');
  text = edit(text, ['model'], profile.lead.split('#')[0]);
  // Native `agents` merges with a legacy `agent` block; respect any model the user already chose.
  for (const id of HELPER_AGENTS) if (before.agents?.[id]?.model === undefined) text = edit(text, ['agents', id, 'model'], profile.helper);
  for (const [id, provider] of Object.entries(profile.providers ?? {})) text = edit(text, ['providers', id], provider);
  const edits = [{ file: coreFile, old, next: withNewline(text) }];

  const tuiFile = disableOmo ? await pickFile(dest, TUI_NAMES) : null;
  if (tuiFile) {
    const tuiOld = await readIfExists(dest, tuiFile);
    const tuiText = tuiOld.toString('utf8');
    const cleaned = withoutOmo(tuiText);
    if (cleaned !== tuiText) edits.push({ file: tuiFile, old: tuiOld, next: withNewline(cleaned) });
  }
  return edits;
}

export async function readActivation(dest) {
  const raw = await readIfExists(dest, ACT_FILE);
  if (!raw) return null;
  let state;
  try { state = JSON.parse(raw); } catch { fail('activation ledger is corrupt'); }
  if (state?.version === 1) {
    // Format before multi-file activation: core file plus an optional `tui` entry.
    state = {
      profile: state.profile,
      disableOmo: Boolean(state.disableOmo),
      files: [
        { file: state.coreFile, backup: state.backupPath, original: state.originalHash, activated: state.activatedHash },
        ...(state.tui ? [{ file: state.tui.file, backup: state.tui.backupPath, original: state.tui.originalHash, activated: state.tui.activatedHash }] : []),
      ],
    };
  }
  if (!PROFILE_IDS.has(state?.profile) || !Array.isArray(state.files) || !state.files.length) fail('activation ledger has an unsupported format');
  for (const entry of state.files) {
    if (![...CORE_NAMES, ...TUI_NAMES].includes(entry.file) || !HASH_RE.test(entry.activated)) fail('activation ledger has an unsupported format');
    if (entry.original === null && entry.backup === null) continue;
    if (!HASH_RE.test(entry.original) || typeof entry.backup !== 'string' || !entry.backup.startsWith(`${LEDGER}/backups/`) || entry.backup.split('/').includes('..')) fail('activation ledger contains an unsafe backup path');
    const saved = await readIfExists(dest, entry.backup);
    if (!saved || hash(saved) !== entry.original) fail(`activation backup for ${entry.file} is missing or does not match`);
  }
  return state;
}

/** Files to put back on deactivation: [{ file, current, original: Buffer|null }]. Refuses if any was edited since. */
async function restorePlan(dest, state) {
  await pickFile(dest, CORE_NAMES);
  await pickFile(dest, TUI_NAMES);
  const restores = [];
  for (const entry of state.files) {
    const current = await readIfExists(dest, entry.file);
    const currentHash = current ? hash(current) : null;
    if (currentHash === entry.original) continue; // never written, or already rolled back
    if (currentHash !== entry.activated) fail(`${entry.file} was edited after activation; refusing to overwrite user changes`);
    restores.push({ file: entry.file, current, original: entry.backup ? await readFile(path.join(dest, entry.backup)) : null });
  }
  return restores;
}

/** Validates without writing; throws what activation would throw. */
export async function previewActivation(dest, profileId, profile, { disableOmo = false } = {}) {
  const active = await readActivation(dest);
  if (!active) return planEdits(dest, profile, disableOmo);
  if (active.profile !== profileId) fail(`profile ${active.profile} is already active; deactivate before switching profiles`);
  if (active.disableOmo !== disableOmo) fail('activation options changed; deactivate before applying a different cutover');
  await restorePlan(dest, active);
  return [];
}

export async function activate(dest, profileId, profile, { disableOmo = false, validateInstalled, onActivationMutation } = {}) {
  return withLock(dest, async () => {
    await validateInstalled();
    if (await readActivation(dest)) { await previewActivation(dest, profileId, profile, { disableOmo }); return 'already active'; }
    const edits = await planEdits(dest, profile, disableOmo);
    const files = [];
    for (const { file, old, next } of edits) files.push({ file, backup: old ? await backup(dest, `activation/${file}`, old) : null, original: old ? hash(old) : null, activated: hash(next) });
    // The ledger goes first, so a crash part-way leaves enough to recover with deactivate.
    await atomicWrite(path.join(dest, ACT_FILE), Buffer.from(`${JSON.stringify({ version: 2, profile: profileId, disableOmo, files }, null, 2)}\n`));
    try {
      for (const { file, next } of edits) await atomicWrite(path.join(dest, file), next);
      await onActivationMutation?.();
    } catch (error) {
      try {
        for (const { file, old } of edits) {
          if (old) await atomicWrite(path.join(dest, file), old);
          else await rm(path.join(dest, file), { force: true });
        }
        await rm(path.join(dest, ACT_FILE));
      } catch (rollbackError) {
        throw new Error(`activation failed and could not be rolled back (${rollbackError.message}); fix the file, then run deactivate to recover: ${error.message}`);
      }
      throw new Error(`activation failed; config restored: ${error.message}`);
    }
    return 'activated';
  });
}

export async function previewDeactivation(dest) {
  const state = await readActivation(dest);
  if (!state) fail('no OCDB activation is recorded');
  return { state, restores: await restorePlan(dest, state) };
}

export async function deactivate(dest) {
  return withLock(dest, async () => {
    const { restores } = await previewDeactivation(dest);
    for (const { file, current, original } of restores) {
      await backup(dest, `before-deactivate/${file}`, current);
      if (original) await atomicWrite(path.join(dest, file), original);
      else await rm(path.join(dest, file));
    }
    await rm(path.join(dest, ACT_FILE));
    return 'deactivated';
  });
}
