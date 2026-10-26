import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { executeCommand } from '../lib/cli.mjs';

const roots = new Set();
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-activation-'));
  roots.add(root);
  const dest = path.join(root, 'opencode');
  await mkdir(dest, { recursive: true });
  return { root, dest };
}
async function command(cmd, c, options = {}) {
  return executeCommand(cmd, { configDir: c.dest, mode: 'apply', log: { log() {} }, ...options });
}
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

test('activation preserves JSONC comments/unrelated settings, removes exact OMO variants, and deactivation restores bytes', async () => {
  const c = await setup();
  const core = path.join(c.dest, 'opencode.jsonc');
  const original = Buffer.from(`{
  // keep this comment
  "theme": "dark",
  "plugins": ["oh-my-opencode-slim", "oh-my-opencode-slim@2.4.0", "unrelated-plugin"],
  "plugin": ["oh-my-opencode-slim", { "package": "oh-my-opencode-slim@3" }, "legacy-other"]
}\n`);
  await writeFile(core, original);
  await command('install', c, { activate: true, disableOmo: true });
  const activatedText = await readFile(core, 'utf8');
  assert.match(activatedText, /keep this comment/);
  const config = parse(activatedText);
  assert.equal(config.default_agent, 'VC-Orchestrator');
  assert.equal(config.model, 'openai/gpt-6.1-sol');
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.plugins, ['unrelated-plugin']);
  assert.deepEqual(config.plugin, ['legacy-other']);
  await command('deactivate', c);
  assert.deepEqual(await readFile(core), original);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/activation.json')), { code: 'ENOENT' });
});

test('activation of a new core config can be deactivated by removing only that created file', async () => {
  const c = await setup();
  await command('install', c);
  await command('activate', c);
  const created = path.join(c.dest, 'opencode.jsonc');
  assert.equal(parse(await readFile(created, 'utf8')).default_agent, 'VC-Orchestrator');
  await command('deactivate', c);
  await assert.rejects(lstat(created), { code: 'ENOENT' });
});

test('dual core config ambiguity prevents setup asset writes', async () => {
  const c = await setup();
  await writeFile(path.join(c.dest, 'opencode.json'), '{}');
  await writeFile(path.join(c.dest, 'opencode.jsonc'), '{}');
  await assert.rejects(command('install', c, { activate: true }), /both opencode\.json and opencode\.jsonc/);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/state.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, 'agents/VC-Orchestrator.md')), { code: 'ENOENT' });
});

test('activation refuses user edits, profile switching, and uninstall until deactivated', async () => {
  const c = await setup();
  await command('install', c, { activate: true });
  await assert.rejects(command('install', c, { profile: 'opencode-go' }), /active; deactivate before switching/);
  await assert.rejects(command('uninstall', c), /deactivate first/);
  await writeFile(path.join(c.dest, 'opencode.jsonc'), `${await readFile(path.join(c.dest, 'opencode.jsonc'), 'utf8')}\n// user's edit\n`);
  await assert.rejects(command('deactivate', c), /edited after activation/);
});

test('activation ledger rejects forged profile and traversal backup paths', async () => {
  const c = await setup();
  await writeFile(path.join(c.dest, 'opencode.jsonc'), '{}');
  await command('install', c, { activate: true });
  const ledgerFile = path.join(c.dest, '.vc-ocdb/activation.json');
  const ledger = JSON.parse(await readFile(ledgerFile, 'utf8'));
  ledger.profile = '../foreign';
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await assert.rejects(command('deactivate', c), /unsupported format/);
  ledger.profile = 'openai';
  ledger.backupPath = '../opencode.jsonc';
  await writeFile(ledgerFile, JSON.stringify(ledger));
  await assert.rejects(command('deactivate', c), /unsafe backup path/);
});

test('failed activation commit restores core bytes and releases lock while reporting installed assets', async () => {
  const c = await setup();
  const core = path.join(c.dest, 'opencode.jsonc');
  const original = Buffer.from('{\n  // recovery comment\n  "theme": "light"\n}\n');
  await writeFile(core, original);
  await assert.rejects(command('install', c, {
    activate: true,
    onActivationMutation: async () => { throw new Error('injected activation failure'); },
  }), /assets installed, but activation did not complete: activation commit failed; config rollback succeeded and pending record cleared: injected activation failure/);
  assert.deepEqual(await readFile(core), original);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/lock')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/activation.json')), { code: 'ENOENT' });
  assert.ok((await readFile(path.join(c.dest, '.vc-ocdb/state.json'), 'utf8')).includes('"profile": "openai"'));
});

test('Direct DeepSeek activation merges its selected native provider config without credentials', async () => {
  const c = await setup();
  await writeFile(path.join(c.dest, 'opencode.jsonc'), '{"provider":{"legacy-unrelated":{"name":"keep"}}}\n');
  await command('install', c, { profile: 'deepseek', activate: true });
  const config = parse(await readFile(path.join(c.dest, 'opencode.jsonc'), 'utf8'));
  assert.equal(config.model, 'ocdb-deepseek/deepseek-flash');
  assert.ok(config.providers['ocdb-deepseek'].models['deepseek-v4-pro']);
  assert.equal(config.provider['legacy-unrelated'].name, 'keep');
  assert.doesNotMatch(JSON.stringify(config.providers['ocdb-deepseek']), /apiKey|DEEPSEEK_API_KEY\s*:/i);
});

test('different existing native provider definition blocks activation before asset install', async () => {
  const c = await setup();
  await writeFile(path.join(c.dest, 'opencode.jsonc'), '{"providers":{"ocdb-deepseek":{"name":"user definition"}}}\n');
  await assert.rejects(command('install', c, { profile: 'deepseek', activate: true }), /native provider ocdb-deepseek already has a different configuration/);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/state.json')), { code: 'ENOENT' });
});

test('conflicting legacy provider definition is not silently shadowed or converted', async () => {
  const c = await setup();
  await writeFile(path.join(c.dest, 'opencode.jsonc'), '{"provider":{"ocdb-deepseek":{"name":"legacy user definition"}}}\n');
  await assert.rejects(command('install', c, { profile: 'deepseek', activate: true }), /legacy provider ocdb-deepseek conflicts/);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/state.json')), { code: 'ENOENT' });
});

test('failed rollback keeps pending baseline authoritative and permits safe later recovery', async () => {
  const c = await setup();
  const core = path.join(c.dest, 'opencode.jsonc');
  const original = Buffer.from('{\n  // true original baseline\n  "theme": "baseline"\n}\n');
  await writeFile(core, original);
  let activatedBytes;
  await assert.rejects(command('install', c, {
    activate: true,
    onActivationMutation: async () => {
      activatedBytes = await readFile(core);
      await rm(core);
      await mkdir(core);
      throw new Error('fault after core write');
    },
  }), /recovery required:.*pending record and original backup retained/);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/lock')), { code: 'ENOENT' });
  const pending = JSON.parse(await readFile(path.join(c.dest, '.vc-ocdb/activation.json'), 'utf8'));
  assert.equal(pending.phase, 'pending');
  assert.deepEqual(await readFile(path.join(c.dest, pending.backupPath)), original);
  const status = [];
  await executeCommand('status', { configDir: c.dest, log: { log(message) { status.push(message); } } });
  assert.match(status[0], /PENDING RECOVERY/);
  await assert.rejects(command('activate', c), /activation recovery is pending/);
  await assert.rejects(command('uninstall', c), /activation recovery is pending/);

  await rmdir(core);
  await writeFile(core, activatedBytes);
  await command('deactivate', c);
  assert.deepEqual(await readFile(core), original);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/activation.json')), { code: 'ENOENT' });
});

test('duplicate JSONC keys at root and nested levels are rejected before setup writes', async () => {
  const duplicateConfigs = [
    '{"model":"first","model":"second"}',
    '{"plugins":[],"plugins":[]}',
    '{"providers":{},"providers":{}}',
    '{"providers":{"ocdb-deepseek":{"models":{},"models":{}}}}',
  ];
  for (const duplicate of duplicateConfigs) {
    const c = await setup();
    await writeFile(path.join(c.dest, 'opencode.jsonc'), duplicate);
    await assert.rejects(command('install', c, { profile: 'deepseek', activate: true }), /duplicate JSONC key/);
    await assert.deepEqual(await readFile(path.join(c.dest, 'opencode.jsonc'), 'utf8'), duplicate);
    await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/state.json')), { code: 'ENOENT' });
  }
});

test('activation preview rejects duplicate keys without changing the existing config', async () => {
  const c = await setup();
  await command('install', c);
  const core = path.join(c.dest, 'opencode.jsonc');
  const duplicate = Buffer.from('{"providers":{"x":{"value":1,"value":2}}}\n');
  await writeFile(core, duplicate);
  await assert.rejects(executeCommand('activate', { configDir: c.dest, mode: 'dry-run', log: { log() {} } }), /duplicate JSONC key/);
  assert.deepEqual(await readFile(core), duplicate);
});

test('deactivation preview and apply both reject a newly ambiguous core config pair', async () => {
  const c = await setup();
  await command('install', c, { activate: true });
  const core = path.join(c.dest, 'opencode.jsonc');
  const activationFile = path.join(c.dest, '.vc-ocdb/activation.json');
  const activeBytes = await readFile(core);
  const ledgerBytes = await readFile(activationFile);
  await writeFile(path.join(c.dest, 'opencode.json'), '{}');
  await assert.rejects(executeCommand('deactivate', { configDir: c.dest, mode: 'dry-run', log: { log() {} } }), /both opencode\.json and opencode\.jsonc/);
  await assert.rejects(command('deactivate', c), /both opencode\.json and opencode\.jsonc/);
  assert.deepEqual(await readFile(core), activeBytes);
  assert.deepEqual(await readFile(activationFile), ledgerBytes);
});

test('public activate command refuses a missing managed lead without touching core config', async () => {
  const c = await setup();
  await command('install', c);
  await rm(path.join(c.dest, 'agents/VC-Orchestrator.md'));
  const proc = spawnSync(process.execPath, [path.resolve('bin/vc-ocdb.mjs'), 'activate', '--apply', '--config-dir', c.dest], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /installed profile asset is missing or unsafe: agents\/VC-Orchestrator\.md/);
  await assert.rejects(lstat(path.join(c.dest, 'opencode.jsonc')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/lock')), { code: 'ENOENT' });
});

test('activation revalidates managed hashes again under its lock after setup preflight', async () => {
  const c = await setup();
  await assert.rejects(command('install', c, {
    activate: true,
    onMutation: async (action) => {
      if (action.rel === 'agents/VC-Orchestrator.md') await writeFile(path.join(c.dest, action.rel), 'changed between preflight and activation');
    },
  }), /assets installed, but activation did not complete: installed profile asset was modified: agents\/VC-Orchestrator\.md/);
  await assert.rejects(lstat(path.join(c.dest, 'opencode.jsonc')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/lock')), { code: 'ENOENT' });
});

test('OMO cutover also removes the TUI registration and deactivation restores tui.json bytes', async () => {
  const c = await setup();
  const tui = path.join(c.dest, 'tui.json');
  const original = Buffer.from('{\n  "plugin": [\n    "oh-my-opencode-slim",\n    "other-tui"\n  ]\n}\n');
  await writeFile(path.join(c.dest, 'opencode.json'), '{ "plugin": ["oh-my-opencode-slim"] }\n');
  await writeFile(tui, original);
  await command('install', c, { activate: true, disableOmo: true });
  assert.deepEqual(parse(await readFile(tui, 'utf8')).plugin, ['other-tui']);
  await command('deactivate', c);
  assert.deepEqual(await readFile(tui), original);
});

test('OMO cutover leaves tui.json untouched without --disable-omo and refuses to clobber later TUI edits', async () => {
  const c = await setup();
  const tui = path.join(c.dest, 'tui.json');
  const original = Buffer.from('{ "plugin": ["oh-my-opencode-slim"] }\n');
  await writeFile(tui, original);
  await command('install', c, { activate: true });
  assert.deepEqual(await readFile(tui), original);
  await command('deactivate', c);
  await command('activate', c, { disableOmo: true });
  await writeFile(tui, '{ "plugin": ["user-added"] }\n');
  await assert.rejects(command('deactivate', c), /tui\.json was edited after activation/);
});

test('activation routes title/summary helpers to the profile helper model without overriding user choices', async () => {
  const c = await setup();
  const core = path.join(c.dest, 'opencode.json');
  const original = Buffer.from('{\n  "agent": { "explore": { "disable": true } },\n  "agents": { "summary": { "model": "openai/gpt-6-sol#low" } }\n}\n');
  await writeFile(core, original);
  await command('install', c, { activate: true });
  const config = parse(await readFile(core, 'utf8'));
  assert.equal(config.agents.title.model, 'openai/gpt-6-luna#low');
  assert.equal(config.agents.summary.model, 'openai/gpt-6-sol#low');
  assert.deepEqual(config.agent, { explore: { disable: true } });
  await command('deactivate', c);
  assert.deepEqual(await readFile(core), original);
});
