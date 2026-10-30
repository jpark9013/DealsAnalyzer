import { test, describe, afterEach } from 'node:test';
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
    headline: 'About $40 under similar monitors. <img src=x onerror="window.pwned=1">',
    keySpecs: ['27in 1440p', '200Hz IPS', 'USB-C KVM'],
    dealPrice: 159.99,
    sameItemPrice: 179.99,
    lowestRecentPrice: 149.99,
    equivalentMarketPrice: 199.99,
    comparableOffers: [
      { store: 'Best Buy', product: 'GIGABYTE M27Q2', price: 179.99, url: 'https://www.bestbuy.com/x', condition: 'new', match: 'same_item', specDifferences: '', verified: true },
      { store: 'Newegg', product: 'MSI MAG 275QF', price: 199.99, url: 'https://newegg.com/made-up', condition: 'refurbished', match: 'equivalent', specDifferences: 'No KVM; 180Hz vs 200Hz', verified: false, quotedPrice: 249.99, check: 'changed', checkedAt: new Date().toISOString() },
      { store: 'Walmart', product: 'Acer Nitro', price: 135, url: null, condition: 'new', match: 'worse', specDifferences: 'VA panel, 165Hz', verified: false }
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

// Every window is closed after each test, even a failing one; an open window
// keeps the panel's timers running and stops the test process from exiting.
const openWindows = [];
afterEach(() => {
  for (const win of openWindows.splice(0)) win.close();
});

function loadPage(html, url, options) {
  const ext = fakeExtensionApi(options);
  const dom = makeDom(html, {
    url,
    scripts: CONTENT_SCRIPTS,
    before: (win) => {
      win.chrome = ext.api;
    }
  });
  openWindows.push(dom.window);
  const shadow = () => dom.window.document.getElementById('deals-analyzer-root')?.shadowRoot;
  return { dom, ext, shadow };
}

describe('deal pages', () => {
  test('shows each stage, and the verdict as it streams in', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    const [port] = ext.ports;
    const root = shadow();
    const status = () => root.querySelector('.loading > div:last-child > div').textContent;
    assert.equal(status(), 'Searching stores for current prices…');

    port.emit({ type: 'progress', stage: 'searching', queries: ['M27Q2 price', 'M27Q2 review'], partial: null });
    assert.deepEqual([...root.querySelectorAll('.loading li')].map((li) => li.textContent), ['“M27Q2 price”', '“M27Q2 review”']);
    port.emit({ type: 'progress', stage: 'thinking', queries: ['M27Q2 price', 'M27Q2 review'], partial: null });
    assert.equal(status(), 'Weighing the evidence…');

    // Prices first, then the rating, while the offers are still being written.
    const partial = { ...RESULT.verdict, rating: null, confidence: null, headline: '', comparableOffers: [], reasonsFor: [], reasonsAgainst: [] };
    port.emit({ type: 'progress', stage: 'writing', queries: [], partial });
    assert.equal(status(), 'Writing the verdict…');
    assert.equal(root.querySelector('.pill'), null);
    assert.match(root.querySelector('table').textContent, /Equivalent products\$199\.99/);

    port.emit({ type: 'progress', stage: 'writing', queries: [], partial: { ...partial, rating: 'yes', confidence: 'medium', headline: 'About $40 under.' } });
    assert.equal(root.querySelector('.pill').textContent, 'Yes');
    assert.ok(root.querySelector('.spinner'), 'still working on the rest');
    assert.equal(root.querySelector('.tab').textContent, 'Yes', 'the minimized tab shows the rating already');

    port.emit({ type: 'result', result: RESULT });
    assert.equal(root.querySelector('.spinner'), null);
    assert.equal(root.querySelectorAll('.offers li').length, 3);
  });

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
    assert.deepEqual([...root.querySelectorAll('.spec')].map((el) => el.textContent), ['27in 1440p', '200Hz IPS', 'USB-C KVM']);
    const priceText = root.querySelector('table').textContent;
    assert.match(priceText, /Equivalent products\$199\.9920% less/);
    assert.match(priceText, /Same item elsewhere\$179\.9911% less/);
    assert.deepEqual(
      [...root.querySelectorAll('.offers .tag')].map((el) => el.textContent),
      ['weaker specs', 'same item', 'equivalent', 'refurbished']
    );
    assert.deepEqual([...root.querySelectorAll('.offers .store')].map((el) => el.textContent), ['Walmart', 'Best Buy', 'Newegg']);
    assert.equal(root.querySelector('.offers .diff').textContent, 'VA panel, 165Hz');
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
  });

  test('says where each price came from, and what was left out', async () => {
    const checkedAt = new Date().toISOString();
    const verdict = {
      ...RESULT.verdict,
      offersHidden: 2,
      comparableOffers: [
        { store: 'A', product: 'Same', price: 100, url: 'https://a.example/1', verified: true, condition: 'new', match: 'equivalent', specDifferences: '', check: 'confirmed', quotedPrice: 100, checkedAt },
        { store: 'B', product: 'Moved', price: 120, url: 'https://b.example/1', verified: true, condition: 'new', match: 'equivalent', specDifferences: '', check: 'changed', quotedPrice: 150, checkedAt },
        { store: 'C', product: 'Walled', price: 140, url: 'https://c.example/1', verified: true, condition: 'new', match: 'equivalent', specDifferences: '', check: 'unverified', checkedAt: null, pageAge: '350 days ago' }
      ],
      savings: [{ text: 'Student deals at A', url: 'https://a.example/student' }, { text: 'Bad', url: 'javascript:alert(1)' }]
    };
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush(20);
    ext.ports[0].emit({ type: 'result', result: { ...RESULT, verdict } });
    const root = shadow();
    const rows = [...root.querySelectorAll('.offers li')];
    assert.match(rows[0].querySelector('.check.confirmed').textContent, /✓ checked just now/);
    assert.equal(rows[1].querySelector('.was').textContent, '$150.00');
    assert.ok(rows[1].querySelector('.check.changed'));
    const unverified = rows[2].querySelector('.check.unverified');
    assert.equal(unverified.textContent, 'not confirmed');
    assert.match(unverified.title, /350 days ago/);
    assert.equal(rows[2].querySelector('a').href, 'https://c.example/1', 'still clickable, to check by hand');
    assert.match(root.querySelector('.offers-note').textContent, /2 more left out/);

    const savings = root.querySelector('.savings');
    assert.equal(savings.querySelector('a').href, 'https://a.example/student');
    assert.equal(savings.querySelectorAll('a').length, 1, 'only http(s) links');
    assert.match(savings.querySelector('.note').textContent, /aren't verified/);
  });

  test('marks a rating changed by the live prices', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush(20);
    ext.ports[0].emit({ type: 'result', result: { ...RESULT, verdict: { ...RESULT.verdict, repriced: true } } });
    assert.match(shadow().querySelector('.revised').textContent, /re-rated with live store prices/);
  });

  test('re-analyze forces a fresh request', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].emit({ type: 'result', result: { ...RESULT, cached: true } });
    assert.match(shadow().querySelector('footer').textContent, /cached/);

    [...shadow().querySelectorAll('button')].find((b) => b.textContent === 'Re-analyze').click();
    assert.equal(ext.ports.length, 2);
    assert.equal(ext.ports[1].posted[0].force, true);
  });

  test('shows errors with a retry button', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].emit({ type: 'error', error: { code: 'overloaded', message: 'The Anthropic API is having trouble (529).' } });
    const alert = shadow().querySelector('[role="alert"]');
    assert.match(alert.textContent, /having trouble/);
    alert.querySelector('button').click();
    assert.equal(ext.ports.length, 2);
  });

  test('reports a dropped connection', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].drop();
    assert.match(shadow().querySelector('[role="alert"]').textContent, /Lost the connection/);
  });

  test('asks for an API key instead of analyzing', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, {
      status: { hasKey: false, autoAnalyze: true }
    });
    await flush();
    assert.equal(ext.ports.length, 0);
    const button = [...shadow().querySelectorAll('button')].find((b) => b.textContent === 'Open settings');
    button.click();
    await flush();
    assert.ok(ext.sent.some((m) => m.type === 'open-options'));
  });

  test('waits for a click when auto-analyze is off', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, {
      status: { hasKey: true, autoAnalyze: false }
    });
    await flush();
    assert.equal(ext.ports.length, 0);
    [...shadow().querySelectorAll('button')].find((b) => b.textContent === 'Analyze deal').click();
    assert.equal(ext.ports.length, 1);
  });

  test('remembers when the panel is minimized', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, { stored: { panelCollapsed: true } });
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
  });
});

describe('listing pages', () => {
  test('stays out of the way until a deal pop-up opens', async () => {
    const { dom, ext } = loadPage('<!doctype html><html><body><div id="deals"></div></body></html>', HOME_URL);
    await flush();
    assert.equal(dom.window.document.getElementById('deals-analyzer-root'), null);
    assert.equal(ext.ports.length, 0);
  });

  function openPopup(document) {
    // Simulate the site opening its colorbox pop-up after page load.
    const wrapper = document.createElement('div');
    wrapper.innerHTML = popupPage(fixture('popup-ebay-openbox-coupon'));
    document.body.append(wrapper.querySelector('#colorbox'));
  }

  test('analyzes a deal pop-up as soon as it opens', async () => {
    const { dom, ext, shadow } = loadPage('<!doctype html><html><body></body></html>', HOME_URL);
    openPopup(dom.window.document);
    await flush(50);

    assert.equal(ext.ports.length, 1, 'no click needed');
    const { deal } = ext.ports[0].posted[0];
    assert.equal(deal.finalPrice, 679.88);
    assert.equal(deal.condition, 'open box');
    assert.equal(shadow().querySelector('.panel').hidden, false);
    // The button stays, for reopening the panel; further DOM changes don't add another.
    dom.window.document.body.append(dom.window.document.createElement('p'));
    await flush(50);
    assert.equal(dom.window.document.querySelectorAll('button[data-deals-analyzer="button"]').length, 1);
  });

  test('with auto-analyze off, waits for the Analyze button', async () => {
    const { dom, ext, shadow } = loadPage('<!doctype html><html><body></body></html>', HOME_URL, {
      status: { hasKey: true, autoAnalyze: false }
    });
    openPopup(dom.window.document);
    await flush(50);
    assert.equal(ext.ports.length, 0);

    dom.window.document.querySelector('button[data-deals-analyzer="button"]').click();
    await flush();
    assert.equal(ext.ports.length, 1);
    assert.equal(shadow().querySelector('.panel').hidden, false);
  });
});

describe('follow-up chat', () => {
  async function showVerdict(options) {
    const page = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, options);
    await flush();
    page.ext.ports[0].emit({ type: 'result', result: RESULT });
    return page;
  }
  const answer = (text, extra = {}) => ({ role: 'assistant', text, sources: [], costUsd: 0.004, ...extra });

  test('offers suggested questions once there is a verdict', async () => {
    const { ext, shadow } = await showVerdict();
    const root = shadow();
    assert.equal(root.querySelector('.composer').hidden, false);
    const chips = [...root.querySelectorAll('.chip')];
    assert.deepEqual(chips.map((c) => c.textContent), [
      'What would you buy instead?',
      'Is this likely to get cheaper soon?',
      'What are the biggest downsides?'
    ]);

    chips[0].click();
    assert.equal(ext.ports.length, 2);
    assert.deepEqual(
      { type: ext.ports[1].posted[0].type, question: ext.ports[1].posted[0].question, upc: ext.ports[1].posted[0].deal.upc },
      { type: 'ask', question: 'What would you buy instead?', upc: '889523049914' }
    );
  });

  test('Enter sends, Shift+Enter does not, and the box is locked while waiting', async () => {
    const { dom, ext, shadow } = await showVerdict();
    const root = shadow();
    const input = root.querySelector('.composer textarea');
    const key = (opts) => input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, ...opts }));

    input.value = 'Is the seller OK?';
    key({ key: 'Enter', shiftKey: true });
    assert.equal(ext.ports.length, 1, 'Shift+Enter is a new line');
    key({ key: 'Enter' });
    assert.equal(ext.ports.length, 2);
    assert.equal(input.value, '');
    assert.equal(input.disabled, true);

    const chat = root.querySelector('.chat');
    assert.match(chat.querySelector('.msg.user').textContent, /Is the seller OK\?/);
    assert.match(chat.querySelector('.msg.pending').textContent, /Thinking/);
    assert.equal(chat.querySelector('.chip'), null, 'suggestions hide once chatting');

    ext.ports[1].emit({ type: 'progress', queries: ['GIGABYTE seller rating'] });
    assert.match(chat.querySelector('.msg.pending').textContent, /Searching…“GIGABYTE seller rating”/);
  });

  test('renders answers as safe rich text with sources', async () => {
    const { dom, ext, shadow } = await showVerdict();
    shadow().querySelector('.chip').click();
    ext.ports[1].emit({
      type: 'answer',
      turns: [
        { role: 'user', text: 'What would you buy instead?' },
        answer('I would get the **MSI G274QPF**:\n- $149.99 at Newegg\n- similar panel\n\n<img src=x onerror="window.pwned=1">', {
          sources: [
            { title: 'Newegg', url: 'https://www.newegg.com/msi' },
            { title: 'Bad', url: 'javascript:alert(1)' }
          ]
        })
      ],
      revision: null
    });

    const root = shadow();
    const msg = root.querySelector('.msg.assistant');
    assert.equal(msg.querySelector('strong').textContent, 'MSI G274QPF');
    assert.deepEqual([...msg.querySelectorAll('li')].map((li) => li.textContent), ['$149.99 at Newegg', 'similar panel']);
    assert.equal(msg.querySelector('img'), null);
    assert.match(msg.textContent, /<img src=x/);
    assert.equal(dom.window.pwned, undefined);
    assert.deepEqual([...msg.querySelectorAll('.cites a')].map((a) => [a.textContent, a.href]), [['[1] newegg.com', 'https://www.newegg.com/msi']]);
    assert.equal(msg.querySelector('.cost').textContent, '~$0.004');
    assert.equal(root.querySelector('.composer textarea').disabled, false);
  });

  test('a revised verdict updates the rating', async () => {
    const { ext, shadow } = await showVerdict();
    shadow().querySelector('.chip').click();
    ext.ports[1].emit({
      type: 'answer',
      turns: [{ role: 'user', text: 'I edit photos.' }, answer('Then skip it.')],
      revision: { verdict: { ...RESULT.verdict, rating: 'no', headline: 'Not for photo work.' }, revisedAt: new Date().toISOString() }
    });
    const root = shadow();
    assert.equal(root.querySelector('.pill').textContent, 'No');
    assert.match(root.querySelector('.verdict').textContent, /updated after your question/);
    assert.match(root.querySelector('.tab').textContent, /No/);
    assert.equal(root.querySelectorAll('.msg').length, 2, 'the chat survives the re-render');
  });

  test('a failed question can be retried without retyping', async () => {
    const { ext, shadow } = await showVerdict();
    const root = shadow();
    const input = root.querySelector('.composer textarea');
    input.value = 'Will it drop?';
    root.querySelector('.composer').dispatchEvent(new input.ownerDocument.defaultView.Event('submit', { cancelable: true }));
    ext.ports[1].emit({ type: 'error', error: { code: 'overloaded', message: 'The Anthropic API is having trouble (529).' } });

    assert.match(root.querySelector('.msg.error').textContent, /having trouble/);
    assert.equal(input.value, 'Will it drop?');
    assert.equal(input.disabled, false);
  });

  test('shows the saved chat when a cached verdict comes back', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    ext.ports[0].emit({
      type: 'result',
      result: { ...RESULT, cached: true, turns: [{ role: 'user', text: 'Earlier question' }, answer('Earlier answer')] }
    });
    assert.deepEqual([...shadow().querySelectorAll('.msg')].map((m) => m.textContent.replace(/~\$.*/, '')), ['Earlier question', 'Earlier answer']);
  });

  test('the question box only appears with a verdict', async () => {
    const { ext, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL);
    await flush();
    assert.equal(shadow().querySelector('.composer').hidden, true, 'hidden while loading');
    ext.ports[0].emit({ type: 'error', error: { code: 'overloaded', message: 'busy' } });
    assert.equal(shadow().querySelector('.composer').hidden, true, 'hidden on error');
  });
});

describe('panel layout', () => {
  test('restores a saved position and size', async () => {
    const layout = { geometry: { left: 40, top: 60, width: 420, height: 500 }, tabPosition: null };
    const { shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, { stored: { panelLayout: layout } });
    await flush();
    const { style } = shadow().querySelector('.panel');
    assert.deepEqual([style.left, style.top, style.width, style.height, style.right], ['40px', '60px', '420px', '500px', 'auto']);
  });

  test('keeps a saved panel on screen in a smaller window', async () => {
    const layout = { geometry: { left: 5000, top: 5000, width: 2000, height: null }, tabPosition: null };
    const { dom, shadow } = loadPage(fixture('detail-amazon-monitor'), DETAIL_URL, { stored: { panelLayout: layout } });
    await flush();
    const { style } = shadow().querySelector('.panel');
    const { innerWidth, innerHeight } = dom.window;
    assert.equal(style.width, '760px', 'capped at the maximum width');
    assert.equal(parseFloat(style.left) + 760 <= innerWidth - 8, true);
    assert.equal(parseFloat(style.top) <= innerHeight - 60 - 8, true);
  });
});

describe('store product pages', () => {
  const STORE_URL = 'https://computers.woot.com/offers/epos-adapt-160t-anc-usb-headset-0';
  const SCRIPTS = ['extension/src/content/extract.js', 'extension/src/content/extract-page.js', 'extension/src/content/panel.js', 'extension/src/content/main.js'];
  const settle = () => flush(20);
  // Past the moment automatic analysis waits on a new page.
  const settleAuto = () => flush(1300);
  const AUTO_OFF = { status: { hasKey: true, autoAnalyze: false, showOnStores: true } };

  function loadStore(html, url = STORE_URL, options) {
    const ext = fakeExtensionApi(options);
    const dom = makeDom(html, { url, scripts: SCRIPTS, before: (win) => { win.chrome = ext.api; } });
    openWindows.push(dom.window);
    const shadow = () => dom.window.document.getElementById('deals-analyzer-root')?.shadowRoot;
    return { dom, ext, shadow };
  }

  const productPage = (name, price) =>
    `<!doctype html><html><head><title>${name}</title><script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name,
      offers: { price, priceCurrency: 'USD' }
    })}</script></head><body><h1>${name}</h1></body></html>`;

  test('opens and analyzes a product page by itself, after a moment', async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'));
    await settle();
    assert.equal(shadow().querySelector('aside').hidden, false, 'open straight away');
    assert.equal(ext.ports.length, 0, 'not paying yet: the shopper may bounce');
    await settleAuto();
    assert.equal(ext.ports.length, 1);
    const { type, deal } = ext.ports[0].posted[0];
    assert.equal(type, 'analyze');
    assert.equal(deal.finalPrice, 24.99);
    assert.ok(shadow().querySelector('.spinner'));
  });

  test('a tab opened in the background waits until it is viewed', async () => {
    const { dom, ext } = loadStore(fixture('store-woot-headset'), STORE_URL, {});
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    await settleAuto();
    assert.equal(ext.ports.length, 0);
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
    dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await settleAuto();
    assert.equal(ext.ports.length, 1);
  });

  test('analyzes minimized when the shopper keeps the panel minimized', async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, { stored: { panelCollapsed: true } });
    await settleAuto();
    assert.equal(shadow().querySelector('aside').hidden, true);
    assert.equal(ext.ports.length, 1);
  });

  test("a verdict from the last day is shown without paying, with auto-analyze on too", async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, { peek: { ...RESULT, cached: true } });
    await settleAuto();
    assert.equal(ext.ports.length, 0);
    assert.equal(shadow().querySelector('.pill').textContent, 'Yes');
  });

  test('moving to another product before the moment passes pays only for that one', async () => {
    const page = (name, price) => productPage(name, price);
    const { dom, ext } = loadStore(page('Lamp X100', 40), 'https://shop.example/lamp');
    await settle();
    const doc = dom.window.document;
    doc.head.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify({ '@type': 'Product', name: 'Desk Y200', offers: { price: 90, priceCurrency: 'USD' } });
    doc.querySelector('h1').textContent = 'Desk Y200';
    dom.window.history.pushState({}, '', '/desk');
    await flush(1100); // the address check runs every second
    await settleAuto();
    assert.equal(ext.ports.length, 1);
    assert.equal(ext.ports[0].posted[0].deal.title, 'Desk Y200');
  });

  test("won't spend on a page with no price; it waits as the tab", async () => {
    const html = '<!doctype html><html><head><title>Lamp</title><meta property="og:type" content="product"></head><body><h1>Lamp</h1></body></html>';
    const { ext, shadow } = loadStore(html, 'https://shop.example/lamp');
    await flush(5500); // past the retries for a late price
    assert.equal(ext.ports.length, 0);
    assert.equal(shadow().querySelector('.tab').hidden, false);
  });

  test('stays inert in a tab opened only to read a price', async () => {
    // It would otherwise pay for an analysis, which could open more such tabs.
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, { status: { hasKey: true, autoAnalyze: true, showOnStores: true, helperTab: true } });
    await settleAuto();
    assert.equal(ext.ports.length, 0);
    assert.equal(shadow(), undefined);
  });

  test('with auto-analyze off: the Deal check tab, without analyzing or charging anything', async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, AUTO_OFF);
    await settleAuto();
    const root = shadow();
    assert.ok(root, 'the panel exists');
    assert.equal(root.querySelector('.tab').hidden, false, 'the tab is showing');
    assert.equal(root.querySelector('aside').hidden, true, 'the panel itself stays minimized');
    assert.equal(ext.ports.length, 0, 'no analysis yet');
    assert.ok(ext.sent.some((m) => m.type === 'peek' && m.key === 'EPOS Adapt 160T ANC USB Headset|computers.woot.com|24.99'));
  });

  test('clicking the tab analyzes the product', async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, AUTO_OFF);
    await settle();
    shadow().querySelector('.tab').click();
    assert.equal(ext.ports.length, 1);
    const { type, deal } = ext.ports[0].posted[0];
    assert.equal(type, 'analyze');
    assert.equal(deal.title, 'EPOS Adapt 160T ANC USB Headset');
    assert.equal(deal.finalPrice, 24.99);
    assert.equal(shadow().querySelector('aside').hidden, false);
    assert.ok(shadow().querySelector('.spinner'));
  });

  test("shows a verdict from the last day on the tab, and doesn't pay for it again", async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, { ...AUTO_OFF, peek: { ...RESULT, cached: true } });
    await settle();
    assert.equal(shadow().querySelector('.tab').textContent, 'Yes');
    shadow().querySelector('.tab').click();
    assert.equal(ext.ports.length, 0);
    assert.equal(shadow().querySelector('.pill').textContent, 'Yes');
  });

  test("stays off pages that aren't products, even ones with a heading and a price", async () => {
    const home = '<!doctype html><html><head><title>Woot</title></head><body><h1>Daily deals</h1></body></html>';
    const article = '<!doctype html><html><head><title>Best TVs</title></head><body><h1>Best TVs of 2026</h1><span class="price">$499.99</span></body></html>';
    for (const html of [home, article]) {
      const { shadow } = loadStore(html, 'https://www.example.com/');
      await settle();
      assert.equal(shadow(), undefined);
    }
  });

  test('can be turned off in settings', async () => {
    const { ext, shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, { status: { hasKey: true, showOnStores: false } });
    await settle();
    assert.equal(shadow(), undefined);
    assert.equal(ext.ports.length, 0);
  });

  test('asks for a key instead of offering to analyze when there is none', async () => {
    const { shadow } = loadStore(fixture('store-woot-headset'), STORE_URL, { status: { hasKey: false, showOnStores: true } });
    await settle();
    assert.match(shadow().querySelector('.notice').textContent, /Add your Anthropic API key/);
  });

  test('picks up a price the store renders after the page loads', async () => {
    // Target renders its price with JavaScript after load.
    const html =
      '<!doctype html><html><head><title>iPad mini : Target</title><meta property="og:type" content="product"></head>' +
      '<body><h1>iPad mini</h1><div id="buy"></div></body></html>';
    const { dom, ext, shadow } = loadStore(html, 'https://www.target.com/p/ipad-mini/-/A-91122078');
    await settle();
    assert.match(shadow().querySelector('.deal-title + div').textContent, /^at target\.com$/);

    dom.window.document.getElementById('buy').innerHTML = '<span data-test="product-price">$499.99</span>';
    await flush(1600);
    assert.match(shadow().querySelector('.deal-title + div').textContent, /^\$499\.99/);

    shadow().querySelector('.tab').click();
    assert.equal(ext.ports[0].posted[0].deal.finalPrice, 499.99);
  });

  test('analyzes what the page shows when the tab is clicked', async () => {
    const { dom, ext, shadow } = loadStore(productPage('Acme Kettle', 40), 'https://shop.example/kettle');
    await settle();
    // The shopper picks the larger size; the store updates the page in place.
    dom.window.document.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify({ '@type': 'Product', name: 'Acme Kettle 2L', offers: { price: 55, priceCurrency: 'USD' } });
    shadow().querySelector('.tab').click();
    const { deal } = ext.ports[0].posted[0];
    assert.equal(deal.title, 'Acme Kettle 2L');
    assert.equal(deal.finalPrice, 55);
  });

  test('follows single-page stores to the next product', async () => {
    const { dom, ext, shadow } = loadStore(productPage('Acme Kettle', 40), 'https://shop.example/kettle');
    await settle();
    assert.match(shadow().querySelector('.deal-title').textContent, /Acme Kettle/);

    // The store swaps the page in place, as React and Next.js stores do.
    const doc = dom.window.document;
    dom.window.history.pushState({}, '', '/toaster');
    doc.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify({ '@type': 'Product', name: 'Acme Toaster', offers: { price: 30, priceCurrency: 'USD' } });
    doc.title = 'Acme Toaster';
    doc.querySelector('h1').textContent = 'Acme Toaster';
    await flush(1100);

    assert.match(shadow().querySelector('.deal-title').textContent, /Acme Toaster/);
    assert.deepEqual(ext.sent.filter((m) => m.type === 'peek').map((m) => m.key), ['Acme Kettle|shop.example|40', 'Acme Toaster|shop.example|30']);
    assert.equal(ext.ports.length, 0);
  });

  test('the toolbar button analyzes right away', async () => {
    const { dom, ext, shadow } = loadStore(fixture('store-woot-headset'));
    await settle();
    dom.window.DealsAnalyzer.analyzePage();
    await settle();
    assert.equal(ext.ports.length, 1);
    assert.equal(ext.ports[0].posted[0].deal.site, 'computers.woot.com');
    assert.equal(shadow().querySelector('aside').hidden, false);
  });

  test("the toolbar button says so when the page has no product", async () => {
    const home = '<!doctype html><html><head><title>Woot</title></head><body><h1>Daily deals</h1></body></html>';
    const { dom, ext, shadow } = loadStore(home, 'https://www.woot.com/');
    dom.window.DealsAnalyzer.analyzePage();
    await settle();
    assert.equal(ext.ports.length, 0);
    assert.match(shadow().querySelector('[role="alert"]').textContent, /Couldn't find a product with a price/);
  });
});
