// Pulls the structured deal out of an eDealinfo deal page or deal pop-up.
//
// Loaded as a classic content script (shares `globalThis.DealsAnalyzer` with
// panel.js and main.js) and imported directly by the Node tests, so it must
// not use import/export and must not touch anything outside the given scope.
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});

  const MONEY_RE = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;

  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoney(text) {
    const match = String(text || '').match(MONEY_RE);
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(value) ? value : null;
  }

  // Text the user actually sees: the site keeps things like a hidden
  // "Copied" confirmation inside the coupon cell.
  function visibleText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[style]').forEach((node) => {
      if (/display\s*:\s*none/i.test(node.getAttribute('style') || '')) node.remove();
    });
    return cleanText(clone.textContent);
  }

  // Value cells start with a bold ":" separator.
  function cellValue(td) {
    return visibleText(td).replace(/^:\s*/, '');
  }

  function inputValue(scope, id) {
    const el = scope.querySelector(`input#${id}`);
    const value = el ? cleanText(el.getAttribute('value')) : '';
    return value || null;
  }

  function absoluteUrl(href, baseUrl) {
    if (!href) return null;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return null;
    }
  }

  function findDealTable(scope) {
    for (const td of scope.querySelectorAll('td.deal-first-line')) {
      if (cleanText(td.textContent)) return td.closest('table');
    }
    return null;
  }

  function detectCondition(text) {
    if (/open[\s-]?box/i.test(text)) return 'open box';
    if (/refurbished|renewed|reconditioned/i.test(text)) return 'refurbished';
    if (/\bused\b|pre-owned/i.test(text)) return 'used';
    return 'new';
  }

  function parseFirstLine(td, baseUrl) {
    const text = visibleText(td);
    const link = td.querySelector('a[href]');
    const boldSpans = [...td.querySelectorAll('span')].filter((s) =>
      /font-weight\s*:\s*(700|bold)/i.test(s.getAttribute('style') || '')
    );
    const store = boldSpans.length ? cleanText(boldSpans[boldSpans.length - 1].textContent) : null;

    let sellerNote = null;
    if (store) {
      const after = text.slice(text.lastIndexOf(store) + store.length);
      const paren = after.match(/\(([^)]+)\)/);
      if (paren) sellerNote = cleanText(paren[1]);
    }

    return {
      text,
      productName: link ? cleanText(link.textContent) : null,
      store,
      sellerNote,
      dealLink: link ? absoluteUrl(link.getAttribute('href'), baseUrl) : null
    };
  }

  function parseRows(table) {
    const rows = {};
    const notes = [];
    let couponCode = null;

    for (const tr of table.querySelectorAll('tr')) {
      const heading = tr.querySelector('.deal-detail-heading-text');
      if (heading) {
        const label = cleanText(heading.textContent);
        const valueCell = tr.querySelector('td.deal-detail-price') || tr.querySelector('td:last-child');
        if (label && valueCell) rows[label] = cellValue(valueCell);
        const coupon = valueCell && valueCell.querySelector('[id^="examplePre"], [title="Click to Copy"]');
        if (coupon && !couponCode) couponCode = cleanText(coupon.textContent) || null;
        continue;
      }
      const td = tr.querySelector('td[colspan]');
      if (td && !td.classList.contains('deal-first-line')) {
        const note = visibleText(td);
        if (note) notes.push(note);
      }
    }
    return { rows, notes, couponCode };
  }

  function parsePriceHistory(raw) {
    if (!raw) return [];
    try {
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      return data
        .slice(1)
        .filter((row) => Array.isArray(row) && row.length >= 2 && Number.isFinite(Number(row[1])))
        .map(([date, price]) => ({ date: String(date), price: Number(price) }));
    } catch {
      return [];
    }
  }

  function parseComparisons(container) {
    const seen = new Set();
    const out = [];
    for (const img of container.querySelectorAll('img.deal-pc-img')) {
      const store = cleanText(img.getAttribute('alt') || img.getAttribute('data-original-title'));
      const anchor = img.closest('a');
      const priceEl = (anchor || img.parentElement).querySelector('.deal-pc-price');
      const price = parseMoney(priceEl && priceEl.textContent);
      if (!store || price === null || seen.has(store)) continue;
      seen.add(store);
      out.push({ store, price });
    }
    return out;
  }

  function parseOtherInfo(scope) {
    const info = {};
    for (const li of scope.querySelectorAll('.individual-steps-get-deal-font-text li')) {
      const match = cleanText(li.textContent).match(/^([^:]+):\s*(.+)$/);
      if (match) info[match[1]] = match[2];
    }
    return info;
  }

  function parseTitle(scope, container) {
    const shortTitle = inputValue(scope, 'new_short_title');
    if (shortTitle) return shortTitle.replace(/DOUBLEQUOTE/g, '"');
    const heading =
      scope.querySelector('h1.individual-deal-title-font a.deal-title') ||
      container.querySelector('.deal-title-div h3') ||
      container.querySelector('a.deal-title');
    return heading ? cleanText(heading.textContent).replace(/\s*»?\s*only\s+\$.*$/i, '') : null;
  }

  function findAsin(container) {
    for (const a of container.querySelectorAll('a[href*="amazonsp.cgi?"]')) {
      const match = (a.getAttribute('href') || '').match(/amazonsp\.cgi\?([A-Z0-9]{10})\b/);
      if (match) return match[1];
    }
    return null;
  }

  /**
   * @param {Document|Element} scope  the whole document on a /d/ page, or the
   *   pop-up container on listing pages
   * @param {{url?: string}} [options]
   * @returns {object|null} the deal, or null if the scope holds no deal
   */
  function extractDeal(scope, options = {}) {
    const doc = scope.ownerDocument || scope;
    const url = options.url || (doc.location && doc.location.href) || null;
    const table = findDealTable(scope);
    if (!table) return null;

    const container = table.closest('.deal-start') || scope;
    const firstLine = parseFirstLine(table.querySelector('td.deal-first-line'), url || undefined);
    const { rows, notes, couponCode } = parseRows(table);

    const finalPrice = parseMoney(rows['Final Price']) ?? parseMoney(rows.Price);
    if (finalPrice === null) return null;

    const regMatch = (rows.Price || '').match(/Reg:?\s*\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
    const otherInfo = parseOtherInfo(scope);
    const title = parseTitle(scope, container);
    const upc = inputValue(scope, 'upc') || otherInfo.UPC || null;
    // The "Other Information" list keeps every spelling ("VQD100M-0804 | VQD100M0804");
    // the hidden input sometimes drops the hyphen, which hurts web searches.
    const model = otherInfo['Model/MFR/MPN'] || inputValue(scope, 'final_mfr_id');
    const dealDate = inputValue(scope, 'dealdate');

    const publishedEl = scope.querySelector('.indivi-dis-noteN');
    const publishedMatch = publishedEl && cleanText(publishedEl.textContent).match(/Published on:\s*(.+?)$/);

    const canonical = doc.querySelector && doc.querySelector('link[rel="canonical"]');
    const detailLink = container.querySelector('a.deal-title[href^="/d/"]');
    const pageUrl =
      (scope === doc && canonical && canonical.getAttribute('href')) ||
      (detailLink && absoluteUrl(detailLink.getAttribute('href'), url || undefined)) ||
      url;

    const image = container.querySelector('img.deal-prod-image');

    const deal = {
      title: title || firstLine.productName,
      productName: firstLine.productName,
      summary: firstLine.text,
      store: firstLine.store,
      sellerNote: firstLine.sellerNote,
      condition: detectCondition(`${firstLine.text} ${title || ''}`),
      finalPrice,
      finalPriceText: rows['Final Price'] || null,
      price: parseMoney(rows.Price),
      listPrice: regMatch ? Number(regMatch[1].replace(/,/g, '')) : null,
      discount: rows.Discount || null,
      couponCode,
      shipping: rows.Shipping || null,
      extraRows: Object.fromEntries(
        Object.entries(rows).filter(([k]) => !['Price', 'Discount', 'Shipping', 'Final Price'].includes(k))
      ),
      notes,
      upc,
      model,
      asin: findAsin(container),
      merchant: inputValue(scope, 'merchant_filename'),
      dealDate,
      publishedAt: publishedMatch ? publishedMatch[1] : null,
      priceHistory: parsePriceHistory(scope.querySelector('input#jsonData')?.getAttribute('value')),
      comparisons: parseComparisons(container),
      imageUrl: image ? absoluteUrl(image.getAttribute('src'), url || undefined) : null,
      dealLink: firstLine.dealLink,
      pageUrl
    };
    deal.key = [upc || model || deal.title, dealDate, finalPrice].join('|');
    return deal;
  }

  ns.extractDeal = extractDeal;
  ns.parseMoney = parseMoney;
  ns.detectCondition = detectCondition;
})(globalThis);
