// Calls the Claude Messages API over plain fetch. The extension loads unpacked
// with no build step, so the official SDK (which would need bundling) isn't used.

import { MODELS } from './settings.js';
import { buildSystemPrompt, buildUserPrompt, buildFollowUpMessages, buildRecheckMessages } from './prompt.js';
import { VERDICT_TOOL, revisionTool, normalizeVerdict, normalizeRating, extractJsonObject, parsePartialObject } from './verdict.js';
import { estimateCost } from './pricing.js';
import { checkOffers, modelTokens } from './pricecheck.js';

export const API_BASE = 'https://api.anthropic.com/v1';
export const API_VERSION = '2026-10-21';

const MAX_TOKENS = 16000;
// Server-side search continuations (pause_turn) allowed within one turn.
const MAX_CONTINUATIONS = 4;
const MAX_RETRIES = 2;
const MAX_SOURCES = 12;
const MAX_ANSWER_SOURCES = 6;
export const MAX_QUESTION_LENGTH = 1000;

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

/**
 * Applies one server-sent event to the message being assembled, so a streamed
 * reply ends up exactly like a non-streamed one (thinking signatures and tool
 * inputs included, since paused turns are sent back as they are).
 */
function applyStreamEvent(message, event, partialJson) {
  switch (event.type) {
    case 'message_start':
      return { ...event.message, content: [] };
    case 'content_block_start': {
      const block = { ...event.content_block };
      message.content[event.index] = block;
      if ('input' in block) partialJson.set(event.index, '');
      return message;
    }
    case 'content_block_delta': {
      const block = message.content[event.index];
      const { delta } = event;
      if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
      else if (delta.type === 'input_json_delta') partialJson.set(event.index, partialJson.get(event.index) + delta.partial_json);
      else if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
      else if (delta.type === 'signature_delta') block.signature = delta.signature;
      else if (delta.type === 'citations_delta') block.citations = [...(block.citations || []), delta.citation];
      return message;
    }
    case 'content_block_stop': {
      if (partialJson.has(event.index)) {
        const json = partialJson.get(event.index);
        partialJson.delete(event.index);
        try {
          message.content[event.index].input = json ? JSON.parse(json) : {};
        } catch {
          // Leave the input as it started; the verdict check reports it.
        }
      }
      return message;
    }
    case 'message_delta':
      message.stop_reason = event.delta?.stop_reason ?? message.stop_reason;
      message.stop_details = event.delta?.stop_details ?? message.stop_details;
      message.usage = { ...message.usage, ...event.usage };
      return message;
    case 'error': {
      const overloaded = event.error?.type === 'overloaded_error';
      throw new AnalysisError(
        overloaded ? 'overloaded' : 'bad_response',
        overloaded ? 'The Anthropic API is overloaded. Try again shortly.' : `The API stream failed: ${event.error?.message || 'unknown error'}`,
        { retryable: true }
      );
    }
    default:
      return message;
  }
}

/** Reads a Messages API event stream, reporting each event with the message so far. */
async function readStream(res, onEvent) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const partialJson = new Map();
  let message = null;
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value.replace(/\r/g, '');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (!data) continue;
      const event = JSON.parse(data);
      message = applyStreamEvent(message, event, partialJson);
      if (message) onEvent(event, message, partialJson);
    }
  }
  if (!message?.stop_reason) {
    throw new AnalysisError('network', 'The connection closed before Claude finished.', { retryable: true });
  }
  return message;
}

async function request(path, init, { fetchImpl = fetch, signal, sleep = defaultSleep, onEvent } = {}) {
  for (let attempt = 0; ; attempt++) {
    let error;
    try {
      const res = await fetchImpl(`${API_BASE}${path}`, { ...init, signal });
      if (res.ok && onEvent) return await readStream(res, onEvent);
      const data = await res.json().catch(() => null);
      if (res.ok && data) return data;
      error = res.ok
        ? new AnalysisError('bad_response', 'The API returned a response that is not JSON.', { retryable: true })
        : errorFromResponse(res.status, data, res.headers);
    } catch (err) {
      if (signal?.aborted) throw new AnalysisError('aborted', 'Analysis cancelled.');
      error =
        err instanceof AnalysisError
          ? err
          : new AnalysisError('network', `Couldn't reach the Anthropic API: ${err.message}`, { retryable: true });
    }
    if (!error.retryable || attempt >= MAX_RETRIES) throw error;
    await sleep(error.retryAfterMs ?? 1000 * 2 ** attempt);
  }
}

/** Streams a Messages request; `onEvent(event, messageSoFar, partialJson)` sees every event. */
export function callMessages(body, { apiKey, betas = [], onEvent = () => {}, ...opts }) {
  return request(
    '/messages',
    { method: 'POST', headers: apiHeaders(apiKey, betas), body: JSON.stringify({ ...body, stream: true }) },
    { ...opts, onEvent }
  );
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

export function buildRequest(settings, now = new Date()) {
  const info = MODELS[settings.model];
  const body = {
    model: settings.model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt({ now, maxSearches: settings.maxSearches }),
    tools: [webSearchTool(settings.model, settings.maxSearches), VERDICT_TOOL],
    tool_choice: { type: 'auto' },
    output_config: { effort: settings.effort }
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

function newResearch(knownSources = []) {
  const sources = new Map();
  for (const s of knownSources) {
    const key = urlKey(s.url);
    if (key) sources.set(key, s);
  }
  return { queries: [], sources };
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
 * Turns stream events into progress for the panel: each search as soon as
 * it's issued, what Claude is doing now, and the verdict's fields as they
 * arrive (a strict tool's input streams one whole field at a time).
 */
function progressReporter(research, onProgress, fallbackPrice) {
  let stage = 'searching';
  let verdictIndex = null;
  let fields = 0;
  return (event, message, partialJson) => {
    const block = message.content[event.index];
    let partial = null;
    if (event.type === 'content_block_start') {
      if (block.type === 'web_search_tool_result') stage = 'reading';
      else if (block.type === 'thinking' && stage === 'reading') stage = 'thinking';
      else if (block.type === 'tool_use' && block.name === VERDICT_TOOL.name) {
        stage = 'writing';
        verdictIndex = event.index;
        fields = 0;
      } else return;
    } else if (event.type === 'content_block_stop' && block?.type === 'server_tool_use') {
      // The query is complete now; fall through to report it.
    } else if (event.type === 'content_block_delta' && event.index === verdictIndex) {
      const input = parsePartialObject(partialJson.get(event.index));
      if (!input || Object.keys(input).length === fields) return;
      fields = Object.keys(input).length;
      partial = normalizeVerdict(input, { partial: true, fallbackPrice });
    } else return;

    const live = message.content
      .filter((b) => b?.type === 'server_tool_use' && b.name === 'web_search' && b.input?.query)
      .map((b) => String(b.input.query));
    onProgress({ stage, queries: [...research.queries, ...live], partial });
  };
}

/**
 * Runs one assistant turn: sends the conversation, resumes server-side search
 * pauses, and appends Claude's reply to `messages`. Returns the reply content.
 */
async function runTurn(messages, request, ctx) {
  const { settings, opts, research, usages } = ctx;
  const onProgress = opts.onProgress || (() => {});
  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    if (opts.signal?.aborted) throw new AnalysisError('aborted', 'Analysis cancelled.');
    const response = await callMessages(
      { ...request.body, messages },
      {
        ...opts,
        apiKey: settings.apiKey,
        betas: request.betas,
        onEvent: progressReporter(research, onProgress, ctx.fallbackPrice ?? null)
      }
    );
    if (response.usage) usages.push(response.usage);
    collectResearch(response.content, research);

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category;
      throw new AnalysisError('refusal', `Claude declined to answer${category ? ` (${category})` : ''}. Try again.`);
    }
    appendAssistant(messages, response.content || []);
    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason === 'max_tokens') {
      throw new AnalysisError('max_tokens', 'Claude ran out of room before finishing. Try a lower effort setting.');
    }
    return messages[messages.length - 1].content;
  }
  throw new AnalysisError('too_long', 'Claude kept searching without finishing. Try again.');
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// "www.bestbuy.com" -> "bestbuy"
function siteName(url) {
  try {
    const labels = new URL(url).hostname.split('.');
    return labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  } catch {
    return '';
  }
}

/**
 * Links offers Claude gave no usable URL for to a search result it saw: one on
 * the offer's store whose title or URL names the product's model.
 */
export function linkOffers(offers, sources) {
  for (const offer of offers) {
    const store = squash(offer.store);
    const tokens = modelTokens(offer.product);
    if (!store || !tokens.length) continue;
    const hit = sources.find((s) => {
      const site = siteName(s.url);
      if (site.length < 2 || !(store.includes(site) || site.includes(store))) return false;
      const haystack = squash(`${s.title} ${s.url}`);
      return tokens.some((t) => haystack.includes(t));
    });
    if (hit) {
      offer.url = hit.url;
      offer.verified = true;
    }
  }
  return offers;
}

// Sites that post or track deals rather than sell anything: a link there isn't an offer.
const NOT_STORES = new Set([
  'edealinfo', 'slickdeals', 'dealnews', 'bensbargains', 'bradsdeals', 'dealtikka', 'dealsea', 'techbargains', 'gottadeal',
  'dealcatcher', 'hip2save', 'krazycouponlady', 'retailmenot', 'offers', 'pricegrabber', 'shopzilla', 'camelcamelcamel',
  'keepa', 'pricespy', 'idealo', 'shopperoo', 'pgrid', 'shopsavvy', 'nextag', 'pcpartpicker', 'rtings', 'reddit', 'youtube'
]);
// Where another listing of the same item is another seller's, not the same offer.
const MARKETPLACES = new Set(['ebay']);
const LISTING_PATH = /^\/(search|s|sch|b|browse|shop)(\/|$)|\/searchpage|\/search(\/|$)|^\/p\/pl$|^\/c\/kp\/|^\/category\/|^\/collections?\/[^/]+\/?$/i;
const LISTING_QUERY = /[?&](q|k|st|query|_nkw|searchterm|keyword)=/i;

function absoluteUrl(cited) {
  const value = String(cited || '').trim();
  if (!value) return null;
  try {
    const url = new URL(/^[a-z]+:/i.test(value) ? value : `https://${value}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** The URL if it's a search result Claude saw; the host and path must match. */
function seenUrl(cited, research) {
  const url = absoluteUrl(cited);
  return url && research.sources.has(urlKey(url.href)) ? url.href : null;
}

function isProductPage(href) {
  const { pathname, search } = new URL(href);
  return !LISTING_PATH.test(pathname) && !LISTING_QUERY.test(search);
}

// Search results often point at a product's reviews tab.
function productPage(href) {
  const url = new URL(href);
  url.pathname = url.pathname.replace(/\/reviews?\/?$/, '');
  return url.href;
}

function onStore(offer, href) {
  const store = squash(offer.store);
  const site = siteName(href);
  return site.length >= 2 && Boolean(store) && (store.includes(site) || site.includes(store));
}

/** Is this the deal itself, seen through another page? (An eDealinfo post of a Best Buy item, say.) */
function isSameListing(offer, deal, seller) {
  if (deal.pageUrl && urlKey(offer.url) === urlKey(deal.pageUrl)) return true;
  if (deal.asin && offer.url.includes(deal.asin)) return true;
  const site = siteName(offer.url);
  const sellers = [deal.store, seller, deal.site].map(squash);
  if (MARKETPLACES.has(site) || site.length < 3 || !sellers.some((s) => s.includes(site))) return false;
  if (offer.match === 'same_item') return true;
  const dealTokens = modelTokens(`${deal.title} ${deal.productName || ''} ${deal.model || ''}`);
  return modelTokens(offer.product).some((t) => dealTokens.includes(t));
}

/**
 * Settles the compared offers: each gets a link to a real product page on its
 * own store, from the search results. The deal itself is removed; offers with
 * no such page are counted in `offersHidden`, since they can't be clicked or
 * checked. Same for savings, which are only as good as the page stating them.
 */
export function resolveOffers(verdict, deal, research) {
  const sources = [...research.sources.values()];
  const offers = [];
  let hidden = 0;
  for (const offer of verdict.comparableOffers) {
    const cited = seenUrl(offer.citedUrl, research);
    const href = cited && onStore(offer, cited) ? cited : linkOffers([{ ...offer }], sources)[0].url;
    if (!href || NOT_STORES.has(siteName(href)) || !isProductPage(href)) {
      hidden++;
      continue;
    }
    const url = productPage(href);
    const linked = { ...offer, url, verified: true, pageAge: research.sources.get(urlKey(href))?.pageAge ?? null };
    if (isSameListing(linked, deal, verdict.seller)) continue;
    if (offers.some((o) => urlKey(o.url) === urlKey(url))) continue;
    offers.push(linked);
  }
  return {
    ...verdict,
    comparableOffers: offers,
    offersHidden: hidden,
    savings: verdict.savings.flatMap((s) => {
      const url = seenUrl(s.citedUrl, research);
      return url ? [{ ...s, url }] : [];
    })
  };
}

function toVerdict(input, deal, research) {
  let verdict;
  try {
    verdict = normalizeVerdict(input, { fallbackPrice: deal.finalPrice });
  } catch (err) {
    throw new AnalysisError('bad_verdict', `Claude returned an unusable verdict: ${err.message}`);
  }
  return resolveOffers(verdict, deal, research);
}

// A price this far off is worth asking Claude to reconsider its rating over.
const RECHECK_PCT = 0.05;

function pricesThatMatter(checked) {
  const moved = checked.offers
    .filter((o) => o.check === 'changed' && o.quotedPrice !== null && Math.abs(o.price - o.quotedPrice) >= o.quotedPrice * RECHECK_PCT)
    .map((offer) => ({ offer, price: offer.price }));
  const lost = checked.removed.filter((r) => r.reason !== 'wrong_product' && r.offer.price !== null);
  return [...moved, ...lost];
}

/**
 * Checks the offers against their store pages, then has Claude look again if
 * they disagree with what it based the rating on. That turn gets the compact
 * verdict rather than the ~100K tokens of search results, so it costs a fraction
 * of a cent, and may only change the prices, rating and reasons.
 */
async function checkPrices(verdict, deal, ctx, { recheck = true } = {}) {
  const { opts, settings, research } = ctx;
  if (!verdict.comparableOffers.length) return verdict;
  const report = (stage) => opts.onProgress?.({ stage, queries: research.queries, partial: verdict });
  report('checking');
  const checked = await checkOffers(verdict.comparableOffers, {
    fetchPage: opts.fetchPage,
    readInTab: opts.readInTab,
    signal: opts.signal
  });
  const current = {
    ...verdict,
    comparableOffers: checked.offers,
    offersHidden: verdict.offersHidden + checked.removed.length
  };
  const changes = pricesThatMatter(checked);
  if (!recheck || !changes.length) return current;

  report('rechecking');
  try {
    const request = buildRequest(settings, opts.now);
    request.body.tools = [revisionTool()];
    const content = await runTurn(buildRecheckMessages(deal, current, changes), request, {
      ...ctx,
      opts: { ...opts, onProgress: undefined }
    });
    const input = findVerdictInput(content);
    if (!input) return current;
    const revised = normalizeVerdict(input, { fallbackPrice: deal.finalPrice });
    return {
      ...revised,
      seller: current.seller,
      comparableOffers: current.comparableOffers,
      savings: current.savings,
      offersHidden: current.offersHidden,
      repriced: revised.rating !== current.rating
    };
  } catch (err) {
    if (err instanceof AnalysisError && err.code === 'aborted') throw err;
    // The offers are right either way; the rating just wasn't reconsidered.
    return current;
  }
}

function requireKey(settings) {
  if (!settings.apiKey) {
    throw new AnalysisError('no_key', 'Add your Anthropic API key in the extension settings to analyze deals.');
  }
}

/**
 * Researches a deal and returns Claude's verdict plus what it looked at.
 * @param {object} deal      output of extractDeal()
 * @param {object} settings  sanitized settings (see settings.js)
 */
export async function analyzeDeal(deal, settings, opts = {}) {
  requireKey(settings);
  const request = buildRequest(settings, opts.now);
  const messages = [{ role: 'user', content: buildUserPrompt(deal) }];
  const ctx = { settings, opts, research: newResearch(), usages: [], fallbackPrice: deal.finalPrice };

  const verdictFrom = (content) => {
    const input = findVerdictInput(content);
    if (input) return input;
    // Ended without calling the tool: accept a verdict written as JSON.
    const fromText = extractJsonObject(textOf(content));
    return fromText && normalizeRating(fromText.rating) ? fromText : null;
  };

  let input = verdictFrom(await runTurn(messages, request, ctx));
  if (!input) {
    messages.push({ role: 'user', content: 'Call the submit_verdict tool now with your final assessment.' });
    input = verdictFrom(await runTurn(messages, request, ctx));
  }
  if (!input) throw new AnalysisError('no_verdict', "Claude didn't return a verdict. Try re-analyzing.");

  return {
    verdict: await checkPrices(toVerdict(input, deal, ctx.research), deal, ctx),
    model: settings.model,
    queries: ctx.research.queries,
    sources: [...ctx.research.sources.values()].slice(0, MAX_SOURCES),
    usage: estimateCost(ctx.usages, settings.model),
    analyzedAt: new Date().toISOString()
  };
}

// Tool calls must be answered before the conversation can go on.
function answerToolCalls(message, text) {
  return message.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ type: 'tool_result', tool_use_id: b.id, content: text }));
}

// The answer is the text after Claude's last search; text before it is
// narration like "Let me check that." Citations split one answer into many
// text blocks, so they're joined without separators.
function answerFrom(content) {
  let lastTool = -1;
  content.forEach((b, i) => {
    if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result') lastTool = i;
  });
  const after = content.slice(lastTool + 1).filter((b) => b.type === 'text');
  const blocks = after.length ? after : content.filter((b) => b.type === 'text');

  const sources = new Map();
  for (const block of blocks) {
    for (const c of block.citations || []) {
      const key = c.type === 'web_search_result_location' ? urlKey(c.url) : null;
      if (key && !sources.has(key)) sources.set(key, { title: c.title || c.url, url: c.url });
    }
  }
  return {
    text: blocks.map((b) => b.text).join('').trim(),
    sources: [...sources.values()].slice(0, MAX_ANSWER_SOURCES)
  };
}

/**
 * Answers a follow-up question about a deal Claude already assessed.
 *
 * Claude gets its earlier verdict and the chat so far rather than a replay of
 * the original research: the raw search results run to ~100K tokens, which
 * would make every question cost as much as a new analysis. It searches again
 * when a question needs it.
 * @param {{previousResult?: object, turns?: {role: string, text: string}[]}} opts
 * @returns {Promise<{answer: {text, sources}, verdict: object|null, usage, queries}>}
 */
export async function askFollowUp(deal, question, settings, opts = {}) {
  requireKey(settings);
  const q = String(question || '').trim().slice(0, MAX_QUESTION_LENGTH);
  if (!q) throw new AnalysisError('no_question', 'Type a question first.');

  const request = buildRequest(settings, opts.now);
  const messages = buildFollowUpMessages(deal, opts.previousResult, opts.turns || [], q);
  // The earlier offers' pages count as seen; the source list kept with a verdict is cut short.
  const known = [...(opts.previousResult?.sources || []), ...(opts.previousResult?.verdict?.comparableOffers || [])];
  const ctx = { settings, opts, research: newResearch(known.filter((s) => s.url)), usages: [], fallbackPrice: deal.finalPrice };

  let content = await runTurn(messages, request, ctx);
  const input = findVerdictInput(content);
  let answer = answerFrom(content);
  if (input && !answer.text) {
    // Claude revised the verdict without explaining; let it finish the answer.
    const last = messages[messages.length - 1];
    messages.push({
      role: 'user',
      content: answerToolCalls(last, 'The revised verdict is on screen. Now answer the question in plain text.')
    });
    content = await runTurn(messages, request, ctx);
    answer = answerFrom(content);
  }
  // No second opinion here: Claude has just told the shopper what it thinks.
  const verdict = input ? await checkPrices(toVerdict(input, deal, ctx.research), deal, ctx, { recheck: false }) : null;
  if (!answer.text && !verdict) throw new AnalysisError('no_answer', "Claude didn't answer. Try asking again.");

  return {
    answer: { text: answer.text || 'I updated the verdict above.', sources: answer.sources },
    verdict,
    usage: estimateCost(ctx.usages, settings.model),
    queries: ctx.research.queries
  };
}
