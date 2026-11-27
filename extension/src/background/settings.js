// User settings and the models the extension knows how to call.

export const MODELS = {
  'claude-haiku-5-5': {
    label: 'Claude Haiku 5.5 — cheapest (recommended)',
    // The dynamic-filtering web search variant (web_search_20260209) isn't
    // documented for Haiku, so it gets the basic tool.
    webSearchTool: 'web_search_20250305',
    // USD per million tokens; Haiku's price steps up for prompts over 100K tokens.
    pricing: { input: 0.1, output: 0.5, longInput: 0.5, longOutput: 2.5, longThreshold: 100_000 }
  },
  'claude-sonnet-5-5': {
    label: 'Claude Sonnet 5.5 — more thorough, ~20× the cost',
    webSearchTool: 'web_search_20260209',
    // If a safety classifier declines the request, the API retries on a model
    // it picks for that category instead of returning a refusal.
    fallbacks: 'default',
    betas: ['server-side-fallback-2026-07-01'],
    pricing: { input: 2, output: 10 }
  }
};

export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const EFFORTS = ['low', 'medium', 'high'];

export const DEFAULT_SETTINGS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  effort: 'medium',
  maxSearches: 6,
  autoAnalyze: true,
  // The panel on store product pages. Off hides it there; the toolbar button still works.
  showOnStores: true,
  // Stores that block the background price check get opened in a background tab instead.
  checkInTabs: true,
  // What Claude writes in, and the panel's labels (translated once, then kept).
  language: 'English',
  // 'simple': just the rating and the price difference with the same and an
  // equivalent product, which is less for Claude to write, so faster and cheaper.
  detail: 'detailed',
  // Search and category pages: a rating under every product shown. Costs per product.
  analyzeLists: false,
  // A separate, parallel search for coupon codes and student, military and other programs.
  findDiscounts: true,
  // Groups the shopper belongs to, so the discount search looks for theirs.
  discountGroups: []
};

export const DETAILS = ['detailed', 'simple'];
// Who a discount is for. The shopper can say which of the groups apply to them.
export const DISCOUNT_GROUPS = ['student', 'military', 'teacher', 'healthcare', 'first_responder', 'senior'];
// Searches per product on a page that lists many: enough for the item and one rival.
export const LIST_SEARCHES = 3;

// A language name in any script ("Español", "한국어", "Brazilian Portuguese").
// It's put into the prompt, so it's held to letters and a little punctuation.
const LANGUAGE_RE = /^[\p{L}\p{M}][\p{L}\p{M} ()'.,-]{0,39}$/u;

export function sanitizeLanguage(value) {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return LANGUAGE_RE.test(name) ? name : 'English';
}

export const isEnglish = (language) => /^english\b/i.test(language || 'English');

export const MIN_SEARCHES = 1;
export const MAX_SEARCHES = 10;

/** Fills gaps and clamps anything out of range, so stale or hand-edited storage can't break a request. */
export function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const searches = Math.round(Number(s.maxSearches));
  return {
    apiKey: typeof s.apiKey === 'string' ? s.apiKey.trim() : '',
    model: Object.hasOwn(MODELS, s.model) ? s.model : DEFAULT_MODEL,
    effort: EFFORTS.includes(s.effort) ? s.effort : DEFAULT_SETTINGS.effort,
    maxSearches: Number.isFinite(searches)
      ? Math.min(MAX_SEARCHES, Math.max(MIN_SEARCHES, searches))
      : DEFAULT_SETTINGS.maxSearches,
    autoAnalyze: s.autoAnalyze !== false,
    showOnStores: s.showOnStores !== false,
    checkInTabs: s.checkInTabs !== false,
    language: sanitizeLanguage(s.language),
    detail: DETAILS.includes(s.detail) ? s.detail : DEFAULT_SETTINGS.detail,
    analyzeLists: s.analyzeLists === true,
    findDiscounts: s.findDiscounts !== false,
    discountGroups: [...new Set(Array.isArray(s.discountGroups) ? s.discountGroups : [])].filter((g) => DISCOUNT_GROUPS.includes(g))
  };
}

export async function loadSettings(storage) {
  const { settings } = await storage.get('settings');
  return sanitizeSettings(settings);
}

export async function saveSettings(storage, settings) {
  const clean = sanitizeSettings(settings);
  await storage.set({ settings: clean });
  return clean;
}

/**
 * What a stored verdict depends on besides the deal: the model, how much it
 * writes, and its language. Cached results are kept apart by it.
 */
export function profileOf(settings, { simple = settings.detail === 'simple' } = {}) {
  const lang = isEnglish(settings.language) ? '' : `:${settings.language.toLowerCase()}`;
  return `${settings.model}:${simple ? 'simple' : 'detailed'}${lang}`;
}
