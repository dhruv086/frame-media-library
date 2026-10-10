const pending = new Map();

/** Serialize modifications to the same asset within this server process. */
export async function withLock(key, action) {
  const previous = pending.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  pending.set(key, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (pending.get(key) === current) pending.delete(key);
  }
}
