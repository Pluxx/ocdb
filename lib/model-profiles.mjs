import { readFile } from 'node:fs/promises';

const ROLE_NAMES = ['lead', 'implementation', 'design', 'explore', 'tester', 'helper', 'solver', 'solverMax'];
const MODEL_NAMESPACE = { openai: 'openai', 'opencode-go': 'opencode-go', opencode: 'opencode', 'opencode-zen': 'opencode', deepseek: 'ocdb-deepseek', 'ocdb-deepseek': 'ocdb-deepseek' };
const fail = (message) => { throw new Error(message); };

export function validateProfiles(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.preferenceOrder) || !data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) fail('model profile catalog has an unsupported format');
  const known = new Set(['openai', 'opencode-go', 'opencode-zen', 'deepseek']);
  const expectedOrder = ['openai', 'opencode-go', 'opencode-zen', 'deepseek'];
  if (JSON.stringify(data.preferenceOrder) !== JSON.stringify(expectedOrder)) fail('model profile preference order is incomplete or unsupported');
  if (Object.keys(data.profiles).length !== known.size || [...known].some((id) => !Object.hasOwn(data.profiles, id))) fail('model profile catalog must contain all four supported profiles');
  for (const [id, profile] of Object.entries(data.profiles)) {
    if (!known.has(id) || !profile || typeof profile !== 'object' || typeof profile.label !== 'string' || !profile.label || typeof profile.provider !== 'string') fail(`invalid model profile: ${id}`);
    const expectedProvider = id === 'opencode-zen' ? 'opencode' : id === 'deepseek' ? 'ocdb-deepseek' : id;
    if (profile.provider !== expectedProvider) fail(`${id} must use provider ${expectedProvider}`);
    for (const role of ROLE_NAMES) {
      const model = profile[role];
      if (typeof model !== 'string' || !model || !model.startsWith(`${MODEL_NAMESPACE[profile.provider]}/`)) fail(`${id}.${role} must be a model from its selected provider (${profile.provider})`);
    }
    if (profile.providers !== undefined) {
      if (!profile.providers || typeof profile.providers !== 'object' || Array.isArray(profile.providers)) fail(`${id}.providers must be an object`);
      for (const [providerId, config] of Object.entries(profile.providers)) {
        if (providerId !== MODEL_NAMESPACE[profile.provider] || !providerId.startsWith('ocdb-') || !config || typeof config !== 'object' || Array.isArray(config)) fail(`${id}.providers contains an unsupported provider definition`);
        if (JSON.stringify(config).match(/"(?:apiKey|token|password|secret|credential)"\s*:/i)) fail(`${id}.providers must not contain credentials`);
      }
    }
    if (profile.provider === 'ocdb-deepseek' && !profile.providers?.[MODEL_NAMESPACE.deepseek]) fail(`${id} must define its custom provider configuration`);
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
  return catalog.preferenceOrder.find((id) => permitted.has(id) && catalog.profiles[id]) || fail('no supported profiles are available in --providers');
}

export function renderProfileAsset(relative, bytes, selected, catalog) {
  const text = bytes.toString('utf8');
  const profile = catalog.profiles[selected];
  let role;
  if (relative === 'agents/VC-Orchestrator.md') role = 'lead';
  else if (['agents/VC-Symfony.md', 'agents/VC-DDEV.md', 'agents/VC-Frontend.md'].includes(relative)) role = 'implementation';
  else if (relative === 'agents/VC-Design.md') role = 'design';
  else if (relative === 'agents/VC-Explorer.md') role = 'explore';
  else if (relative === 'agents/VC-Tester.md') role = 'tester';
  else if (relative === 'agents/VC-Solver.md') role = 'solver';
  else if (relative === 'commands/vc-solve-max.md') role = 'solverMax';
  if (!role) return bytes;
  const model = profile[role];
  const replaced = text.replace(/^(model:\s*).+$/m, `$1${model}`);
  if (replaced === text && !/^model:/m.test(text)) fail(`expected model field in ${relative}`);
  return Buffer.from(replaced);
}
