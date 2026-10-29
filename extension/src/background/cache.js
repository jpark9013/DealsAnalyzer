// Keeps verdicts so revisiting a deal doesn't pay for another analysis.

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PREFIX = 'verdict:';

export function cacheKey(dealKey, model) {
  return `${PREFIX}${model}:${dealKey}`;
}

export async function getCached(storage, dealKey, model, now = Date.now()) {
  const key = cacheKey(dealKey, model);
  const entry = (await storage.get(key))[key];
  if (!entry || now - entry.savedAt > CACHE_TTL_MS) return null;
  return entry.result;
}

export async function putCached(storage, dealKey, model, result, now = Date.now()) {
  await storage.set({ [cacheKey(dealKey, model)]: { savedAt: now, result } });
  await pruneCache(storage, now);
}

/** Drops expired entries; pass `all` to clear every cached verdict. */
export async function pruneCache(storage, now = Date.now(), { all = false } = {}) {
  const everything = await storage.get(null);
  const stale = Object.entries(everything)
    .filter(([key, entry]) => key.startsWith(PREFIX) && (all || !entry || now - entry.savedAt > CACHE_TTL_MS))
    .map(([key]) => key);
  if (stale.length) await storage.remove(stale);
  return stale.length;
}
