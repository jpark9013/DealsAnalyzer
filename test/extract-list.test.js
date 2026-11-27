// Pages that list many products: finding each one, and the badge under it.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, plain, fakeExtensionApi, flush, CONTENT_SCRIPTS } from './helpers.js';

const SCRIPTS = ['extension/src/content/strings.js', 'extension/src/content/extract-page.js', 'extension/src/content/extract-list.js'];

function list(html, url) {
  const dom = makeDom(html, { url, scripts: SCRIPTS });
  const items = dom.window.DealsAnalyzer.extractListDeals(dom.window.document, { url });
  const out = plain(items.map(({ el, deal }) => ({ tag: el.tagName.toLowerCase(), deal })));
  dom.window.close();
  return out;
}

const card = (i, price, { was = null, extra = '' } = {}) =>
  `<li class="card"><a href="/p/${i}"><img alt="Acme 27in Monitor ${i}" src="data:,"></a>` +
  `<a class="title" href="/p/${i}">Acme 27in QHD 180Hz Monitor Model ${i}</a>` +
  (was ? `<s class="was">$${was}</s>` : '') +
  `<span class="price">$${price}</span>${extra}<button>Add to cart</button></li>`;
const grid = (cards) => `<!doctype html><html><head><meta property="og:site_name" content="Acme Store"></head><body><h1>Search</h1><ul class="results">${cards.join('')}</ul></body></html>`;

describe('extractListDeals', () => {
  test("finds each product's name, link and price to pay, not the struck-out one", () => {
    const items = list(grid([card(1, '199.99', { was: '249.99' }), card(2, '149.00'), card(3, '1,099.95')]), 'https://acme.example/search?q=monitor');
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((i) => i.tag), ['li', 'li', 'li']);
    const [first] = items;
    assert.equal(first.deal.title, 'Acme 27in QHD 180Hz Monitor Model 1');
    assert.equal(first.deal.finalPrice, 199.99);
    assert.equal(first.deal.pageUrl, 'https://acme.example/p/1');
    assert.equal(first.deal.store, 'Acme Store');
    assert.equal(first.deal.fromList, true);
    assert.equal(items[2].deal.finalPrice, 1099.95);
    // Each has its own cache key.
    assert.equal(new Set(items.map((i) => i.deal.key)).size, 3);
  });

  test("two or three priced things side by side aren't a list (a product's options)", () => {
    assert.deepEqual(list(grid([card(1, '10.00'), card(2, '12.00')]), 'https://acme.example/p/9'), []);
  });

  test('skips hidden templates and loading skeletons', () => {
    const items = list(
      grid([card(1, '10.00'), card(2, '11.00'), card(3, '12.00'), `<li class="card" hidden><a href="/p/x">Example Deal Title Placeholder</a><span class="price">$9.99</span></li>`]),
      'https://acme.example/s'
    );
    assert.equal(items.length, 3);
  });

  test("ignores the badges it added, whose prices aren't the page's", () => {
    const badge = '<div data-deals-analyzer="badge"><span class="x">$5.00</span><span>$6.00</span><span>$7.00</span></div>';
    const items = list(grid([card(1, '10.00', { extra: badge }), card(2, '11.00', { extra: badge }), card(3, '12.00', { extra: badge })]), 'https://acme.example/s');
    assert.deepEqual(items.map((i) => i.deal.finalPrice), [10, 11, 12]);
  });

  test("reads Amazon's results with their ASINs, so a badge and the product page share a verdict", () => {
    const result = (asin, title, price) =>
      `<div data-component-type="s-search-result" data-asin="${asin}"><h2 aria-label="Sponsored Ad - ${title}"><a href="/x/dp/${asin}/ref=sr_1">${title}</a></h2>` +
      `<span class="a-price"><span class="a-offscreen">$${price}</span></span><span class="a-price a-text-price"><span class="a-offscreen">$299.99</span></span></div>`;
    const html = `<html><body>${result('B0D4QVHWPJ', 'KTC 27 Inch QHD Monitor', '123.24')}${result('B0H85RW8H8', 'Samsung ViewFinity S7', '179.99')}</body></html>`;
    const items = list(html, 'https://www.amazon.com/s?k=monitor');
    assert.deepEqual(items.map((i) => [i.deal.asin, i.deal.title, i.deal.finalPrice, i.deal.listPrice]), [
      ['B0D4QVHWPJ', 'KTC 27 Inch QHD Monitor', 123.24, 299.99],
      ['B0H85RW8H8', 'Samsung ViewFinity S7', 179.99, 299.99]
    ]);
    assert.equal(items[0].deal.pageUrl, 'https://www.amazon.com/dp/B0D4QVHWPJ');
    assert.equal(items[0].deal.key, 'B0D4QVHWPJ|amazon.com|123.24');
  });

  test("reads eDealinfo's grid, whose tiles open a pop-up, with the pop-up's own key", () => {
    const tile = (n, title, price, upc) =>
      `<div id="myViewedDeal2026-11-26${n}" class="col-lg-5th"><div onclick='showDetails("d","2026-11-26",${n},"${upc}");'>` +
      `<span class="grid-price-pos">${price}</span></div><div class="grid-deal-title">${title}</div><span class="mName">Best Buy</span></div>`;
    const html = `<html><body>${tile(1, '75" Vizio 4K TV [Open Box]', '$239', '00845226023521')}${tile(2, 'Deals on shoes', 'Various', '00020261124530')}</body></html>`;
    const items = list(html, 'https://www.edealinfo.com/');
    assert.equal(items.length, 1, 'a tile without a price is skipped');
    assert.deepEqual([items[0].deal.title, items[0].deal.store, items[0].deal.finalPrice, items[0].deal.key], ['75" Vizio 4K TV [Open Box]', 'Best Buy', 239, '845226023521|2026-11-26|239']);
    assert.equal(items[0].deal.condition, 'open box');
  });

  test("a deal site's list is marked as such, since the site isn't the seller", () => {
    const items = list(grid([card(1, '10.00'), card(2, '11.00'), card(3, '12.00')]), 'https://slickdeals.net/');
    assert.equal(items[0].deal.dealSite, true);
  });
});

describe('list mode in the page', () => {
  const windows = [];
  afterEach(() => windows.splice(0).forEach((w) => w.close()));

  // jsdom has no layout, so no IntersectionObserver: this one reports every product as in view.
  function load(html, url, status) {
    const ext = fakeExtensionApi({ status: { hasKey: true, autoAnalyze: true, showOnStores: true, analyzeLists: true, ...status } });
    const dom = makeDom(html, {
      url,
      scripts: CONTENT_SCRIPTS,
      before: (win) => {
        win.chrome = ext.api;
        win.IntersectionObserver = class {
          constructor(fn) {
            this.fn = fn;
          }
          observe(el) {
            setTimeout(() => this.fn([{ isIntersecting: true, target: el }]), 0);
          }
          unobserve() {}
        };
      }
    });
    windows.push(dom.window);
    return { dom, ext };
  }
  const page = grid([card(1, '100.00'), card(2, '110.00'), card(3, '120.00')]);
  const URL = 'https://acme.example/search?q=monitor';
  const badgeText = (dom) => [...dom.window.document.querySelectorAll('[data-deals-analyzer="badge"]')].map((b) => b.shadowRoot.querySelector('.badge').textContent);

  test('rates each product shown, through one port, with a badge under each', async () => {
    const { dom, ext } = load(page, URL);
    await flush(1400);
    const port = ext.ports.find((p) => p.name === 'deal-list');
    assert.ok(port, 'a list port');
    const asked = port.posted.filter((m) => m.type === 'analyze');
    assert.deepEqual(asked.map((m) => m.deal.title), [1, 2, 3].map((i) => `Acme 27in QHD 180Hz Monitor Model ${i}`));
    assert.deepEqual(badgeText(dom), ['Deal check: waiting…', 'Deal check: waiting…', 'Deal check: waiting…']);

    port.emit({ type: 'started', id: asked[0].id });
    port.emit({
      type: 'item',
      id: asked[0].id,
      result: {
        verdict: {
          simple: true,
          rating: 'yes',
          dealPrice: 100,
          sameItemPrice: 125,
          equivalentMarketPrice: 90,
          priceSupport: { sameItem: null, equivalent: 'unconfirmed' },
          comparableOffers: []
        },
        queries: [],
        sources: []
      }
    });
    port.emit({ type: 'item-error', id: asked[1].id, error: { message: 'Rate limited' } });
    const [first, second] = badgeText(dom);
    // Same item elsewhere costs more (this is 20% less); the cheaper equivalent wasn't confirmed.
    assert.equal(first, 'YesSame $125.0020% lessEquiv. $90.00?');
    assert.equal(second, "Deal check couldn't rate this");
  });

  test('stays off when the setting is off, on product pages, and in helper tabs', async () => {
    for (const [status, html] of [
      [{ analyzeLists: false }, page],
      [{ helperTab: true }, page],
      [{ hasKey: false }, page]
    ]) {
      const { ext, dom } = load(html, URL, status);
      await flush(1400);
      assert.ok(!ext.ports.some((p) => p.name === 'deal-list'), JSON.stringify(status));
      assert.equal(badgeText(dom).length, 0);
    }
  });
});
