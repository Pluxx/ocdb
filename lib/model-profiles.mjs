import { readFile } from 'node:fs/promises';
import { fail } from './fs-safe.mjs';

export const PROFILE_IDS = new Set(['oai-hq', 'oai-lc', 'ocgo-hq', 'ocgo-lc', 'oai-ocgo-mix', 'opencode-zen', 'deepseek']);
// Profile IDs earlier releases wrote to the ledgers, and the profile that replaced each.
const LEGACY_PROFILES = { openai: 'oai-hq', 'opencode-go': 'ocgo-lc' };
// Names accepted by --providers besides the provider IDs themselves.
const PROVIDER_ALIASES = { oai: 'openai', go: 'opencode-go', zen: 'opencode', 'opencode-zen': 'opencode', deepseek: 'ocdb-deepseek' };
// Which catalog role sets the model of each agent. The sidebar plugin assigns these
// at runtime, so the profile can be switched live; agent files carry no model.
export const AGENT_ROLES = {
  'VC-Orchestrator': 'lead',
  'VC-Symfony': 'implementation',
  'VC-DDEV': 'implementation',
  'VC-Frontend': 'implementation',
  'VC-Design': 'design',
  'VC-Explorer': 'explore',
  'VC-Librarian': 'explore',
  'VC-Tester': 'tester',
  'VC-Reviewer': 'review',
  'VC-Solver': 'solver',
  'VC-Solver-Max': 'solverMax',
  // Built-in agents: hidden helpers that would otherwise run on the expensive
  // default model, and `plan`, which /vc-plan uses.
  title: 'helper',
  summary: 'helper',
  compaction: 'compaction',
  plan: 'lead',
};
const ROLES = ['lead', 'implementation', 'design', 'explore', 'tester', 'review', 'helper', 'compaction', 'solver', 'solverMax'];
// Generated for the sidebar plugin's live profile switcher.
export const PLUGIN_CATALOG = 'plugins/ocdb-hw/catalog.json';

/** Lower-cases a profile ID and maps IDs from earlier releases to their replacement. */
export function normalizeProfileId(id) {
  if (typeof id !== 'string') return id;
  const lower = id.toLowerCase();
  return LEGACY_PROFILES[lower] ?? lower;
}

export function validateProfiles(data) {
  if (data?.version !== 2 || !data.providers || !Array.isArray(data.preferenceOrder) || [...PROFILE_IDS].some((id) => !data.profiles?.[id] || !data.preferenceOrder.includes(id))) fail(`model profile catalog must define every supported profile (${[...PROFILE_IDS].join(', ')})`);
  for (const id of PROFILE_IDS) {
    const profile = data.profiles[id];
    if (typeof profile.label !== 'string' || !Array.isArray(profile.requires) || !profile.requires.length || profile.requires.some((p) => !data.providers[p])) fail(`${id} must have a label and require known providers`);
    for (const role of ROLES) {
      if (typeof profile[role] !== 'string' || !profile.requires.some((p) => profile[role].startsWith(`${p}/`))) fail(`${id}.${role} must be a model from a provider the profile requires (${profile.requires.join(', ')})`);
    }
    if (Object.keys(profile.providers ?? {}).some((p) => !profile.requires.includes(p))) fail(`${id}.providers may only define providers the profile requires`);
    if (/"(?:apiKey|token|password|secret|credential)"\s*:/i.test(JSON.stringify(profile.providers ?? {}))) fail(`${id}.providers must not contain credentials`);
  }
  return data;
}

export async function loadProfiles(file) {
  let value;
  try { value = JSON.parse(await readFile(file, 'utf8')); }
  catch { fail(`cannot read model profile catalog: ${file}`); }
  return validateProfiles(value);
}

/** The requested profile, or the first in preference order that the given providers can run. */
export function chooseProfile(catalog, { profile, providers } = {}) {
  const available = providers == null ? null : new Set(providers.map((p) => PROVIDER_ALIASES[p.toLowerCase()] ?? p.toLowerCase()));
  if (available && [...available].some((p) => !catalog.providers[p])) fail(`--providers accepts ${Object.keys(catalog.providers).join(', ')}`);
  const runnable = (id) => !available || catalog.profiles[id].requires.every((p) => available.has(p));
  if (profile) {
    const id = normalizeProfileId(profile);
    if (!catalog.profiles[id]) fail(`unknown model profile: ${profile}`);
    if (!runnable(id)) fail(`profile ${id} needs ${catalog.profiles[id].requires.join(' and ')}, which --providers does not include`);
    return id;
  }
  if (!available) return null;
  return catalog.preferenceOrder.find(runnable) || fail('no profile can run with the given --providers');
}

/** Builds VC-Solver-Max from VC-Solver: the same prompt, reached only through /vc-solve-max. */
export function deriveSolverMax(solverBytes) {
  const text = solverBytes.toString('utf8');
  if (!/^description:.*$/m.test(text)) fail('expected description field in agents/VC-Solver.md');
  return Buffer.from(text.replace(/^description:.*$/m, 'description: Highest-effort VC-Solver; runs only through the /vc-solve-max command'));
}

/** Writes the selected profile into the plugin catalog; other files install unchanged. */
export function renderProfileAsset(relative, bytes, selected, catalog) {
  if (relative === PLUGIN_CATALOG) {
    const profiles = Object.fromEntries(catalog.preferenceOrder.map((id) => {
      const { label, description = '', requires } = catalog.profiles[id];
      return [id, { label, description, requires, ...Object.fromEntries(ROLES.map((role) => [role, catalog.profiles[id][role]])) }];
    }));
    return Buffer.from(`${JSON.stringify({ version: 1, installed: selected, agents: AGENT_ROLES, profiles }, null, 2)}\n`);
  }
  if (relative.startsWith('agents/') && /^model:/m.test(bytes.toString('utf8'))) fail(`${relative} must not set a model; the profile catalog routes it`);
  return bytes;
}
