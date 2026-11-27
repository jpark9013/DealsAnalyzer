// Background entry point: runs analyses for the content script and keeps the
// API key out of the page.

import { analyzeDeal, askFollowUp, AnalysisError } from './claude.js';
import { loadSettings, profileOf, isEnglish } from './settings.js';
import { getCached, putCached, getChat, putChat, getDiscounts, putDiscounts } from './cache.js';
import { tabReader, isHelperTab } from './pricecheck.js';
import { findDiscounts, discountKey } from './discounts.js';
import { translateTexts } from './translate.js';

const ext = globalThis.browser ?? globalThis.chrome;
const storage = ext.storage.local;

// Analyses in flight, keyed by deal and profile, so two tabs on the same deal share one request.
const inflight = new Map();

function serializeError(err) {
  if (err instanceof AnalysisError) return { code: err.code, message: err.message };
  return { code: 'internal', message: err?.message || String(err) };
}

// Blocked stores' pages can be opened in a background tab, if the setting
// allows. Not for the products on a search page: that could be dozens of tabs.
const priceCheckOptions = (settings, { list = false } = {}) => (settings.checkInTabs && !list ? { readInTab: tabReader(ext) } : {});

const wantsSimple = (settings, simple) => simple ?? settings.detail === 'simple';

/**
 * A saved verdict for this deal and its profile. A detailed one also answers
 * for a simple one, since it has everything the simple view shows. `either`
 * takes a simple one for a detailed one too: a question about the verdict on
 * screen, which may have come from a list page's badge.
 */
async function lookup(dealKey, settings, simple, { either = false } = {}) {
  const detailed = profileOf(settings, { simple: false });
  const short = profileOf(settings, { simple: true });
  const profiles = simple ? [short, detailed] : either ? [detailed, short] : [detailed];
  for (const profile of profiles) {
    const cached = await getCached(storage, dealKey, profile);
    if (cached) {
      const chat = await getChat(storage, dealKey, profile);
      return { result: { ...cached, turns: chat?.turns || [], cached: true }, profile };
    }
  }
  return null;
}

async function runAnalysis(deal, force, onProgress, { simple: asked, list = false } = {}) {
  const settings = await loadSettings(storage);
  const simple = list || wantsSimple(settings, asked);
  if (!force) {
    const saved = await lookup(deal.key, settings, simple);
    if (saved) return saved.result;
  }

  // A job keeps running if its tab closes: it's already being paid for, and
  // finishing it means the cache has the answer next time.
  const profile = profileOf(settings, { simple });
  const id = `${profile}:${deal.key}`;
  let job = inflight.get(id);
  if (!job) {
    const listeners = new Set();
    const promise = analyzeDeal(deal, settings, {
      ...priceCheckOptions(settings, { list }),
      simple,
      list,
      onProgress: (p) => listeners.forEach((fn) => fn(p))
    })
      .then(async (result) => {
        await putCached(storage, deal.key, profile, result);
        return result;
      })
      .finally(() => inflight.delete(id));
    job = { promise, listeners };
    inflight.set(id, job);
  }
  job.listeners.add(onProgress);
  try {
    return { ...(await job.promise), turns: [], cached: false };
  } finally {
    job.listeners.delete(onProgress);
  }
}

/**
 * Answers a follow-up question about the saved verdict and chat. Returns the
 * updated chat turns, plus a revised verdict if Claude changed its mind.
 */
async function runAsk(deal, question, onProgress) {
  const settings = await loadSettings(storage);
  const saved = await lookup(deal.key, settings, wantsSimple(settings), { either: true });
  const profile = saved?.profile || profileOf(settings);
  const cached = saved ? await getCached(storage, deal.key, profile) : null;
  const chat = saved ? { turns: saved.result.turns } : null;
  const outcome = await askFollowUp(deal, question, settings, {
    previousResult: cached,
    turns: chat?.turns,
    ...priceCheckOptions(settings),
    onProgress
  });

  const turns = [
    ...(chat?.turns || []),
    { role: 'user', text: String(question).trim() },
    { role: 'assistant', text: outcome.answer.text, sources: outcome.answer.sources, costUsd: outcome.usage.costUsd }
  ];
  await putChat(storage, deal.key, profile, { turns });

  let revision = null;
  if (outcome.verdict) {
    revision = { verdict: outcome.verdict, revisedAt: new Date().toISOString() };
    if (cached) await putCached(storage, deal.key, profile, { ...cached, ...revision });
  }
  return { turns, revision };
}

// --- Discounts ---------------------------------------------------------

const discountJobs = new Map();

async function runDiscounts(deal) {
  const settings = await loadSettings(storage);
  if (!settings.findDiscounts) return null;
  const key = discountKey(deal, settings.discountGroups);
  const profile = `${settings.model}${isEnglish(settings.language) ? '' : `:${settings.language.toLowerCase()}`}`;
  const cached = await getDiscounts(storage, key, profile);
  if (cached) return { ...cached, cached: true };
  const id = `${profile}:${key}`;
  if (!discountJobs.has(id)) {
    discountJobs.set(
      id,
      findDiscounts(deal, settings)
        .then(async (result) => {
          await putDiscounts(storage, key, profile, result);
          return result;
        })
        .finally(() => discountJobs.delete(id))
    );
  }
  return { ...(await discountJobs.get(id)), cached: false };
}

// --- Products on search and category pages -----------------------------

// Shared by every tab, so a long page doesn't send dozens of requests at once
// (the API rate-limits that, and the shopper may scroll past most of them).
const LIST_CONCURRENCY = 3;
const listQueue = [];
let listRunning = 0;

function pumpList() {
  while (listRunning < LIST_CONCURRENCY && listQueue.length) {
    const job = listQueue.shift();
    // Its tab closed or moved on before its turn: nothing spent, nothing to do.
    if (job.cancelled()) continue;
    listRunning++;
    job.run().finally(() => {
      listRunning--;
      pumpList();
    });
  }
}

function onListPort(port) {
  let open = true;
  const post = (msg) => {
    if (open) port.postMessage(msg);
  };
  port.onDisconnect.addListener(() => {
    open = false;
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'analyze' || !msg.deal?.key || msg.id === undefined) return;
    const { id, deal } = msg;
    const settings = await loadSettings(storage);
    const saved = await lookup(deal.key, settings, true);
    if (saved) {
      post({ type: 'item', id, result: saved.result });
      return;
    }
    post({ type: 'queued', id });
    listQueue.push({
      cancelled: () => !open,
      run: async () => {
        post({ type: 'started', id });
        try {
          post({ type: 'item', id, result: await runAnalysis(deal, false, () => {}, { list: true }) });
        } catch (err) {
          post({ type: 'item-error', id, error: serializeError(err) });
        }
      }
    });
    pumpList();
  });
}

// A long-lived port per analysis: the content script pings it, which keeps
// the service worker alive while the (slow) web-search request runs.
ext.runtime.onConnect.addListener((port) => {
  if (port.name === 'deal-list') {
    onListPort(port);
    return;
  }
  if (port.name !== 'deal-analysis') return;
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  const post = (msg) => {
    if (open) port.postMessage(msg);
  };

  port.onMessage.addListener(async (msg) => {
    if (!msg?.deal?.key) return;
    const onProgress = (progress) => post({ type: 'progress', ...progress });
    try {
      if (msg.type === 'analyze') {
        post({ type: 'result', result: await runAnalysis(msg.deal, Boolean(msg.force), onProgress, { simple: msg.simple }) });
      } else if (msg.type === 'discounts') {
        post({ type: 'discounts', result: await runDiscounts(msg.deal) });
      } else if (msg.type === 'ask') {
        post({ type: 'answer', ...(await runAsk(msg.deal, msg.question, onProgress)) });
      }
    } catch (err) {
      post({ type: 'error', error: serializeError(err) });
    }
  });
});

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    ext.runtime.openOptionsPage();
    return false;
  }
  if (msg?.type === 'get-status') {
    loadSettings(storage).then((s) =>
      sendResponse({
        hasKey: Boolean(s.apiKey),
        autoAnalyze: s.autoAnalyze,
        showOnStores: s.showOnStores,
        analyzeLists: s.analyzeLists,
        findDiscounts: s.findDiscounts,
        discountGroups: s.discountGroups,
        detail: s.detail,
        english: isEnglish(s.language),
        model: s.model,
        helperTab: isHelperTab(sender.tab?.id)
      })
    );
    return true;
  }
  // A saved verdict for this deal, if there is one: free, and never starts an analysis.
  if (msg?.type === 'peek' && msg.key) {
    loadSettings(storage)
      .then(async (s) => (await lookup(msg.key, s, wantsSimple(s, msg.simple)))?.result ?? null)
      .then(sendResponse, () => sendResponse(null));
    return true;
  }
  // The extension's own words in the shopper's language (see translate.js).
  if (msg?.type === 'translate' && Array.isArray(msg.texts)) {
    const texts = msg.texts.map((t) => String(t)).slice(0, 400);
    loadSettings(storage)
      .then((s) => translateTexts(storage, texts, s))
      .then(
        (translated) => sendResponse({ texts: translated }),
        (err) => sendResponse({ texts: null, error: serializeError(err) })
      );
    return true;
  }
  return false;
});

// The toolbar button (or Alt+Shift+D) analyzes the product on the current tab.
// `activeTab` lets the extension into that one tab for this click, even where
// the shopper hasn't granted it access to every site (Firefox asks).
export const PAGE_SCRIPTS = [
  'src/content/strings.js',
  'src/content/extract.js',
  'src/content/extract-page.js',
  'src/content/extract-list.js',
  'src/content/panel.js',
  'src/content/badges.js',
  'src/content/main.js'
];

export async function analyzeTab(tabId, scripting = ext.scripting) {
  const target = { tabId };
  const [probe] = await scripting.executeScript({ target, func: () => Boolean(globalThis.DealsAnalyzer?.analyzePage) });
  if (!probe?.result) await scripting.executeScript({ target, files: PAGE_SCRIPTS });
  await scripting.executeScript({ target, func: () => globalThis.DealsAnalyzer.analyzePage() });
}

ext.action.onClicked.addListener((tab) => {
  // Browser pages, extension stores and PDF viewers can't be scripted;
  // settings are the useful thing to show there.
  analyzeTab(tab.id).catch((err) => {
    console.warn(`Deals Analyzer couldn't run on ${tab.url || 'this tab'}:`, err);
    ext.runtime.openOptionsPage();
  });
});

ext.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const settings = await loadSettings(storage);
  if (!settings.apiKey) ext.runtime.openOptionsPage();
});
