// Puts the extension's own words (the panel's labels, the settings page) into
// the shopper's language. Claude translates them once per language and the
// result is kept, so it costs a fraction of a cent the first time and nothing
// after. Claude's verdicts are written in that language directly (prompt.js).

import { MODELS, isEnglish } from './settings.js';
import { callMessages, requireKey } from './claude.js';

const PREFIX = 'ui-strings:';

// A short, stable fingerprint of the English text, so a new release's new
// wording is translated again rather than matched to an old translation.
export function textsHash(texts) {
  let h = 2166136261;
  for (const ch of texts.join('\u0001')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const placeholders = (s) => (String(s).match(/\{[a-z_]+\}/g) || []).sort().join();

/**
 * Reads Claude's numbered lines back into a list the length of `texts`. A line
 * that's missing, far too long, or lost a {placeholder} stays in English.
 */
export function parseTranslation(reply, texts) {
  const out = [...texts];
  for (const line of String(reply || '').split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s?(.*)$/);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    const text = m[2].trim();
    if (i < 0 || i >= texts.length || !text) continue;
    if (text.length > Math.max(40, texts[i].length * 4)) continue;
    if (placeholders(text) !== placeholders(texts[i])) continue;
    out[i] = text;
  }
  return out;
}

async function requestTranslation(texts, language, settings, opts) {
  requireKey(settings);
  const info = MODELS[settings.model];
  const body = {
    model: settings.model,
    max_tokens: 16000,
    system: `Translate each numbered line of a shopping extension's interface from English into ${language}. Reply with the same numbered lines only, one per line. Keep {placeholders}, "$", numbers, product and brand names, and "Claude" as they are. Use short, natural interface wording.`,
    messages: [{ role: 'user', content: texts.map((t, i) => `${i + 1}. ${t.replace(/\s+/g, ' ')}`).join('\n') }],
    output_config: { effort: 'low' }
  };
  const message = await callMessages(body, { ...opts, apiKey: settings.apiKey, betas: info.betas || [] });
  const reply = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return parseTranslation(reply, texts);
}

const inflight = new Map();

/**
 * The texts in the shopper's language: from storage when translated before,
 * otherwise from Claude (once, even if several tabs ask together). English,
 * or no API key yet, gives the texts back unchanged.
 * @param {string[]} texts
 */
export async function translateTexts(storage, texts, settings, opts = {}) {
  const language = settings.language;
  if (isEnglish(language) || !settings.apiKey || !texts.length) return texts;
  const key = `${PREFIX}${language.toLowerCase()}:${textsHash(texts)}`;
  const stored = (await storage.get(key))[key];
  if (Array.isArray(stored) && stored.length === texts.length) return stored;
  if (!inflight.has(key)) {
    inflight.set(
      key,
      requestTranslation(texts, language, settings, opts)
        .then(async (translated) => {
          await storage.set({ [key]: translated });
          return translated;
        })
        .finally(() => inflight.delete(key))
    );
  }
  return inflight.get(key);
}
