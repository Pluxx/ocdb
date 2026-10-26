#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function findTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(path));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

try {
  const tests = (await findTests(join(repository, 'tests'))).sort();
  if (tests.length === 0) {
    throw new Error(`No tests matching tests/**/*.test.ts found in ${repository}`);
  }
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', ...tests], {
    cwd: repository,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) process.exitCode = 1;
  else process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Test runner failed: ${error.message}`);
  process.exitCode = 1;
}
