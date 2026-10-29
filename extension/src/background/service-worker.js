// Background entry point: runs analyses for the content script and keeps the
// API key out of the page.

import { analyzeDeal, AnalysisError } from './claude.js';
import { loadSettings } from './settings.js';
import { getCached, putCached } from './cache.js';

const ext = globalThis.browser ?? globalThis.chrome;
const storage = ext.storage.local;

// Analyses in flight, keyed by deal and model, so two tabs on the same deal share one request.
const inflight = new Map();

function serializeError(err) {
  if (err instanceof AnalysisError) return { code: err.code, message: err.message };
  return { code: 'internal', message: err?.message || String(err) };
}

async function runAnalysis(deal, force, onProgress) {
  const settings = await loadSettings(storage);
  if (!force) {
    const cached = await getCached(storage, deal.key, settings.model);
    if (cached) return { ...cached, cached: true };
  }

  // A job keeps running if its tab closes: it's already being paid for, and
  // finishing it means the cache has the answer next time.
  const id = `${settings.model}:${deal.key}`;
  let job = inflight.get(id);
  if (!job) {
    const listeners = new Set();
    const promise = analyzeDeal(deal, settings, { onProgress: (p) => listeners.forEach((fn) => fn(p)) })
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
    return { ...(await job.promise), cached: false };
  } finally {
    job.listeners.delete(onProgress);
  }
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
    if (msg?.type !== 'analyze' || !msg.deal?.key) return;
    try {
      const result = await runAnalysis(msg.deal, Boolean(msg.force), (progress) =>
        post({ type: 'progress', ...progress })
      );
      post({ type: 'result', result });
    } catch (err) {
      post({ type: 'error', error: serializeError(err) });
    }
  });
});

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'open-options') {
    ext.runtime.openOptionsPage();
    return false;
  }
  if (msg?.type === 'get-status') {
    loadSettings(storage).then((s) =>
      sendResponse({ hasKey: Boolean(s.apiKey), autoAnalyze: s.autoAnalyze, model: s.model })
    );
    return true;
  }
  return false;
});

ext.action.onClicked.addListener(() => ext.runtime.openOptionsPage());

ext.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const settings = await loadSettings(storage);
  if (!settings.apiKey) ext.runtime.openOptionsPage();
});
