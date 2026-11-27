// List mode: on a page that shows many products (search results, a category),
// a small badge under each one with its rating and how its price compares
// with the same item and an equivalent product elsewhere. Products are rated
// as they scroll into view, a few at a time, with the simple verdict (fewer
// searches, a few dozen tokens to write), and each badge opens the full panel.
// Off unless the shopper turns it on: every product rated costs money.
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});
  if (ns.watchListPage) return;

  const PING_MS = 20_000;
  const RESCAN_MS = 1500;
  // Products rated per page before it stops: a long infinite-scroll page shouldn't run up a bill.
  const MAX_REQUESTS = 40;
  const MARK = 'data-deals-analyzer';

  const t = (key, vars) => ns.t(key, vars);

  const STYLE = `
    :host { all: initial; display: block; }
    .badge {
      display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; width: 100%; box-sizing: border-box;
      margin: 4px 0; padding: 4px 8px; border: 1px solid #d0d7de; border-radius: 8px; background: #fff;
      font: 12px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328;
      text-align: left; cursor: pointer;
    }
    .badge:hover { border-color: #8c959f; }
    .badge.quiet { color: #6e7781; cursor: default; }
    .pill { padding: 1px 8px; border-radius: 999px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: .02em; }
    .cmp { white-space: nowrap; font-variant-numeric: tabular-nums; }
    .cmp .label { color: #57606a; }
    .dim { color: #6e7781; text-decoration: line-through; }
    .delta { font-weight: 600; margin-left: 3px; }
    .good { color: #1a7f37; } .bad { color: #b42318; } .muted { color: #6e7781; }
    .q { color: #bc4c00; font-weight: 700; margin-left: 2px; }
  `;

  function badgeFor(tile, { onOpen }) {
    const { h } = ns.ui;
    const host = document.createElement('div');
    host.setAttribute(MARK, 'badge');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    // The rating colors are the panel's.
    style.textContent = STYLE + ns.ui.STYLE_RATINGS;
    const box = h('button', { class: 'badge quiet', type: 'button', title: t('b_tip') });
    shadow.append(style, box);
    // A table row can only hold cells; the badge goes in its last one.
    (tile.tagName === 'TR' ? tile.lastElementChild || tile : tile).append(host);

    let state = 'idle';
    let result = null;
    let deal = null;
    box.addEventListener('click', (event) => {
      // The tile around it is usually a link; the badge opens the panel instead.
      event.preventDefault();
      event.stopPropagation();
      if (result && onOpen) onOpen(deal, result);
    });

    function compare(labelKey, kind, price, dealPrice, unconfirmed) {
      if (typeof price !== 'number') return null;
      const { money, deltaVs } = ns.ui;
      return h(
        'span',
        { class: 'cmp', title: t('b_delta_tip', { kind: t(kind === 'same' ? 'm_same_item' : 'm_equivalent'), price: money(price) }) + (unconfirmed ? `\n${t('p_unconfirmed_tip')}` : '') },
        h('span', { class: 'label' }, `${t(labelKey)} `),
        h('span', { class: unconfirmed ? 'dim' : '' }, money(price)),
        unconfirmed ? h('span', { class: 'q' }, '?') : deltaVs(dealPrice, price)
      );
    }

    function render() {
      const { h: el, ratingLabel } = ns.ui;
      if (state === 'result' && result?.verdict?.rating) {
        const v = result.verdict;
        const support = v.priceSupport || {};
        box.className = 'badge';
        box.title = t('b_tip');
        box.replaceChildren(
          el('span', { class: `pill r-${v.rating}` }, ratingLabel(v.rating)),
          compare('b_same', 'same', v.sameItemPrice, v.dealPrice, support.sameItem === 'unconfirmed'),
          compare('b_equivalent', 'equivalent', v.equivalentMarketPrice, v.dealPrice, support.equivalent === 'unconfirmed')
        );
        return;
      }
      box.className = 'badge quiet';
      box.replaceChildren(t(state === 'failed' ? 'b_failed' : state === 'checking' ? 'b_checking' : 'b_queued'));
    }

    return {
      host,
      set(next, payload = null, forDeal = null) {
        state = next;
        if (next === 'result') {
          result = payload;
          deal = forDeal;
        }
        if (next === 'failed') box.title = payload?.message || t('b_failed');
        render();
      },
      render,
      remove: () => host.remove()
    };
  }

  /**
   * Watches the page for products and rates the ones the shopper scrolls to.
   * @param {{ext: object, isProductPage: () => boolean, onOpen: (deal: object, result: object) => void}} options
   */
  function watchListPage({ ext, isProductPage, onOpen }) {
    const items = new Map(); // id -> { el, deal, badge, requested }
    const byTile = new WeakMap();
    let nextId = 0;
    let requests = 0;
    let port = null;
    let pingTimer = null;

    function connect() {
      if (port) return port;
      const thisPort = ext.runtime.connect({ name: 'deal-list' });
      port = thisPort;
      pingTimer = setInterval(() => {
        try {
          thisPort.postMessage({ type: 'ping' });
        } catch {
          // disconnected; onDisconnect handles it
        }
      }, PING_MS);
      thisPort.onMessage.addListener((msg) => {
        const item = items.get(msg?.id);
        if (!item) return;
        if (msg.type === 'queued') item.badge.set('queued');
        else if (msg.type === 'started') item.badge.set('checking');
        else if (msg.type === 'item') item.badge.set('result', msg.result, item.deal);
        else if (msg.type === 'item-error') item.badge.set('failed', msg.error);
      });
      thisPort.onDisconnect.addListener(() => {
        clearInterval(pingTimer);
        port = null;
        // The background restarted: ask again for what hadn't come back.
        for (const item of items.values()) if (item.requested && item.waiting) send(item, true);
      });
      return thisPort;
    }

    function send(item, retry = false) {
      if (!retry) {
        if (item.requested || requests >= MAX_REQUESTS) return;
        requests++;
        item.requested = true;
      }
      item.waiting = true;
      item.badge.set('queued');
      try {
        connect().postMessage({ type: 'analyze', id: item.id, deal: item.deal });
      } catch {
        item.badge.set('failed');
      }
    }

    const observer = new root.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = items.get(byTile.get(entry.target));
          if (item) send(item);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px 200px 0px', threshold: 0.25 }
    );

    function scan() {
      if (isProductPage()) return;
      for (const { el, deal } of ns.extractListDeals(document, { url: location.href })) {
        if (byTile.has(el)) continue;
        const id = nextId++;
        const item = { id, el, deal, requested: false, waiting: false };
        item.badge = badgeFor(el, {
          onOpen: (d, result) => onOpen(d, result)
        });
        // Results reach the badge through the port, keyed by id.
        const set = item.badge.set;
        item.badge.set = (next, payload, forDeal) => {
          if (next === 'result' || next === 'failed') item.waiting = false;
          set(next, payload, forDeal);
        };
        items.set(id, item);
        byTile.set(el, id);
        observer.observe(el);
      }
    }

    let queued = null;
    new root.MutationObserver((records) => {
      // The badges' own changes don't count.
      if (records.every((r) => [...r.addedNodes].every((n) => n.nodeType === 1 && n.hasAttribute?.(MARK)))) return;
      clearTimeout(queued);
      queued = setTimeout(scan, RESCAN_MS);
    }).observe(document.body, { childList: true, subtree: true });
    scan();

    return {
      relabel() {
        for (const item of items.values()) item.badge.render();
      }
    };
  }

  ns.watchListPage = watchListPage;
})(globalThis);
