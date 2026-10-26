#!/usr/bin/env node
// Installs and activates OCDB into a throwaway config directory, starts a private
// `opencode serve` against it, and checks that OpenCode actually loads every agent
// (with its routed model), skill, command, and plugin. Does not touch the live
// OpenCode service or config. Usage: npm run verify:opencode [-- --profile ID]
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, COMMANDS, SKILLS, executeCommand } from '../lib/cli.mjs';
import { ADDON_ROOT } from '../lib/openai-weekly.mjs';

const profileIndex = process.argv.indexOf('--profile');
const profile = profileIndex > 0 ? process.argv[profileIndex + 1] : 'openai';
const quiet = { log() {} };
let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), 'ocdb-verify-'));
const configDir = path.join(root, 'xdg', 'opencode');
const project = path.join(root, 'project');
let server;
try {
  const withQuota = await access(path.join(ADDON_ROOT, 'node_modules')).then(() => true, () => false);
  await executeCommand('install', { configDir, mode: 'apply', profile, activate: true, openaiQuota: withQuota, log: quiet });

  const port = await freePort();
  await mkdir(project, { recursive: true });
  server = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: project,
    env: { ...process.env, XDG_CONFIG_HOME: path.dirname(configDir) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const password = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`opencode serve did not start: ${output.trim()}`)), 30_000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/server password (\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    server.once('exit', (code) => reject(new Error(`opencode serve exited with ${code}: ${output.trim()}`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`, 'content-type': 'application/json' };
  const api = async (route, init) => {
    const response = await fetch(`${base}${route}${route.includes('?') ? '&' : '?'}directory=${encodeURIComponent(project)}`, { headers, ...init });
    return response.json();
  };

  // The first listing after startup can come back before discovery finishes.
  let agents = [];
  for (let attempt = 0; attempt < 30 && !agents.some((agent) => agent.id === 'VC-Orchestrator'); attempt++) {
    agents = (await api('/api/agent')).data ?? [];
    if (!agents.some((agent) => agent.id === 'VC-Orchestrator')) await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  console.log(`OpenCode loaded OCDB (profile ${profile}) from ${configDir}`);
  for (const id of AGENTS) {
    const agent = agents.find((candidate) => candidate.id === id);
    const source = await readFile(path.join(configDir, 'agents', `${id}.md`), 'utf8');
    const expected = source.match(/^model:\s*(\S+)\s*$/m)?.[1] ?? null;
    const model = agent?.model ? `${agent.model.providerID}/${agent.model.id}${agent.model.variant ? `#${agent.model.variant}` : ''}` : null;
    check(Boolean(agent) && model === expected, `agent ${id}`, agent ? (model ?? 'inherits model') : 'not loaded');
  }

  const config = await api('/api/config');
  const document = config.find?.((entry) => entry.type === 'document')?.info ?? {};
  check(document.default_agent === 'VC-Orchestrator', 'default agent', String(document.default_agent));

  const skills = new Set(((await api('/api/skill')).data ?? []).map((skill) => skill.id));
  for (const id of SKILLS) check(skills.has(id), `skill ${id}`);

  const commands = new Set(((await api('/api/command')).data ?? []).map((command) => command.name));
  for (const id of COMMANDS) check(commands.has(id), `command /${id}`);

  const plugins = (await api('/api/plugin')).data ?? [];
  const active = (id) => plugins.find((plugin) => plugin.id === id)?.state?.status === 'active';
  check(active('ocdb.hardware'), 'plugin ocdb.hardware');
  if (withQuota) {
    check(active('openai-weekly.server'), 'plugin openai-weekly.server');
    const quota = await api('/api/rpc/openai-weekly/status', { method: 'POST', body: JSON.stringify({ input: {} }) });
    check(typeof quota.output?.status === 'string', 'quota RPC answers', quota.output?.status ?? JSON.stringify(quota).slice(0, 120));
  } else {
    console.log('- quota add-on skipped (run npm ci in addons/openai-weekly to include it)');
  }
} catch (error) {
  check(false, 'verification run', error.message);
} finally {
  server?.kill();
  await rm(root, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
