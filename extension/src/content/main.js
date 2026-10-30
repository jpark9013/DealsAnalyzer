// Wires the extractors and panel into the page. On eDealinfo, deal pages (/d/...)
// get the panel straight away and deal pop-ups get an "Analyze" button. Any other
// site's product page gets the same automatic check, or with auto-analyze off the
// minimized "Deal check" tab, which analyzes when clicked. The toolbar button
// calls analyzePage() on any page (the background injects these scripts first
// where the browser hasn't).
(function (root) {
  'use strict';

  const ns = root.DealsAnalyzer;
  const ext = root.browser ?? root.chrome;
  if (!ns || !ns.extractDeal || !ns.createPanel || ns.started) return;
  ns.started = true;

  const PING_MS = 20_000;
  const POPUP_SELECTOR = '#cboxLoadedContent';
  const MARK = 'data-deals-analyzer';
  // Stores often add their product data after the page loads.
  const STORE_RETRY_MS = [0, 1500, 4000];
  const URL_CHECK_MS = 1000;
  // A moment on the page before paying for an analysis, for bouncing straight
  // back or clicking through a product's sizes and colors.
  const AUTO_ANALYZE_DELAY_MS = 1200;
  const onEdealinfo = /(^|\.)edealinfo\.com$/.test(location.hostname);

  let panel = null;
  let currentDeal = null;
  let port = null;
  let pingTimer = null;
  // A store page analyzes when its tab is first opened, unless there's already a verdict.
  let analyzeOnExpand = false;
  // The minimized tab on a store with auto-analyze off isn't the shopper's choice to remember.
  let quietCollapse = false;
  // Counts what's been put in the panel, so a slower, older setup can't
  // overwrite a newer one (say, the toolbar button's analysis).
  let shown = 0;

  function openSettings() {
    ext.runtime.sendMessage({ type: 'open-options' }).catch(() => {});
  }

  function ensurePanel() {
    if (!panel) {
      panel = ns.createPanel({
        onAnalyze: (force) => (currentDeal ? analyze(currentDeal, force) : ns.analyzePage()),
        onAsk: (question) => ask(currentDeal, question),
        onOpenSettings: openSettings,
        onExpand: () => {
          if (analyzeOnExpand && currentDeal) analyzeFromPage();
        },
        onCollapseChange: (collapsed) => {
          if (!quietCollapse) ext.storage.local.set({ panelCollapsed: collapsed }).catch(() => {});
        },
        onLayoutChange: (layout) => ext.storage.local.set({ panelLayout: layout }).catch(() => {})
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

  // Each request gets its own port: the content script pings it, which keeps
  // the background worker alive while the slow web-search request runs.
  function request(message, { onProgress, onDone, onError }) {
    disconnect();
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
      if (msg.type === 'progress') onProgress(msg);
      else if (msg.type === 'error') {
        disconnect();
        onError(msg.error || {});
      } else {
        disconnect();
        onDone(msg);
      }
    });
    thisPort.onDisconnect.addListener(() => {
      if (thisPort !== port) return;
      disconnect();
      onError({ code: 'disconnected', message: 'Lost the connection to the extension. Try again.' });
    });
    thisPort.postMessage(message);
  }

  function analyze(deal, force) {
    if (!deal) return;
    analyzeOnExpand = false;
    const p = ensurePanel();
    p.showLoading();
    request(
      { type: 'analyze', deal, force: Boolean(force) },
      {
        onProgress: (progress) => p.updateProgress(progress),
        onDone: (msg) => p.showResult(msg.result),
        onError: (error) => p.showError(error)
      }
    );
  }

  // Read the page again first: the price may have loaded since, or the shopper
  // picked another size or color.
  function analyzeFromPage() {
    const fresh = !onEdealinfo && ns.extractPageDeal(document, { url: location.href });
    if (fresh) {
      currentDeal = fresh;
      panel.setDeal(fresh);
    }
    analyze(currentDeal, false);
  }

  function ask(deal, question) {
    if (!deal) return;
    const p = ensurePanel();
    p.showAsking(question);
    request(
      { type: 'ask', deal, question },
      {
        onProgress: (progress) => p.updateAskQueries(progress.queries || []),
        onDone: (msg) => p.showAnswer({ turns: msg.turns || [], revision: msg.revision || null }),
        onError: (error) => p.showAskError(error, question)
      }
    );
  }

  async function present(deal, { expand = false, status: knownStatus = null } = {}) {
    shown++;
    currentDeal = deal;
    const p = ensurePanel();
    p.setDeal(deal);
    const [stored, status] = await Promise.all([
      ext.storage.local.get(['panelCollapsed', 'panelLayout']).catch(() => ({})),
      knownStatus || getStatus()
    ]);
    p.show({ collapsed: expand ? false : Boolean(stored.panelCollapsed), layout: stored.panelLayout || null });
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

    // With auto-analyze on, opening a pop-up is enough; the button stays for
    // reopening the panel or when auto-analyze is off.
    getStatus().then((status) => {
      if (!status.hasKey || !status.autoAnalyze) return;
      const deal = ns.extractDeal(container, { url: location.href });
      if (deal) present(deal, { status });
    });
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

  // The deal this page shows: an open eDealinfo pop-up or deal page, or a
  // store's product page.
  function pageDeal() {
    const url = location.href;
    if (onEdealinfo) {
      const popup = document.querySelector(POPUP_SELECTOR);
      const fromPopup = popup && ns.extractDeal(popup, { url });
      if (fromPopup) return fromPopup;
      return /^\/d\//.test(location.pathname) ? ns.extractDeal(document, { url }) : null;
    }
    return ns.extractPageDeal ? ns.extractPageDeal(document, { url }) : null;
  }

  // The toolbar button: analyze whatever product this page shows. Read fresh
  // each time, since the shopper may have picked another size or color.
  ns.analyzePage = () => {
    const deal = pageDeal();
    if (deal) {
      present(deal, { expand: true });
      return;
    }
    shown++;
    currentDeal = null;
    const p = ensurePanel();
    p.setDeal({ title: document.title || location.hostname });
    ext.storage.local
      .get('panelLayout')
      .catch(() => ({}))
      .then((stored) => p.show({ collapsed: false, layout: stored.panelLayout || null }));
    p.showError({
      code: 'no_product',
      message: "Couldn't find a product with a price on this page. Open the product's own page, then try again."
    });
  };

  // Resolves once the shopper has been looking at this tab for a moment: a tab
  // opened in the background costs nothing until it's actually viewed.
  function whenViewed() {
    return new Promise((resolve) => {
      const settle = () => setTimeout(resolve, AUTO_ANALYZE_DELAY_MS);
      if (document.visibilityState === 'visible') {
        settle();
        return;
      }
      document.addEventListener('visibilitychange', function onChange() {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onChange);
        settle();
      });
    });
  }

  // Shows a store's product: its rating if it was analyzed in the last day
  // (free), otherwise checked automatically, or with auto-analyze off, as the
  // minimized tab that analyzes on a click. A page with no price yet waits as
  // the tab too; the store watcher comes back when the price renders.
  async function offerStoreDeal(deal) {
    const mine = ++shown;
    const status = await getStatus();
    if (status.showOnStores === false || status.helperTab || mine !== shown) return;
    disconnect(); // a request for the previous product's panel
    currentDeal = deal;
    analyzeOnExpand = false;
    const p = ensurePanel();
    p.setDeal(deal);
    const stored = await ext.storage.local.get(['panelCollapsed', 'panelLayout']).catch(() => ({}));
    if (mine !== shown) return;
    const auto = Boolean(status.hasKey && status.autoAnalyze && typeof deal.finalPrice === 'number');
    quietCollapse = !auto;
    p.show({ collapsed: auto ? Boolean(stored.panelCollapsed) : true, layout: stored.panelLayout || null });
    quietCollapse = false;
    if (!status.hasKey) {
      p.showNeedsKey();
      return;
    }
    const cached = await ext.runtime.sendMessage({ type: 'peek', key: deal.key }).catch(() => null);
    if (mine !== shown) return; // the shopper moved on meanwhile
    if (cached) {
      p.showResult(cached);
      return;
    }
    p.showIdle();
    analyzeOnExpand = true;
    if (!auto) return;
    await whenViewed();
    // Moved on, or opened the tab and started it already.
    if (mine === shown && analyzeOnExpand) analyzeFromPage();
  }

  // Product pages on any store. Single-page stores change products without
  // reloading, so the address is checked every second.
  function watchStorePages() {
    let lastUrl = null;
    let shownKey = null;
    let retry = null;
    const attempt = (i) => {
      const deal = ns.extractPageDeal(document, { url: location.href, strict: true });
      if (deal && deal.key !== shownKey) {
        shownKey = deal.key;
        offerStoreDeal(deal);
      }
      // Keep looking while there's no product yet, or no price (some stores render it late).
      const done = deal && typeof deal.finalPrice === 'number';
      if (!done && i + 1 < STORE_RETRY_MS.length) retry = setTimeout(() => attempt(i + 1), STORE_RETRY_MS[i + 1] - STORE_RETRY_MS[i]);
    };
    const check = () => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      clearTimeout(retry);
      attempt(0);
    };
    check();
    setInterval(check, URL_CHECK_MS);
  }

  if (onEdealinfo) {
    if (/^\/d\//.test(location.pathname)) {
      const deal = ns.extractDeal(document, { url: location.href });
      if (deal) present(deal);
    }
    watchPopups();
  } else if (ns.extractPageDeal) {
    watchStorePages();
  }
})(globalThis);
