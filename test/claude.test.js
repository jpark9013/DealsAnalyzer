import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDeal, askFollowUp, testApiKey, linkOffers, resolveOffers, AnalysisError, API_VERSION, urlKey } from '../extension/src/background/claude.js';
import { sanitizeSettings } from '../extension/src/background/settings.js';
import { sampleDeal, sseFromMessage } from './helpers.js';

const SETTINGS = sanitizeSettings({ apiKey: 'sk-ant-test', maxSearches: 4 });
const noSleep = async () => {};

function mockFetch(responses) {
  const queue = [...responses];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null
    });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected extra request to ${url}`);
    if (next instanceof Error) throw next;
    // Messages replies stream; errors and other endpoints are plain JSON.
    if (next.sse !== undefined) return new Response(next.sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (next.body?.type === 'message') {
      return new Response(sseFromMessage(next.body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers ?? {} });
  };
  return { fetchImpl, calls, remaining: () => queue.length };
}

const reply = (content, stopReason = 'end_turn', usage = { input_tokens: 2000, output_tokens: 300 }) => ({
  body: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content, stop_reason: stopReason, usage }
});

const searchBlocks = (id, query, results) => [
  { type: 'server_tool_use', id, name: 'web_search', input: { query } },
  {
    type: 'web_search_tool_result',
    tool_use_id: id,
    content: results.map((r) => ({ type: 'web_search_result', url: r.url, title: r.title, encrypted_content: 'enc', page_age: '2 days ago' }))
  }
];

const verdictCall = (input) => ({ type: 'tool_use', id: 'toolu_v', name: 'submit_verdict', input });

const VERDICT = {
  specs: ['27in 1440p', '200Hz IPS'],
  deal_price: 159.99,
  same_item_price: 199.99,
  lowest_price: 159.99,
  equivalent_price: 219.99,
  rating: 'strong_yes',
  confidence: 'high',
  headline: 'Lowest price seen for this monitor; usually $199+.',
  offers: [
    { match: 'same_item', store: 'Best Buy', product: 'GIGABYTE M27Q2', price: 199.99, condition: 'new', diff: '' },
    { match: 'equivalent', store: 'Newegg', product: 'MSI MAG 275QF', price: 179.99, condition: 'new', diff: '180Hz vs 200Hz' }
  ],
  pros: ['Matches the all-time low'],
  cons: ['Older panel generation']
};

// Store pages stay off the network: by default every store refuses, as some do.
const blockedPage = async (url) => ({ status: 403, url, text: async () => '' });
const storePage = (price, title = 'GIGABYTE M27Q2') => async (url) => ({
  status: 200,
  url,
  text: async () =>
    `<html><head><title>${title}</title><script type="application/ld+json">${JSON.stringify({
      '@type': 'Product',
      name: title,
      offers: { price, priceCurrency: 'USD' }
    })}</script></head></html>`
});

const run = (fetchImpl, settings = SETTINGS, extra = {}) =>
  analyzeDeal(sampleDeal(), settings, { fetchImpl, fetchPage: blockedPage, sleep: noSleep, now: new Date(2026, 9, 29), ...extra });

describe('analyzeDeal request', () => {
  test('sends a Haiku request with basic web search, the verdict tool, and browser-access headers', async () => {
    const { fetchImpl, calls } = mockFetch([reply([verdictCall(VERDICT)], 'tool_use')]);
    await run(fetchImpl);

    assert.equal(calls.length, 1);
    const [{ url, method, headers, body }] = calls;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(method, 'POST');
    assert.equal(headers['x-api-key'], 'sk-ant-test');
    assert.equal(headers['anthropic-version'], API_VERSION);
    assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(headers['anthropic-beta'], undefined);

    assert.equal(body.model, 'claude-haiku-5-5');
    assert.equal(body.stream, true);
    assert.deepEqual(body.tools[0], {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 4,
      user_location: { type: 'approximate', country: 'US' }
    });
    assert.equal(body.tools[1].name, 'submit_verdict');
    assert.equal(body.tools[1].strict, true);
    assert.deepEqual(body.tool_choice, { type: 'auto' });
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.ok(body.max_tokens >= 8000, 'room for thinking plus the verdict');
    // API version 2026-10-21 rejects sampling parameters outright.
    for (const field of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks']) assert.ok(!(field in body), field);

    assert.match(body.system, /Today is 2026-10-29/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.match(body.messages[0].content, /Model \/ MPN: M27Q2/);
  });

  test('Sonnet uses dynamic-filtering web search and server-side fallbacks', async () => {
    const { fetchImpl, calls } = mockFetch([reply([verdictCall(VERDICT)], 'tool_use')]);
    await run(fetchImpl, sanitizeSettings({ apiKey: 'k', model: 'claude-sonnet-5-5', effort: 'high' }));
    const [{ headers, body }] = calls;
    assert.equal(body.model, 'claude-sonnet-5-5');
    assert.equal(body.tools[0].type, 'web_search_20260209');
    assert.equal(body.fallbacks, 'default');
    assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.deepEqual(body.output_config, { effort: 'high' });
  });

  test('refuses to run without an API key and makes no request', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    await assert.rejects(run(fetchImpl, sanitizeSettings({})), { code: 'no_key' });
    assert.equal(calls.length, 0);
  });
});

describe('analyzeDeal results', () => {
  test('returns the normalized verdict, research trail, and cost', async () => {
    const { fetchImpl } = mockFetch([
      reply(
        [
          { type: 'thinking', thinking: '', signature: 'sig' },
          ...searchBlocks('srv_1', 'GIGABYTE M27Q2 price', [
            { url: 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p/', title: 'Best Buy M27Q2' },
            { url: 'https://camelcamelcamel.com/product/B0GKFQXR3R', title: 'Price history' }
          ]),
          verdictCall(VERDICT)
        ],
        'tool_use',
        { input_tokens: 12_000, output_tokens: 800, server_tool_use: { web_search_requests: 1 } }
      )
    ]);
    const result = await run(fetchImpl);

    assert.equal(result.verdict.rating, 'strong_yes');
    assert.equal(result.verdict.equivalentMarketPrice, 219.99);
    assert.equal(result.verdict.sameItemPrice, 199.99);
    assert.deepEqual(result.verdict.keySpecs, ['27in 1440p', '200Hz IPS']);
    assert.equal(result.model, 'claude-haiku-5-5');
    assert.deepEqual(result.queries, ['GIGABYTE M27Q2 price']);
    assert.equal(result.sources.length, 2);
    // Offers are linked to a search result on their store that names the model;
    // one with no page to link to isn't shown at all.
    assert.equal(result.verdict.comparableOffers.length, 1);
    const [bestBuy] = result.verdict.comparableOffers;
    assert.equal(bestBuy.url, 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p/');
    assert.equal(bestBuy.verified, true);
    assert.equal(bestBuy.check, 'unverified');
    assert.equal(result.verdict.offersHidden, 1);
    assert.deepEqual(result.usage, {
      inputTokens: 12_000,
      outputTokens: 800,
      webSearches: 1,
      requests: 1,
      costUsd: 0.0116
    });
    assert.ok(!Number.isNaN(Date.parse(result.analyzedAt)));
  });

  test('resumes paused turns by re-sending the assistant content, without a "continue" message', async () => {
    const firstContent = searchBlocks('srv_1', 'M27Q2 price', [{ url: 'https://a.example/1', title: 'A' }]);
    const secondContent = searchBlocks('srv_2', 'M27Q2 alternatives', [{ url: 'https://b.example/2', title: 'B' }]);
    const progress = [];
    const { fetchImpl, calls } = mockFetch([
      reply(firstContent, 'pause_turn'),
      reply(secondContent, 'pause_turn'),
      reply([verdictCall(VERDICT)], 'tool_use')
    ]);
    const result = await run(fetchImpl, SETTINGS, { onProgress: (p) => progress.push(p) });

    assert.equal(calls.length, 3);
    assert.equal(calls[1].body.messages.length, 2);
    assert.deepEqual(calls[1].body.messages[1], { role: 'assistant', content: firstContent });
    // A second pause extends the same assistant message.
    assert.equal(calls[2].body.messages.length, 2);
    assert.deepEqual(calls[2].body.messages[1].content, [...firstContent, ...secondContent]);
    assert.deepEqual(result.queries, ['M27Q2 price', 'M27Q2 alternatives']);
    assert.equal(result.usage.requests, 3);
    assert.deepEqual(progress.at(-1).queries, ['M27Q2 price', 'M27Q2 alternatives']);
  });

  test('accepts a verdict written as JSON text', async () => {
    const { fetchImpl } = mockFetch([
      reply([{ type: 'text', text: `Here you go:\n\`\`\`json\n${JSON.stringify({ ...VERDICT, rating: 'Maybe' })}\n\`\`\`` }])
    ]);
    const result = await run(fetchImpl);
    assert.equal(result.verdict.rating, 'maybe');
  });

  test('nudges once when Claude ends without a verdict', async () => {
    const { fetchImpl, calls } = mockFetch([
      reply([{ type: 'text', text: 'Looks like a good deal overall.' }]),
      reply([verdictCall(VERDICT)], 'tool_use')
    ]);
    const result = await run(fetchImpl);
    assert.equal(result.verdict.rating, 'strong_yes');
    const { messages } = calls[1].body;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[2].role, 'user');
    assert.match(messages[2].content, /submit_verdict/);
  });

  test('gives up after the nudge is ignored', async () => {
    const { fetchImpl, calls } = mockFetch([
      reply([{ type: 'text', text: 'Hmm.' }]),
      reply([{ type: 'text', text: 'Still thinking.' }])
    ]);
    await assert.rejects(run(fetchImpl), { code: 'no_verdict' });
    assert.equal(calls.length, 2);
  });

  test('reports refusals with their category', async () => {
    const { fetchImpl } = mockFetch([
      { body: { ...reply([]).body, stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms' } } }
    ]);
    await assert.rejects(run(fetchImpl), (err) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.code, 'refusal');
      assert.match(err.message, /general_harms/);
      return true;
    });
  });

  test('reports running out of tokens', async () => {
    const { fetchImpl } = mockFetch([reply([{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens')]);
    await assert.rejects(run(fetchImpl), { code: 'max_tokens' });
  });

  test('rejects a verdict with an unknown rating', async () => {
    const { fetchImpl } = mockFetch([reply([verdictCall({ ...VERDICT, rating: 'definitely' })], 'tool_use')]);
    await assert.rejects(run(fetchImpl), { code: 'bad_verdict' });
  });

  test('tolerates a web search error result', async () => {
    const { fetchImpl } = mockFetch([
      reply(
        [
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
          { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
          verdictCall(VERDICT)
        ],
        'tool_use'
      )
    ]);
    const result = await run(fetchImpl);
    assert.deepEqual(result.sources, []);
    assert.deepEqual(result.queries, ['x']);
  });
});

describe('analyzeDeal streaming', () => {
  test('reports each search as issued, the stage, and the verdict field by field', async () => {
    const progress = [];
    const { fetchImpl } = mockFetch([
      reply(
        [
          ...searchBlocks('srv_1', 'GIGABYTE M27Q2 price', [{ url: 'https://www.bestbuy.com/site/m27q2/1.p', title: 'Best Buy M27Q2' }]),
          { type: 'thinking', thinking: 'Benchmark is $219.99.', signature: 'sig' },
          verdictCall(VERDICT)
        ],
        'tool_use'
      )
    ]);
    const result = await run(fetchImpl, SETTINGS, { onProgress: (p) => progress.push(p) });

    assert.deepEqual(progress[0], { stage: 'searching', queries: ['GIGABYTE M27Q2 price'], partial: null });
    assert.deepEqual(
      [...new Set(progress.map((p) => p.stage))],
      ['searching', 'reading', 'thinking', 'writing', 'checking']
    );
    // The mock streams the verdict in two halves: the first already has the rating.
    const partials = progress.filter((p) => p.partial);
    assert.ok(partials.length >= 1);
    assert.equal(partials[0].partial.rating, 'strong_yes');
    assert.equal(partials[0].partial.dealPrice, 159.99);
    assert.equal(result.verdict.comparableOffers.length, 1);
  });

  test('passes thinking blocks back intact when a paused turn resumes', async () => {
    const thinking = { type: 'thinking', thinking: 'Plan the searches.', signature: 'sig-123' };
    const { fetchImpl, calls } = mockFetch([reply([thinking, ...searchBlocks('srv_1', 'q', [])], 'pause_turn'), reply([verdictCall(VERDICT)], 'tool_use')]);
    await run(fetchImpl);
    assert.deepEqual(calls[1].body.messages[1].content[0], thinking);
    assert.deepEqual(calls[1].body.messages[1].content[1].input, { query: 'q' });
  });

  test('retries when the stream reports an overloaded error', async () => {
    const overloaded = 'event: message_start\ndata: {"type":"message_start","message":{"content":[],"usage":{}}}\n\n' +
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
    const { fetchImpl, calls } = mockFetch([{ sse: overloaded }, reply([verdictCall(VERDICT)], 'tool_use')]);
    const result = await run(fetchImpl);
    assert.equal(result.verdict.rating, 'strong_yes');
    assert.equal(calls.length, 2);
  });

  test('retries when the connection drops mid-reply', async () => {
    const cut = sseFromMessage(reply([verdictCall(VERDICT)], 'tool_use').body).split('event: message_delta')[0];
    const { fetchImpl, calls } = mockFetch([{ sse: cut }, reply([verdictCall(VERDICT)], 'tool_use')]);
    await run(fetchImpl);
    assert.equal(calls.length, 2);
  });
});

describe('resolveOffers', () => {
  const research = (...urls) => ({ sources: new Map(urls.map((url) => [urlKey(url), { title: url, url, pageAge: '3 days ago' }])) });
  const offer = (store, product, citedUrl, match = 'equivalent') => ({ store, product, citedUrl, match, url: null, verified: false, price: 100 });
  const verdict = (...offers) => ({ comparableOffers: offers, savings: [], offersHidden: 0, seller: null });
  const resolve = (offers, sources, deal = sampleDeal(), extra = {}) => resolveOffers({ ...verdict(...offers), ...extra }, deal, sources);

  test('links an offer to the search result Claude cited', () => {
    const url = 'https://www.newegg.com/gigabyte/p/N82E16824012109';
    const { comparableOffers: [linked], offersHidden } = resolve([offer('Newegg', 'Acer XV272U', url)], research(url));
    assert.equal(linked.url, url);
    assert.equal(linked.verified, true);
    assert.equal(linked.pageAge, '3 days ago');
    assert.equal(offersHidden, 0);
  });

  test('accepts a cited URL without its scheme', () => {
    const url = 'https://www.bestbuy.com/product/acer/J1';
    assert.equal(resolve([offer('Best Buy', 'Acer XV272U', 'bestbuy.com/product/acer/J1'.replace('bestbuy', 'www.bestbuy'))], research(url)).comparableOffers[0].url, url);
  });

  test("hides an offer whose URL Claude never saw, or that isn't the store's", () => {
    const seen = research('https://www.tomshardware.com/deals/acer-xv272u');
    const made = resolve([offer('Newegg', 'Acer XV272U', 'https://www.newegg.com/made-up/p/1')], seen);
    assert.equal(made.comparableOffers.length, 0);
    assert.equal(made.offersHidden, 1);
    const article = resolve([offer('Newegg', 'Acer XV272U', 'https://www.tomshardware.com/deals/acer-xv272u')], seen);
    assert.equal(article.comparableOffers.length, 0);
    assert.equal(article.offersHidden, 1);
  });

  test('never links to a script, whatever Claude writes', () => {
    assert.equal(resolve([offer('Evil', 'Thing X100', 'javascript:alert(1)')], research('https://other.example/page')).comparableOffers.length, 0);
  });

  test('falls back to matching a result by store and model', () => {
    const url = 'https://www.bestbuy.com/site/acer-xv272u/1.p';
    assert.equal(resolve([offer('Best Buy', 'Acer XV272U', null)], research(url)).comparableOffers[0].url, url);
  });

  test("won't link to search pages, deal posts or price trackers", () => {
    for (const url of [
      'https://www.newegg.com/p/pl?d=acer+xv272u',
      'https://www.walmart.com/search?q=acer+xv272u',
      'https://www.ebay.com/sch/i.html?_nkw=acer+xv272u',
      'https://slickdeals.net/f/123-acer-xv272u',
      'https://camelcamelcamel.com/product/acer-xv272u'
    ]) {
      const store = new URL(url).hostname.replace(/^www\./, '').split('.')[0];
      const out = resolve([offer(store, 'Acer XV272U', url)], research(url));
      assert.equal(out.comparableOffers.length, 0, url);
      assert.equal(out.offersHidden, 1, url);
    }
  });

  test('links to the product, not its reviews tab', () => {
    const url = 'https://www.bestbuy.com/product/acer-xv272u/J1/sku/2/reviews';
    assert.equal(resolve([offer('Best Buy', 'Acer XV272U', url)], research(url)).comparableOffers[0].url, 'https://www.bestbuy.com/product/acer-xv272u/J1/sku/2');
  });

  test("leaves out the deal itself when a deal site's post links to that store", () => {
    // An eDealinfo post of a Best Buy item: comparing it with Best Buy compares it with itself.
    const deal = sampleDeal({ store: 'Best Buy', asin: null });
    const url = 'https://www.bestbuy.com/site/gigabyte-m27q2/1.p';
    const out = resolve([offer('Best Buy', 'GIGABYTE M27Q2', url, 'same_item')], research(url), deal);
    assert.equal(out.comparableOffers.length, 0);
    assert.equal(out.offersHidden, 0, "it isn't a hidden offer, it was never a comparison");
  });

  test('catches the same model at the same store even when not labelled same item', () => {
    const deal = sampleDeal({ store: 'Best Buy', asin: null });
    const url = 'https://www.bestbuy.com/site/gigabyte-m27q2/1.p';
    assert.equal(resolve([offer('Best Buy', 'GIGABYTE M27Q2 SA', url)], research(url), deal).comparableOffers.length, 0);
  });

  test('uses the seller Claude names when the deal site hides it', () => {
    const deal = sampleDeal({ store: 'Slickdeals', dealSite: true, asin: null });
    const url = 'https://www.bestbuy.com/site/gigabyte-m27q2/1.p';
    const out = resolve([offer('Best Buy', 'GIGABYTE M27Q2', url, 'same_item')], research(url), deal, { seller: 'Best Buy' });
    assert.equal(out.comparableOffers.length, 0);
  });

  test('keeps other products at the same store', () => {
    const deal = sampleDeal({ store: 'Best Buy', asin: null });
    const url = 'https://www.bestbuy.com/site/acer-xv272u/1.p';
    assert.equal(resolve([offer('Best Buy', 'Acer XV272U', url)], research(url), deal).comparableOffers.length, 1);
  });

  test('leaves out the same page, and the same ASIN, as the deal', () => {
    const deal = sampleDeal({ store: 'Other', asin: 'B0GKFQXR3R', pageUrl: 'https://www.example-store.com/p/1' });
    const onDealPage = 'https://www.example-store.com/p/1';
    const amazon = 'https://www.amazon.com/dp/B0GKFQXR3R';
    const out = resolve(
      [offer('Example Store', 'Acer XV272U', onDealPage), offer('Amazon', 'GIGABYTE M27Q2', amazon)],
      research(onDealPage, amazon),
      deal
    );
    assert.equal(out.comparableOffers.length, 0);
  });

  test("keeps another seller's listing of the same item on a marketplace", () => {
    const deal = sampleDeal({ store: 'eBay', asin: null, pageUrl: 'https://www.ebay.com/itm/1' });
    const other = 'https://www.ebay.com/itm/2';
    const out = resolve([offer('eBay', 'GIGABYTE M27Q2', other, 'same_item')], research(other, deal.pageUrl), deal);
    assert.equal(out.comparableOffers.length, 1);
  });

  test('lists a page once', () => {
    const url = 'https://www.bestbuy.com/site/acer-xv272u/1.p';
    assert.equal(resolve([offer('Best Buy', 'Acer XV272U', url), offer('Best Buy', 'Acer XV272U', url)], research(url)).comparableOffers.length, 1);
  });

  test('keeps savings only when a search result states them', () => {
    const url = 'https://www.bestbuy.com/student';
    const out = resolve([], research(url), sampleDeal(), {
      savings: [
        { text: 'Best Buy student deals', citedUrl: url, url: null },
        { text: 'SAVE20 at checkout', citedUrl: 'https://made-up.example/code', url: null },
        { text: 'A code from memory', citedUrl: null, url: null }
      ]
    });
    assert.deepEqual(out.savings.map((s) => [s.text, s.url]), [['Best Buy student deals', url]]);
  });
});

describe('checking prices against store pages', () => {
  const URL_A = 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p';
  const withResult = (verdict = VERDICT) => [
    ...searchBlocks('srv_1', 'M27Q2 price', [{ url: URL_A, title: 'Best Buy M27Q2' }]),
    verdictCall(verdict)
  ];
  const offers = [{ match: 'same_item', store: 'Best Buy', url: URL_A, product: 'GIGABYTE M27Q2', price: 199.99, condition: 'new', diff: '' }];
  const cited = { ...VERDICT, offers };

  test('a matching page costs no second request', async () => {
    const { fetchImpl, calls } = mockFetch([reply(withResult(cited), 'tool_use')]);
    const result = await run(fetchImpl, SETTINGS, { fetchPage: storePage(199.99) });
    assert.equal(calls.length, 1);
    assert.equal(result.verdict.comparableOffers[0].check, 'confirmed');
    assert.equal(result.verdict.repriced, undefined);
  });

  test('a blocked page costs no second request either', async () => {
    const { fetchImpl, calls } = mockFetch([reply(withResult(cited), 'tool_use')]);
    const result = await run(fetchImpl, SETTINGS);
    assert.equal(calls.length, 1);
    assert.equal(result.verdict.comparableOffers[0].check, 'unverified');
  });

  test('re-rates when a page disagrees, showing the live price and keeping the offers', async () => {
    const revised = { ...VERDICT, rating: 'maybe', headline: 'Best Buy now matches it.', same_item_price: 159.99 };
    delete revised.offers;
    const { fetchImpl, calls } = mockFetch([reply(withResult(cited), 'tool_use'), reply([verdictCall(revised)], 'tool_use')]);
    const stages = [];
    const result = await run(fetchImpl, SETTINGS, { fetchPage: storePage(159.99), onProgress: (p) => stages.push(p.stage) });

    assert.equal(calls.length, 2);
    // A small request: the compact verdict and only the verdict tool, no search.
    const second = calls[1].body;
    assert.deepEqual(second.tools.map((t) => t.name), ['submit_verdict']);
    assert.ok(!('offers' in second.tools[0].input_schema.properties));
    assert.match(second.messages[0].content, /now \$159\.99 \(you said \$199\.99\)/);
    assert.match(second.messages[0].content, /<your_verdict>/);

    const { verdict } = result;
    assert.equal(verdict.rating, 'maybe');
    assert.equal(verdict.repriced, true);
    assert.equal(verdict.sameItemPrice, 159.99);
    assert.equal(verdict.comparableOffers[0].price, 159.99);
    assert.equal(verdict.comparableOffers[0].quotedPrice, 199.99);
    assert.equal(verdict.comparableOffers[0].check, 'changed');
    assert.ok(stages.includes('checking') && stages.includes('rechecking'));
    assert.equal(result.usage.requests, 2);
  });

  test('keeps the rating when Claude says the difference changes nothing', async () => {
    const { fetchImpl } = mockFetch([reply(withResult(cited), 'tool_use'), reply([{ type: 'text', text: 'unchanged' }])]);
    const result = await run(fetchImpl, SETTINGS, { fetchPage: storePage(159.99) });
    assert.equal(result.verdict.rating, 'strong_yes');
    assert.equal(result.verdict.comparableOffers[0].price, 159.99);
  });

  test('still shows the live prices if re-rating fails', async () => {
    const { fetchImpl } = mockFetch([reply(withResult(cited), 'tool_use'), { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'no' } } }]);
    const result = await run(fetchImpl, SETTINGS, { fetchPage: storePage(159.99) });
    assert.equal(result.verdict.rating, 'strong_yes');
    assert.equal(result.verdict.comparableOffers[0].price, 159.99);
  });

  test('tells Claude an offer sold out, and counts it as left out', async () => {
    const revised = { ...VERDICT, rating: 'yes' };
    delete revised.offers;
    const { fetchImpl, calls } = mockFetch([reply(withResult(cited), 'tool_use'), reply([verdictCall(revised)], 'tool_use')]);
    const fetchPage = async (url) => ({ status: 404, url, text: async () => '' });
    const result = await run(fetchImpl, SETTINGS, { fetchPage });
    assert.match(calls[1].body.messages[0].content, /page gone \(you said \$199\.99\); removed/);
    assert.equal(result.verdict.comparableOffers.length, 0);
    assert.equal(result.verdict.offersHidden, 1);
  });
});

describe('linkOffers', () => {
  const offer = (store, product) => ({ store, product, url: null, verified: false });
  const sources = [
    { title: 'GIGABYTE M27Q2 27" Monitor - Best Buy', url: 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p' },
    { title: 'MSI MAG 275QF review', url: 'https://www.rtings.com/monitor/reviews/msi/mag-275qf' },
    { title: 'KTC H27T22C-3 27in 200Hz', url: 'https://www.amazon.com/dp/B0ABCDEFGH' }
  ];

  test('links an offer to a result on its store that names the model', () => {
    const [bestBuy, ktc] = linkOffers([offer('Best Buy', 'GIGABYTE M27Q2'), offer('Amazon (KTC store)', 'KTC H27T22C-3')], sources);
    assert.equal(bestBuy.url, sources[0].url);
    assert.equal(ktc.url, sources[2].url);
    assert.ok(bestBuy.verified && ktc.verified);
  });

  test("never links to another site, or on sizes and units alone", () => {
    // The MSI result is a review site, not Newegg; "27in" and "200Hz" don't identify a model.
    const [msi, generic] = linkOffers([offer('Newegg', 'MSI MAG 275QF'), offer('Best Buy', 'Some 27in 200Hz monitor')], sources);
    assert.equal(msi.url, null);
    assert.equal(generic.url, null);
  });

  test("doesn't treat a CPU as a model, since many models share one", () => {
    const ebay = [{ title: 'HP ProDesk 600 G5 Mini i5-9500T 8GB', url: 'https://www.ebay.com/itm/123' }];
    const [dell] = linkOffers([offer('eBay', 'Dell OptiPlex 7070 Micro i5-9500T')], ebay);
    assert.equal(dell.url, null);
  });
});

describe('analyzeDeal HTTP errors', () => {
  const apiError = (status, type, message, headers) => ({ status, headers, body: { type: 'error', error: { type, message } } });

  test('a rejected key fails immediately', async () => {
    const { fetchImpl, calls } = mockFetch([apiError(401, 'authentication_error', 'invalid x-api-key')]);
    await assert.rejects(run(fetchImpl), { code: 'auth' });
    assert.equal(calls.length, 1);
  });

  test('rate limits are retried, honoring retry-after', async () => {
    const waits = [];
    const { fetchImpl, calls } = mockFetch([
      apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '3' }),
      reply([verdictCall(VERDICT)], 'tool_use')
    ]);
    const result = await run(fetchImpl, SETTINGS, { sleep: async (ms) => waits.push(ms) });
    assert.equal(result.verdict.rating, 'strong_yes');
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [3000]);
  });

  test('server errors are retried twice, then reported', async () => {
    const waits = [];
    const { fetchImpl, calls } = mockFetch([
      apiError(529, 'overloaded_error', 'Overloaded'),
      apiError(500, 'api_error', 'oops'),
      apiError(503, 'api_error', 'oops')
    ]);
    await assert.rejects(run(fetchImpl, SETTINGS, { sleep: async (ms) => waits.push(ms) }), { code: 'overloaded' });
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [1000, 2000]);
  });

  test('network failures are retried', async () => {
    const { fetchImpl, calls } = mockFetch([new TypeError('Failed to fetch'), reply([verdictCall(VERDICT)], 'tool_use')]);
    const result = await run(fetchImpl);
    assert.equal(result.verdict.rating, 'strong_yes');
    assert.equal(calls.length, 2);
  });

  test('a 400 surfaces the API message', async () => {
    const { fetchImpl } = mockFetch([apiError(400, 'invalid_request_error', 'tools.0.type: unknown tool')]);
    await assert.rejects(run(fetchImpl), (err) => err.code === 'bad_request' && /unknown tool/.test(err.message));
  });

  test('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl, calls } = mockFetch([]);
    await assert.rejects(run(fetchImpl, SETTINGS, { signal: controller.signal }), { code: 'aborted' });
    assert.equal(calls.length, 0);
  });
});

describe('testApiKey', () => {
  test('checks the key against the free Models endpoint', async () => {
    const { fetchImpl, calls } = mockFetch([{ body: { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' } }]);
    const info = await testApiKey('sk-ant-test', 'claude-haiku-5-5', { fetchImpl, sleep: noSleep });
    assert.deepEqual(info, { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' });
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models/claude-haiku-5-5');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
  });

  test('requires a key', async () => {
    await assert.rejects(testApiKey('', 'claude-haiku-5-5'), { code: 'no_key' });
  });
});

test('urlKey ignores scheme, www, query and trailing slashes', () => {
  assert.equal(urlKey('https://www.BestBuy.com/site/x/1.p/?ref=a#b'), 'bestbuy.com/site/x/1.p');
  assert.equal(urlKey('http://bestbuy.com/site/x/1.p'), 'bestbuy.com/site/x/1.p');
  assert.equal(urlKey('not a url'), null);
});

describe('askFollowUp', () => {
  const previousResult = {
    verdict: { rating: 'yes', headline: 'Good price.', comparableOffers: [] },
    queries: ['GIGABYTE M27Q2 price'],
    sources: [{ title: 'Best Buy', url: 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p' }]
  };
  const ask = (fetchImpl, question = 'What would you buy instead?', extra = {}) =>
    askFollowUp(sampleDeal(), question, SETTINGS, { fetchImpl, fetchPage: blockedPage, sleep: noSleep, previousResult, ...extra });

  test('sends the verdict and chat as context, with the same tools, and returns the cited answer', async () => {
    const { fetchImpl, calls } = mockFetch([
      reply(
        [
          { type: 'text', text: 'Let me check current prices.' },
          ...searchBlocks('srv_1', 'MSI G274QPF price', [{ url: 'https://newegg.com/msi', title: 'Newegg MSI' }]),
          { type: 'text', text: 'The MSI G274QPF is ' },
          {
            type: 'text',
            text: '$149.99 at Newegg',
            citations: [{ type: 'web_search_result_location', url: 'https://newegg.com/msi', title: 'Newegg MSI', cited_text: '...' }]
          },
          { type: 'text', text: ', with similar specs.' }
        ],
        'end_turn',
        { input_tokens: 6000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } }
      )
    ]);
    const turns = [
      { role: 'user', text: 'Is the seller OK?' },
      { role: 'assistant', text: 'Yes, Amazon sells it directly.' }
    ];
    const out = await ask(fetchImpl, '  What would you buy instead?  ', { turns });

    assert.equal(out.answer.text, 'The MSI G274QPF is $149.99 at Newegg, with similar specs.');
    assert.deepEqual(out.answer.sources, [{ title: 'Newegg MSI', url: 'https://newegg.com/msi' }]);
    assert.equal(out.verdict, null);
    assert.deepEqual(out.queries, ['MSI G274QPF price']);
    assert.equal(out.usage.costUsd, 0.0108);

    const [{ body }] = calls;
    assert.deepEqual(body.tools.map((t) => t.name), ['web_search', 'submit_verdict']);
    assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(body.messages[0].content, /<your_verdict>\nRating: yes\. Good price\.\n[\s\S]*<\/your_verdict>/);
    assert.match(body.messages[0].content, /Question: Is the seller OK\?$/);
    assert.equal(body.messages[2].content, 'What would you buy instead?');
  });

  test('lets Claude finish its answer after a silent verdict revision', async () => {
    const revised = { ...VERDICT, rating: 'no', headline: 'Not for photo work.' };
    const { fetchImpl, calls } = mockFetch([
      reply([verdictCall(revised)], 'tool_use'),
      reply([{ type: 'text', text: 'For photo editing, get a calibrated monitor instead.' }])
    ]);
    const out = await ask(fetchImpl, 'I edit photos. Still worth it?');

    assert.equal(out.verdict.rating, 'no');
    assert.equal(out.answer.text, 'For photo editing, get a calibrated monitor instead.');
    assert.equal(calls.length, 2);
    const { messages } = calls[1].body;
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual(messages[2].content.map((b) => [b.type, b.tool_use_id]), [['tool_result', 'toolu_v']]);
    assert.equal(out.usage.requests, 2);
  });

  test('a revision with an explanation needs no extra request, and checks links against all sources', async () => {
    const { fetchImpl, calls } = mockFetch([
      reply([{ type: 'text', text: 'With EPP pricing this is a strong buy.' }, verdictCall({ ...VERDICT, rating: 'strong_yes' })], 'tool_use')
    ]);
    const out = await ask(fetchImpl, 'I have EPP pricing.');
    assert.equal(calls.length, 1);
    assert.equal(out.verdict.rating, 'strong_yes');
    // The Best Buy page was found in the original research, so the offer still gets its link.
    assert.equal(out.verdict.comparableOffers[0].url, 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p');
  });

  test('rejects empty questions without calling the API', async () => {
    const { fetchImpl, calls } = mockFetch([]);
    await assert.rejects(ask(fetchImpl, '   '), { code: 'no_question' });
    assert.equal(calls.length, 0);
  });

  test('reports an empty reply', async () => {
    const { fetchImpl } = mockFetch([reply([{ type: 'thinking', thinking: '', signature: 's' }])]);
    await assert.rejects(ask(fetchImpl), { code: 'no_answer' });
  });

  test('reports refusals', async () => {
    const { fetchImpl } = mockFetch([{ body: { ...reply([]).body, stop_reason: 'refusal', stop_details: { category: null } } }]);
    await assert.rejects(ask(fetchImpl), { code: 'refusal' });
  });
});
