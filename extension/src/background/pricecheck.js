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

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

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

function offerOf(product) {
  const offers = [...[].concat(product.offers || [])];
  for (const variant of [].concat(product.hasVariant || [])) offers.push(...[].concat(variant.offers || []));
  return offers.find((o) => o && typeof o === 'object' && toPrice(o.price ?? o.lowPrice) !== null) || null;
}

function fromJsonLd(html, tokens) {
  const products = [];
  for (const [, body] of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      findProducts(JSON.parse(body), products);
    } catch {
      // Some sites ship invalid JSON-LD; skip it.
    }
  }
  const priced = products.filter(offerOf);
  const names = (p) => squash(`${p.name} ${p.mpn} ${p.sku} ${p.model?.name || p.model}`);
  // With several products on the page, only the one naming the model will do.
  const product = priced.find((p) => tokens.some((t) => names(p).includes(t))) || (priced.length === 1 ? priced[0] : null);
  if (!product) return null;
  const offer = offerOf(product);
  if (offer.priceCurrency && offer.priceCurrency !== 'USD') return null;
  return {
    price: toPrice(offer.price ?? offer.lowPrice),
    inStock: !OUT_OF_STOCK.test(String(offer.availability || '')),
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
  if (currency && currency !== 'USD') return null;
  const price = toPrice(metaContent(html, 'product:price:amount') || metaContent(html, 'og:price:amount'));
  if (price === null) return null;
  return { price, inStock: !/^(oos|out.?of.?stock|sold.?out)$/i.test(metaContent(html, 'product:availability') || '') };
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
  return price === null && inStock ? null : { price, inStock };
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
  return { price, inStock: !stock || stock[1] === 'true' };
}

const STORE_READERS = [
  { site: /(^|\.)amazon\.com$/, read: fromAmazon },
  { site: /(^|\.)newegg\.com$/, read: fromNewegg }
];

/**
 * What a store's page says about a product.
 * @param {string} html
 * @param {{url?: string, status?: number, tokens?: string[], pagePrice?: number|null}} [options]
 *   `pagePrice` is a price read from the rendered page, for when its data has none
 * @returns {{state: 'read'|'blocked'|'gone'|'wrong_product'|'unreadable', price?: number|null, inStock?: boolean, loose?: boolean}}
 *   `loose` marks a guess from the rendered page, which can confirm a quoted price but not replace it
 */
export function readStorePage(html, { url = '', status = 200, tokens = [], pagePrice = null } = {}) {
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

  if (tokens.length) {
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
    const named = squash(`${title} ${h1} ${found.names} ${metaContent(html, 'og:title')} ${path}`);
    if (!tokens.some((t) => named.includes(t))) {
      // Not in the page's name: a page about this model still repeats it in its specs.
      const page = squash(html);
      if (!tokens.some((t) => page.split(t).length > 3)) return { state: 'wrong_product' };
    }
  }
  return { state: 'read', price: found.price, inStock: found.inStock, ...(found.loose ? { loose: true } : {}) };
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
  return async (url, tokens) => {
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
              pagePrice: globalThis.DealsAnalyzer?.extractPageDeal?.(document, { url: location.href })?.finalPrice ?? null
            })
          });
          if (probe?.result?.ready) page = readStorePage(probe.result.html, { url: probe.result.url, tokens, pagePrice: probe.result.pagePrice });
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
      tokens: modelTokens(offer.product)
    });
  } catch {
    return { state: 'blocked' };
  }
}

/**
 * Checks each linked offer against its store page, in parallel. Offers whose
 * page is gone, sold out or about another product are removed; the rest come
 * back with `check` set: 'confirmed' (the page shows this price), 'changed'
 * (`price` is the page's, `quotedPrice` what the search result said), or
 * 'unverified' (the store didn't let us read it, or we couldn't). Pages a
 * fetch can't read go to `readInTab`, when given, a few at most.
 * @returns {Promise<{offers: object[], removed: {offer: object, reason: string}[]}>}
 */
export async function checkOffers(offers, { fetchPage, readInTab = null, signal, now = new Date() } = {}) {
  const get = fetchPage || globalThis.fetch.bind(globalThis);
  const reads = await Promise.all(offers.map((offer) => readOffer(offer, { fetchPage: get, signal })));
  if (readInTab) {
    const retry = reads.flatMap((page, i) => (needsTab(page) ? [i] : [])).slice(0, MAX_TAB_CHECKS);
    await Promise.all(
      retry.map(async (i) => {
        try {
          reads[i] = await readInTab(offers[i].url, modelTokens(offers[i].product));
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

  reads.forEach((page, i) => {
    const offer = offers[i];
    if (page.state === 'gone' || page.state === 'wrong_product') {
      removed.push({ offer, reason: page.state });
    } else if (page.state === 'read' && page.inStock === false) {
      removed.push({ offer, reason: 'out_of_stock' });
    } else if (page.state === 'read' && page.price !== null && plausible(page.price, offer.price) && (!page.loose || samePrice(page.price, offer.price))) {
      const close = samePrice(page.price, offer.price);
      kept.push({
        ...offer,
        price: page.price,
        quotedPrice: offer.price,
        check: close ? 'confirmed' : 'changed',
        checkedAt
      });
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
