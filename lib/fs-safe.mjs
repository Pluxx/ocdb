// File helpers shared by the installer and activation: everything OCDB writes
// under the OpenCode config directory goes through these.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const LEDGER = '.vc-ocdb';
export class CliError extends Error {}
export const fail = (message) => { throw new CliError(message); };
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function maybeStat(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** lstat of `root/rel`, refusing symlinks anywhere on the way (root included). */
export async function inspectPath(root, rel) {
  let cursor = root;
  for (const part of ['', ...rel.split('/')]) {
    cursor = path.join(cursor, part);
    const st = await maybeStat(cursor);
    if (!st) return null;
    if (st.isSymbolicLink()) fail(`symlink in managed path: ${path.relative(root, cursor) || root}`);
    if (cursor !== path.join(root, rel) && !st.isDirectory()) fail(`managed path component is not a directory: ${path.relative(root, cursor)}`);
  }
  return maybeStat(path.join(root, rel));
}

/** Bytes of a regular file at `root/rel`, or null if it doesn't exist. */
export async function readIfExists(root, rel) {
  const st = await inspectPath(root, rel);
  if (!st) return null;
  if (!st.isFile()) fail(`${rel} must be a regular file`);
  return readFile(path.join(root, rel));
}

/** Creates the missing directories of `relDir` under `root`; records each new one in `created`. */
export async function ensureDir(root, relDir, created = []) {
  let cursor = root;
  for (const part of relDir.split('/').filter(Boolean)) {
    cursor = path.join(cursor, part);
    const st = await maybeStat(cursor);
    if (st?.isSymbolicLink()) fail(`symlink in managed path: ${path.relative(root, cursor)}`);
    if (st && !st.isDirectory()) fail(`managed path component is not a directory: ${path.relative(root, cursor)}`);
    if (!st) { await mkdir(cursor); created.push(cursor); }
  }
}

export async function atomicWrite(file, bytes) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await rename(temp, file); }
  catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error; }
}

/** Copies `bytes` to a fresh `.vc-ocdb/backups/<id>/<rel>` and returns that relative path. */
export async function backup(dest, rel, bytes) {
  const backupRel = `${LEDGER}/backups/${Date.now()}-${randomUUID()}/${rel}`;
  await ensureDir(dest, path.posix.dirname(backupRel));
  await atomicWrite(path.join(dest, backupRel), bytes);
  return backupRel;
}

export async function withLock(dest, work) {
  await mkdir(dest, { recursive: true });
  const st = await lstat(dest);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('config destination must be a real directory, not a symlink');
  await ensureDir(dest, LEDGER);
  const lock = path.join(dest, LEDGER, 'lock');
  const handle = await open(lock, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') fail('another vc-ocdb operation holds the lock');
    throw error;
  });
  try { return await work(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}
