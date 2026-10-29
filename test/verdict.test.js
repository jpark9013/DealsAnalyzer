import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATINGS,
  VERDICT_TOOL,
  normalizeVerdict,
  normalizeRating,
  extractJsonObject
} from '../extension/src/background/verdict.js';
import { makeDom, plain } from './helpers.js';

const base = {
  rating: 'yes',
  confidence: 'medium',
  headline: 'Good price.',
  deal_price: 100,
  typical_price: 120,
  lowest_recent_price: 95,
  comparable_offers: [],
  reasons_for: [],
  reasons_against: []
};

describe('VERDICT_TOOL schema', () => {
  // Strict tool use requires every object to list all its properties as
  // required and to forbid extra properties.
  function checkStrictObjects(schema, path = 'input_schema') {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties: false`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path} required list`);
      for (const [key, value] of Object.entries(schema.properties)) checkStrictObjects(value, `${path}.${key}`);
    }
    if (schema.items) checkStrictObjects(schema.items, `${path}[]`);
    for (const option of schema.anyOf || []) checkStrictObjects(option, path);
  }

  test('is strict-mode compatible', () => {
    assert.equal(VERDICT_TOOL.strict, true);
    checkStrictObjects(VERDICT_TOOL.input_schema);
  });

  test('uses no JSON Schema keywords that structured outputs reject', () => {
    const banned = ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'minItems', 'maxItems'];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const key of banned) assert.ok(!(key in node), `schema uses unsupported "${key}"`);
      Object.values(node).forEach(walk);
    };
    walk(VERDICT_TOOL.input_schema);
  });

  test('offers exactly the five ratings, in order', () => {
    assert.deepEqual(RATINGS, ['strong_no', 'no', 'maybe', 'yes', 'strong_yes']);
    assert.deepEqual(VERDICT_TOOL.input_schema.properties.rating.enum, RATINGS);
  });

  test('matches the ratings the panel knows how to display', () => {
    const dom = makeDom('<!doctype html><html></html>', { scripts: ['extension/src/content/panel.js'] });
    assert.deepEqual(Object.keys(plain(dom.window.DealsAnalyzer.RATING_LABELS)), RATINGS);
    dom.window.close();
  });
});

describe('normalizeVerdict', () => {
  test('maps API fields to camelCase and keeps valid values', () => {
    const v = normalizeVerdict({
      ...base,
      comparable_offers: [
        { store: 'Best Buy', product: 'Same thing', price: 110, url: 'https://bestbuy.com/x', same_product: true, condition: 'new' }
      ],
      reasons_for: ['Cheap'],
      reasons_against: ['Old model']
    });
    assert.deepEqual(v, {
      rating: 'yes',
      confidence: 'medium',
      headline: 'Good price.',
      dealPrice: 100,
      typicalPrice: 120,
      lowestRecentPrice: 95,
      comparableOffers: [
        { store: 'Best Buy', product: 'Same thing', price: 110, url: 'https://bestbuy.com/x', sameProduct: true, condition: 'new' }
      ],
      reasonsFor: ['Cheap'],
      reasonsAgainst: ['Old model']
    });
  });

  test('accepts loosely written ratings', () => {
    assert.equal(normalizeRating('Strong Yes'), 'strong_yes');
    assert.equal(normalizeRating('strong-no'), 'strong_no');
    assert.equal(normalizeRating(' MAYBE '), 'maybe');
    assert.equal(normalizeRating('great'), null);
    assert.equal(normalizeRating(undefined), null);
  });

  test('throws without a usable rating', () => {
    assert.throws(() => normalizeVerdict({ ...base, rating: 'great' }), /unknown rating/);
    assert.throws(() => normalizeVerdict(null), /not an object/);
  });

  test('cleans up bad values instead of trusting them', () => {
    const v = normalizeVerdict(
      {
        rating: 'no',
        confidence: 'very high',
        headline: '   ',
        deal_price: 'n/a',
        typical_price: '$1,299.50',
        lowest_recent_price: -5,
        comparable_offers: [
          { store: 'Evil', product: 'x', price: 1, url: 'javascript:alert(1)', same_product: 'yes', condition: '' },
          { store: '', product: 'nameless store is dropped' },
          'not an object'
        ],
        reasons_for: ['a', '', 42, 'b', 'c', 'd', 'e'],
        reasons_against: 'not a list'
      },
      { fallbackPrice: 77 }
    );
    assert.equal(v.confidence, 'low');
    assert.equal(v.headline, 'No summary provided.');
    assert.equal(v.dealPrice, 77);
    assert.equal(v.typicalPrice, 1299.5);
    assert.equal(v.lowestRecentPrice, null);
    assert.deepEqual(v.comparableOffers, [
      { store: 'Evil', product: 'x', price: 1, url: null, sameProduct: false, condition: 'new' }
    ]);
    assert.deepEqual(v.reasonsFor, ['a', 'b', 'c', 'd']);
    assert.deepEqual(v.reasonsAgainst, []);
  });

  test('truncates very long text', () => {
    const v = normalizeVerdict({ ...base, headline: 'x'.repeat(1000) });
    assert.equal(v.headline.length, 300);
    assert.ok(v.headline.endsWith('…'));
  });
});

describe('extractJsonObject', () => {
  test('finds JSON in fenced blocks and in prose', () => {
    assert.deepEqual(extractJsonObject('```json\n{"rating":"yes"}\n```'), { rating: 'yes' });
    assert.deepEqual(extractJsonObject('Verdict: {"rating":"no","x":{"y":1}} done'), { rating: 'no', x: { y: 1 } });
  });

  test('returns null for anything else', () => {
    assert.equal(extractJsonObject('no json here'), null);
    assert.equal(extractJsonObject('{broken'), null);
    assert.equal(extractJsonObject('[1,2]'), null);
    assert.equal(extractJsonObject(undefined), null);
  });
});
