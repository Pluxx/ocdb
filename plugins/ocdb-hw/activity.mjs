function attempt(read, fallback) {
  try { return read() ?? fallback; } catch { return fallback; }
}

/**
 * Summarize the agent tree of the session shown in the sidebar. `session` is the
 * TUI plugin's `context.data.session` (root, family, get, status).
 */
export function summarizeActivity(session, sessionID) {
  if (!sessionID) return null;
  const root = attempt(() => session.root(sessionID), sessionID);
  const ids = attempt(() => session.family(root), [root]);
  const running = (id) => attempt(() => session.status(id), 'idle') === 'running';
  const children = ids.filter((id) => id !== root).map((id) => {
    const info = attempt(() => session.get(id), {});
    return { id, agent: info.agent ?? 'subagent', title: info.title ?? '', running: running(id) };
  });
  return {
    agent: attempt(() => session.get(root)?.agent, null),
    running: running(root),
    total: children.length,
    active: children.filter((child) => child.running),
  };
}
