// The verdict Claude must return, and the checks applied before it reaches the page.

export const RATINGS = ['strong_no', 'no', 'maybe', 'yes', 'strong_yes'];
export const CONFIDENCE = ['low', 'medium', 'high'];
// How a comparable offer's specs and build quality compare with the deal's product.
export const MATCHES = ['same_item', 'equivalent', 'better', 'worse'];

const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const strings = (description) => ({ type: 'array', items: { type: 'string' }, description });

// Claude answers through this tool rather than free text: `strict` guarantees
// the input matches the schema, which free-form JSON after web searches doesn't.
// Every output token costs time (Haiku writes ~300 a second), so keys are short
// and text is capped in words. Offers and savings carry the URL of the search
// result they came from: matching by name left most offers without a link, and
// resolveOffers in claude.js accepts only URLs Claude actually saw.
// The prices come before the rating, which is measured against them; the
// offers and reasons follow, so the rating reaches the panel early.
export const VERDICT_TOOL = {
  name: 'submit_verdict',
  description: 'Submit your assessment once you have finished searching. Prices are USD including required shipping.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['specs', 'seller', 'deal_price', 'same_item_price', 'lowest_price', 'equivalent_price', 'rating', 'confidence', 'headline', 'offers', 'savings', 'pros', 'cons'],
    properties: {
      specs: strings('2–6 specs that set its value, a few words each, e.g. "i5-9500T (9th gen)", "120GB SSD".'),
      seller: { type: 'string', description: 'The store that sells this deal; on a deal site, the store it sends buyers to.' },
      deal_price: { type: 'number' },
      same_item_price: { ...nullableNumber, description: 'Typical price of this exact model and configuration, same condition, at reputable US stores.' },
      lowest_price: { ...nullableNumber, description: 'Lowest credible recent price for this exact model and configuration, same condition.' },
      equivalent_price: { ...nullableNumber, description: 'Typical price of products with matching key specs and build, same condition.' },
      rating: { type: 'string', enum: RATINGS },
      confidence: { type: 'string', enum: CONFIDENCE, description: 'How solid the price evidence is.' },
      headline: { type: 'string', description: 'Why, under 20 words.' },
      offers: {
        type: 'array',
        description: "Up to 6 offers you saw on the store's own product page, mostly other models.",
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['match', 'store', 'url', 'product', 'price', 'condition', 'diff'],
          properties: {
            match: {
              type: 'string',
              enum: MATCHES,
              description: 'equivalent: other model, matching key specs and build. A different configuration of the same model is better or worse.'
            },
            store: { type: 'string' },
            url: { type: 'string', description: "That product page's URL, copied exactly from the search result." },
            product: { type: 'string', description: 'Brand and model number.' },
            price: { ...nullableNumber, description: 'Price shown on that page, before shipping and tax.' },
            condition: { type: 'string' },
            diff: { type: 'string', description: 'Spec differences, under 10 words; empty for same_item.' }
          }
        }
      },
      savings: {
        type: 'array',
        description: 'Up to 4 ways to pay less for this item that a search result states. Empty if none.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'url'],
          properties: {
            text: { type: 'string', description: 'Store, code or program, who qualifies, under 15 words.' },
            url: { type: 'string', description: 'The URL of that search result.' }
          }
        }
      },
      pros: strings('1–4 reasons to buy, under 15 words each.'),
      cons: strings('1–4 reasons to skip, under 15 words each.')
    }
  }
};

/** The verdict tool for re-rating with live prices: the offers and savings are already settled. */
export function revisionTool() {
  const properties = { ...VERDICT_TOOL.input_schema.properties };
  for (const settled of ['offers', 'savings', 'seller']) delete properties[settled];
  return {
    ...VERDICT_TOOL,
    input_schema: { ...VERDICT_TOOL.input_schema, required: Object.keys(properties), properties }
  };
}

const MAX_TEXT = 300;
const MAX_REASONS = 4;
const MAX_SPECS = 6;
const MAX_OFFERS = 6;
const MAX_SAVINGS = 4;

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function money(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

function enumKey(value, allowed) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return allowed.includes(key) ? key : null;
}

export function normalizeRating(value) {
  return enumKey(value, RATINGS);
}

function textList(value, max, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map((item) => text(item, maxLength))
    .filter(Boolean)
    .slice(0, max);
}

/**
 * Validates and tidies Claude's verdict. Throws if there is no usable rating,
 * since everything else in the panel hangs off it, unless `partial` is set:
 * then it tidies whatever part of the verdict has streamed in so far.
 */
export function normalizeVerdict(input, { fallbackPrice = null, partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Verdict is not an object');
  const rating = normalizeRating(input.rating);
  if (!rating && !partial) throw new Error(`Verdict has an unknown rating: ${JSON.stringify(input.rating)}`);

  const confidence = CONFIDENCE.includes(input.confidence) ? input.confidence : partial ? null : 'low';
  const offers = Array.isArray(input.offers) ? input.offers : [];

  return {
    rating,
    confidence,
    headline: text(input.headline) || (partial ? '' : 'No summary provided.'),
    keySpecs: textList(input.specs, MAX_SPECS, 80),
    seller: text(input.seller, 80) || null,
    dealPrice: money(input.deal_price) ?? fallbackPrice,
    sameItemPrice: money(input.same_item_price),
    lowestRecentPrice: money(input.lowest_price),
    equivalentMarketPrice: money(input.equivalent_price),
    comparableOffers: offers
      .filter((o) => o && typeof o === 'object' && text(o.store))
      .slice(0, MAX_OFFERS)
      .map((o) => {
        const match = enumKey(o.match, MATCHES);
        return {
          store: text(o.store, 80),
          product: text(o.product, 160),
          price: money(o.price),
          // What Claude cited. `url` is only set once resolveOffers() finds it in the search results.
          citedUrl: text(o.url, 2000) || null,
          url: null,
          verified: false,
          condition: text(o.condition, 30) || 'new',
          // null when Claude didn't say; the panel shows that as "similar".
          match,
          specDifferences: match === 'same_item' ? '' : text(o.diff, 200)
        };
      }),
    savings: (Array.isArray(input.savings) ? input.savings : [])
      .filter((s) => s && typeof s === 'object' && text(s.text))
      .slice(0, MAX_SAVINGS)
      .map((s) => ({ text: text(s.text, 160), citedUrl: text(s.url, 2000) || null, url: null })),
    // Offers left out because they had no store page or couldn't be bought.
    offersHidden: 0,
    reasonsFor: textList(input.pros, MAX_REASONS),
    reasonsAgainst: textList(input.cons, MAX_REASONS)
  };
}

/**
 * Reads a strict tool's input as it streams in. The API sends each top-level
 * field whole, so the JSON so far usually ends on a field boundary; closing
 * the object there gives every finished field. Returns null otherwise.
 */
export function parsePartialObject(json) {
  const body = String(json || '').trim().replace(/,\s*$/, '');
  if (!body.startsWith('{')) return null;
  for (const candidate of [body, `${body}}`]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // not at a field boundary yet
    }
  }
  return null;
}

/** Last-resort parse when Claude writes the verdict as JSON text instead of calling the tool. */
export function extractJsonObject(raw) {
  if (typeof raw !== 'string') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
