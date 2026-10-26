import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemSampler } from '../plugins/ocdb-hw/metrics.mjs';

const proc = (cpu, mem = 'MemTotal: 100 kB\nMemAvailable: 40 kB\nMemFree: 1 kB\n') => ({
  '/proc/stat': cpu,
  '/proc/meminfo': mem,
});

function injectedLinux(samples, extra = {}) {
  let index = 0;
  return createSystemSampler({
    platform: 'linux',
    readFile: async (file) => {
      const sample = samples[Math.min(index, samples.length - 1)];
      if (file === '/proc/meminfo') index++;
      const value = sample?.[file];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`missing ${file}`);
      return value;
    },
    totalmem: () => 1000,
    freemem: () => 250,
    ...extra,
  });
}

test('Linux CPU reports proper aggregate delta across all cores, including idle and iowait', async () => {
  const sampler = injectedLinux([
    proc('cpu 100 10 20 200 10 5 5 0 50 3\ncpu0 1 2 3 4'),
    proc('cpu 150 15 30 220 15 10 10 0 75 4\ncpu0 1 2 3 4'),
  ]);
  assert.equal((await sampler()).cpuPercent, null);
  // Guest counters are excluded: total delta 100, idle+iowait delta 25.
  assert.equal((await sampler()).cpuPercent, 75);
});

test('Linux CPU handles no progress, reset, malformed and missing proc data as null', async () => {
  const sampler = injectedLinux([
    proc('cpu 10 0 0 20 0 0 0 0'),
    proc('cpu 10 0 0 20 0 0 0 0'),
    proc('cpu 2 0 0 5 0 0 0 0'),
    proc('cpu broken 0 0 5'),
    proc('cpu 5 0 0 10 0 0 0 0'),
  ]);
  assert.equal((await sampler()).cpuPercent, null);
  assert.equal((await sampler()).cpuPercent, null);
  assert.equal((await sampler()).cpuPercent, null);
  assert.equal((await sampler()).cpuPercent, null);
  // Reset sample became the baseline; malformed sample did not replace it.
  assert.equal((await sampler()).cpuPercent, 37.5);
});

test('Linux memory prefers MemAvailable, converts kB to bytes, and bounds values', async () => {
  const sampler = injectedLinux([proc('cpu 1 0 0 1', 'MemTotal: 100 kB\nMemAvailable: 40 kB\nMemFree: 99 kB\n')]);
  assert.deepEqual((await sampler()).memory, {
    totalBytes: 102400, availableBytes: 40960, usedBytes: 61440, availableLabel: 'available',
  });
  const bounded = injectedLinux([proc('cpu 1 0 0 1', 'MemTotal: 100 kB\nMemAvailable: 200 kB\n')]);
  assert.deepEqual((await bounded()).memory, {
    totalBytes: 102400, availableBytes: 102400, usedBytes: 0, availableLabel: 'available',
  });
});

test('missing or malformed MemAvailable falls back to os free memory with honest label', async () => {
  for (const mem of ['MemTotal: 100 kB\nMemFree: 90 kB\n', 'not meminfo']) {
    const sampler = injectedLinux([proc('cpu 1 0 0 1', mem)]);
    assert.deepEqual((await sampler()).memory, {
      totalBytes: 1000, availableBytes: 250, usedBytes: 750, availableLabel: 'free',
    });
  }
});

test('non-Linux uses all-core os.cpus deltas and free-memory fallback', async () => {
  let tick = 0;
  const cpuSamples = [
    [{ times: { user: 10, nice: 0, sys: 0, idle: 90, irq: 0 } }, { times: { user: 10, nice: 0, sys: 0, idle: 90, irq: 0 } }],
    [{ times: { user: 30, nice: 0, sys: 0, idle: 90, irq: 0 } }, { times: { user: 10, nice: 0, sys: 0, idle: 110, irq: 0 } }],
  ];
  const sampler = createSystemSampler({
    platform: 'darwin', cpus: () => cpuSamples[tick++], totalmem: () => 500, freemem: () => 125,
  });
  assert.equal((await sampler()).cpuPercent, null);
  const result = await sampler();
  assert.equal(result.cpuPercent, 50);
  assert.deepEqual(result.memory, { totalBytes: 500, availableBytes: 125, usedBytes: 375, availableLabel: 'free' });
  assert.equal(result.scope, 'local machine');
});

test('read and OS errors degrade to null readings without throwing', async () => {
  const sampler = createSystemSampler({
    platform: 'linux', readFile: async () => { throw new Error('unavailable'); },
    totalmem: () => { throw new Error('unavailable'); }, freemem: () => 0,
  });
  assert.deepEqual(await sampler(), {
    cpuPercent: null,
    memory: { totalBytes: null, availableBytes: null, usedBytes: null, availableLabel: 'available' },
    scope: 'local machine',
  });
});

test('invalid OS memory numbers produce nulls', async () => {
  const sampler = createSystemSampler({ platform: 'win32', totalmem: () => NaN, freemem: () => -1 });
  assert.deepEqual((await sampler()).memory, {
    totalBytes: null, availableBytes: null, usedBytes: null, availableLabel: 'free',
  });
});
