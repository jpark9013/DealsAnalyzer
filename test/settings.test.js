import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, loadSettings, saveSettings, DEFAULT_SETTINGS, MODELS } from '../extension/src/background/settings.js';
import { estimateCost } from '../extension/src/background/pricing.js';
import { getCached, putCached, pruneCache, CACHE_TTL_MS } from '../extension/src/background/cache.js';
import { memoryStorage } from './helpers.js';

describe('settings', () => {
  test('defaults to Haiku 5.5 with medium effort', () => {
    assert.deepEqual(sanitizeSettings(undefined), DEFAULT_SETTINGS);
    assert.equal(DEFAULT_SETTINGS.model, 'claude-haiku-5-5');
  });

  test('clamps and repairs bad values', () => {
    assert.deepEqual(
      sanitizeSettings({ apiKey: '  sk-ant-x \n', model: 'gpt-9', effort: 'max', maxSearches: '99', autoAnalyze: 'no' }),
      { apiKey: 'sk-ant-x', model: 'claude-haiku-5-5', effort: 'medium', maxSearches: 10, autoAnalyze: true }
    );
    assert.equal(sanitizeSettings({ maxSearches: 0 }).maxSearches, 1);
    assert.equal(sanitizeSettings({ maxSearches: 'abc' }).maxSearches, DEFAULT_SETTINGS.maxSearches);
    assert.equal(sanitizeSettings({ autoAnalyze: false }).autoAnalyze, false);
  });

  test('round-trips through storage', async () => {
    const storage = memoryStorage();
    const saved = await saveSettings(storage, { apiKey: 'k', model: 'claude-sonnet-5-5', maxSearches: 3 });
    assert.equal(saved.model, 'claude-sonnet-5-5');
    assert.deepEqual(await loadSettings(storage), saved);
  });

  test('every model has a web search tool and pricing', () => {
    for (const [id, info] of Object.entries(MODELS)) {
      assert.match(info.webSearchTool, /^web_search_\d{8}$/, id);
      assert.ok(info.pricing.input > 0 && info.pricing.output > 0, id);
    }
  });
});

describe('estimateCost', () => {
  test('adds token and search costs across requests', () => {
    const usage = estimateCost(
      [
        { input_tokens: 20_000, output_tokens: 1_000, server_tool_use: { web_search_requests: 2 } },
        { input_tokens: 30_000, output_tokens: 500, cache_read_input_tokens: 1_000, server_tool_use: { web_search_requests: 1 } }
      ],
      'claude-haiku-5-5'
    );
    // (51K * $0.10 + 1.5K * $0.50) / 1M + 3 * $0.01
    assert.deepEqual(usage, { inputTokens: 51_000, outputTokens: 1_500, webSearches: 3, requests: 2, costUsd: 0.0359 });
  });

  test("charges Haiku's long-prompt rate above 100K tokens", () => {
    const usage = estimateCost([{ input_tokens: 150_000, output_tokens: 2_000 }], 'claude-haiku-5-5');
    assert.equal(usage.costUsd, 0.08); // 150K * $0.50 + 2K * $2.50, per million
  });

  test('leaves cost unknown for models without a price', () => {
    assert.equal(estimateCost([{ input_tokens: 10, output_tokens: 10 }], 'mystery').costUsd, null);
  });
});

describe('verdict cache', () => {
  const result = { verdict: { rating: 'yes' } };

  test('returns fresh entries and ignores stale ones', async () => {
    const storage = memoryStorage();
    await putCached(storage, 'deal-1', 'claude-haiku-5-5', result, 1_000);
    assert.deepEqual(await getCached(storage, 'deal-1', 'claude-haiku-5-5', 1_000 + CACHE_TTL_MS - 1), result);
    assert.equal(await getCached(storage, 'deal-1', 'claude-haiku-5-5', 1_000 + CACHE_TTL_MS + 1), null);
  });

  test('keeps models separate', async () => {
    const storage = memoryStorage();
    await putCached(storage, 'deal-1', 'claude-haiku-5-5', result, 1_000);
    assert.equal(await getCached(storage, 'deal-1', 'claude-sonnet-5-5', 1_000), null);
  });

  test('prunes expired entries on write and can clear everything', async () => {
    const storage = memoryStorage({ settings: { apiKey: 'k' } });
    await putCached(storage, 'old', 'm', result, 0);
    await putCached(storage, 'new', 'm', result, CACHE_TTL_MS + 10);
    assert.deepEqual(Object.keys(storage.data).sort(), ['settings', 'verdict:m:new']);
    assert.equal(await pruneCache(storage, 0, { all: true }), 1);
    assert.deepEqual(Object.keys(storage.data), ['settings']);
  });
});
