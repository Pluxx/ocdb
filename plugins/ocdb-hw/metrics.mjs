import { readFile as nodeReadFile } from 'node:fs/promises';
import os from 'node:os';

function nonnegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseCpuStat(contents) {
  if (typeof contents !== 'string') return null;
  const row = contents.split(/\r?\n/).find((line) => /^cpu\s/.test(line));
  if (!row) return null;
  const fields = row.trim().split(/\s+/).slice(1);
  if (fields.length < 4) return null;
  const counters = fields.map((field) => {
    if (!/^\d+$/.test(field)) return null;
    const value = Number(field);
    return Number.isSafeInteger(value) ? value : null;
  });
  if (counters.some((value) => value === null)) return null;

  // Linux includes guest and guest_nice in user and nice; do not count them twice.
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = counters;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const idleTotal = idle + iowait;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(idleTotal)) return null;
  return { total, idle: idleTotal };
}

function parseMeminfo(contents) {
  if (typeof contents !== 'string') return null;
  const values = new Map();
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^(MemTotal|MemAvailable):\s*(\d+)\s*kB\s*$/i);
    if (match) values.set(match[1].toLowerCase(), Number(match[2]));
  }
  const totalKb = values.get('memtotal');
  const availableKb = values.get('memavailable');
  if (!Number.isSafeInteger(totalKb) || !Number.isSafeInteger(availableKb)) return null;
  const totalBytes = totalKb * 1024;
  const availableBytes = availableKb * 1024;
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null;
  return { totalBytes, availableBytes };
}

/**
 * Create a sampler for the local machine. Injection options are platform (string),
 * readFile(path, encoding) (async or sync), cpus() and totalmem()/freemem() (Node os signatures).
 */
export function createSystemSampler(options = {}) {
  const platform = options.platform ?? process.platform;
  const readFile = options.readFile ?? nodeReadFile;
  const cpus = options.cpus ?? os.cpus;
  const totalmem = options.totalmem ?? os.totalmem;
  const freemem = options.freemem ?? os.freemem;
  let previousCpu = null;

  return async function sample() {
    let cpuPercent = null;
    if (platform === 'linux') {
      try {
        const current = parseCpuStat(await readFile('/proc/stat', 'utf8'));
        if (current) {
          if (previousCpu) {
            const totalDelta = current.total - previousCpu.total;
            const idleDelta = current.idle - previousCpu.idle;
            if (totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) {
              cpuPercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
            }
          }
          // A reset establishes a fresh baseline; malformed samples leave the last baseline intact.
          previousCpu = current;
        }
      } catch { /* Unavailable proc data yields null for this sample. */ }
    } else {
      try {
        const cores = cpus();
        if (Array.isArray(cores) && cores.length > 0) {
          let total = 0;
          let idle = 0;
          let valid = true;
          for (const core of cores) {
            const times = core?.times;
            if (!times || !['user', 'nice', 'sys', 'idle', 'irq'].every((key) => Number.isFinite(times[key]) && times[key] >= 0)) {
              valid = false;
              break;
            }
            total += times.user + times.nice + times.sys + times.idle + times.irq;
            idle += times.idle;
          }
          if (valid && Number.isFinite(total) && Number.isFinite(idle)) {
            if (previousCpu) {
              const totalDelta = total - previousCpu.total;
              const idleDelta = idle - previousCpu.idle;
              if (totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta) {
                cpuPercent = Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
              }
            }
            previousCpu = { total, idle };
          }
        }
      } catch { /* Unavailable OS counters yield null for this sample. */ }
    }

    let memory = null;
    if (platform === 'linux') {
      try {
        const parsed = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
        if (parsed) {
          const availableBytes = Math.min(parsed.totalBytes, parsed.availableBytes);
          memory = {
            totalBytes: parsed.totalBytes,
            availableBytes,
            usedBytes: parsed.totalBytes - availableBytes,
            availableLabel: 'available',
          };
        }
      } catch { /* Fall through to the portable free-memory estimate. */ }
    }
    if (!memory) {
      try {
        const total = nonnegativeNumber(totalmem());
        const free = nonnegativeNumber(freemem());
        if (total !== null && free !== null) {
          const availableBytes = Math.min(total, free);
          memory = {
            totalBytes: total,
            availableBytes,
            usedBytes: total - availableBytes,
            availableLabel: 'free',
          };
        }
      } catch { /* Missing OS readings are represented as nulls. */ }
    }

    return {
      cpuPercent,
      memory: memory ?? { totalBytes: null, availableBytes: null, usedBytes: null, availableLabel: platform === 'linux' ? 'available' : 'free' },
      scope: 'local machine',
    };
  };
}
