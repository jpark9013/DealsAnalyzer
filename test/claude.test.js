import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDeal, testApiKey, AnalysisError, API_VERSION, urlKey } from '../extension/src/background/claude.js';
import { sanitizeSettings } from '../extension/src/background/settings.js';
import { sampleDeal } from './helpers.js';

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
  rating: 'strong_yes',
  confidence: 'high',
  headline: 'Lowest price seen for this monitor; usually $199+.',
  deal_price: 159.99,
  typical_price: 219.99,
  lowest_recent_price: 159.99,
  comparable_offers: [
    {
      store: 'Best Buy',
      product: 'GIGABYTE M27Q2',
      price: 199.99,
      url: 'https://www.bestbuy.com/site/gigabyte-m27q2/123.p',
      same_product: true,
      condition: 'new'
    },
    {
      store: 'Newegg',
      product: 'MSI MAG 275QF',
      price: 179.99,
      url: 'https://www.newegg.com/made-up-link',
      same_product: false,
      condition: 'new'
    }
  ],
  reasons_for: ['Matches the all-time low'],
  reasons_against: ['Older panel generation']
};

const run = (fetchImpl, settings = SETTINGS, extra = {}) =>
  analyzeDeal(sampleDeal(), settings, { fetchImpl, sleep: noSleep, now: new Date(2026, 9, 29), ...extra });

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

    assert.match(body.system, /Today's date is 2026-10-29/);
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
    assert.equal(result.verdict.typicalPrice, 219.99);
    assert.equal(result.model, 'claude-haiku-5-5');
    assert.deepEqual(result.queries, ['GIGABYTE M27Q2 price']);
    assert.equal(result.sources.length, 2);
    // Only links that appeared in the search results count as verified.
    const [bestBuy, newegg] = result.verdict.comparableOffers;
    assert.equal(bestBuy.verified, true);
    assert.equal(newegg.verified, false);
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
