import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addonLink, addonState, installAddon, uninstallAddon } from '../lib/openai-weekly.mjs';
import { parseArgs } from '../lib/cli.mjs';

const quiet = { log() {} };
const roots = new Set();
test.after(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vc-ocdb-addon-'));
  roots.add(root);
  const addon = path.join(root, 'addon');
  await mkdir(addon, { recursive: true });
  await writeFile(path.join(addon, 'package.json'), JSON.stringify({ name: 'opencode-openai-weekly', dependencies: {} }));
  return { root, addon, dest: path.join(root, 'opencode') };
}

test('install links the add-on, is idempotent, and uninstall removes only its own link', async () => {
  const c = await fixture();
  await installAddon(c.dest, { mode: 'dry-run', log: quiet, root: c.addon });
  assert.equal(await addonState(c.dest, c.addon), 'absent');
  await installAddon(c.dest, { mode: 'apply', log: quiet, root: c.addon });
  assert.equal(await readlink(addonLink(c.dest)), c.addon);
  await installAddon(c.dest, { mode: 'apply', log: quiet, root: c.addon });
  assert.equal(await addonState(c.dest, c.addon), 'installed');
  assert.equal(await uninstallAddon(c.dest, { mode: 'apply', log: quiet, root: c.addon }), true);
  await assert.rejects(lstat(addonLink(c.dest)), { code: 'ENOENT' });
});

test('install replaces a link to the old standalone add-on checkout', async () => {
  const c = await fixture();
  const legacy = path.join(c.root, 'vc_oc2addon_openai');
  await mkdir(legacy);
  await writeFile(path.join(legacy, 'package.json'), JSON.stringify({ name: 'opencode-openai-weekly' }));
  await mkdir(path.dirname(addonLink(c.dest)), { recursive: true });
  await symlink(legacy, addonLink(c.dest));
  assert.equal(await addonState(c.dest, c.addon), 'legacy');
  await installAddon(c.dest, { mode: 'apply', log: quiet, root: c.addon });
  assert.equal(await readlink(addonLink(c.dest)), c.addon);
});

test('install refuses foreign paths and uninstall leaves them alone', async () => {
  const c = await fixture();
  await mkdir(addonLink(c.dest), { recursive: true });
  await assert.rejects(installAddon(c.dest, { mode: 'apply', log: quiet, root: c.addon }), /not an OpenAI weekly add-on link/);
  assert.equal(await uninstallAddon(c.dest, { mode: 'apply', log: quiet, root: c.addon }), false);
  assert.ok((await lstat(addonLink(c.dest))).isDirectory());
});

test('quota flags are limited to setup/install and --codex-quota needs --openai-quota', () => {
  assert.equal(parseArgs(['setup', '--profile', 'openai', '--openai-quota', '--codex-quota']).codexQuota, true);
  assert.throws(() => parseArgs(['setup', '--codex-quota']), /requires --openai-quota/);
  assert.throws(() => parseArgs(['activate', '--openai-quota']), /does not accept --openai-quota/);
});
