import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDom,
  fixture,
  popupPage,
  fakeExtensionApi,
  flush,
  CONTENT_SCRIPTS,
  DETAIL_URL,
  HOME_URL
} from './helpers.js';

const RESULT = {
  verdict: {
    rating: 'yes',
    confidence: 'medium',
    headline: 'About $40 under the usual price. <img src=x onerror="window.pwned=1">',
    dealPrice: 159.99,
    typicalPrice: 199.99,
    lowestRecentPrice: 149.99,
    comparableOffers: [
      { store: 'Best Buy', product: 'GIGABYTE M27Q2', price: 199.99, url: 'https://www.bestbuy.com/x', sameProduct: true, condition: 'new', verified: true },
      { store: 'Newegg', product: 'MSI MAG 275QF', price: 179.99, url: 'https://newegg.com/made-up', sameProduct: false, condition: 'refurbished', verified: false }
    ],
    reasonsFor: ['Below typical price'],
    reasonsAgainst: ['Was $149.99 last month']
  },
  model: 'claude-haiku-5-5',
  queries: ['GIGABYTE M27Q2 price'],
  sources: [{ title: 'Best Buy', url: 'https://www.bestbuy.com/x' }, { title: 'Bad', url: 'javascript:alert(1)' }],
  usage: { inputTokens: 1, outputTokens: 1, webSearches: 1, requests: 1, costUsd: 0.0231 },
  analyzedAt: new Date().toISOString(),
  cached: false
};

function loadPage(html, url, options) {
  const ext = fakeExtensionApi(options);
  const dom = makeDom(html, {
    url,
    scripts: CONTENT_SCRIPTS,
    before: (win) => {
      win.chrome = ext.api;
    }
  });
  const shadow = () => dom.window.document.getElementById('deals-analyzer-root')?.shadowRoot;
  return { dom, ext, shadow };
}

describe('deal pages', () => {
  test('auto-analyzes and renders the verdict safely', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();

    assert.equal(ext.ports.length, 1, 'opened an analysis port');
    const [port] = ext.ports;
    assert.equal(port.name, 'deal-analysis');
    const [request] = port.posted;
    assert.equal(request.type, 'analyze');
    assert.equal(request.force, false);
    assert.equal(request.deal.upc, '889523049914');
    assert.equal(request.deal.finalPrice, 159.99);

    const root = shadow();
    assert.ok(root.querySelector('.spinner'), 'shows progress while waiting');
    port.emit({ type: 'progress', queries: ['GIGABYTE M27Q2 price'] });
    assert.match(root.querySelector('.loading').textContent, /GIGABYTE M27Q2 price/);

    port.emit({ type: 'result', result: RESULT });
    assert.equal(port.disconnected, true);
    assert.equal(root.querySelector('.pill').textContent, 'Yes');
    assert.equal(root.querySelector('.verdict').dataset.rating, 'yes');
    assert.match(root.querySelector('.deal-title').textContent, /GIGABYTE M27Q2/);
    assert.match(root.textContent, /20% less/);
    assert.match(root.querySelector('footer').textContent, /Haiku 5\.5 · ~\$0\.023/);

    // Model text is inserted as text, never as markup.
    assert.equal(root.querySelector('.headline img'), null);
    assert.match(root.querySelector('.headline').textContent, /<img src=x/);
    assert.equal(dom.window.pwned, undefined);

    // Only verified offer URLs become links, and only http(s) links are rendered.
    const offerLinks = [...root.querySelectorAll('.offers a')].map((a) => a.href);
    assert.deepEqual(offerLinks, ['https://www.bestbuy.com/x']);
    const sourceLinks = [...root.querySelectorAll('details a')].map((a) => a.getAttribute('href'));
    assert.deepEqual(sourceLinks, ['https://www.bestbuy.com/x']);
    for (const a of root.querySelectorAll('a')) assert.equal(a.rel, 'noopener noreferrer');
    dom.window.close();
  });

  test('re-analyze forces a fresh request', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].emit({ type: 'result', result: { ...RESULT, cached: true } });
    assert.match(shadow().querySelector('footer').textContent, /cached/);

    [...shadow().querySelectorAll('button')].find((b) => b.textContent === 'Re-analyze').click();
    assert.equal(ext.ports.length, 2);
    assert.equal(ext.ports[1].posted[0].force, true);
    dom.window.close();
  });

  test('shows errors with a retry button', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].emit({ type: 'error', error: { code: 'overloaded', message: 'The Anthropic API is having trouble (529).' } });
    const alert = shadow().querySelector('[role="alert"]');
    assert.match(alert.textContent, /having trouble/);
    alert.querySelector('button').click();
    assert.equal(ext.ports.length, 2);
    dom.window.close();
  });

  test('reports a dropped connection', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].drop();
    assert.match(shadow().querySelector('[role="alert"]').textContent, /Lost the connection/);
    dom.window.close();
  });

  test('asks for an API key instead of analyzing', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, {
      status: { hasKey: false, autoAnalyze: true }
    });
    await flush();
    assert.equal(ext.ports.length, 0);
    const button = [...shadow().querySelectorAll('button')].find((b) => b.textContent === 'Open settings');
    button.click();
    await flush();
    assert.ok(ext.sent.some((m) => m.type === 'open-options'));
    dom.window.close();
  });

  test('waits for a click when auto-analyze is off', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, {
      status: { hasKey: true, autoAnalyze: false }
    });
    await flush();
    assert.equal(ext.ports.length, 0);
    [...shadow().querySelectorAll('button')].find((b) => b.textContent === 'Analyze deal').click();
    assert.equal(ext.ports.length, 1);
    dom.window.close();
  });

  test('remembers when the panel is minimized', async () => {
    const { dom, ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, { stored: { panelCollapsed: true } });
    await flush();
    const root = shadow();
    assert.equal(root.querySelector('.panel').hidden, true);
    assert.equal(root.querySelector('.tab').hidden, false);

    ext.ports[0].emit({ type: 'result', result: RESULT });
    assert.match(root.querySelector('.tab').textContent, /Yes/);
    root.querySelector('.tab').click();
    assert.equal(root.querySelector('.panel').hidden, false);
    await flush();
    assert.equal(ext.stored.panelCollapsed, false);
    dom.window.close();
  });
});

describe('listing pages', () => {
  test('stays out of the way until a deal pop-up opens', async () => {
    const { dom, ext } = loadPage('<!doctype html><html><body><div id="deals"></div></body></html>', HOME_URL);
    await flush();
    assert.equal(dom.window.document.getElementById('deals-analyzer-root'), null);
    assert.equal(ext.ports.length, 0);
    dom.window.close();
  });

  test('adds an Analyze button to deal pop-ups', async () => {
    const { dom, ext, shadow } = loadPage('<!doctype html><html><body></body></html>', HOME_URL);
    const { document } = dom.window;

    // Simulate the site opening its colorbox pop-up after page load.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = popupPage(fixture('popup-ebay-openbox-coupon'));
    document.body.append(wrapper.querySelector('#colorbox'));
    await flush(50);

    const buttons = document.querySelectorAll('button[data-deals-analyzer="button"]');
    assert.equal(buttons.length, 1);
    buttons[0].click();
    await flush();

    assert.equal(ext.ports.length, 1);
    const { deal } = ext.ports[0].posted[0];
    assert.equal(deal.finalPrice, 679.88);
    assert.equal(deal.condition, 'open box');
    assert.equal(shadow().querySelector('.panel').hidden, false);

    // Further DOM changes don't add a second button.
    document.body.append(document.createElement('p'));
    await flush(50);
    assert.equal(document.querySelectorAll('button[data-deals-analyzer="button"]').length, 1);
    dom.window.close();
  });
});
