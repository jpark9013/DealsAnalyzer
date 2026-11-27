// Finds the products on a page that lists several: search results, category
// pages, deal lists. Each becomes a small deal (title, price, link) that the
// list mode rates with a badge under the product.
//
// Stores lay these out in many ways, so it goes by shape rather than by site:
// a product is the smallest element around a price whose siblings repeat it
// (three or more alike, each with a price of its own). Amazon's results get an
// adapter, since their markup nests deeply and carries the ASIN.
//
// Loaded as a classic content script (shares `globalThis.DealsAnalyzer`) and
// by the Node tests.
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});

  const MAX_ITEMS = 60;
  const MIN_REPEATS = 3;
  const MAX_DEPTH = 12;
  const TILE_TEXT_MAX = 300;
  const PRICE_RE = /\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/;
  // "Was", list and per-unit prices sit next to the price to pay.
  const NOT_THE_PRICE = /was|list|strike|original|regular|compare|old|msrp|reference|per[-_ ]?unit|unit[-_ ]?price/i;
  const NOT_A_TITLE = /^(add to (cart|bag|basket)|buy (it )?now|shop now|see (more|details|all)|view (details|all)|compare|sponsored|quick ?view|options?|more like this|\d+ (reviews?|ratings?))$/i;
  const SKIP = 'script, style, noscript, template, svg';
  // Skeletons a page shows while it loads its products.
  const PLACEHOLDER = /placeholder|lorem ipsum|loading…?$/i;

  // Not shown: a hidden carousel slide or template. Browsers can say so
  // directly; without layout (tests), the markup's own hiding is all there is.
  function hidden(el) {
    if (el.closest('[hidden], [aria-hidden="true"], [style*="display: none"], [style*="display:none"]')) return true;
    return typeof el.checkVisibility === 'function' ? !el.checkVisibility() : false;
  }

  const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  function toNumber(text) {
    const match = String(text ?? '').match(PRICE_RE);
    if (!match) return null;
    const n = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function absolute(href, base) {
    try {
      const url = new URL(href, base);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch {
      return null;
    }
  }

  function struck(el) {
    for (let node = el, i = 0; node && i < 4; node = node.parentElement, i++) {
      if (node.matches('s, del, strike')) return true;
      const label = `${node.className && typeof node.className === 'string' ? node.className : ''} ${node.id || ''} ${node.getAttribute('data-testid') || ''}`;
      if (NOT_THE_PRICE.test(label)) return true;
    }
    return false;
  }

  /** Elements showing one price to pay: short text with a dollar amount, not struck out. */
  function priceElements(scope) {
    const out = [];
    const walker = scope.ownerDocument.createTreeWalker(scope, root.NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!PRICE_RE.test(node.nodeValue)) continue;
      const el = node.parentElement;
      if (!el || el.closest(SKIP) || el.closest('[data-deals-analyzer]')) continue;
      const text = clean(el.textContent);
      if (text.length > 40 || /\d\s*[-–]\s*\$/.test(text) || struck(el)) continue;
      if (toNumber(text) !== null) out.push(el);
    }
    return out;
  }

  const signature = (el) => `${el.tagName}.${(typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '') || ''}`;

  /**
   * The repeating units around these prices: for each price, the first
   * ancestor with enough look-alike siblings that also hold prices.
   */
  function tiles(prices) {
    const priced = new Set();
    for (const el of prices) {
      for (let node = el, i = 0; node && i < MAX_DEPTH; node = node.parentElement, i++) priced.add(node);
    }
    const found = new Set();
    for (const el of prices) {
      for (let node = el, i = 0; node?.parentElement && i < MAX_DEPTH; node = node.parentElement, i++) {
        // A tile links to its product; a cell of prices in a row doesn't.
        if (!node.matches('a[href]') && !node.querySelector('a[href]')) continue;
        const sig = signature(node);
        const alike = [...node.parentElement.children].filter((c) => signature(c) === sig && priced.has(c));
        if (alike.length >= MIN_REPEATS) {
          found.add(node);
          break;
        }
      }
    }
    // A tile inside another found tile is a part of it (a variant swatch, say).
    return [...found].filter((tile) => ![...found].some((other) => other !== tile && other.contains(tile)));
  }

  // The product's name: its longest link text, or its picture's description.
  function titleAndLink(tile, base) {
    let best = null;
    for (const a of [...(tile.matches('a[href]') ? [tile] : []), ...tile.querySelectorAll('a[href]')]) {
      const url = absolute(a.getAttribute('href'), base);
      if (!url || url.split('#')[0] === base.split('#')[0]) continue;
      const text = clean(a.getAttribute('aria-label') || a.textContent);
      const alt = clean(a.querySelector('img[alt]')?.getAttribute('alt'));
      for (const candidate of [text, alt]) {
        if (candidate.length >= 10 && candidate.length <= 300 && !NOT_A_TITLE.test(candidate) && !PRICE_RE.test(candidate.slice(0, 2)) && (!best || candidate.length > best.title.length)) {
          best = { title: candidate, url };
        }
      }
    }
    if (best) return best;
    const heading = tile.querySelector('h2, h3, h4, [class*="title" i], [class*="name" i]');
    const link = tile.matches('a[href]') ? tile : tile.querySelector('a[href]');
    const title = clean(heading?.textContent);
    const url = link && absolute(link.getAttribute('href'), base);
    return title.length >= 10 && url ? { title, url } : null;
  }

  function detectCondition(text) {
    if (/open[\s-]?box/i.test(text)) return 'open box';
    if (/refurbished|renewed|reconditioned/i.test(text)) return 'refurbished';
    if (/\bused\b|pre-owned/i.test(text)) return 'used';
    return 'new';
  }

  function tileText(tile) {
    const copy = tile.cloneNode(true);
    copy.querySelectorAll(`${SKIP}, button, select, input`).forEach((n) => n.remove());
    copy.querySelectorAll('*').forEach((el) => el.append(' '));
    const text = clean(copy.textContent);
    return (ns.scrubPersonal ? ns.scrubPersonal(text) : text).slice(0, TILE_TEXT_MAX);
  }

  function makeDeal({ title, url, price, store, site, asin = null, text, listPrice = null }) {
    return {
      title,
      productName: title,
      brand: null,
      model: null,
      upc: null,
      asin,
      sku: null,
      store,
      sellerNote: null,
      condition: detectCondition(title),
      finalPrice: price,
      listPrice,
      listPriceLabel: listPrice ? 'Was' : null,
      shipping: null,
      availability: null,
      rating: null,
      specs: {},
      notes: [],
      pageText: text || null,
      site,
      pageUrl: asin ? `https://www.amazon.com/dp/${asin}` : url,
      fromList: true,
      key: [asin || title, site, price].join('|')
    };
  }

  // --- Amazon search results ---------------------------------------------

  function amazonItems(doc, base) {
    const items = [];
    for (const tile of doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]')) {
      const asin = tile.getAttribute('data-asin');
      if (!/^[A-Z0-9]{10}$/.test(asin)) continue;
      const title = clean(tile.querySelector('h2')?.getAttribute('aria-label') || tile.querySelector('h2')?.textContent).replace(/^Sponsored Ad - /, '');
      const price = toNumber(tile.querySelector('.a-price:not(.a-text-price) .a-offscreen')?.textContent);
      const was = toNumber(tile.querySelector('.a-price.a-text-price .a-offscreen')?.textContent);
      const href = tile.querySelector('h2 a, a.a-link-normal[href*="/dp/"]')?.getAttribute('href');
      if (!title || price === null) continue;
      items.push({
        el: tile,
        deal: makeDeal({ title, url: absolute(href || `/dp/${asin}`, base), price, store: 'Amazon.com', site: 'amazon.com', asin, text: tileText(tile), listPrice: was })
      });
    }
    return items;
  }

  // --- eDealinfo's deal grid ---------------------------------------------

  // Its tiles open the deal in a pop-up rather than linking to it, and name
  // the store that sells it. The pop-up's own deal key is the UPC, posting
  // date and price, so a badge and the pop-up share one saved verdict.
  function edealinfoItems(doc, base) {
    const items = [];
    for (const tile of doc.querySelectorAll('[id^="myViewedDeal"]')) {
      const title = clean(tile.querySelector('.grid-deal-title')?.textContent);
      const price = toNumber(`$${clean(tile.querySelector('.grid-price-pos')?.textContent).replace(/^\$/, '')}`);
      if (!title || price === null) continue;
      const onclick = tile.querySelector('[onclick*="showDetails"]')?.getAttribute('onclick') || '';
      const details = (onclick.match(/showDetails\("d",\s*"(\d{4}-\d{2}-\d{2})",\s*\d+,\s*"(\d+)"\)/) || []).slice(1);
      const [date, code] = details;
      const upc = code ? code.replace(/^00/, '') : null;
      const deal = makeDeal({
        title,
        url: upc ? `https://www.edealinfo.com/d/${code}/` : base,
        price,
        store: clean(tile.querySelector('.mName')?.textContent) || 'eDealinfo',
        site: 'edealinfo.com',
        text: tileText(tile)
      });
      deal.upc = upc;
      deal.dealDate = date || null;
      deal.key = [upc || title, date || '', price].join('|');
      items.push({ el: tile, deal });
    }
    return items;
  }

  /**
   * @param {Document} doc
   * @param {{url?: string}} [options]
   * @returns {{el: Element, deal: object}[]} the products shown, in page order
   */
  function extractListDeals(doc, options = {}) {
    const base = options.url || doc.location?.href || '';
    const site = hostOf(base);
    const adapter = /(^|\.)amazon\.com$/.test(site) ? amazonItems : /(^|\.)edealinfo\.com$/.test(site) ? edealinfoItems : null;
    if (adapter) {
      const items = adapter(doc, base);
      if (items.length) return items.slice(0, MAX_ITEMS);
    }
    if (!doc.body) return [];
    const store = clean(doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')) || site;
    const items = [];
    const seen = new Set();
    for (const tile of tiles(priceElements(doc.body))) {
      if (hidden(tile)) continue;
      const named = titleAndLink(tile, base);
      if (!named || PLACEHOLDER.test(named.title)) continue;
      const price = toNumber(priceElements(tile)[0]?.textContent);
      if (price === null) continue;
      const deal = makeDeal({ ...named, price, store, site, text: tileText(tile) });
      // A deal site's list: the store selling it is named in the post, not the site.
      if (ns.isDealSite?.(site)) deal.dealSite = true;
      if (seen.has(deal.key)) continue;
      seen.add(deal.key);
      items.push({ el: tile, deal });
      if (items.length >= MAX_ITEMS) break;
    }
    // Two or three priced things side by side is a product's options or a
    // related-items strip, not a list of products.
    return items.length >= MIN_REPEATS ? items : [];
  }

  ns.extractListDeals = extractListDeals;
})(globalThis);
