// How far the verdict can be trusted, worked out from what the store pages
// confirmed rather than asked of Claude (which answered "medium" nearly every
// time, whatever it had found).

// Prices read from the store's page just now.
const LIVE = new Set(['confirmed', 'changed']);
// A price this far under the deal's counts as "cheaper elsewhere".
const BELOW = 0.98;
// How close a store page's price must be to a claimed price to back it up.
const NEAR = 0.05;
// The rubric's lines, as the share by which the benchmark is above the deal:
// strong_yes from 20%, yes from 10%, no at about the same money or less.
const RUBRIC_LINES = [0.2, 0.1, 0];
const CLOSE_TO_LINE = 0.03;
const CLEAR_OF_LINES = 0.08;

const RATING_STEPS = ['strong_no', 'no', 'maybe', 'yes', 'strong_yes'];

// strong_yes from 20% under the benchmark, yes from 10%, maybe around it, no
// when it costs more, strong_no when well above (20%+).
function impliedStep(under) {
  if (under >= 0.2) return 4;
  if (under >= 0.1) return 3;
  if (under >= -0.03) return 2;
  if (under > -0.2) return 1;
  return 0;
}

const isLive = (o) => LIVE.has(o.check) && typeof o.price === 'number';

function cheapestLive(offers, matches) {
  const prices = offers.filter((o) => isLive(o) && matches.includes(o.match)).map((o) => o.price);
  return prices.length ? Math.min(...prices) : null;
}

const SAME = ['same_item'];
// A product with better specs for less backs up "equivalent value is cheaper" too.
const EQUIVALENT = ['same_item', 'equivalent', 'better'];

/**
 * Whether the store pages back up the verdict's lower prices. Each of the
 * same-item and equivalent prices that's below the deal's is 'confirmed' when
 * a store page shows that price or less (within 5%), else 'unconfirmed'. It's
 * null when it isn't below the deal's price, so there's no "cheaper" to back up.
 */
export function priceSupport(verdict) {
  const deal = verdict.dealPrice;
  const offers = verdict.comparableOffers || [];
  const check = (claimed, matches) => {
    if (typeof claimed !== 'number' || typeof deal !== 'number' || claimed >= deal * BELOW) return null;
    const best = cheapestLive(offers, matches);
    return best !== null && best <= claimed * (1 + NEAR) ? 'confirmed' : 'unconfirmed';
  };
  return {
    sameItem: check(verdict.sameItemPrice, SAME),
    equivalent: check(verdict.equivalentMarketPrice, EQUIVALENT)
  };
}

/** The benchmark the rubric rates against, from the prices that held up. */
function benchmark(verdict, support) {
  const prices = [
    support.sameItem === 'unconfirmed' ? null : verdict.sameItemPrice,
    support.equivalent === 'unconfirmed' ? null : verdict.equivalentMarketPrice
  ].filter((p) => typeof p === 'number' && p > 0);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * Scores the evidence behind a verdict:
 *   +2  the same item's price confirmed on another store's page
 *   +1  an equivalent product's price confirmed (+2 for two or more)
 *   +1  the price is well clear of the rubric's lines (20%, 10%, 0% under the
 *       benchmark) and the rating is the one those prices point to
 *   -1  it's within 3 points of one, so a small price change flips the rating
 *   -2  the rating is two or more steps from what the prices point to
 *   -1  no store prices to compare, or most of them only from search results
 *   -2  a lower price it relies on wasn't confirmed by any store page
 *   -2  rated yes, but a store page shows equivalent value 5%+ cheaper
 *   -1  fewer than two searches, or the deal's own price wasn't read from the page
 * 3 or more is high, 1–2 medium, less is low. `reasons` lists what counted,
 * as codes the panel words: [{code, n?, sign}].
 */
export function assessConfidence(verdict, { searches = 0, dealPriceKnown = true } = {}) {
  const offers = verdict.comparableOffers || [];
  const support = priceSupport(verdict);
  const reasons = [];
  let score = 0;
  const add = (points, code, n) => {
    score += points;
    reasons.push({ code, sign: points > 0 ? 1 : -1, ...(n === undefined ? {} : { n }) });
  };

  const liveSame = offers.filter((o) => isLive(o) && o.match === 'same_item').length;
  const liveEquivalent = offers.filter((o) => isLive(o) && (o.match === 'equivalent' || o.match === 'better')).length;
  const unverified = offers.filter((o) => !isLive(o)).length;

  if (liveSame) add(2, 'same_confirmed', liveSame);
  if (liveEquivalent) add(liveEquivalent >= 2 ? 2 : 1, 'equivalent_confirmed', liveEquivalent);
  if (!offers.length) add(-1, 'no_offers');
  else if (unverified > offers.length - unverified) add(-1, 'mostly_unconfirmed', unverified);
  if (support.sameItem === 'unconfirmed' || support.equivalent === 'unconfirmed') add(-2, 'cheaper_unconfirmed');

  const deal = verdict.dealPrice;
  const cheapest = cheapestLive(offers, EQUIVALENT);
  if ((verdict.rating === 'yes' || verdict.rating === 'strong_yes') && cheapest !== null && typeof deal === 'number' && cheapest < deal * 0.95) {
    add(-2, 'cheaper_confirmed');
  }

  const bench = benchmark(verdict, support);
  if (bench !== null && typeof deal === 'number') {
    const under = (bench - deal) / bench;
    // The rating the prices alone point to. Two steps or more from Claude's
    // means it rests on something the prices don't show (a rival it didn't
    // list, the seller, reviews), which nothing here could check.
    const gap = verdict.rating ? Math.abs(RATING_STEPS.indexOf(verdict.rating) - impliedStep(under)) : 0;
    const distance = Math.min(...RUBRIC_LINES.map((line) => Math.abs(under - line)));
    if (gap >= 2) add(-2, 'rating_vs_prices');
    else if (distance < CLOSE_TO_LINE) add(-1, 'borderline');
    else if (distance >= CLEAR_OF_LINES && gap === 0) add(1, 'clear_margin');
  }

  if (searches < 2) add(-1, 'little_research', searches);
  if (!dealPriceKnown) add(-1, 'deal_price_guessed');

  const confidence = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low';
  return { confidence, confidenceScore: score, confidenceReasons: reasons, priceSupport: support };
}
