// The verdict Claude must return, and the checks applied before it reaches the page.

export const RATINGS = ['strong_no', 'no', 'maybe', 'yes', 'strong_yes'];
export const CONFIDENCE = ['low', 'medium', 'high'];

const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

// Claude answers through this tool rather than free text: `strict` guarantees
// the input matches the schema, which free-form JSON after web searches doesn't.
export const VERDICT_TOOL = {
  name: 'submit_verdict',
  description:
    'Submit your final assessment of the deal. Call this exactly once, after you have finished searching. ' +
    'Prices are in US dollars, including any required shipping.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'rating',
      'confidence',
      'headline',
      'deal_price',
      'typical_price',
      'lowest_recent_price',
      'comparable_offers',
      'reasons_for',
      'reasons_against'
    ],
    properties: {
      rating: { type: 'string', enum: RATINGS, description: 'Overall verdict on whether the deal is worth buying.' },
      confidence: {
        type: 'string',
        enum: CONFIDENCE,
        description: 'How solid the price evidence you found is.'
      },
      headline: { type: 'string', description: 'One short sentence explaining the verdict.' },
      deal_price: { type: 'number', description: 'The final price of the deal you evaluated.' },
      typical_price: {
        ...nullableNumber,
        description: 'Typical current price of the same product in the same condition at reputable US stores, or null if unknown.'
      },
      lowest_recent_price: {
        ...nullableNumber,
        description: 'Lowest credible recent price you found for the same product and condition, or null if unknown.'
      },
      comparable_offers: {
        type: 'array',
        description: 'Up to 6 offers you found: the same product elsewhere, or similar products that compete with it.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['store', 'product', 'price', 'url', 'same_product', 'condition'],
          properties: {
            store: { type: 'string' },
            product: { type: 'string' },
            price: nullableNumber,
            url: { ...nullableString, description: 'A URL from your search results, or null.' },
            same_product: { type: 'boolean', description: 'True if this is the exact same model.' },
            condition: { type: 'string', description: 'new, open box, refurbished, or used.' }
          }
        }
      },
      reasons_for: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short reasons to buy.' },
      reasons_against: { type: 'array', items: { type: 'string' }, description: 'Up to 4 short reasons to skip.' }
    }
  }
};

const MAX_TEXT = 300;
const MAX_REASONS = 4;
const MAX_OFFERS = 6;

function text(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function money(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[$,\s]/g, '')) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

export function normalizeRating(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return RATINGS.includes(key) ? key : null;
}

function httpUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Validates and tidies Claude's verdict. Throws if there is no usable rating,
 * since everything else in the panel hangs off it.
 */
export function normalizeVerdict(input, { fallbackPrice = null } = {}) {
  if (!input || typeof input !== 'object') throw new Error('Verdict is not an object');
  const rating = normalizeRating(input.rating);
  if (!rating) throw new Error(`Verdict has an unknown rating: ${JSON.stringify(input.rating)}`);

  const confidence = CONFIDENCE.includes(input.confidence) ? input.confidence : 'low';
  const offers = Array.isArray(input.comparable_offers) ? input.comparable_offers : [];

  return {
    rating,
    confidence,
    headline: text(input.headline) || 'No summary provided.',
    dealPrice: money(input.deal_price) ?? fallbackPrice,
    typicalPrice: money(input.typical_price),
    lowestRecentPrice: money(input.lowest_recent_price),
    comparableOffers: offers
      .filter((o) => o && typeof o === 'object' && text(o.store))
      .slice(0, MAX_OFFERS)
      .map((o) => ({
        store: text(o.store, 80),
        product: text(o.product, 160),
        price: money(o.price),
        url: httpUrl(o.url),
        sameProduct: o.same_product === true,
        condition: text(o.condition, 30) || 'new'
      })),
    reasonsFor: (Array.isArray(input.reasons_for) ? input.reasons_for : []).map((r) => text(r)).filter(Boolean).slice(0, MAX_REASONS),
    reasonsAgainst: (Array.isArray(input.reasons_against) ? input.reasons_against : [])
      .map((r) => text(r))
      .filter(Boolean)
      .slice(0, MAX_REASONS)
  };
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
