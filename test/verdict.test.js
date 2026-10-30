import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATINGS,
  MATCHES,
  VERDICT_TOOL,
  normalizeVerdict,
  normalizeRating,
  extractJsonObject,
  parsePartialObject, revisionTool } from '../extension/src/background/verdict.js';
import { makeDom, plain } from './helpers.js';

const base = {
  specs: [],
  deal_price: 100,
  same_item_price: 110,
  lowest_price: 95,
  equivalent_price: 120,
  rating: 'yes',
  confidence: 'medium',
  headline: 'Good price.',
  offers: [],
  pros: [],
  cons: []
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

  test('asks for the prices before the rating, and the offers and reasons after it', () => {
    // The rating is measured against the prices; putting the long lists after
    // it gets the rating to the panel seconds sooner.
    const order = Object.keys(VERDICT_TOOL.input_schema.properties);
    assert.deepEqual(order, ['specs', 'seller', 'deal_price', 'same_item_price', 'lowest_price', 'equivalent_price', 'rating', 'confidence', 'headline', 'offers', 'savings', 'pros', 'cons']);
    assert.deepEqual(VERDICT_TOOL.input_schema.properties.offers.items.properties.match.enum, MATCHES);
  });

  test('asks for the URL behind each offer and saving, and no other URLs', () => {
    // Long text is what costs time, so these are the only URLs it writes;
    // resolveOffers then accepts only ones from the search results.
    const { offers, savings } = VERDICT_TOOL.input_schema.properties;
    assert.ok(offers.items.required.includes('url'));
    assert.ok(savings.items.required.includes('url'));
    assert.equal(JSON.stringify(VERDICT_TOOL).match(/"url":/g).length, 2);
  });

  test('the re-rating tool leaves out what the price check already settled', () => {
    const { input_schema: schema, name, strict } = revisionTool();
    assert.equal(name, VERDICT_TOOL.name);
    assert.equal(strict, true);
    for (const settled of ['offers', 'savings', 'seller']) {
      assert.ok(!(settled in schema.properties), settled);
      assert.ok(!schema.required.includes(settled), settled);
    }
    assert.ok(schema.required.includes('rating'));
    assert.ok('offers' in VERDICT_TOOL.input_schema.properties, "doesn't change the original");
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
      specs: ['i5-9500T (9th gen)', '8GB RAM'],
      offers: [
        { match: 'same_item', store: 'Best Buy', product: 'Same thing', price: 110, condition: 'new', diff: '' },
        { match: 'better', store: 'Dell', product: 'OptiPlex 7070', price: 130, condition: 'refurbished', diff: '256GB vs 120GB' }
      ],
      pros: ['Cheap'],
      cons: ['Old model']
    });
    assert.deepEqual(v, {
      rating: 'yes',
      confidence: 'medium',
      headline: 'Good price.',
      keySpecs: ['i5-9500T (9th gen)', '8GB RAM'],
      seller: null,
      dealPrice: 100,
      sameItemPrice: 110,
      lowestRecentPrice: 95,
      equivalentMarketPrice: 120,
      comparableOffers: [
        { store: 'Best Buy', product: 'Same thing', price: 110, citedUrl: null, url: null, verified: false, condition: 'new', match: 'same_item', specDifferences: '' },
        { store: 'Dell', product: 'OptiPlex 7070', price: 130, citedUrl: null, url: null, verified: false, condition: 'refurbished', match: 'better', specDifferences: '256GB vs 120GB' }
      ],
      savings: [],
      offersHidden: 0,
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
        equivalent_price: '$1,299.50',
        lowest_price: -5,
        offers: [
          { store: 'Evil', product: 'x', price: 1, url: 'javascript:alert(1)', match: 'identical', condition: '' },
          { store: '', product: 'nameless store is dropped' },
          'not an object'
        ],
        pros: ['a', '', 42, 'b', 'c', 'd', 'e'],
        cons: 'not a list'
      },
      { fallbackPrice: 77 }
    );
    assert.equal(v.confidence, 'low');
    assert.equal(v.headline, 'No summary provided.');
    assert.equal(v.dealPrice, 77);
    assert.equal(v.equivalentMarketPrice, 1299.5);
    assert.equal(v.sameItemPrice, null);
    assert.equal(v.lowestRecentPrice, null);
    assert.deepEqual(v.comparableOffers, [
      // Kept as what Claude said; only resolveOffers can turn it into a link.
      { store: 'Evil', product: 'x', price: 1, citedUrl: 'javascript:alert(1)', url: null, verified: false, condition: 'new', match: null, specDifferences: '' }
    ]);
    assert.deepEqual(v.reasonsFor, ['a', 'b', 'c', 'd']);
    assert.deepEqual(v.reasonsAgainst, []);
  });

  test('normalizes match labels and drops differences for the same item', () => {
    const v = normalizeVerdict({
      ...base,
      offers: [
        { store: 'A', product: 'p', price: 1, condition: 'new', match: 'Same Item', diff: 'ignored' },
        { store: 'B', product: 'p', price: 1, condition: 'new', match: 'WORSE', diff: ' older   CPU ' }
      ]
    });
    assert.deepEqual(
      v.comparableOffers.map((o) => [o.match, o.specDifferences]),
      [
        ['same_item', ''],
        ['worse', 'older CPU']
      ]
    );
  });

  test('in partial mode, tidies what has arrived without requiring a rating', () => {
    const v = normalizeVerdict({ specs: ['27in'], deal_price: 99 }, { partial: true });
    assert.equal(v.rating, null);
    assert.equal(v.confidence, null);
    assert.equal(v.headline, '');
    assert.deepEqual(v.keySpecs, ['27in']);
    assert.equal(v.dealPrice, 99);
    assert.deepEqual(v.comparableOffers, []);
  });

  test('truncates very long text', () => {
    const v = normalizeVerdict({ ...base, headline: 'x'.repeat(1000) });
    assert.equal(v.headline.length, 300);
    assert.ok(v.headline.endsWith('…'));
  });
});

describe('parsePartialObject', () => {
  test('reads the fields a streaming tool input has finished', () => {
    assert.deepEqual(parsePartialObject('{"specs": ["27in"], "deal_price": 99'), { specs: ['27in'], deal_price: 99 });
    assert.deepEqual(parsePartialObject('{"rating": "yes",'), { rating: 'yes' });
    assert.deepEqual(parsePartialObject('{"a": 1}'), { a: 1 });
  });

  test('returns null mid-field', () => {
    assert.equal(parsePartialObject('{"headline": "Fair pri'), null);
    assert.equal(parsePartialObject(''), null);
    assert.equal(parsePartialObject('[1, 2'), null);
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
