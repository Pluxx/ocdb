import { readFile } from 'node:fs/promises';
import { fail } from './fs-safe.mjs';

export const PROFILE_IDS = new Set(['openai', 'opencode-go', 'opencode-zen', 'deepseek']);
// Which catalog role sets the `model:` line of each installed file.
const ROLE_OF = {
  'agents/VC-Orchestrator.md': 'lead',
  'agents/VC-Symfony.md': 'implementation',
  'agents/VC-DDEV.md': 'implementation',
  'agents/VC-Frontend.md': 'implementation',
  'agents/VC-Design.md': 'design',
  'agents/VC-Explorer.md': 'explore',
  'agents/VC-Librarian.md': 'explore',
  'agents/VC-Tester.md': 'tester',
  'agents/VC-Solver.md': 'solver',
  'commands/vc-solve-max.md': 'solverMax',
};
const ROLES = ['lead', 'implementation', 'design', 'explore', 'tester', 'helper', 'solver', 'solverMax'];

export function validateProfiles(data) {
  if (data?.version !== 1 || !Array.isArray(data.preferenceOrder) || [...PROFILE_IDS].some((id) => !data.profiles?.[id] || !data.preferenceOrder.includes(id))) fail('model profile catalog must define all four supported profiles');
  for (const id of PROFILE_IDS) {
    const profile = data.profiles[id];
    for (const role of ROLES) {
      if (typeof profile[role] !== 'string' || !profile[role].startsWith(`${profile.provider}/`)) fail(`${id}.${role} must be a model from its selected provider (${profile.provider})`);
    }
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

export function chooseProfile(catalog, { profile, providers } = {}) {
  const permitted = providers == null ? null : new Set(providers);
  if (permitted && [...permitted].some((id) => !catalog.profiles[id])) fail('providers contains an unsupported profile');
  if (profile) {
    if (!catalog.profiles[profile]) fail(`unknown model profile: ${profile}`);
    if (permitted && !permitted.has(profile)) fail(`profile ${profile} was not included in --providers`);
    return profile;
  }
  if (!permitted) return null;
  return catalog.preferenceOrder.find((id) => permitted.has(id)) || fail('no supported profiles are available in --providers');
}

/** Writes the selected profile's model into a file's `model:` frontmatter line. */
export function renderProfileAsset(relative, bytes, selected, catalog) {
  const role = ROLE_OF[relative];
  if (!role) return bytes;
  const text = bytes.toString('utf8');
  if (!/^model:/m.test(text)) fail(`expected model field in ${relative}`);
  return Buffer.from(text.replace(/^(model:\s*).+$/m, `$1${catalog.profiles[selected][role]}`));
}
