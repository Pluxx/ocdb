import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

test('package metadata, lockfile, executable aliases, and packed runtime assets agree', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.engines.node, '>=22');
  assert.deepEqual(pkg.bin, { 'vc-ocdb': 'bin/vc-ocdb.mjs', ocdb: 'bin/vc-ocdb.mjs' });
  assert.equal(pkg.dependencies['jsonc-parser'], '3.3.1');
  assert.equal(lock.packages[''].dependencies['jsonc-parser'], '3.3.1');
  assert.equal(lock.packages['node_modules/jsonc-parser'].version, '3.3.1');
  assert.ok((await stat('bin/vc-ocdb.mjs')).mode & 0o111, 'bin entrypoint must be executable');

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(packed.status, 0, packed.stderr);
  const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
  for (const file of ['bin/vc-ocdb.mjs', 'lib/activation.mjs', 'lib/model-profiles.mjs', 'profiles/models.json', 'profiles/web/agents/VC-Orchestrator.md', 'plugins/ocdb-hw/index.ts', 'plugins/ocdb-hw/tui.tsx', 'plugins/ocdb-hw/metrics.mjs', 'plugins/ocdb-hw/activity.mjs', 'plugins/ocdb-hw/package.json']) assert.ok(files.has(file), `packed package missing ${file}`);
});
