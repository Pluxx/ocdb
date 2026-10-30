import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assignments, effectiveProfile, missingModels, modelRef, parseRef, profileStatus } from '../plugins/ocdb-hw/profiles.mjs';
import { renderProfileAsset } from '../lib/model-profiles.mjs';

const source = JSON.parse(await readFile(new URL('../profiles/models.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(renderProfileAsset('plugins/ocdb-hw/catalog.json', Buffer.from('{}'), 'oai-hq', source).toString());

test('model references round-trip between strings and OpenCode model values', () => {
  assert.deepEqual(parseRef('openai/gpt-6.1-sol#high'), { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' });
  assert.deepEqual(parseRef('opencode-go/mimo-v2.6-flash'), { providerID: 'opencode-go', id: 'mimo-v2.6-flash' });
  assert.equal(modelRef({ providerID: 'openai', id: 'gpt-6-luna', variant: 'low' }), 'openai/gpt-6-luna#low');
  assert.equal(modelRef({ providerID: 'opencode-go', modelID: 'kimi-k3.1-pro' }), 'opencode-go/kimi-k3.1-pro');
  assert.equal(modelRef(undefined), null);
});

test('every managed agent, including the built-in helpers, gets its role model', () => {
  const routed = assignments(catalog, 'ocgo-hq');
  assert.equal(routed['VC-Orchestrator'], 'opencode-go/kimi-k3.1-pro#high');
  assert.equal(routed['VC-Solver-Max'], 'opencode-go/kimi-k3.1-pro#max');
  assert.equal(routed.compaction, 'opencode-go/minimax-m3.1-flash#medium');
  assert.equal(routed.plan, routed['VC-Orchestrator']);
  const mixed = assignments(catalog, 'oai-ocgo-mix');
  assert.ok(mixed['VC-Orchestrator'].startsWith('openai/'));
  assert.ok(mixed['VC-Reviewer'].startsWith('opencode-go/'));
});

test('a stored choice applies only to the install it was made for', () => {
  assert.equal(effectiveProfile(catalog, undefined), 'oai-hq');
  assert.equal(effectiveProfile(catalog, { profile: 'ocgo-lc', installed: 'oai-hq' }), 'ocgo-lc');
  assert.equal(effectiveProfile(catalog, { profile: 'ocgo-lc', installed: 'ocgo-hq' }), 'oai-hq', 'a reinstall resets the choice');
  assert.equal(effectiveProfile(catalog, { profile: 'retired', installed: 'oai-hq' }), 'oai-hq');
  assert.equal(effectiveProfile(catalog, 'ocgo-lc'), 'oai-hq');
});

test('a profile is available only when every model it routes to is offered', () => {
  const goOnly = new Set(Object.values(assignments(catalog, 'ocgo-hq')).map((ref) => ref.split('#')[0]));
  assert.deepEqual(missingModels(catalog, 'ocgo-hq', goOnly), []);
  assert.ok(missingModels(catalog, 'oai-ocgo-mix', goOnly).every((ref) => ref.startsWith('openai/')));
  const status = profileStatus(catalog, 'oai-hq', goOnly);
  assert.equal(status.installed, 'oai-hq');
  assert.equal(status.profiles.find((p) => p.id === 'ocgo-hq').available, true);
  assert.equal(status.profiles.find((p) => p.id === 'oai-hq').available, false);
  assert.deepEqual(status.profiles.map((p) => p.id), source.preferenceOrder);
});
