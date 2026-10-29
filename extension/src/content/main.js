// Wires the extractor and panel into eDealinfo pages: deal pages (/d/...) get
// the panel straight away; deal pop-ups on listing pages get an "Analyze" button.
(function (root) {
  'use strict';

  const ns = root.DealsAnalyzer;
  const ext = root.browser ?? root.chrome;
  if (!ns || !ns.extractDeal || !ns.createPanel || ns.started) return;
  ns.started = true;

  const PING_MS = 20_000;
  const POPUP_SELECTOR = '#cboxLoadedContent';
  const MARK = 'data-deals-analyzer';

  let panel = null;
  let currentDeal = null;
  let port = null;
  let pingTimer = null;

  function openSettings() {
    ext.runtime.sendMessage({ type: 'open-options' }).catch(() => {});
  }

  function ensurePanel() {
    if (!panel) {
      panel = ns.createPanel({
        onAnalyze: (force) => analyze(currentDeal, force),
        onOpenSettings: openSettings,
        onCollapseChange: (collapsed) => ext.storage.local.set({ panelCollapsed: collapsed }).catch(() => {})
      });
    }
    return panel;
  }

  async function getStatus() {
    try {
      return (await ext.runtime.sendMessage({ type: 'get-status' })) || { hasKey: false, autoAnalyze: false };
    } catch {
      return { hasKey: false, autoAnalyze: false };
    }
  }

  function disconnect() {
    clearInterval(pingTimer);
    pingTimer = null;
    if (port) {
      const old = port;
      port = null;
      try {
        old.disconnect();
      } catch {
        // already closed
      }
    }
  }

  function analyze(deal, force) {
    if (!deal) return;
    disconnect();
    const p = ensurePanel();
    p.showLoading();

    const thisPort = ext.runtime.connect({ name: 'deal-analysis' });
    port = thisPort;
    pingTimer = setInterval(() => {
      try {
        thisPort.postMessage({ type: 'ping' });
      } catch {
        // disconnected; onDisconnect reports it
      }
    }, PING_MS);

    thisPort.onMessage.addListener((msg) => {
      if (thisPort !== port || !msg) return;
      if (msg.type === 'progress') p.updateQueries(msg.queries || []);
      else if (msg.type === 'result') {
        disconnect();
        p.showResult(msg.result);
      } else if (msg.type === 'error') {
        disconnect();
        p.showError(msg.error || {});
      }
    });
    thisPort.onDisconnect.addListener(() => {
      if (thisPort !== port) return;
      disconnect();
      p.showError({ code: 'disconnected', message: 'Lost the connection to the extension. Try again.' });
    });
    thisPort.postMessage({ type: 'analyze', deal, force: Boolean(force) });
  }

  async function present(deal, { expand = false } = {}) {
    currentDeal = deal;
    const p = ensurePanel();
    p.setDeal(deal);
    const [stored, status] = await Promise.all([
      ext.storage.local.get('panelCollapsed').catch(() => ({})),
      getStatus()
    ]);
    p.show({ collapsed: expand ? false : Boolean(stored.panelCollapsed) });
    if (!status.hasKey) p.showNeedsKey();
    else if (expand || status.autoAnalyze) analyze(deal, false);
    else p.showIdle();
  }

  function addPopupButton(container) {
    const firstLine = container.querySelector('td.deal-first-line');
    const table = firstLine && firstLine.closest('table');
    if (!table || table.hasAttribute(MARK)) return;
    table.setAttribute(MARK, '1');

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Is this a good deal? Analyze';
    button.setAttribute(MARK, 'button');
    button.style.cssText =
      'margin:4px 0 8px;padding:4px 12px;border:0;border-radius:6px;background:#1f6feb;color:#fff;' +
      'font:600 13px system-ui,sans-serif;cursor:pointer;';
    button.addEventListener('click', () => {
      const deal = ns.extractDeal(container, { url: location.href });
      if (deal) present(deal, { expand: true });
    });
    table.parentElement.insertBefore(button, table);
  }

  function watchPopups() {
    let queued = false;
    const scan = () => {
      queued = false;
      const popup = document.querySelector(POPUP_SELECTOR);
      if (popup) addPopupButton(popup);
    };
    new MutationObserver(() => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(scan);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (/^\/d\//.test(location.pathname)) {
    const deal = ns.extractDeal(document, { url: location.href });
    if (deal) present(deal);
  }
  watchPopups();
})(globalThis);
