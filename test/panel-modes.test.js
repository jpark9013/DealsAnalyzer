// The panel's simple view, its "not confirmed" and confidence notes, the
// discounts section, and its words in another language.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, fixture, fakeExtensionApi, flush, CONTENT_SCRIPTS, DETAIL_URL } from './helpers.js';

const windows = [];
afterEach(() => windows.splice(0).forEach((w) => w.close()));

function load(status = {}, { translate = null } = {}) {
  const ext = fakeExtensionApi({ status: { hasKey: true, autoAnalyze: true, showOnStores: true, ...status } });
  if (translate) {
    const send = ext.api.runtime.sendMessage;
    ext.api.runtime.sendMessage = async (msg) => {
      if (msg.type !== 'translate') return send(msg);
      ext.sent.push({ type: 'translate' });
      return { texts: msg.texts.map(translate) };
    };
  }
  const dom = makeDom(fixture('detail-amazon-monitor'), { url: DETAIL_URL, scripts: CONTENT_SCRIPTS, before: (win) => (win.chrome = ext.api) });
  windows.push(dom.window);
  const shadow = () => dom.window.document.getElementById('deals-analyzer-root')?.shadowRoot;
  return { dom, ext, shadow };
}

const analysisPort = (ext) => ext.ports.find((p) => p.name === 'deal-analysis' && p.posted.some((m) => m.type === 'analyze'));
const discountPort = (ext) => ext.ports.find((p) => p.posted.some((m) => m.type === 'discounts'));

const result = (verdict) => ({
  verdict: { comparableOffers: [], keySpecs: [], savings: [], reasonsFor: [], reasonsAgainst: [], offersHidden: 0, ...verdict },
  model: 'claude-haiku-5-5',
  queries: [],
  sources: [],
  usage: { costUsd: 0.04 },
  analyzedAt: new Date().toISOString(),
  cached: false
});

describe('the simple view', () => {
  test('shows the rating and the deal against the same item and an equivalent product, each with its store', async () => {
    const { ext, shadow } = load();
    await flush();
    analysisPort(ext).emit({
      type: 'result',
      result: result({
        simple: true,
        rating: 'no',
        confidence: 'low',
        confidenceReasons: [{ code: 'cheaper_unconfirmed', sign: -1 }],
        dealPrice: 159.99,
        sameItemPrice: 139.99,
        equivalentMarketPrice: 149.99,
        equivalentProduct: 'MSI MAG 275QF',
        priceSupport: { sameItem: 'unconfirmed', equivalent: 'confirmed' },
        comparableOffers: [
          { match: 'same_item', store: 'bestbuy.com', product: 'GIGABYTE M27Q2', price: 139.99, url: 'https://www.bestbuy.com/site/1.p', verified: true, check: 'unverified' },
          { match: 'equivalent', store: 'newegg.com', product: 'MSI MAG 275QF', price: 149.99, url: 'https://www.newegg.com/p/1', verified: true, check: 'confirmed', checkedAt: new Date().toISOString() }
        ]
      })
    });
    const root = shadow();
    const rows = [...root.querySelectorAll('.simple-row')].map((r) => r.textContent);
    assert.equal(rows.length, 3);
    assert.match(rows[0], /This deal\$159\.99/);
    assert.match(rows[1], /Same item elsewherebestbuy\.com · GIGABYTE M27Q2\$139\.99.*not confirmed/);
    assert.match(rows[2], /Equivalent productnewegg\.com · MSI MAG 275QF\$149\.99.*✓ checked/);
    assert.ok(!root.querySelector('.headline'), 'no headline, specs or reasons');
    // The confidence says why.
    const confidence = root.querySelector('.confidence');
    assert.equal(confidence.textContent, 'low confidence');
    assert.match(confidence.title, /a lower price elsewhere could not be confirmed/);
  });

  test("a detailed verdict marks a lower price no store page confirmed, and why it's shaky", async () => {
    const { ext, shadow } = load();
    await flush();
    analysisPort(ext).emit({
      type: 'result',
      result: result({
        rating: 'no',
        confidence: 'low',
        headline: 'h',
        dealPrice: 159.99,
        sameItemPrice: 129.99,
        lowestRecentPrice: 119.99,
        equivalentMarketPrice: 189.99,
        priceSupport: { sameItem: 'unconfirmed', equivalent: null }
      })
    });
    const rows = [...shadow().querySelectorAll('tr')].map((r) => r.textContent);
    assert.ok(rows.some((r) => /^Same item elsewhere\$129\.99.*not confirmed$/.test(r)), rows.join(' | '));
    assert.ok(rows.some((r) => /^Equivalent products\$189\.99\d+% less$/.test(r)), 'a higher price needs no backing');
    // A past low is labeled as one, since past deals have usually ended.
    assert.ok(rows.includes('Lowest recently (may have ended)$119.99'), rows.join(' | '));
  });
});

describe('discounts', () => {
  test("load after the analysis's searches, with codes to copy and the shopper's programs marked", async () => {
    const { ext, shadow } = load({ findDiscounts: true, discountGroups: ['military'] });
    await flush();
    assert.equal(discountPort(ext), undefined, 'not while the analysis is still searching');
    analysisPort(ext).emit({ type: 'progress', stage: 'searching', queries: ['q'] });
    assert.equal(discountPort(ext), undefined);
    analysisPort(ext).emit({ type: 'progress', stage: 'reading', queries: ['q'] });
    const port = discountPort(ext);
    assert.ok(port);
    assert.match(shadow().querySelector('.discounts').textContent, /Looking for coupon codes/);

    port.emit({
      type: 'discounts',
      result: {
        discounts: [
          { who: 'military', offer: '10% off with ID.me', code: '', url: 'https://www.bestbuy.com/military', couponSite: false },
          { who: 'anyone', offer: '$20 off $200', code: 'SAVE20', url: 'https://www.retailmenot.com/x', couponSite: true },
          { who: 'anyone', offer: 'Evil', code: '', url: 'javascript:alert(1)', couponSite: false }
        ]
      }
    });
    const section = shadow().querySelector('.discounts');
    const items = [...section.querySelectorAll('li')];
    assert.equal(items.length, 3);
    assert.match(items[0].textContent, /Military & veterans✓ for you10% off with ID\.me/);
    assert.equal(items[1].querySelector('code').textContent, 'SAVE20');
    assert.match(items[1].textContent, /Code from a coupon site; it may not work\./);
    assert.equal(items[2].querySelector('a'), null, 'never a script link');
    // The discounts stay while the verdict arrives.
    analysisPort(ext).emit({ type: 'result', result: result({ rating: 'yes', headline: 'h', dealPrice: 1 }) });
    assert.equal(shadow().querySelectorAll('.discounts li').length, 3);
  });

  test('none asked for when the setting is off', async () => {
    const { ext } = load({ findDiscounts: false });
    await flush();
    analysisPort(ext).emit({ type: 'result', result: result({ rating: 'yes', headline: 'h', dealPrice: 1 }) });
    assert.equal(discountPort(ext), undefined);
  });
});

describe('another language', () => {
  test("the panel's words switch once the translation arrives; Claude's text is left as written", async () => {
    const { ext, shadow } = load({ english: false }, { translate: (t) => `«${t}»` });
    await flush();
    await flush();
    analysisPort(ext).emit({ type: 'result', result: result({ rating: 'yes', confidence: 'high', headline: 'Bon prix.', dealPrice: 100 }) });
    const root = shadow();
    assert.equal(root.querySelector('.pill').textContent, '«Yes»');
    assert.equal(root.querySelector('.confidence').textContent, '«high confidence»');
    assert.equal(root.querySelector('header .brand').textContent, '«Deal check»');
    assert.equal(root.querySelector('.headline').textContent, 'Bon prix.');
    assert.equal(ext.sent.filter((m) => m.type === 'translate').length, 1);
  });

  test('English asks for no translation', async () => {
    const { ext } = load({ english: true });
    await flush();
    assert.equal(ext.sent.filter((m) => m.type === 'translate').length, 0);
  });
});
