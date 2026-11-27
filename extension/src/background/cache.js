// Keeps verdicts so revisiting a deal doesn't pay for another analysis, and
// each deal's follow-up chat so it's still there when you come back.

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Chats are short text, but there's no reason to keep more than a busy day's worth.
export const MAX_CHATS = 50;

const VERDICT_PREFIX = 'verdict:';
const CHAT_PREFIX = 'chat:';
const DISCOUNT_PREFIX = 'discounts:';
const PREFIXES = [VERDICT_PREFIX, CHAT_PREFIX, DISCOUNT_PREFIX];
// Bump when the shape of a stored entry changes, so older entries are never
// handed to code that can't read them. pruneCache() still clears them out.
// v4: confidence is worked out from the price checks, and verdicts can be simple.
const VERDICT_SCHEMA = 'v4';
const CHAT_SCHEMA = 'v1';
const DISCOUNT_SCHEMA = 'v1';

// `profile` is the model, or profileOf() in settings.js: the model, simple or
// detailed, and the language, since each gives a different verdict.
export function cacheKey(dealKey, profile) {
  return `${VERDICT_PREFIX}${VERDICT_SCHEMA}:${profile}:${dealKey}`;
}

export function chatKey(dealKey, profile) {
  return `${CHAT_PREFIX}${CHAT_SCHEMA}:${profile}:${dealKey}`;
}

export function discountCacheKey(key, profile) {
  return `${DISCOUNT_PREFIX}${DISCOUNT_SCHEMA}:${profile}:${key}`;
}

async function getFresh(storage, key, field, now) {
  const entry = (await storage.get(key))[key];
  if (!entry || now - entry.savedAt > CACHE_TTL_MS) return null;
  return entry[field];
}

export function getCached(storage, dealKey, model, now = Date.now()) {
  return getFresh(storage, cacheKey(dealKey, model), 'result', now);
}

export async function putCached(storage, dealKey, model, result, now = Date.now()) {
  await storage.set({ [cacheKey(dealKey, model)]: { savedAt: now, result } });
  await pruneCache(storage, now);
}

/** @returns {Promise<{turns: {role: string, text: string}[]}|null>} */
export function getChat(storage, dealKey, model, now = Date.now()) {
  return getFresh(storage, chatKey(dealKey, model), 'chat', now);
}

export async function putChat(storage, dealKey, model, chat, now = Date.now()) {
  await storage.set({ [chatKey(dealKey, model)]: { savedAt: now, chat } });
  await pruneCache(storage, now);
}

/** Discounts found for a store and brand (see discountKey() in discounts.js). */
export function getDiscounts(storage, key, profile, now = Date.now()) {
  return getFresh(storage, discountCacheKey(key, profile), 'result', now);
}

export async function putDiscounts(storage, key, profile, result, now = Date.now()) {
  await storage.set({ [discountCacheKey(key, profile)]: { savedAt: now, result } });
  await pruneCache(storage, now);
}

/**
 * Drops expired verdicts, discounts and conversations, and conversations
 * beyond the newest MAX_CHATS. Pass `all` to clear them entirely.
 * @returns {Promise<number>} entries removed
 */
export async function pruneCache(storage, now = Date.now(), { all = false } = {}) {
  const entries = Object.entries(await storage.get(null));
  const expired = ([, entry]) => all || !entry || now - entry.savedAt > CACHE_TTL_MS;

  const stale = entries.filter((e) => PREFIXES.some((p) => e[0].startsWith(p)) && expired(e));
  const extraChats = entries
    .filter((e) => e[0].startsWith(CHAT_PREFIX) && !expired(e))
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(MAX_CHATS);

  const keys = [...stale, ...extraChats].map(([key]) => key);
  if (keys.length) await storage.remove(keys);
  return keys.length;
}
