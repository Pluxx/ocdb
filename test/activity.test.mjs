import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeActivity } from '../plugins/ocdb-hw/activity.mjs';

function fakeSession(sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const root = (id) => { let s = byId.get(id); while (s?.parentID) s = byId.get(s.parentID); return s?.id ?? id; };
  return {
    root,
    family: (id) => sessions.filter((s) => root(s.id) === id).map((s) => s.id),
    get: (id) => byId.get(id),
    status: (id) => byId.get(id)?.status ?? 'idle',
  };
}

test('summarizes the lead agent and running subagents from any session in the tree', () => {
  const session = fakeSession([
    { id: 'root', agent: 'vc-web', status: 'running' },
    { id: 'a', parentID: 'root', agent: 'vc-explorer', title: 'Find routes', status: 'running' },
    { id: 'b', parentID: 'root', agent: 'vc-symfony', status: 'idle' },
    { id: 'c', parentID: 'a', agent: 'vc-tester', status: 'running' },
  ]);
  for (const viewed of ['root', 'c']) {
    const summary = summarizeActivity(session, viewed);
    assert.equal(summary.agent, 'vc-web');
    assert.equal(summary.running, true);
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.active.map((child) => child.agent), ['vc-explorer', 'vc-tester']);
  }
});

test('degrades to an idle summary when host lookups throw or are missing', () => {
  const broken = { root() { throw new Error('x'); }, family() { throw new Error('x'); }, get() { throw new Error('x'); }, status() { throw new Error('x'); } };
  assert.deepEqual(summarizeActivity(broken, 's1'), { agent: null, running: false, total: 0, active: [] });
  assert.equal(summarizeActivity(broken, ''), null);
});
