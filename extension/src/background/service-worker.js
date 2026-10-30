// Background entry point: runs analyses for the content script and keeps the
// API key out of the page.

import { analyzeDeal, askFollowUp, AnalysisError } from './claude.js';
import { loadSettings } from './settings.js';
import { getCached, putCached, getChat, putChat } from './cache.js';
import { tabReader, isHelperTab } from './pricecheck.js';

const ext = globalThis.browser ?? globalThis.chrome;
const storage = ext.storage.local;

// Analyses in flight, keyed by deal and model, so two tabs on the same deal share one request.
const inflight = new Map();

function serializeError(err) {
  if (err instanceof AnalysisError) return { code: err.code, message: err.message };
  return { code: 'internal', message: err?.message || String(err) };
}


// Blocked stores' pages can be opened in a background tab, if the setting allows.
const priceCheckOptions = (settings) => (settings.checkInTabs ? { readInTab: tabReader(ext) } : {});

async function runAnalysis(deal, force, onProgress) {
  const settings = await loadSettings(storage);
  if (!force) {
    const cached = await getCached(storage, deal.key, settings.model);
    if (cached) {
      const chat = await getChat(storage, deal.key, settings.model);
      return { ...cached, turns: chat?.turns || [], cached: true };
    }
  }

  // A job keeps running if its tab closes: it's already being paid for, and
  // finishing it means the cache has the answer next time.
  const id = `${settings.model}:${deal.key}`;
  let job = inflight.get(id);
  if (!job) {
    const listeners = new Set();
    const promise = analyzeDeal(deal, settings, { ...priceCheckOptions(settings), onProgress: (p) => listeners.forEach((fn) => fn(p)) })
      .then(async (result) => {
        await putCached(storage, deal.key, settings.model, result);
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
  const [chat, cached] = await Promise.all([
    getChat(storage, deal.key, settings.model),
    getCached(storage, deal.key, settings.model)
  ]);
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
  await putChat(storage, deal.key, settings.model, { turns });

  let revision = null;
  if (outcome.verdict) {
    revision = { verdict: outcome.verdict, revisedAt: new Date().toISOString() };
    if (cached) await putCached(storage, deal.key, settings.model, { ...cached, ...revision });
  }
  return { turns, revision };
}

// A long-lived port per analysis: the content script pings it, which keeps
// the service worker alive while the (slow) web-search request runs.
ext.runtime.onConnect.addListener((port) => {
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
        post({ type: 'result', result: await runAnalysis(msg.deal, Boolean(msg.force), onProgress) });
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
        model: s.model,
        helperTab: isHelperTab(sender.tab?.id)
      })
    );
    return true;
  }
  // A saved verdict for this deal, if there is one: free, and never starts an analysis.
  if (msg?.type === 'peek' && msg.key) {
    loadSettings(storage)
      .then(async (s) => {
        const cached = await getCached(storage, msg.key, s.model);
        if (!cached) return null;
        const chat = await getChat(storage, msg.key, s.model);
        return { ...cached, turns: chat?.turns || [], cached: true };
      })
      .then(sendResponse, () => sendResponse(null));
    return true;
  }
  return false;
});

// The toolbar button (or Alt+Shift+D) analyzes the product on the current tab.
// `activeTab` lets the extension into that one tab for this click, even where
// the shopper hasn't granted it access to every site (Firefox asks).
export const PAGE_SCRIPTS = [
  'src/content/extract.js',
  'src/content/extract-page.js',
  'src/content/panel.js',
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
