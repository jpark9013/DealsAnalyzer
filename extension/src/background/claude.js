// Calls the Claude Messages API over plain fetch. The extension loads unpacked
// with no build step, so the official SDK (which would need bundling) isn't used.

import { MODELS } from './settings.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
import { VERDICT_TOOL, normalizeVerdict, normalizeRating, extractJsonObject } from './verdict.js';
import { estimateCost } from './pricing.js';

export const API_BASE = 'https://api.anthropic.com/v1';
export const API_VERSION = '2026-10-21';

const MAX_TOKENS = 16000;
// One initial request, server-side search continuations (pause_turn), and one nudge.
const MAX_REQUESTS = 6;
const MAX_RETRIES = 2;
const MAX_SOURCES = 12;

export class AnalysisError extends Error {
  constructor(code, message, { retryable = false, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'AnalysisError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function apiHeaders(apiKey, betas = []) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    // Extension pages and workers send a browser Origin header; the API
    // rejects those requests without this opt-in.
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  if (betas.length) headers['anthropic-beta'] = betas.join(',');
  return headers;
}

function retryAfterMs(headers) {
  const seconds = Number(headers?.get?.('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 20) * 1000 : null;
}

export function errorFromResponse(status, body, headers) {
  const detail = body?.error?.message || `HTTP ${status}`;
  if (status === 401) {
    return new AnalysisError('auth', 'Your Anthropic API key was rejected. Check it in the extension settings.', { status });
  }
  if (status === 403) return new AnalysisError('permission', `Your API key can't do this: ${detail}`, { status });
  if (status === 404) return new AnalysisError('not_found', `Model or endpoint not found: ${detail}`, { status });
  if (status === 429) {
    return new AnalysisError('rate_limit', 'Rate limited by the Anthropic API. Try again in a minute.', {
      status,
      retryable: true,
      retryAfterMs: retryAfterMs(headers)
    });
  }
  if (status === 529 || status >= 500) {
    return new AnalysisError('overloaded', `The Anthropic API is having trouble (${status}). Try again shortly.`, {
      status,
      retryable: true,
      retryAfterMs: retryAfterMs(headers)
    });
  }
  return new AnalysisError('bad_request', `The API rejected the request: ${detail}`, { status });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, init, { fetchImpl = fetch, signal, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    let error;
    try {
      const res = await fetchImpl(`${API_BASE}${path}`, { ...init, signal });
      const data = await res.json().catch(() => null);
      if (res.ok && data) return data;
      error = res.ok
        ? new AnalysisError('bad_response', 'The API returned a response that is not JSON.', { retryable: true })
        : errorFromResponse(res.status, data, res.headers);
    } catch (err) {
      if (signal?.aborted) throw new AnalysisError('aborted', 'Analysis cancelled.');
      error = new AnalysisError('network', `Couldn't reach the Anthropic API: ${err.message}`, { retryable: true });
    }
    if (!error.retryable || attempt >= MAX_RETRIES) throw error;
    await sleep(error.retryAfterMs ?? 1000 * 2 ** attempt);
  }
}

export function callMessages(body, { apiKey, betas = [], ...opts }) {
  return request('/messages', { method: 'POST', headers: apiHeaders(apiKey, betas), body: JSON.stringify(body) }, opts);
}

/** Checks a key without spending tokens: the Models endpoint is free. */
export async function testApiKey(apiKey, model, opts = {}) {
  if (!apiKey) throw new AnalysisError('no_key', 'Enter an API key first.');
  const data = await request(`/models/${encodeURIComponent(model)}`, { method: 'GET', headers: apiHeaders(apiKey) }, opts);
  return { id: data.id, displayName: data.display_name || data.id };
}

export function webSearchTool(model, maxSearches) {
  return {
    type: MODELS[model].webSearchTool,
    name: 'web_search',
    max_uses: maxSearches,
    user_location: { type: 'approximate', country: 'US' }
  };
}

export function buildRequest(deal, settings, now = new Date()) {
  const info = MODELS[settings.model];
  const body = {
    model: settings.model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt({ now, maxSearches: settings.maxSearches }),
    tools: [webSearchTool(settings.model, settings.maxSearches), VERDICT_TOOL],
    tool_choice: { type: 'auto' },
    output_config: { effort: settings.effort },
    messages: [{ role: 'user', content: buildUserPrompt(deal) }]
  };
  if (info.fallbacks) body.fallbacks = info.fallbacks;
  return { body, betas: info.betas || [] };
}

// Matches a URL Claude quotes against the search results it actually saw.
export function urlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function collectResearch(content, research) {
  for (const block of content || []) {
    if (block.type === 'server_tool_use' && block.name === 'web_search' && block.input?.query) {
      research.queries.push(String(block.input.query));
    }
    // An error result carries an object here instead of a list.
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        const key = r?.type === 'web_search_result' ? urlKey(r.url) : null;
        if (key && !research.sources.has(key)) {
          research.sources.set(key, { title: r.title || r.url, url: r.url, pageAge: r.page_age || null });
        }
      }
    }
  }
}

function findVerdictInput(content) {
  const block = (content || []).find((b) => b.type === 'tool_use' && b.name === VERDICT_TOOL.name);
  return block ? block.input : null;
}

function textOf(content) {
  return (content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// A paused turn resumes from the assistant content so far; consecutive
// continuations extend the same assistant message.
function appendAssistant(messages, content) {
  const last = messages[messages.length - 1];
  if (last.role === 'assistant') last.content = [...last.content, ...content];
  else messages.push({ role: 'assistant', content: [...content] });
}

/**
 * Researches a deal and returns Claude's verdict plus what it looked at.
 * @param {object} deal      output of extractDeal()
 * @param {object} settings  sanitized settings (see settings.js)
 */
export async function analyzeDeal(deal, settings, opts = {}) {
  const { signal, onProgress = () => {}, now = new Date() } = opts;
  if (!settings.apiKey) {
    throw new AnalysisError('no_key', 'Add your Anthropic API key in the extension settings to analyze deals.');
  }

  const { body, betas } = buildRequest(deal, settings, now);
  const { messages } = body;
  const usages = [];
  const research = { queries: [], sources: new Map() };
  let nudged = false;

  const finish = (input) => {
    let verdict;
    try {
      verdict = normalizeVerdict(input, { fallbackPrice: deal.finalPrice });
    } catch (err) {
      throw new AnalysisError('bad_verdict', `Claude returned an unusable verdict: ${err.message}`);
    }
    for (const offer of verdict.comparableOffers) {
      offer.verified = Boolean(offer.url && research.sources.has(urlKey(offer.url)));
    }
    return {
      verdict,
      model: settings.model,
      queries: research.queries,
      sources: [...research.sources.values()].slice(0, MAX_SOURCES),
      usage: estimateCost(usages, settings.model),
      analyzedAt: new Date().toISOString()
    };
  };

  for (let i = 0; i < MAX_REQUESTS; i++) {
    if (signal?.aborted) throw new AnalysisError('aborted', 'Analysis cancelled.');
    const response = await callMessages({ ...body, messages }, { ...opts, apiKey: settings.apiKey, betas });
    if (response.usage) usages.push(response.usage);
    collectResearch(response.content, research);
    onProgress({ stage: 'researching', queries: [...research.queries] });

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category;
      throw new AnalysisError(
        'refusal',
        `Claude declined to analyze this deal${category ? ` (${category})` : ''}. Try re-analyzing.`
      );
    }

    const verdictInput = findVerdictInput(response.content);
    if (verdictInput) return finish(verdictInput);

    if (response.stop_reason === 'pause_turn') {
      appendAssistant(messages, response.content);
      continue;
    }
    if (response.stop_reason === 'max_tokens') {
      throw new AnalysisError('max_tokens', 'Claude ran out of room before giving a verdict. Try a lower effort setting.');
    }

    // Ended without calling the tool: accept a JSON answer, otherwise ask once.
    const fromText = extractJsonObject(textOf(response.content));
    if (fromText && normalizeRating(fromText.rating)) return finish(fromText);
    if (nudged) break;
    nudged = true;
    appendAssistant(messages, response.content);
    messages.push({ role: 'user', content: 'Call the submit_verdict tool now with your final assessment.' });
  }

  throw new AnalysisError('no_verdict', "Claude didn't return a verdict. Try re-analyzing.");
}
