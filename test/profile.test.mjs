import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve('.');
const profile = path.join(repo, 'profiles/web');
const agents = ['VC-Orchestrator', 'VC-Symfony', 'VC-DDEV', 'VC-Design', 'VC-Frontend', 'VC-Reviewer', 'VC-Tester', 'VC-Solver', 'VC-Explorer', 'VC-Librarian'];
const skills = ['vc-symfony', 'vc-ddev', 'vc-web-design', 'vc-tailwind', 'vc-solving', 'vc-TYPO3', 'vc-TYPO3-upgrade'];
const commands = ['vc-web', 'vc-plan', 'vc-check', 'vc-solve', 'vc-solve-max', 'vc-t3u'];

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) assert.fail(`profile must not contain symlink: ${target}`);
    if (entry.isDirectory()) files.push(...await markdownFiles(target));
    else if (entry.isFile()) files.push(path.relative(profile, target).split(path.sep).join('/'));
    else assert.fail(`unsupported profile entry: ${target}`);
  }
  return files;
}

async function text(relative) { return readFile(path.join(profile, relative), 'utf8'); }
function frontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, 'expected native Markdown frontmatter');
  return match[1];
}

test('assembled profile has exactly the 23 expected allowlisted Markdown assets and installs through CLI', async () => {
  const expected = [
    ...agents.map((id) => `agents/${id}.md`),
    ...skills.map((id) => `skills/${id}/SKILL.md`),
    ...commands.map((id) => `commands/${id}.md`),
  ].sort();
  assert.deepEqual((await markdownFiles(profile)).sort(), expected);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-profile-'));
  try {
    const destination = path.join(temp, 'config');
    const proc = spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), 'install', '--apply', '--config-dir', destination], { cwd: repo, encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    const state = JSON.parse(await readFile(path.join(destination, '.vc-ocdb/state.json'), 'utf8'));
    assert.equal(Object.keys(state.assets).length, 28);
    assert.deepEqual(Object.keys(state.assets).filter((rel) => !rel.startsWith('plugins/')).sort(), expected);
    assert.deepEqual(Object.keys(state.assets).filter((rel) => rel.startsWith('plugins/')).sort(), ['plugins/ocdb-hw/activity.mjs', 'plugins/ocdb-hw/index.ts', 'plugins/ocdb-hw/metrics.mjs', 'plugins/ocdb-hw/package.json', 'plugins/ocdb-hw/tui.tsx']);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('solver routing and OpenCode command policy remain explicit and bounded', async () => {
  const solver = frontmatter(await text('agents/VC-Solver.md'));
  assert.match(solver, /^model: openai\/gpt-6-astra#high$/m);
  assert.match(solver, /^steps: 10$/m);
  assert.doesNotMatch(solver, /^model: openai\/gpt-6-astra#(?:max|low)$/m);

  const lead = frontmatter(await text('agents/VC-Orchestrator.md'));
  const solverRules = lead.split(/(?=^  - action: subagent\n)/m).filter((rule) => /^  - action: subagent\n    resource: VC-Solver$/m.test(rule));
  assert.equal(solverRules.length, 1, 'lead must declare one specific solver permission');
  assert.match(solverRules[0], /^    effect: ask$/m, 'solver must be ask, never allow');

  for (const id of ['VC-Symfony', 'VC-DDEV', 'VC-Design', 'VC-Frontend', 'VC-Reviewer', 'VC-Tester', 'VC-Solver', 'VC-Explorer', 'VC-Librarian']) {
    const body = frontmatter(await text(`agents/${id}.md`));
    assert.match(body, /^mode: subagent$/m, `${id} must be a specialist subagent`);
    assert.match(body, /^  - action: subagent\n    resource: ["']?\*["']?\n    effect: deny$/m, `${id} must deny onward delegation`);
  }

  const regularCommand = frontmatter(await text('commands/vc-solve.md'));
  const maxCommand = frontmatter(await text('commands/vc-solve-max.md'));
  assert.match(regularCommand, /^agent: VC-Solver$/m);
  assert.doesNotMatch(regularCommand, /^model:/m, 'vc-solve inherits the solver high route');
  assert.match(maxCommand, /^agent: VC-Solver$/m);
  assert.match(maxCommand, /^model: openai\/gpt-6-astra#max$/m, 'explicit max command overrides the route');

  for (const relative of [...agents.map((id) => `agents/${id}.md`), ...commands.map((id) => `commands/${id}.md`)]) {
    const source = await text(relative);
    assert.doesNotMatch(frontmatter(source), /^(?:temperature|top_p|max_tokens|maxSteps|tools):/m, `${relative} contains unsupported V1-style fields`);
    assert.doesNotMatch(source, /^!\s*`[^`]+`/m, `${relative} contains a shell-interpolation command block`);
  }
});

test('non-TTY setup selects only declared providers and prefers OpenAI only when declared', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-selection-'));
  try {
    const openaiDest = path.join(root, 'openai');
    const openai = spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), 'setup', '--providers', 'openai,opencode-go', '--apply', '--config-dir', openaiDest], { cwd: repo, encoding: 'utf8' });
    assert.equal(openai.status, 0, openai.stderr);
    assert.equal(JSON.parse(await readFile(path.join(openaiDest, '.vc-ocdb/state.json'), 'utf8')).profile, 'openai');
    assert.match(await readFile(path.join(openaiDest, 'agents/VC-Solver.md'), 'utf8'), /^model: openai\/gpt-6-astra#high$/m);

    const goDest = path.join(root, 'go');
    const go = spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), 'setup', '--providers', 'opencode-go', '--apply', '--config-dir', goDest], { cwd: repo, encoding: 'utf8' });
    assert.equal(go.status, 0, go.stderr);
    assert.equal(JSON.parse(await readFile(path.join(goDest, '.vc-ocdb/state.json'), 'utf8')).profile, 'opencode-go');
    const goSolver = await readFile(path.join(goDest, 'agents/VC-Solver.md'), 'utf8');
    assert.match(goSolver, /^model: opencode-go\/qwen3\.8-max#medium$/m);
    assert.doesNotMatch(goSolver, /openai\/gpt-6-astra|openai\/gpt-6\.1-sol/);

    const noSelection = path.join(root, 'no-selection');
    const rejected = spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), 'setup', '--config-dir', noSelection], { cwd: repo, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /requires --profile or --providers/);
    await assert.rejects(readFile(path.join(noSelection, '.vc-ocdb/state.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--profile without --providers selects that profile through the public CLI', async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-profile-only-'));
  try {
    const proc = spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), 'setup', '--profile', 'opencode-go', '--dry-run', '--config-dir', dest], { cwd: repo, encoding: 'utf8' });
    assert.equal(proc.status, 0, proc.stderr);
    assert.doesNotMatch(proc.stderr, /not included in --providers/);
  } finally { await rm(dest, { recursive: true, force: true }); }
});

test('updating an install from before the VC-Orchestrator rename removes the old vc-web agent', async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-rename-'));
  try {
    const cli = (...args) => spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), ...args, '--config-dir', dest], { cwd: repo, encoding: 'utf8' });
    assert.equal(cli('install', '--apply').status, 0);
    const { writeFile, rename } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    // Recreate the pre-rename layout: the lead lived at agents/vc-web.md.
    await rename(path.join(dest, 'agents/VC-Orchestrator.md'), path.join(dest, 'agents/vc-web.md'));
    const ledger = JSON.parse(await readFile(path.join(dest, '.vc-ocdb/state.json'), 'utf8'));
    const bytes = await readFile(path.join(dest, 'agents/vc-web.md'));
    delete ledger.assets['agents/VC-Orchestrator.md'];
    ledger.assets['agents/vc-web.md'] = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(dest, '.vc-ocdb/state.json'), JSON.stringify(ledger));
    const update = cli('install', '--apply');
    assert.equal(update.status, 0, update.stderr);
    await assert.rejects(readFile(path.join(dest, 'agents/vc-web.md')), { code: 'ENOENT' });
    const after = JSON.parse(await readFile(path.join(dest, '.vc-ocdb/state.json'), 'utf8'));
    assert.ok(after.assets['agents/VC-Orchestrator.md']);
    assert.equal(after.assets['agents/vc-web.md'], undefined);
  } finally { await rm(dest, { recursive: true, force: true }); }
});

test('updating removes the folders of retired skills once they are empty', async () => {
  const dest = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-skilldir-'));
  try {
    const cli = (...args) => spawnSync(process.execPath, [path.join(repo, 'bin/vc-ocdb.mjs'), ...args, '--config-dir', dest], { cwd: repo, encoding: 'utf8' });
    assert.equal(cli('install', '--apply').status, 0);
    const { mkdir, rename, writeFile, readdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    // Recreate the layout from before the TYPO3 rename.
    await mkdir(path.join(dest, 'skills/vc-typo3'));
    await rename(path.join(dest, 'skills/vc-TYPO3/SKILL.md'), path.join(dest, 'skills/vc-typo3/SKILL.md'));
    await rm(path.join(dest, 'skills/vc-TYPO3'), { recursive: true });
    const ledger = JSON.parse(await readFile(path.join(dest, '.vc-ocdb/state.json'), 'utf8'));
    delete ledger.assets['skills/vc-TYPO3/SKILL.md'];
    ledger.assets['skills/vc-typo3/SKILL.md'] = createHash('sha256').update(await readFile(path.join(dest, 'skills/vc-typo3/SKILL.md'))).digest('hex');
    await writeFile(path.join(dest, '.vc-ocdb/state.json'), JSON.stringify(ledger));
    const update = cli('install', '--apply');
    assert.equal(update.status, 0, update.stderr);
    const skills = await readdir(path.join(dest, 'skills'));
    assert.ok(skills.includes('vc-TYPO3'));
    assert.ok(!skills.includes('vc-typo3'));
  } finally { await rm(dest, { recursive: true, force: true }); }
});
