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
  maxSearches: 5,
  autoAnalyze: true
};

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
    autoAnalyze: s.autoAnalyze !== false
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
