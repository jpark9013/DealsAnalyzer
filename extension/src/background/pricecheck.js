// Reads compared offers' store pages from the browser, so the panel shows what
// the store says now rather than what a search result said at some point.
//
// A plain fetch reads most stores. Some (eBay) answer it with a bot check but
// load normally as a page, so those can be opened in a background tab. Nothing
// here disguises the request or solves a challenge: a store that refuses both
// stays "unverified".
//
// Runs in the service worker, which has no DOM, so pages are read with regular
// expressions. A wrong price is worse than an unconfirmed one, so every reader
// prefers no answer to a doubtful one (pages list related products with their
// own prices). Only numbers from these pages reach Claude, never their text.

const TIMEOUT_MS = 7000;
const MAX_TAB_CHECKS = 3;
const TAB_POLL_MS = 1500;
// eBay's check clears in about 3 seconds; rendered prices take a little longer.
const TAB_POLLS = 5;
// A quote this far from the page price means the page was misread, not that the price moved.
const MAX_RATIO = 3;
// Differences this small are rounding or a missed cent, not a price change.
const SAME_PRICE_PCT = 0.01;
const SAME_PRICE_USD = 1;

const BLOCKED_STATUS = new Set([401, 403, 405, 429, 503]);
const BLOCKED_TITLE = /robot or human|just a moment|attention required|access denied|captcha|pardon our interruption|verify you are (a )?human|are you a human/i;
const GONE_TITLE = /(page|product|item) (was )?not found|no longer available|^\s*404\b/i;
const OUT_OF_STOCK = /outofstock|soldout|discontinued/i;
// Pages that still show a price for something that can't be bought: ended
// marketplace listings, delisted products. Specific phrases only, read from the
// page's visible text (its scripts carry every message the site might show).
const ENDED_TEXT =
  /this listing (?:was|has) ended|this listing (?:sold|ended) on|bidding (?:has )?ended|the seller ended this listing|(?:item|product) is no longer available|no longer (?:sold|carried) (?:here|by)|this item is (?:currently )?unavailable|this product has been discontinued/i;
// The buy box saying so, when the page publishes no availability of its own.
const STOCK_TEXT = /\b(?:sold out|out of stock|currently unavailable|no longer available|not available (?:online|for (?:shipping|delivery)))\b/i;
// The text right after the product's heading: its buy box, before related products.
const BUY_BOX_CHARS = 1200;

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** What a shopper would read on the page: no scripts, styles or tags. */
function visibleText(html) {
  return decode(
    String(html || '')
      .replace(/<(script|style|template|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function buyBoxText(html, chars = BUY_BOX_CHARS) {
  const start = html.search(/<h1[\s>]/i);
  return start === -1 ? '' : visibleText(html.slice(start, start + 40_000)).slice(0, chars);
}

// Around the product's heading, where stores say a listing ended; not the
// reviews further down ("the product is no longer available at Costco, so...").
function headingText(html) {
  const start = html.search(/<h1[\s>]/i);
  if (start === -1) return visibleText(html.slice(0, 300_000)).slice(0, 6000);
  return `${visibleText(html.slice(Math.max(0, start - 60_000), start)).slice(-3000)} ${buyBoxText(html, 3000)}`;
}

// Words of a product's name worth matching on, when it has no model number:
// "Samsung Odyssey G5 27in" -> ["samsung", "odyssey"].
const FILLER = new Set(['with', 'and', 'for', 'the', 'inch', 'new', 'black', 'white', 'gaming', 'monitor', 'laptop', 'edition', 'renewed', 'refurbished', 'pack']);
export function nameWords(product) {
  return [...new Set((String(product || '').toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !FILLER.has(w)))];
}

// schema.org/RefurbishedCondition -> "refurbished"; null when not stated.
function conditionOf(value) {
  const name = String(value || '').split('/').pop().toLowerCase();
  if (!name) return null;
  if (name.startsWith('new')) return 'new';
  if (/refurb|renew/.test(name)) return 'refurbished';
  if (/used|damaged/.test(name)) return 'used';
  return null;
}

const asCondition = (text) => {
  const t = String(text || '').toLowerCase();
  if (/open[\s-]?box/.test(t)) return 'open box';
  if (/refurb|renewed|reconditioned/.test(t)) return 'refurbished';
  if (/\bused\b|pre-owned/.test(t)) return 'used';
  return 'new';
};

// Tokens that pin down a model ("M27Q2", "H27T22C-3", "100QD6QF"), not units
// like "27in" or "256GB", or CPUs like "i5-9500T", which many models share.
const UNIT_RE = /^\d+(?:\.\d+)?(?:in|hz|p|k|gb|tb|mb|w|mah|mm|ms|nits?)$/;
const CPU_RE = /^i[3579]-?\d{4,5}[a-z]{0,3}$|^\d{4,5}[a-z]{0,2}$/;

export function modelTokens(product) {
  return (String(product || '').toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [])
    .filter((t) => t.length >= 4 && /\d/.test(t) && /[a-z]/.test(t) && !UNIT_RE.test(t) && !CPU_RE.test(t))
    .map(squash);
}

function toPrice(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function decode(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- schema.org JSON-LD -------------------------------------------------

function findProducts(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => findProducts(n, out));
  else if (node && typeof node === 'object') {
    const types = [].concat(node['@type'] || []);
    if (types.includes('Product') || types.includes('ProductGroup')) out.push(node);
    else Object.values(node).forEach((v) => findProducts(v, out));
  }
  return out;
}

function offersOf(product) {
  const offers = [...[].concat(product.offers || [])];
  for (const variant of [].concat(product.hasVariant || [])) offers.push(...[].concat(variant.offers || []));
  return offers.filter((o) => o && typeof o === 'object');
}

const offerPrice = (o) => toPrice(o.price ?? o.lowPrice);

function fromJsonLd(html, tokens) {
  const products = [];
  for (const [, body] of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      findProducts(JSON.parse(body), products);
    } catch {
      // Some sites ship invalid JSON-LD; skip it.
    }
  }
  const priced = products.filter((p) => offersOf(p).some((o) => offerPrice(o) !== null));
  const names = (p) => squash(`${p.name} ${p.mpn} ${p.sku} ${p.model?.name || p.model}`);
  // With several products on the page, only the one naming the model will do.
  const product = priced.find((p) => tokens.some((t) => names(p).includes(t))) || (priced.length === 1 ? priced[0] : null);
  if (!product) return null;
  const offers = offersOf(product).filter((o) => offerPrice(o) !== null);
  const offer = offers[0];
  if (offer.priceCurrency && offer.priceCurrency !== 'USD') return { foreign: true };
  // An AggregateOffer's low price is the cheapest of many sellers and
  // conditions (often used), and a product group's prices are its sizes and
  // colors: either can confirm a quoted price, but not replace it.
  const aggregate = [].concat(offer['@type'] || []).includes('AggregateOffer') && Number(offer.offerCount) !== 1 && toPrice(offer.highPrice) !== toPrice(offer.lowPrice);
  const prices = [...new Set(offers.map(offerPrice))];
  const availability = String(offer.availability || '');
  return {
    price: offerPrice(offer),
    prices,
    loose: aggregate || prices.length > 1 || undefined,
    confirmOnly: aggregate || undefined,
    inStock: !OUT_OF_STOCK.test(availability),
    stockKnown: Boolean(availability),
    condition: conditionOf(offer.itemCondition || product.itemCondition),
    names: `${product.name} ${product.mpn} ${product.sku}`
  };
}

// --- Meta tags and microdata --------------------------------------------

function metaContent(html, name) {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (new RegExp(`(?:property|name)=["']${name}["']`, 'i').test(tag)) {
      const content = tag.match(/content=["']([^"']*)["']/i);
      if (content) return decode(content[1]);
    }
  }
  return null;
}

function fromMeta(html) {
  const currency = metaContent(html, 'product:price:currency') || metaContent(html, 'og:price:currency');
  if (currency && currency !== 'USD') return { foreign: true };
  const price = toPrice(metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount'));
  if (price === null) return null;
  const availability = metaContent(html, 'product:availability') || '';
  return {
    price,
    inStock: !/^(oos|out.?of.?stock|sold.?out)$/i.test(availability),
    stockKnown: Boolean(availability),
    condition: metaContent(html, 'product:condition') ? asCondition(metaContent(html, 'product:condition')) : null
  };
}

function fromMicrodata(html) {
  const prices = new Set();
  for (const [tag, text] of html.matchAll(/<[a-z]+\b[^>]*itemprop=["']price["'][^>]*>([^<]*)/gi)) {
    const price = toPrice((tag.match(/content=["']([^"']*)["']/i) || [])[1] ?? text);
    if (price !== null) prices.add(price);
  }
  // More than one price means a list of products, not one product.
  return prices.size === 1 ? { price: [...prices][0], inStock: true } : null;
}

// --- Stores that publish no product data --------------------------------

// The first "price to pay" is the buy box's. Reading the price block more
// loosely finds the struck-out list price, or another seller's tier.
function fromAmazon(html) {
  const stock = html.indexOf('id="availability"');
  const inStock = stock === -1 || !/currently unavailable|out of stock/i.test(html.slice(stock, stock + 600));
  const start = html.search(/class="[^"]*(?:apex-pricetopay-value|\bpriceToPay\b)[^"]*"/);
  const match = start === -1 ? null : html.slice(start, start + 600).match(/a-offscreen">\$([0-9,.]+)</);
  const price = match ? toPrice(match[1]) : null;
  return price === null && inStock ? null : { price, inStock, stockKnown: stock !== -1 };
}

// Newegg's page data lists related products too, so it's read from the entry
// for the item in the address: N82E16824012109 is "24-012-109".
function fromNewegg(html, url) {
  const id = (url.match(/\/p\/([A-Za-z0-9-]+)/) || [])[1];
  if (!id) return null;
  const parts = id.match(/^N82E168(\d{2})(\d{3})(\d{3})$/);
  const item = parts ? `${parts[1]}-${parts[2]}-${parts[3]}` : id;
  const start = html.indexOf(`"ItemNumber":"${item}"`);
  if (start === -1) return null;
  const entry = html.slice(start, start + 6000);
  const price = toPrice((entry.match(/"FinalPrice":([0-9.]+)/) || [])[1]);
  if (price === null) return null;
  const stock = entry.match(/"Instock":(true|false)/);
  return { price, inStock: !stock || stock[1] === 'true', stockKnown: Boolean(stock) };
}

const STORE_READERS = [
  { site: /(^|\.)amazon\.com$/, read: fromAmazon },
  { site: /(^|\.)newegg\.com$/, read: fromNewegg }
];

/**
 * What a store's page says about a product.
 * @param {string} html
 * @param {{url?: string, status?: number, tokens?: string[], words?: string[], pagePrice?: number|null, pageAvailability?: string|null}} [options]
 *   `tokens` are the product's model numbers, `words` its name's words for when
 *   it has none; `pagePrice` and `pageAvailability` come from the rendered page,
 *   for when its data has none
 * @returns {{state: 'read'|'blocked'|'gone'|'foreign'|'wrong_product'|'unreadable', price?: number|null, prices?: number[], inStock?: boolean, condition?: string|null, loose?: boolean, confirmOnly?: boolean}}
 *   `loose` marks a price that can confirm a quoted one but not replace it (a
 *   guess from the rendered page, or one of several); `confirmOnly` one that
 *   can't even confirm a different listing's (a marketplace's lowest offer)
 */
export function readStorePage(html, { url = '', status = 200, tokens = [], words = [], pagePrice = null, pageAvailability = null } = {}) {
  if (status === 404 || status === 410) return { state: 'gone' };
  if (BLOCKED_STATUS.has(status)) return { state: 'blocked' };
  const title = decode((html.match(/<title[^>]*>([^<]*)/i) || [])[1]);
  if (BLOCKED_TITLE.test(title)) return { state: 'blocked' };
  if (GONE_TITLE.test(title)) return { state: 'gone' };

  let host = '';
  let path = '';
  try {
    ({ hostname: host, pathname: path } = new URL(url));
  } catch {
    // no address given; only the generic readers apply
  }
  // Removed products often redirect to the home page.
  if (path === '/' && url) return { state: 'gone' };
  // Or redirect to another country's store.
  if (url && foreignStore(url)) return { state: 'foreign' };
  if (ENDED_TEXT.test(headingText(html))) return { state: 'gone' };

  const reader = STORE_READERS.find((r) => r.site.test(host));
  const found =
    (reader && reader.read(html, url)) ||
    fromJsonLd(html, tokens) ||
    fromMeta(html) ||
    fromMicrodata(html) ||
    (pagePrice !== null ? { price: pagePrice, inStock: true, loose: true } : null);

  // Nothing that reads as a product: a half-loaded page or an unfamiliar bot
  // check, neither of which says the offer is wrong.
  if (!found) return { state: 'unreadable' };
  if (found.foreign) return { state: 'foreign' };

  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  if (tokens.length) {
    const named = squash(`${title} ${h1} ${found.names} ${metaContent(html, 'og:title')} ${path}`);
    if (!tokens.some((t) => named.includes(t))) {
      // Not in the page's name: a page about this model still repeats it in its specs.
      const page = squash(html);
      if (!tokens.some((t) => page.split(t).length > 3)) return { state: 'wrong_product' };
    }
  } else if (words.length >= 2) {
    // No model number to go by: most of the name's words must be in the page's name.
    const named = `${title} ${visibleText(h1 || '')} ${found.names || ''} ${metaContent(html, 'og:title') || ''} ${path}`.toLowerCase();
    if (words.filter((w) => named.includes(w)).length < Math.ceil(words.length * 0.6)) return { state: 'wrong_product' };
  }

  let inStock = found.inStock;
  if (inStock && !found.stockKnown && (STOCK_TEXT.test(buyBoxText(html)) || STOCK_TEXT.test(pageAvailability || ''))) inStock = false;
  return {
    state: 'read',
    price: found.price,
    inStock,
    ...(found.prices?.length > 1 ? { prices: found.prices } : {}),
    ...(found.condition ? { condition: found.condition } : {}),
    ...(found.loose ? { loose: true } : {}),
    ...(found.confirmOnly ? { confirmOnly: true } : {})
  };
}

// Another country's storefront: prices in another currency, often not shipped
// to the US. Country domains (bestbuy.ca, amazon.co.uk) and locale paths (/en-ca/).
const US_FRIENDLY_TLDS = new Set(['us', 'co', 'io', 'ai', 'tv', 'me', 'gg', 'ly', 'fm', 'to', 'app', 'shop', 'store']);
export function foreignStore(href) {
  try {
    const { hostname, pathname } = new URL(href);
    const labels = hostname.toLowerCase().split('.');
    const tld = labels[labels.length - 1];
    if (tld.length === 2 && !US_FRIENDLY_TLDS.has(tld)) return true;
    // amazon.com.au, ebay.com.mx: a country under .com
    if (labels.length >= 3 && labels[labels.length - 2] === 'com' && tld.length === 2) return true;
    return /^\/(?:[a-z]{2}[-_](?!us\b)[a-z]{2}|ca|uk|au|de|fr|mx|in|jp)(?:\/|$)/i.test(pathname);
  } catch {
    return false;
  }
}

// A fetch can come back as a block page, or as a page whose price is only
// added by its scripts.
const needsTab = (page) => page.state === 'blocked' || page.state === 'unreadable';

// Tabs opened only to read a price. The content scripts run in them like any
// other page, and must not start an analysis there: that would cost money and
// open more tabs. Visibility can't be relied on to prevent it.
const helperTabs = new Set();
export const isHelperTab = (tabId) => helperTabs.has(tabId);

/** Opens a page in an inactive, muted tab and reads it once loaded, with the content scripts' reader as a backstop. */
export function tabReader(ext, { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  return async (url, tokens, words = []) => {
    // Blank first, so the tab is known to be a helper before its page can ask.
    const tab = await ext.tabs.create({ url: 'about:blank', active: false });
    helperTabs.add(tab.id);
    let page = { state: 'blocked' };
    try {
      await ext.tabs.update(tab.id, { url, muted: true });
      for (let i = 0; i < TAB_POLLS && needsTab(page); i++) {
        await sleep(TAB_POLL_MS);
        try {
          const [probe] = await ext.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({
              ready: document.readyState === 'complete',
              html: document.documentElement.outerHTML,
              url: location.href,
              page: (() => {
                const deal = globalThis.DealsAnalyzer?.extractPageDeal?.(document, { url: location.href });
                return { price: deal?.finalPrice ?? null, availability: deal?.availability ?? null };
              })()
            })
          });
          if (probe?.result?.ready) {
            const { html, url: at, page: rendered } = probe.result;
            page = readStorePage(html, { url: at, tokens, words, pagePrice: rendered?.price ?? null, pageAvailability: rendered?.availability ?? null });
          }
        } catch {
          // Mid-navigation, or on an error page: a bot check redirects, so look again.
        }
      }
    } finally {
      helperTabs.delete(tab.id);
      await ext.tabs.remove(tab.id).catch(() => {});
    }
    return page;
  };
}

const productWords = (offer) => (modelTokens(offer.product).length ? [] : nameWords(offer.product));

async function readOffer(offer, { fetchPage, signal }) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    // Without cookies: this isn't the shopper visiting, so it stays out of
    // their account's history and recommendations.
    const res = await fetchPage(offer.url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    return readStorePage(await res.text(), {
      url: res.url || offer.url,
      status: res.status,
      tokens: modelTokens(offer.product),
      words: productWords(offer)
    });
  } catch {
    return { state: 'blocked' };
  }
}

/**
 * Starts reading offers' pages before the verdict is finished, so the price
 * check is under way while Claude writes the rest. `reads` keeps each page's
 * promise by URL for checkOffers() to pick up.
 */
export function prefetchOffers(offers, reads, { fetchPage, signal } = {}) {
  const get = fetchPage || globalThis.fetch.bind(globalThis);
  for (const offer of offers) {
    if (offer.url && !reads.has(offer.url)) reads.set(offer.url, readOffer(offer, { fetchPage: get, signal }));
  }
}

const isNew = (condition) => asCondition(condition) === 'new';

/**
 * Checks each linked offer against its store page, in parallel. Offers whose
 * page is gone, in another country, sold out, in a different condition or
 * about another product are removed; the rest come back with `check` set:
 * 'confirmed' (the page shows this price), 'changed' (`price` is the page's,
 * `quotedPrice` what the search result said), or 'unverified' (the store
 * didn't let us read it, or we couldn't). Pages a fetch can't read go to
 * `readInTab`, when given, a few at most: the ones cheaper than the deal
 * first, since those are what a "cheaper elsewhere" rests on.
 * @param {{reads?: Map<string, Promise<object>>, dealPrice?: number|null}} options
 *   `reads` holds pages prefetchOffers() already started
 * @returns {Promise<{offers: object[], removed: {offer: object, reason: string}[]}>}
 */
export async function checkOffers(offers, { fetchPage, readInTab = null, signal, now = new Date(), reads = new Map(), dealPrice = null } = {}) {
  prefetchOffers(offers, reads, { fetchPage, signal });
  const pages = await Promise.all(offers.map((offer) => reads.get(offer.url)));
  if (readInTab) {
    const cheaper = (o) => typeof dealPrice === 'number' && typeof o.price === 'number' && o.price < dealPrice;
    const retry = pages
      .flatMap((page, i) => (needsTab(page) ? [i] : []))
      .sort((a, b) => cheaper(offers[b]) - cheaper(offers[a]) || (offers[b].match === 'same_item') - (offers[a].match === 'same_item'))
      .slice(0, MAX_TAB_CHECKS);
    await Promise.all(
      retry.map(async (i) => {
        try {
          pages[i] = await readInTab(offers[i].url, modelTokens(offers[i].product), productWords(offers[i]));
        } catch (err) {
          // The tab was closed or couldn't be scripted; the offer stays unverified.
          console.warn(`Deals Analyzer couldn't read ${offers[i].url} in a tab:`, err);
        }
      })
    );
  }
  const kept = [];
  const removed = [];
  const checkedAt = now.toISOString();

  pages.forEach((page, i) => {
    const offer = offers[i];
    if (page.state === 'gone' || page.state === 'wrong_product' || page.state === 'foreign') {
      removed.push({ offer, reason: page.state });
      return;
    }
    if (page.state !== 'read') {
      kept.push({ ...offer, check: 'unverified', checkedAt: null });
      return;
    }
    if (page.inStock === false) {
      removed.push({ offer, reason: 'out_of_stock' });
      return;
    }
    // Quoted as new, sold used or refurbished: that's where the low price came from.
    if (page.condition && page.condition !== 'new' && isNew(offer.condition)) {
      removed.push({ offer, reason: 'wrong_condition' });
      return;
    }
    const prices = page.prices || (page.price === null ? [] : [page.price]);
    const match = (page.confirmOnly ? [] : prices).find((p) => samePrice(p, offer.price));
    if (match !== undefined) {
      kept.push({ ...offer, price: match, quotedPrice: offer.price, check: 'confirmed', checkedAt });
    } else if (page.price !== null && !page.loose && plausible(page.price, offer.price)) {
      kept.push({ ...offer, price: page.price, quotedPrice: offer.price, check: 'changed', checkedAt });
    } else {
      kept.push({ ...offer, check: 'unverified', checkedAt: null });
    }
  });
  return { offers: kept, removed };
}

function samePrice(price, quoted) {
  return quoted !== null && Math.abs(price - quoted) <= Math.max(SAME_PRICE_USD, quoted * SAME_PRICE_PCT);
}

function plausible(price, quoted) {
  return quoted === null || (price <= quoted * MAX_RATIO && price >= quoted / MAX_RATIO);
}
