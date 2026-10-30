// Activation: a reversible edit of the user's OpenCode config files. Every file is
// backed up first, and deactivation restores it byte for byte, unless the user
// has edited it since. The ledger lives in .vc-ocdb/activation.json.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode } from 'jsonc-parser';
import { LEDGER, atomicWrite, backup, fail, hash, inspectPath, readIfExists, withLock } from './fs-safe.mjs';
import { PROFILE_IDS, normalizeProfileId } from './model-profiles.mjs';

const ACT_FILE = `${LEDGER}/activation.json`;
const CORE_NAMES = ['opencode.json', 'opencode.jsonc'];
// Activation no longer edits the TUI config, but ledgers from earlier releases may record it.
const TUI_NAMES = ['tui.json', 'tui.jsonc'];
const HASH_RE = /^[a-f0-9]{64}$/;
// Hidden built-in agents whose model earlier releases wrote into the core config.
const LEGACY_HELPER_AGENTS = ['title', 'summary'];

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

/** The existing one of `names`, null if neither exists; refuses when both do. */
async function pickFile(dest, names) {
  const existing = [];
  for (const name of names) if (await inspectPath(dest, name)) existing.push(name);
  if (existing.length > 1) fail(`both ${names.join(' and ')} exist; refusing ambiguous activation`);
  return existing[0] ?? null;
}

/** The config edits activation would make: [{ file, old: Buffer|null, next: Buffer }]. */
async function planEdits(dest, profile) {
  const coreFile = await pickFile(dest, CORE_NAMES) ?? 'opencode.jsonc';
  const old = await readIfExists(dest, coreFile);
  const text = old?.toString('utf8') ?? '{}\n';
  const before = parseConfig(text);
  for (const key of ['providers', 'provider', 'agents']) {
    if (before[key] !== undefined && (!before[key] || typeof before[key] !== 'object' || Array.isArray(before[key]))) fail(`existing ${key} config must be an object`);
  }
  for (const [id, provider] of Object.entries(profile.providers ?? {})) {
    if (before.providers?.[id] && canonical(before.providers[id]) !== canonical(provider)) fail(`native provider ${id} already has a different configuration; refusing activation`);
    if (before.provider?.[id] && canonical(before.provider[id]) !== canonical(provider)) fail(`legacy provider ${id} conflicts with the selected native configuration; refusing activation`);
  }
  return [{ file: coreFile, old, next: activatedText(text, profile) }];
}

/** `text` with OCDB's activation edits; `legacyHelpers` adds the helper models earlier releases also wrote. */
function activatedText(text, profile, { legacyHelpers = false } = {}) {
  const before = parseConfig(text);
  text = edit(text, ['default_agent'], 'VC-Orchestrator');
  text = edit(text, ['model'], profile.lead.split('#')[0]);
  if (legacyHelpers) for (const id of LEGACY_HELPER_AGENTS) if (before.agents?.[id]?.model === undefined) text = edit(text, ['agents', id, 'model'], profile.helper);
  for (const [id, provider] of Object.entries(profile.providers ?? {})) text = edit(text, ['providers', id], provider);
  return withNewline(text);
}

/** True when `current` is exactly what OCDB's activation, current or earlier, makes of `original`. */
function isOwnActivation(current, original, profile) {
  if (!profile) return false;
  const text = original?.toString('utf8') ?? '{}\n';
  try {
    return [false, true].some((legacyHelpers) => activatedText(text, profile, { legacyHelpers }).equals(current));
  } catch { return false; }
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
      files: [
        { file: state.coreFile, backup: state.backupPath, original: state.originalHash, activated: state.activatedHash },
        ...(state.tui ? [{ file: state.tui.file, backup: state.tui.backupPath, original: state.tui.originalHash, activated: state.tui.activatedHash }] : []),
      ],
    };
  }
  if (state) state.profile = normalizeProfileId(state.profile);
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

/**
 * Files to put back on deactivation: [{ file, current, original: Buffer|null }]. Refuses if any was
 * edited since, unless its content is still exactly what activation writes for `profile`; that
 * covers a ledger whose recorded hash went stale while the file itself was left alone.
 */
async function restorePlan(dest, state, profile) {
  await pickFile(dest, CORE_NAMES);
  await pickFile(dest, TUI_NAMES);
  const restores = [];
  for (const entry of state.files) {
    const current = await readIfExists(dest, entry.file);
    const currentHash = current ? hash(current) : null;
    if (currentHash === entry.original) continue; // never written, or already rolled back
    const original = entry.backup ? await readFile(path.join(dest, entry.backup)) : null;
    const own = current && CORE_NAMES.includes(entry.file) && isOwnActivation(current, original, profile);
    if (currentHash !== entry.activated && !own) fail(`${entry.file} was edited after activation; refusing to overwrite user changes`);
    restores.push({ file: entry.file, current, original });
  }
  return restores;
}

/** Validates without writing; throws what activation would throw. */
export async function previewActivation(dest, profileId, profile) {
  const active = await readActivation(dest);
  if (!active) return planEdits(dest, profile);
  if (active.profile !== profileId) fail(`profile ${active.profile} is already active; deactivate before switching profiles`);
  await restorePlan(dest, active, profile);
  return [];
}

export async function activate(dest, profileId, profile, { validateInstalled, onActivationMutation } = {}) {
  return withLock(dest, async () => {
    await validateInstalled();
    if (await readActivation(dest)) { await previewActivation(dest, profileId, profile); return 'already active'; }
    const edits = await planEdits(dest, profile);
    const files = [];
    for (const { file, old, next } of edits) files.push({ file, backup: old ? await backup(dest, `activation/${file}`, old) : null, original: old ? hash(old) : null, activated: hash(next) });
    // The ledger goes first, so a crash part-way leaves enough to recover with deactivate.
    await atomicWrite(path.join(dest, ACT_FILE), Buffer.from(`${JSON.stringify({ version: 2, profile: profileId, files }, null, 2)}\n`));
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

/** `profiles` is the catalog's profile map, used to recognise OCDB's own activation output. */
export async function previewDeactivation(dest, profiles = {}) {
  const state = await readActivation(dest);
  if (!state) fail('no OCDB activation is recorded');
  return { state, restores: await restorePlan(dest, state, profiles[state.profile]) };
}

export async function deactivate(dest, profiles) {
  return withLock(dest, async () => {
    const { restores } = await previewDeactivation(dest, profiles);
    for (const { file, current, original } of restores) {
      await backup(dest, `before-deactivate/${file}`, current);
      if (original) await atomicWrite(path.join(dest, file), original);
      else await rm(path.join(dest, file));
    }
    await rm(path.join(dest, ACT_FILE));
    return 'deactivated';
  });
}
