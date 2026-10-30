import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readStorePage, checkOffers, tabReader, isHelperTab, modelTokens } from '../extension/src/background/pricecheck.js';

const ld = (data) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
const product = (name, price, extra = {}) => ({
  '@type': 'Product',
  name,
  offers: { price, priceCurrency: 'USD', availability: 'https://schema.org/InStock', ...extra }
});
const page = (title, body = '') => `<html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
const tokens = modelTokens('Sony WH-1000XM5');

describe('readStorePage', () => {
  test('reads schema.org data, as Best Buy, B&H and eBay publish it', () => {
    const html = page('Sony WH-1000XM5 Headphones', ld(product('Sony - WH-1000XM5', 198)));
    assert.deepEqual(readStorePage(html, { url: 'https://www.bestbuy.com/product/x', tokens }), { state: 'read', price: 198, inStock: true });
  });

  test('picks the product it was asked about, not a related one listed first', () => {
    const html = page('Sony WH-1000XM5', ld([product('Case for headphones', 19.99), product('Sony WH-1000XM5', 248)]));
    assert.equal(readStorePage(html, { url: 'https://a.example/p/1', tokens }).price, 248);
  });

  test("won't guess among several products when none is named", () => {
    const html = page('Sony WH-1000XM5', ld([product('Case', 19.99), product('Stand', 29.99)]));
    assert.equal(readStorePage(html, { url: 'https://a.example/p/1', tokens }).state, 'unreadable');
  });

  test('notices a sold-out product', () => {
    const html = page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 198, { availability: 'https://schema.org/OutOfStock' })));
    assert.equal(readStorePage(html, { url: 'https://a.example/p/1', tokens }).inStock, false);
  });

  test('ignores prices in other currencies', () => {
    const html = page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 239, { priceCurrency: 'GBP' })));
    assert.equal(readStorePage(html, { url: 'https://a.example/p/1', tokens }).state, 'unreadable');
  });

  test('reads Amazon\'s price to pay, not the struck-out list price', () => {
    // The shape of a real page: the list price sits in the block a looser reader would search.
    const html = page(
      'GIGABYTE M27Q2',
      '<div id="corePriceDisplay_desktop_feature_div"><span class="a-price" data-a-strike="true"><span class="a-offscreen">$249.99</span></span></div>' +
        '<span class="a-price apex-pricetopay-value"><span class="a-offscreen">$159.99</span></span>' +
        '<div id="availability"><span>In Stock</span></div>'
    );
    const read = readStorePage(html, { url: 'https://www.amazon.com/dp/B0GKFQXR3R', tokens: modelTokens('GIGABYTE M27Q2') });
    assert.deepEqual(read, { state: 'read', price: 159.99, inStock: true });
  });

  test('reads Newegg\'s entry for this item, not the first product in its page data', () => {
    const html = page(
      'GIGABYTE Monitor M27Q2 SA - Newegg.com',
      '<script>{"UnitCost":10.99,"FinalPrice":10.99,"Instock":true,"ItemNumber":"9SIC4AWM6A3636"},' +
        '{"ItemNumber":"24-012-109","Model":"M27Q2 SA","UnitCost":279.99,"FinalPrice":159.99,"Instock":false}</script>'
    );
    const read = readStorePage(html, { url: 'https://www.newegg.com/x/p/N82E16824012109', tokens: modelTokens('GIGABYTE M27Q2 SA') });
    assert.deepEqual(read, { state: 'read', price: 159.99, inStock: false });
  });

  test('knows a bot check or block page when it sees one', () => {
    for (const title of ['Robot or human?', 'Just a moment...', 'Attention Required! | Cloudflare', 'Access Denied', 'Pardon Our Interruption...']) {
      assert.equal(readStorePage(page(title), { url: 'https://a.example/p/1', tokens }).state, 'blocked', title);
    }
    assert.equal(readStorePage('nope', { url: 'https://a.example/p/1', status: 403, tokens }).state, 'blocked');
  });

  test('knows a dead page', () => {
    assert.equal(readStorePage('nope', { url: 'https://a.example/p/1', status: 404 }).state, 'gone');
    assert.equal(readStorePage(page('Product not found'), { url: 'https://a.example/p/1' }).state, 'gone');
    assert.equal(readStorePage(page('Shop everything'), { url: 'https://a.example/' }).state, 'gone', 'redirected home');
  });

  test('rejects a page about another product, but not one that just titles it differently', () => {
    assert.equal(readStorePage(page('Bose QC45', ld(product('Bose QC45', 199))), { url: 'https://a.example/p/1', tokens }).state, 'wrong_product');
    const specs = 'WH-1000XM5 specs. WH-1000XM5 battery. WH1000XM5 weight.';
    assert.equal(readStorePage(page('Sony headphones', `${specs}${ld(product('Sony headphones', 198))}`), { url: 'https://a.example/p/1', tokens }).price, 198);
  });

  test("doesn't call an unfamiliar bot check or half-loaded page the wrong product", () => {
    assert.equal(readStorePage(page('One moment, please...'), { url: 'https://a.example/p/1', tokens }).state, 'unreadable');
    assert.equal(readStorePage('<html></html>', { url: 'https://a.example/p/1', tokens }).state, 'unreadable');
  });

  test('uses a rendered page price only when the page data has none', () => {
    const guess = readStorePage(page('Sony WH-1000XM5'), { url: 'https://a.example/p/1', tokens, pagePrice: 288 });
    assert.deepEqual(guess, { state: 'read', price: 288, inStock: true, loose: true });
    const html = page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 198)));
    assert.equal(readStorePage(html, { url: 'https://a.example/p/1', tokens, pagePrice: 288 }).price, 198);
  });

  test('reads a microdata price from its text, unless the page lists several', () => {
    const one = page('Sony WH-1000XM5', '<span itemprop="price">$288.00</span>');
    assert.equal(readStorePage(one, { url: 'https://a.example/p/1', tokens }).price, 288);
    const many = page('Sony WH-1000XM5', '<span itemprop="price" content="288"></span><span itemprop="price" content="19"></span>');
    assert.equal(readStorePage(many, { url: 'https://a.example/p/1', tokens }).state, 'unreadable');
  });
});

describe('checkOffers', () => {
  const offer = (price, url = 'https://a.example/p/1') => ({ store: 'A', product: 'Sony WH-1000XM5', price, url });
  const respond = (html, status = 200) => async (url) => ({ status, url, text: async () => html });
  const shown = (price) => page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', price)));
  const now = new Date('2026-10-30T12:00:00Z');

  test('confirms a price the page shows, allowing for rounding', async () => {
    const { offers } = await checkOffers([offer(198.5)], { fetchPage: respond(shown(198)), now });
    assert.equal(offers[0].check, 'confirmed');
    assert.equal(offers[0].price, 198);
    assert.equal(offers[0].checkedAt, now.toISOString());
  });

  test('replaces a stale price with the one on the page', async () => {
    const { offers } = await checkOffers([offer(279.95)], { fetchPage: respond(shown(219.95)) });
    assert.equal(offers[0].check, 'changed');
    assert.equal(offers[0].price, 219.95);
    assert.equal(offers[0].quotedPrice, 279.95);
  });

  test('removes what can no longer be bought, or is the wrong product', async () => {
    const soldOut = page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 198, { availability: 'https://schema.org/SoldOut' })));
    assert.equal((await checkOffers([offer(198)], { fetchPage: respond(soldOut) })).removed[0].reason, 'out_of_stock');
    assert.equal((await checkOffers([offer(198)], { fetchPage: respond('x', 404) })).removed[0].reason, 'gone');
    const other = page('Bose QC45', ld(product('Bose QC45', 199)));
    assert.equal((await checkOffers([offer(198)], { fetchPage: respond(other) })).removed[0].reason, 'wrong_product');
  });

  test('keeps a blocked store, marked unverified, with the quoted price', async () => {
    const { offers, removed } = await checkOffers([offer(248)], { fetchPage: respond('x', 403) });
    assert.equal(removed.length, 0);
    assert.equal(offers[0].check, 'unverified');
    assert.equal(offers[0].price, 248);
  });

  test('a network failure only means unverified', async () => {
    const fetchPage = async () => {
      throw new TypeError('Failed to fetch');
    };
    assert.equal((await checkOffers([offer(248)], { fetchPage })).offers[0].check, 'unverified');
  });

  test("distrusts a price too far off to be the same product's", async () => {
    const { offers } = await checkOffers([offer(248)], { fetchPage: respond(shown(19.99)) });
    assert.equal(offers[0].check, 'unverified');
    assert.equal(offers[0].price, 248);
  });

  test('a guess from the rendered page can confirm a price, but never replace it', async () => {
    // CDW's page: the first price a loose reader finds is the list price.
    const guess = (price) => async () => ({ state: 'read', price, inStock: true, loose: true });
    const blocked = respond('x', 403);
    const confirmed = await checkOffers([offer(131.99)], { fetchPage: blocked, readInTab: guess(131.99) });
    assert.equal(confirmed.offers[0].check, 'confirmed');
    const doubtful = await checkOffers([offer(131.99)], { fetchPage: blocked, readInTab: guess(159) });
    assert.equal(doubtful.offers[0].check, 'unverified');
    assert.equal(doubtful.offers[0].price, 131.99);
  });

  test('sends what a fetch could not read to a background tab, a few at most', async () => {
    const opened = [];
    const readInTab = async (url) => {
      opened.push(url);
      return { state: 'read', price: 219.95, inStock: true };
    };
    const offers = [1, 2, 3, 4].map((n) => offer(279.95, `https://www.ebay.com/itm/${n}`));
    const out = await checkOffers(offers, { fetchPage: respond(page('Pardon Our Interruption...')), readInTab });
    assert.equal(opened.length, 3);
    assert.deepEqual(out.offers.map((o) => o.check), ['changed', 'changed', 'changed', 'unverified']);
  });

  test("doesn't open a tab for a page the fetch already read", async () => {
    let opened = 0;
    const readInTab = async () => {
      opened++;
      return { state: 'blocked' };
    };
    await checkOffers([offer(198)], { fetchPage: respond(shown(198)), readInTab });
    assert.equal(opened, 0);
  });

  test('a tab that fails leaves the offer unverified', async () => {
    const readInTab = async () => {
      throw new Error('No tab');
    };
    const { offers } = await checkOffers([offer(248)], { fetchPage: respond('x', 403), readInTab });
    assert.equal(offers[0].check, 'unverified');
  });
});

describe('tabReader', () => {
  function fakeExt(results) {
    const log = [];
    return {
      log,
      tabs: {
        create: async (props) => {
          log.push(['create', props]);
          return { id: 9 };
        },
        update: async (id, props) => log.push(['update', id, props]),
        remove: async (id) => log.push(['remove', id])
      },
      scripting: {
        executeScript: async () => [{ result: results.shift() }]
      }
    };
  }
  const sleep = async () => {};
  const loaded = (html) => ({ ready: true, html, url: 'https://www.ebay.com/itm/1', pagePrice: null });

  test('opens the page behind the current tab, muted, waits out a bot check, and closes it', async () => {
    const ext = fakeExt([loaded(page('Pardon Our Interruption...')), loaded(page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 219.95))))]);
    const read = await tabReader(ext, { sleep })('https://www.ebay.com/itm/1', tokens);
    assert.deepEqual(read, { state: 'read', price: 219.95, inStock: true });
    assert.deepEqual(ext.log[0], ['create', { url: 'about:blank', active: false }]);
    assert.deepEqual(ext.log[1], ['update', 9, { url: 'https://www.ebay.com/itm/1', muted: true }]);
    assert.deepEqual(ext.log.at(-1), ['remove', 9]);
  });

  test('knows its tab is a helper before the page loads, and only until it closes', async () => {
    const ext = fakeExt([loaded(page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 198))))]);
    const seen = [];
    const update = ext.tabs.update;
    ext.tabs.update = async (id, props) => {
      seen.push(isHelperTab(id));
      return update(id, props);
    };
    await tabReader(ext, { sleep })('https://a.example/p/1', tokens);
    assert.deepEqual(seen, [true]);
    assert.equal(isHelperTab(9), false);
  });

  test("doesn't read a page that is still loading", async () => {
    const ext = fakeExt([{ ...loaded(page('Bose QC45', ld(product('Bose QC45', 1)))), ready: false }, loaded(page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 198))))]);
    assert.equal((await tabReader(ext, { sleep })('https://a.example/p/1', tokens)).price, 198);
  });

  test('gives up on a check that never clears, and still closes the tab', async () => {
    const ext = fakeExt(Array.from({ length: 20 }, () => loaded(page('Just a moment...'))));
    const read = await tabReader(ext, { sleep })('https://a.example/p/1', tokens);
    assert.equal(read.state, 'blocked');
    assert.deepEqual(ext.log.at(-1), ['remove', 9]);
  });

  test('looks again after a page it could not read, such as mid-redirect', async () => {
    const ext = fakeExt([]);
    let calls = 0;
    ext.scripting.executeScript = async () => {
      if (++calls === 1) throw new Error('Frame with ID 0 is showing error page');
      return [{ result: loaded(page('Sony WH-1000XM5', ld(product('Sony WH-1000XM5', 219.95)))) }];
    };
    assert.equal((await tabReader(ext, { sleep })('https://a.example/p/1', tokens)).price, 219.95);
    assert.equal(calls, 2);
  });

  test('closes the tab if it can never be read', async () => {
    const ext = fakeExt([]);
    ext.scripting.executeScript = async () => {
      throw new Error('Missing host permission');
    };
    assert.equal((await tabReader(ext, { sleep })('https://a.example/p/1', tokens)).state, 'blocked');
    assert.deepEqual(ext.log.at(-1), ['remove', 9]);
  });
});
