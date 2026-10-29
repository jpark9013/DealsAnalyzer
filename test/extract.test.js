import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, fixture, popupPage, plain, DETAIL_URL, HOME_URL } from './helpers.js';

function extractFrom(html, url = DETAIL_URL, scopeSelector = null) {
  const dom = makeDom(html, { url, scripts: ['extension/src/content/extract.js'] });
  const { document, DealsAnalyzer } = dom.window;
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
  const deal = DealsAnalyzer.extractDeal(scope, { url });
  dom.window.close();
  return deal && plain(deal);
}

describe('extractDeal on deal pages', () => {
  test('Amazon monitor deal: prices, store, identifiers', () => {
    const deal = extractFrom(fixture('detail-amazon-monitor'));
    assert.equal(deal.title, '27" GIGABYTE M27Q2 WQHD 200Hz 1ms HDR IPS Freesync and G-SYNC Compatible Gaming Monitor');
    assert.match(deal.productName, /^GIGABYTE M27Q2 27" Widescreen WQHD 1440p/);
    assert.equal(deal.store, 'Amazon.com');
    assert.equal(deal.sellerNote, 'Sold & Shipped directly by Amazon');
    assert.equal(deal.condition, 'new');
    assert.equal(deal.finalPrice, 159.99);
    assert.equal(deal.price, 159.99);
    assert.equal(deal.listPrice, 249.99);
    assert.equal(deal.shipping, 'Free');
    assert.equal(deal.discount, 'Reflected in sale price');
    assert.equal(deal.couponCode, null);
    assert.equal(deal.upc, '889523049914');
    assert.equal(deal.model, 'M27Q2');
    assert.equal(deal.asin, 'B0GKFQXR3R');
    assert.equal(deal.merchant, 'amazon');
    assert.equal(deal.dealDate, '2026-10-29');
    assert.equal(deal.publishedAt, '10/29/2026 17:16 PM ET');
    assert.deepEqual(deal.priceHistory, [{ date: '10/29/26', price: 159.99 }]);
    assert.deepEqual(deal.comparisons, []);
    assert.equal(
      deal.pageUrl,
      'https://www.edealinfo.com/d/00889523049914/GIGABYTE-M27Q2-27-inch-Widescreen-WQHD-1440p-2560-x-1440-200Hz'
    );
    assert.equal(deal.dealLink, 'https://www.edealinfo.com/cgi-bin/amazonsp.cgi?B0GKFQXR3R');
    assert.equal(deal.key, '889523049914|2026-10-29|159.99');
  });

  test('open-box eBay deal: coupon, comparisons, price history, model spellings', () => {
    const deal = extractFrom(fixture('detail-ebay-openbox-coupon'));
    assert.equal(deal.condition, 'open box');
    assert.equal(deal.store, 'eBay.com');
    assert.equal(deal.sellerNote, 'via vipoutlet');
    assert.equal(deal.price, 739);
    assert.equal(deal.finalPrice, 679.88);
    assert.equal(deal.listPrice, null);
    assert.equal(deal.couponCode, 'VIPTAKE8OCTOBER');
    // The hidden "Copied" confirmation next to the coupon must not leak in.
    assert.equal(deal.discount, '8% via coupon VIPTAKE8OCTOBER');
    assert.equal(deal.model, 'VQD100M-0804 | VQD100M0804');
    assert.deepEqual(deal.comparisons, [
      { store: 'Sams Club', price: 1198 },
      { store: 'Walmart.com', price: 1498 }
    ]);
    assert.deepEqual(deal.priceHistory, [{ date: '11/29/25', price: 1298 }]);
    assert.deepEqual(deal.notes, ['Price Comparison provided below is for a retail box unit.']);
  });

  test('refurbished deal without a UPC still gets a stable key', () => {
    const deal = extractFrom(fixture('detail-ebay-refurb-no-upc'));
    assert.equal(deal.condition, 'refurbished');
    assert.equal(deal.upc, null);
    assert.equal(deal.model, null);
    assert.equal(deal.finalPrice, 159);
    assert.equal(deal.listPrice, 795);
    assert.equal(deal.sellerNote, 'via Tech Leaf');
    assert.equal(deal.key, `${deal.title}|2026-10-29|159`);
  });
});

describe('extractDeal on listing-page pop-ups', () => {
  test('reads the deal inside the colorbox container', () => {
    const deal = extractFrom(popupPage(fixture('popup-ebay-openbox-coupon')), HOME_URL, '#cboxLoadedContent');
    assert.equal(deal.title, '100" Vizio VQD100M-0804 4K Ultra HD Smart QLED TV [Open Box]');
    assert.equal(deal.finalPrice, 679.88);
    assert.equal(deal.couponCode, 'VIPTAKE8OCTOBER');
    assert.equal(deal.model, 'VQD100M-0804');
    assert.equal(deal.comparisons.length, 2);
    // The pop-up links to the deal's own page; that's the URL to report.
    assert.equal(
      deal.pageUrl,
      'https://www.edealinfo.com/d/00845226023484/Vizio-VQD100M-0804-100-inch-4K-Ultra-HD-2160p-Smart-QLED-HDTV'
    );
  });

  test('ignores site promos that have no product or price', () => {
    assert.equal(extractFrom(popupPage(fixture('popup-promo-no-price')), HOME_URL, '#cboxLoadedContent'), null);
  });

  test('pop-up and deal page for the same deal share a cache key', () => {
    const popup = extractFrom(popupPage(fixture('popup-ebay-openbox-coupon')), HOME_URL, '#cboxLoadedContent');
    const page = extractFrom(fixture('detail-ebay-openbox-coupon'));
    assert.equal(popup.key, page.key);
  });
});

describe('extractDeal edge cases', () => {
  const minimal = (rows, extra = '') => `<!doctype html><html><body>
    <input type="hidden" id="new_short_title" value="12DOUBLEQUOTE Widget">
    ${extra}
    <div class="deal-start"><table>
      <tr><td colspan="2" class="deal-first-line">Get <a href="/cgi-bin/x.cgi?1">Widget Pro</a> from <span style="font-weight:700;">Best Buy</span>.</td></tr>
      ${rows}
    </table></div></body></html>`;
  const row = (label, value) =>
    `<tr><td><span class="deal-detail-heading-text">${label}</span></td><td class="deal-detail-price"><b>:&nbsp;&nbsp;</b> ${value}</td></tr>`;

  test('returns null for pages without a deal', () => {
    assert.equal(extractFrom('<!doctype html><html><body><p>Hello</p></body></html>'), null);
  });

  test('returns null when no price can be read', () => {
    assert.equal(extractFrom(minimal(row('Price', 'See store'))), null);
  });

  test('falls back to the Price row and handles thousands separators', () => {
    const deal = extractFrom(minimal(row('Price', '$1,299.99 (Reg: $1,599.00)')));
    assert.equal(deal.finalPrice, 1299.99);
    assert.equal(deal.listPrice, 1599);
    assert.equal(deal.title, '12" Widget');
    assert.equal(deal.store, 'Best Buy');
    assert.equal(deal.sellerNote, null);
  });

  test('keeps unfamiliar rows such as rebates', () => {
    const deal = extractFrom(
      minimal(row('Price', '$100.00') + row('Rebate', '$20 mail-in rebate') + row('Final Price', '$80.00 after rebate'))
    );
    assert.equal(deal.finalPrice, 80);
    assert.deepEqual(deal.extraRows, { Rebate: '$20 mail-in rebate' });
  });

  test('ignores malformed price-history JSON', () => {
    const deal = extractFrom(minimal(row('Price', '$10.00'), `<input type="hidden" id="jsonData" value="[[not json">`));
    assert.deepEqual(deal.priceHistory, []);
  });

  test('detects condition keywords', () => {
    const dom = makeDom('<!doctype html><html></html>', { scripts: ['extension/src/content/extract.js'] });
    const { detectCondition } = dom.window.DealsAnalyzer;
    assert.equal(detectCondition('Apple iPad (Renewed)'), 'refurbished');
    assert.equal(detectCondition('Open-Box Excellent TV'), 'open box');
    assert.equal(detectCondition('Used - Like New camera'), 'used');
    assert.equal(detectCondition('Brand new blender'), 'new');
    dom.window.close();
  });
});
