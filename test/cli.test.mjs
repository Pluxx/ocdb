import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeCommand, parseArgs } from '../lib/cli.mjs';

const base = os.tmpdir();
await mkdir(base, { recursive: true });
const fixtures = new Set();
const agentIds = ['VC-Orchestrator', 'VC-Symfony', 'VC-DDEV', 'VC-Design', 'VC-Frontend', 'VC-Reviewer', 'VC-Tester', 'VC-Solver', 'VC-Explorer', 'VC-Librarian'];
const skillIds = ['vc-symfony', 'vc-ddev', 'vc-web-design', 'vc-tailwind', 'vc-solving', 'vc-TYPO3', 'vc-TYPO3-upgrade'];
const commandIds = ['vc-web', 'vc-plan', 'vc-check', 'vc-solve', 'vc-solve-max', 'vc-t3u'];
async function setup() {
  const root = await mkdtemp(path.join(base, 'vc-ocdb-test-'));
  fixtures.add(root);
  const source = path.join(root, 'source');
  const pluginDir = path.join(root, 'plugin');
  const modelsFile = path.join(root, 'models.json');
  const dest = path.join(root, 'config');
  for (const id of agentIds) {
    await mkdir(path.join(source, 'agents'), { recursive: true });
    const body = id === 'VC-Orchestrator' ? 'agent-v1\n' : `${id}\n`;
    await writeFile(path.join(source, 'agents', `${id}.md`), `---\ndescription: ${id}\n---\n${body}`);
  }
  for (const id of skillIds) {
    await mkdir(path.join(source, 'skills', id), { recursive: true });
    await writeFile(path.join(source, 'skills', id, 'SKILL.md'), id === 'vc-web-design' ? 'skill-v1\n' : `${id}\n`);
  }
  for (const id of commandIds) {
    await mkdir(path.join(source, 'commands'), { recursive: true });
    await writeFile(path.join(source, 'commands', `${id}.md`), id === 'vc-web' ? 'command-v1\n' : `${id}\n`);
  }
  await mkdir(pluginDir, { recursive: true });
  for (const file of ['package.json', 'index.ts', 'tui.tsx', 'rpc.ts', 'profiles.mjs', 'metrics.mjs', 'activity.mjs']) await writeFile(path.join(pluginDir, file), `plugin fixture ${file}\n`);
  await writeFile(modelsFile, await readFile(new URL('../profiles/models.json', import.meta.url)));
  return { root, source, pluginDir, modelsFile, dest };
}
async function run(command, ctx, mode = 'apply') {
  await executeCommand(command, { configDir: ctx.dest, sourceDir: ctx.source, pluginDir: ctx.pluginDir, modelsFile: ctx.modelsFile, mode, log: { log() {} } });
}
test.after(async () => {
  for (const root of fixtures) await rm(root, { recursive: true, force: true });
});

test('fresh install tracks assets and repeated install is idempotent', async () => {
  const c = await setup();
  await run('install', c);
  const before = await readFile(path.join(c.dest, 'agents/VC-Orchestrator.md'));
  const stateBefore = await readFile(path.join(c.dest, '.vc-ocdb/state.json'));
  await run('install', c);
  assert.deepEqual(await readFile(path.join(c.dest, 'agents/VC-Orchestrator.md')), before);
  assert.deepEqual(await readFile(path.join(c.dest, '.vc-ocdb/state.json')), stateBefore);
});

test('the selected profile is rendered into the plugin catalog and persists across an unselected update', async () => {
  const c = await setup();
  const install = (options) => executeCommand('install', { configDir: c.dest, sourceDir: c.source, pluginDir: c.pluginDir, modelsFile: c.modelsFile, mode: 'apply', log: { log() {} }, ...options });
  const routing = async () => JSON.parse(await readFile(path.join(c.dest, 'plugins/ocdb-hw/catalog.json'), 'utf8'));
  await install({ profile: 'OCGO-LC' });
  const catalog = await routing();
  assert.equal(catalog.installed, 'ocgo-lc');
  assert.deepEqual(Object.keys(catalog.profiles), ['oai-ocgo-mix', 'oai-hq', 'ocgo-hq', 'opencode-zen', 'deepseek', 'oai-lc', 'ocgo-lc']);
  assert.equal(catalog.agents['VC-Solver-Max'], 'solverMax');
  assert.equal(catalog.agents.compaction, 'compaction');
  assert.equal(catalog.profiles['ocgo-lc'].lead, 'opencode-go/deepseek-v4.1-flash#high');
  assert.equal(JSON.parse(await readFile(path.join(c.dest, '.vc-ocdb/state.json'), 'utf8')).profile, 'ocgo-lc');
  await install({});
  assert.equal((await routing()).installed, 'ocgo-lc');
});

test('VC-Solver-Max is derived from VC-Solver and agent sources may not set a model', async () => {
  const c = await setup();
  await run('install', c);
  const max = await readFile(path.join(c.dest, 'agents/VC-Solver-Max.md'), 'utf8');
  assert.match(max, /^description: Highest-effort VC-Solver; runs only through the \/vc-solve-max command$/m);
  assert.match(max, /^VC-Solver$/m);
  await writeFile(path.join(c.source, 'agents/VC-Symfony.md'), '---\nmodel: openai/gpt-6-luna#high\n---\nVC-Symfony\n');
  await assert.rejects(run('install', c), /agents\/VC-Symfony\.md must not set a model/);
});

test('profile IDs from earlier releases map to their replacements', async () => {
  const c = await setup();
  await executeCommand('install', { configDir: c.dest, sourceDir: c.source, pluginDir: c.pluginDir, modelsFile: c.modelsFile, mode: 'apply', profile: 'openai', log: { log() {} } });
  const statePath = path.join(c.dest, '.vc-ocdb/state.json');
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).profile, 'oai-hq');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  await writeFile(statePath, JSON.stringify({ ...state, profile: 'opencode-go' }));
  await run('install', c);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).profile, 'ocgo-lc');
});

test('--providers picks the first profile the given providers can run', async () => {
  const c = await setup();
  const pick = async (providers) => {
    await executeCommand('install', { configDir: c.dest, sourceDir: c.source, pluginDir: c.pluginDir, modelsFile: c.modelsFile, mode: 'apply', providers, log: { log() {} } });
    return JSON.parse(await readFile(path.join(c.dest, '.vc-ocdb/state.json'), 'utf8')).profile;
  };
  assert.equal(await pick(['opencode-go']), 'ocgo-hq');
  assert.equal(await pick(['openai', 'go']), 'oai-ocgo-mix');
  assert.equal(await pick(['openai']), 'oai-hq');
  assert.equal(await pick(['zen']), 'opencode-zen');
  await assert.rejects(pick(['anthropic']), /--providers accepts/);
});

test('direct DeepSeek profile asks for activation to register its provider', async () => {
  const c = await setup();
  const messages = [];
  await executeCommand('install', { configDir: c.dest, sourceDir: c.source, pluginDir: c.pluginDir, modelsFile: c.modelsFile, mode: 'apply', profile: 'deepseek', log: { log(message) { messages.push(message); } } });
  assert.ok(messages.some((message) => message.includes('ocdb activate --apply')));
});

test('hardware plugin files are copied byte-for-byte and ownership-protected', async () => {
  const c = await setup();
  await run('install', c);
  const plugin = 'plugins/ocdb-hw/index.ts';
  assert.deepEqual(await readFile(path.join(c.dest, plugin)), await readFile(path.join(c.pluginDir, 'index.ts')));
  await writeFile(path.join(c.dest, plugin), 'local plugin edit');
  await assert.rejects(run('uninstall', c), /locally modified/);
});

test('plan, dry-run, and status do not create an absent destination', async () => {
  const c = await setup();
  await run('install', c, 'dry-run');
  await run('status', c);
  await run('plan', c);
  await assert.rejects(lstat(c.dest), { code: 'ENOENT' });
  const cli = spawnSync(process.execPath, [path.resolve('bin/vc-ocdb.mjs'), 'install', '--dry-run', '--config-dir', path.join(c.root, 'cli-absent')], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  await assert.rejects(lstat(path.join(c.root, 'cli-absent')), { code: 'ENOENT' });
});

test('does not rewrite existing OpenCode JSON or JSONC files', async () => {
  const c = await setup();
  await mkdir(c.dest, { recursive: true });
  const json = Buffer.from('{"model":"unchanged"}\n');
  const jsonc = Buffer.from('{\n // keep comment\n "model": "unchanged"\n}\n');
  await writeFile(path.join(c.dest, 'opencode.json'), json);
  await writeFile(path.join(c.dest, 'opencode.jsonc'), jsonc);
  await run('install', c);
  assert.deepEqual(await readFile(path.join(c.dest, 'opencode.json')), json);
  assert.deepEqual(await readFile(path.join(c.dest, 'opencode.jsonc')), jsonc);
});

test('foreign collision aborts the whole install before changes', async () => {
  const c = await setup();
  await mkdir(path.join(c.dest, 'agents'), { recursive: true });
  await writeFile(path.join(c.dest, 'agents/VC-Orchestrator.md'), 'foreign');
  await assert.rejects(run('install', c), /unowned destination collision/);
  await assert.rejects(lstat(path.join(c.dest, 'commands/vc-web.md')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(c.dest, 'agents/VC-Orchestrator.md'), 'utf8'), 'foreign');
});

test('incomplete source inventories reject before first install and preserve an existing install', async () => {
  const fresh = await setup();
  await rm(path.join(fresh.source, 'agents'), { recursive: true, force: true });
  await assert.rejects(run('install', fresh), /profile source inventory is incomplete/);
  await assert.rejects(lstat(fresh.dest), { code: 'ENOENT' });

  const installed = await setup();
  await run('install', installed);
  const oldState = await readFile(path.join(installed.dest, '.vc-ocdb/state.json'));
  const oldAgent = await readFile(path.join(installed.dest, 'agents/VC-Orchestrator.md'));
  await rm(path.join(installed.source, 'agents'), { recursive: true, force: true });
  await assert.rejects(run('install', installed), /profile source inventory is incomplete/);
  assert.deepEqual(await readFile(path.join(installed.dest, '.vc-ocdb/state.json')), oldState);
  assert.deepEqual(await readFile(path.join(installed.dest, 'agents/VC-Orchestrator.md')), oldAgent);
});

test('modified owned files prevent updates and uninstall', async () => {
  const c = await setup();
  await run('install', c);
  await writeFile(path.join(c.dest, 'agents/VC-Orchestrator.md'), 'local edit');
  await writeFile(path.join(c.source, 'agents/VC-Orchestrator.md'), '---\ndescription: VC-Orchestrator\n---\nagent-v2\n');
  await assert.rejects(run('install', c), /locally modified/);
  await assert.rejects(run('uninstall', c), /locally modified/);
  assert.equal(await readFile(path.join(c.dest, 'agents/VC-Orchestrator.md'), 'utf8'), 'local edit');
});

test('a stale ledger hash on a file OCDB rendered does not block update or uninstall', async () => {
  const c = await setup();
  await run('install', c);
  const stateFile = path.join(c.dest, '.vc-ocdb/state.json');
  const stale = async () => {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    state.assets['agents/VC-Orchestrator.md'] = '0'.repeat(64);
    await writeFile(stateFile, JSON.stringify(state));
  };
  await stale();
  await run('install', c);
  assert.notEqual(JSON.parse(await readFile(stateFile, 'utf8')).assets['agents/VC-Orchestrator.md'], '0'.repeat(64), 'the update records the real hash');
  await stale();
  await run('uninstall', c);
  await assert.rejects(lstat(path.join(c.dest, 'agents/VC-Orchestrator.md')), { code: 'ENOENT' });
});

test('managed update and uninstall preserve prior bytes in backups', async () => {
  const c = await setup();
  await run('install', c);
  await writeFile(path.join(c.source, 'agents/VC-Orchestrator.md'), '---\ndescription: VC-Orchestrator\n---\nagent-v2\n');
  await run('install', c);
  const backups = path.join(c.dest, '.vc-ocdb/backups');
  const entries = await readdir(backups);
  assert.ok(entries.length >= 1);
  let saved = false;
  for (const entry of entries) {
    try { saved ||= (await readFile(path.join(backups, entry, 'agents/VC-Orchestrator.md'), 'utf8')) === '---\ndescription: VC-Orchestrator\n---\nagent-v1\n'; } catch {}
  }
  assert.ok(saved);
  await run('uninstall', c);
  assert.equal(await readFile(path.join(backups, entries[0], 'agents/VC-Orchestrator.md'), 'utf8'), '---\ndescription: VC-Orchestrator\n---\nagent-v1\n');
  await assert.rejects(lstat(path.join(c.dest, 'agents/VC-Orchestrator.md')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse(await readFile(path.join(c.dest, '.vc-ocdb/state.json'), 'utf8')).assets, {});
});

test('ordinary mid-operation failure rolls back files and always releases the lock', async () => {
  const c = await setup();
  let triggered = false;
  await assert.rejects(executeCommand('install', {
    configDir: c.dest,
    sourceDir: c.source,
    pluginDir: c.pluginDir,
    modelsFile: c.modelsFile,
    mode: 'apply',
    log: { log() {} },
    onMutation: async () => { if (!triggered) { triggered = true; throw new Error('injected ordinary failure'); } },
  }), /injected ordinary failure/);
  assert.equal(triggered, true);
  await assert.rejects(lstat(path.join(c.dest, 'agents/VC-Orchestrator.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, 'commands/vc-web.md')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/state.json')), { code: 'ENOENT' });
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/lock')), { code: 'ENOENT' });
  // A subsequent operation proves that a failed operation did not strand a lock.
  await run('install', c);
});

test('failed restoration leaves durable old-byte backup and releases lock', async () => {
  const c = await setup();
  await run('install', c);
  const ownedFile = path.join(c.dest, 'agents/VC-Orchestrator.md');
  await writeFile(path.join(c.source, 'agents/VC-Orchestrator.md'), '---\ndescription: VC-Orchestrator\n---\nagent-v2\n');
  await assert.rejects(executeCommand('install', {
    configDir: c.dest,
    sourceDir: c.source,
    pluginDir: c.pluginDir,
    modelsFile: c.modelsFile,
    mode: 'apply',
    log: { log() {} },
    onMutation: async (action) => {
      if (action.rel === 'agents/VC-Orchestrator.md') {
        await rm(ownedFile);
        await mkdir(ownedFile);
        throw new Error('injected restore failure');
      }
    },
  }), /injected restore failure; rollback incomplete:/);
  await assert.rejects(lstat(path.join(c.dest, '.vc-ocdb/lock')), { code: 'ENOENT' });
  const backupRoots = await readdir(path.join(c.dest, '.vc-ocdb/backups'));
  let recoveredBytes;
  for (const root of backupRoots) {
    try { recoveredBytes = await readFile(path.join(c.dest, '.vc-ocdb/backups', root, 'agents/VC-Orchestrator.md')); } catch {}
  }
  assert.equal(recoveredBytes?.toString(), '---\ndescription: VC-Orchestrator\n---\nagent-v1\n');
});

test('malformed and traversal ledgers are refused', async () => {
  for (const contents of ['{bad json', JSON.stringify({ version: 1, assets: { '../opencode.json': 'a'.repeat(64) } })]) {
    const c = await setup();
    await mkdir(path.join(c.dest, '.vc-ocdb'), { recursive: true });
    await writeFile(path.join(c.dest, '.vc-ocdb/state.json'), contents);
    await assert.rejects(run('uninstall', c), /corrupt|unsafe managed path/);
  }
});

test('symlink managed paths and lock contention are rejected', async () => {
  const c = await setup();
  await mkdir(c.dest, { recursive: true });
  await symlink(c.root, path.join(c.dest, 'agents'));
  await assert.rejects(run('install', c), /symlink/);
  const d = await setup();
  await mkdir(path.join(d.dest, '.vc-ocdb'), { recursive: true });
  await writeFile(path.join(d.dest, '.vc-ocdb/lock'), 'busy');
  await assert.rejects(run('install', d), /lock/);
});

test('argument parser rejects unknown, conflicting, and malformed flags', () => {
  for (const args of [['install', '--bogus'], ['install', '--apply', '--dry-run'], ['install', '--config-dir'], ['status', '--apply']]) assert.throws(() => parseArgs(args));
  assert.equal(parseArgs([]).command, 'plan');
});
