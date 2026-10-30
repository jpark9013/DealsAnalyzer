// Pulls the product and price out of a store's product page, on any site.
//
// Most stores describe their products for search engines, so the generic
// reader tries that first: schema.org JSON-LD, then schema.org microdata, then
// OpenGraph/product meta tags, then the page itself. It also keeps a short
// excerpt of the product section's text, so Claude can read what the markup
// didn't say (condition, warranty, "reference price"). Sites whose markup
// leaves out what matters get an adapter (Amazon publishes no product data,
// and its seller, list price and coupon matter for the verdict).
//
// Loaded as a classic content script (shares `globalThis.DealsAnalyzer`) and
// by the Node tests, like extract.js.
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});

  const MONEY_RE = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/;
  const PAGE_TEXT_MAX = 2500;
  const PAGE_TEXT_MIN = 1000;
  const MAX_SPECS = 15;
  const SKIP_TAGS = 'script, style, noscript, template, svg, iframe, button, select, input, textarea';

  function clean(text) {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoney(text) {
    const match = String(text ?? '').match(MONEY_RE);
    return match ? toNumber(match[1]) : null;
  }

  function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
  }

  // Text a shopper would read: without inline scripts and styles, which some
  // sites put inside price and stock elements.
  function readable(el) {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll(SKIP_TAGS).forEach((node) => node.remove());
    return clean(copy.textContent);
  }

  function first(scope, selectors, read = readable) {
    for (const selector of selectors) {
      for (const el of scope.querySelectorAll(selector)) {
        const value = read(el);
        if (value) return value;
      }
    }
    return null;
  }

  const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function meta(doc, name) {
    const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    return el ? clean(el.getAttribute('content')) || null : null;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function detectCondition(text) {
    const t = String(text || '');
    if (/open[\s-]?box/i.test(t)) return 'open box';
    if (/refurbished|renewed|reconditioned/i.test(t)) return 'refurbished';
    if (/\bused\b|pre-owned|damaged/i.test(t)) return 'used';
    return 'new';
  }

  // schema.org/RefurbishedCondition -> "refurbished"
  function schemaCondition(value) {
    const name = String(value || '').split('/').pop();
    if (!name) return null;
    return name === 'NewCondition' ? 'new' : detectCondition(name.replace(/Condition$/, ''));
  }

  function schemaAvailability(value) {
    const name = String(value || '').split('/').pop();
    return name ? name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() : null;
  }

  // --- schema.org JSON-LD -------------------------------------------------

  function isType(node, type) {
    const t = node && node['@type'];
    return Array.isArray(t) ? t.includes(type) : t === type;
  }

  function findProducts(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => findProducts(n, out));
    else if (node && typeof node === 'object') {
      if (isType(node, 'Product') || isType(node, 'ProductGroup')) out.push(node);
      else Object.values(node).forEach((v) => findProducts(v, out));
    }
    return out;
  }

  function nameOf(value) {
    if (!value) return null;
    if (typeof value === 'string') return clean(value) || null;
    if (Array.isArray(value)) return nameOf(value[0]);
    return clean(value.name) || null;
  }

  function offersOf(product) {
    const offers = [].concat(product.offers || []);
    // A ProductGroup (variants) keeps its offers on each variant.
    for (const variant of [].concat(product.hasVariant || [])) offers.push(...[].concat(variant.offers || []));
    return offers.filter((o) => o && typeof o === 'object');
  }

  function fromJsonLd(doc) {
    const products = [];
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        findProducts(JSON.parse(script.textContent), products);
      } catch {
        // Some sites ship invalid JSON-LD; skip it.
      }
    }
    // The page's main product is the one with a price.
    const product = products.find((p) => offersOf(p).some((o) => toNumber(o.price ?? o.lowPrice) !== null)) || products[0];
    if (!product) return null;
    const offer = offersOf(product).find((o) => toNumber(o.price ?? o.lowPrice) !== null) || {};
    const rating = product.aggregateRating || {};
    return {
      title: nameOf(product.name),
      brand: nameOf(product.brand),
      model: clean(product.mpn || product.model?.name || product.model) || null,
      upc: clean(product.gtin13 || product.gtin12 || product.gtin14 || product.gtin8 || product.gtin) || null,
      sku: clean(product.sku) || null,
      price: toNumber(offer.price ?? offer.lowPrice),
      currency: offer.priceCurrency || null,
      condition: schemaCondition(offer.itemCondition || product.itemCondition),
      availability: schemaAvailability(offer.availability),
      seller: nameOf(offer.seller),
      shipping: toNumber(offer.shippingDetails?.shippingRate?.value),
      rating: rating.ratingValue ? `${rating.ratingValue} out of ${rating.bestRating || 5}${rating.reviewCount || rating.ratingCount ? ` (${rating.reviewCount || rating.ratingCount} reviews)` : ''}` : null
    };
  }

  // --- schema.org microdata ----------------------------------------------

  // A scope's own properties, not those of scopes nested inside it (a
  // product's seller has a `name` too).
  function microProps(scope) {
    const props = {};
    for (const el of scope.querySelectorAll('[itemprop]')) {
      if (el.parentElement.closest('[itemscope]') !== scope) continue;
      const name = el.getAttribute('itemprop');
      if (name in props) continue;
      props[name] = el.hasAttribute('itemscope')
        ? el
        : clean(el.getAttribute('content') ?? el.getAttribute('href') ?? el.getAttribute('src') ?? el.textContent);
    }
    return props;
  }

  function fromMicrodata(doc) {
    const scope = doc.querySelector('[itemscope][itemtype*="schema.org/Product"]');
    if (!scope) return null;
    const p = microProps(scope);
    const offerEl = p.offers instanceof root.Element ? p.offers : null;
    const offer = offerEl ? microProps(offerEl) : {};
    const brand = p.brand instanceof root.Element ? microProps(p.brand).name : p.brand;
    const seller = offer.seller instanceof root.Element ? microProps(offer.seller).name : offer.seller;
    return {
      title: typeof p.name === 'string' ? p.name : null,
      brand: typeof brand === 'string' ? brand : null,
      model: typeof p.mpn === 'string' ? p.mpn : null,
      upc: p.gtin13 || p.gtin12 || p.gtin || null,
      sku: typeof p.sku === 'string' ? p.sku : null,
      price: toNumber(typeof offer.price === 'string' ? offer.price.replace(/^[^0-9]*/, '') : null),
      currency: offer.priceCurrency || null,
      condition: schemaCondition(offer.itemCondition),
      availability: schemaAvailability(offer.availability),
      seller: typeof seller === 'string' ? seller : null
    };
  }

  // --- OpenGraph / product meta tags -------------------------------------

  function fromMeta(doc) {
    return {
      title: meta(doc, 'og:title'),
      price: toNumber(meta(doc, 'product:price:amount') || meta(doc, 'og:price:amount')),
      currency: meta(doc, 'product:price:currency') || meta(doc, 'og:price:currency'),
      brand: meta(doc, 'product:brand'),
      condition: meta(doc, 'product:condition') ? detectCondition(meta(doc, 'product:condition')) : null,
      availability: meta(doc, 'product:availability'),
      shipping: toNumber(meta(doc, 'product:shipping_cost:amount')),
      siteName: meta(doc, 'og:site_name')
    };
  }

  // --- The page itself ---------------------------------------------------

  // The heading that names the product: the h1 closest to the known title
  // (some sites' first h1 is a banner), else the first h1.
  function titleHeading(doc, knownTitle) {
    const headings = [...doc.querySelectorAll('h1')].filter((h) => readable(h));
    if (!knownTitle) return headings[0] || null;
    const words = new Set(knownTitle.toLowerCase().match(/[a-z0-9]+/g) || []);
    let best = null;
    let bestScore = 0;
    for (const h of headings) {
      const hw = readable(h).toLowerCase().match(/[a-z0-9]+/g) || [];
      const score = hw.filter((w) => words.has(w)).length / Math.max(words.size, 1);
      if (score > bestScore) [best, bestScore] = [h, score];
    }
    return bestScore >= 0.5 ? best : null;
  }

  // Where the page shows the product's name, when no h1 does.
  function namedElement(doc, title) {
    if (!title) return null;
    const want = squash(title);
    for (const el of doc.querySelectorAll('[itemprop="name"], h2, h3, [class*="title" i]')) {
      if (squash(readable(el)) === want) return el;
    }
    return null;
  }

  // A product page has one item to buy; search and category pages have one
  // button per product, articles none. Labels only, so it works on any store.
  const BUY_RE = /^(add to (cart|bag|basket|trolley|order)|buy (it )?now|pre-?order( now)?)$/i;
  const MAX_BUY_BUTTONS = 3;

  // Sites that post deals sold elsewhere. Their posts have no buy button or
  // product data, but do have a heading and a price. Listing pages have those
  // too, so only addresses shaped like one post count ("/f/123-27-inch-monitor").
  const DEAL_SITES = /(^|\.)(slickdeals\.net|dealnews\.com|bensbargains\.com|bradsdeals\.com|dealtikka\.com|dealsea\.com|techbargains\.com|gottadeal\.com|dealcatcher\.com|hip2save\.com)$/;
  const POST_PATH = /\/[^/]*(?:-[^/-]+){3,}\/?$/;

  function isDealPost(url) {
    try {
      const { hostname, pathname } = new URL(url);
      return DEAL_SITES.test(hostname) && POST_PATH.test(pathname);
    } catch {
      return false;
    }
  }

  function buyButtonCount(doc) {
    let count = 0;
    for (const el of doc.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
      const label = clean(el.value || el.textContent);
      if (BUY_RE.test(label) || BUY_RE.test(clean(el.getAttribute('aria-label')))) count++;
      if (count > MAX_BUY_BUTTONS) break;
    }
    return count;
  }

  // The first price-looking element after the title that isn't a struck-out
  // "was" price.
  function pagePrice(doc, heading) {
    const candidates = doc.querySelectorAll(
      '[itemprop="price"], [data-testid*="price" i], [data-test*="price" i], [class*="price" i], [id*="price" i]'
    );
    let fallback = null;
    for (const el of candidates) {
      const label = `${el.className} ${el.id} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-test') || ''}`;
      if (/was|list|strike|original|regular|compare|old|msrp|reference/i.test(label)) continue;
      if (el.closest('s, del, strike')) continue;
      const text = readable(el);
      if (text.length > 40) continue;
      const price = parseMoney(text);
      if (price === null) continue;
      const after = !heading || Boolean(heading.compareDocumentPosition(el) & root.Node.DOCUMENT_POSITION_FOLLOWING);
      if (after) return price;
      fallback ??= price;
    }
    return fallback;
  }

  // Stores show where you are next to the price ("Deliver by Tue to Anytown,
  // NY", "Pickup at Main St store", "delivered ... to 12345") and greet you by
  // name; none of that is about the product, so it's cut before the text
  // leaves the page. Locations are recognized by their shape (a ZIP code, or
  // "City, ST" with a real state code), since every store words it differently.
  const STATES =
    'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR';
  // One to three capitalized words, but not the store's own words that follow
  // a place ("Pickup at Anytown Delivering to ...").
  const PLACE_WORD = "(?!Deliver|Pick|Ship|Arriv|Free|Get|Order|Sold|Return|Update|Change)[A-Z][A-Za-z.'-]+";
  const PLACE = `${PLACE_WORD}(?:\\s${PLACE_WORD}){0,2}`;
  const CITY_STATE_ZIP = new RegExp(`\\b${PLACE},\\s?(?:${STATES})\\s+\\d{5}(?:-\\d{4})?\\b`, 'g');
  const TO_CITY_STATE = new RegExp(`\\b(to|at|near|in|from)\\s+${PLACE},\\s?(?:${STATES})\\b`, 'g');
  // "Pickup at Anytown", "Delivering to Anytown Supercenter". Not "Ships from
  // Best Buy": who ships it matters to the verdict.
  const PICKUP_PLACE = new RegExp(`\\b([Pp]ick ?up|[Dd]eliver(?:y|ing|s)?)\\s+(to|at|near|in)\\s+${PLACE}`, 'g');

  function scrubPersonal(text) {
    return text
      .replace(CITY_STATE_ZIP, '[location]')
      .replace(TO_CITY_STATE, '$1 [location]')
      .replace(/\b(to|at|near|in|from|zip(?: code)?:?)\s+\d{5}(?:-\d{4})?\b/gi, '$1 [location]')
      .replace(PICKUP_PLACE, '$1 $2 [location]')
      .replace(/\b(hello|hi|welcome back),?\s+[A-Z][a-z]+\b/gi, '$1')
      .replace(/\b\d{5}(?:-\d{4})?\b(?=\s*(?:update location|change location|change store))/gi, '[location]');
  }

  // The text around the product's title: its section of the page, without
  // the site's header, menus and footer, starting at the product's name.
  function pageText(doc, anchor) {
    let section = anchor || doc.querySelector('main') || doc.body;
    while (section && section !== doc.body && readable(section).length < PAGE_TEXT_MIN) section = section.parentElement;
    if (!section) return null;
    const copy = section.cloneNode(true);
    copy.querySelectorAll(`${SKIP_TAGS}, nav, header, footer, aside, form`).forEach((node) => node.remove());
    // Elements' text would otherwise run together ("$24.99Only 1 left").
    copy.querySelectorAll('*').forEach((el) => el.append(' '));
    let text = clean(copy.textContent);
    const start = anchor ? text.indexOf(readable(anchor)) : -1;
    if (start > 0) text = text.slice(start);
    text = scrubPersonal(text);
    return text ? text.slice(0, PAGE_TEXT_MAX) : null;
  }

  function stripSiteName(title, siteName) {
    // "Product name | Store" or "Product - $24.99 - Free shipping" -> "Product name"
    let t = clean(title).replace(/\s+[-–|:]\s+\$[0-9].*$/, '');
    if (siteName) t = t.replace(new RegExp(`\\s*[-–|:]\\s*${siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'i'), '');
    return t.replace(/^(amazon\.com|walmart\.com)\s*:\s*/i, '').trim() || null;
  }

  function merge(...sources) {
    const out = {};
    for (const source of sources) {
      for (const [k, v] of Object.entries(source || {})) if (out[k] == null && v != null && v !== '') out[k] = v;
    }
    return out;
  }

  function canonicalUrl(doc, url) {
    const href = doc.querySelector('link[rel="canonical"]')?.getAttribute('href');
    try {
      return href ? new URL(href, url).href : url;
    } catch {
      return url;
    }
  }

  function genericDeal(doc, url, strict) {
    const m = fromMeta(doc);
    const ld = fromJsonLd(doc);
    const micro = fromMicrodata(doc);
    const found = merge(ld, micro, m);
    const siteName = m.siteName;
    const title = stripSiteName(found.title, siteName) || stripSiteName(doc.title, siteName);
    const heading = titleHeading(doc, title) || namedElement(doc, title);
    const dealPost = isDealPost(url);
    // A deal post's title states its price ("$249.99: 27-inch monitor"); the page's own price may be rounded.
    const titlePrice = dealPost ? parseMoney(title) : null;
    const price = found.price ?? titlePrice ?? pagePrice(doc, heading);
    // A product page describes a product or shows a price; a home page or article does neither.
    // Stores declare products in their markup (og:type "product", Walmart's
    // "product.item"), though some big ones, like Newegg, no longer do.
    const declaresProduct = Boolean(ld || micro || /^product\b/.test(meta(doc, 'og:type') || '') || m.price !== null);
    if (!title || (price === null && !declaresProduct)) return null;
    // Unprompted (strict), a page must declare a product or be laid out like
    // one: the product's heading, a price after it, and a button to buy it.
    if (strict && !declaresProduct && !(dealPost && heading && price !== null)) {
      const buttons = heading && price !== null ? buyButtonCount(doc) : 0;
      if (buttons < 1 || buttons > MAX_BUY_BUTTONS) return null;
    }
    if (found.currency && found.currency !== 'USD') return null;

    const text = pageText(doc, heading);
    return {
      title,
      brand: found.brand || null,
      model: found.model || null,
      upc: found.upc || null,
      sku: found.sku || null,
      store: found.seller && siteName && !squash(siteName).includes(squash(found.seller)) ? `${siteName} (seller: ${found.seller})` : siteName || found.seller || hostOf(url),
      condition: found.condition || detectCondition(`${title} ${text || ''}`.slice(0, 400)),
      finalPrice: price,
      dealSite: dealPost || undefined,
      shipping: found.shipping === null || found.shipping === undefined ? null : `$${found.shipping.toFixed(2)}`,
      availability: found.availability || null,
      rating: found.rating || null,
      pageText: text
    };
  }

  // --- Amazon ------------------------------------------------------------

  function amazonDeal(doc, url) {
    const title = first(doc, ['#productTitle', '#title']);
    if (!title) return null;
    const price = parseMoney(
      first(doc, [
        '#corePrice_feature_div .a-price .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
        '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
        '#apex_desktop .a-price .a-offscreen',
        '#tp_price_block_total_price_ww .a-offscreen',
        '#priceblock_dealprice',
        '#priceblock_ourprice',
        '#price_inside_buybox',
        '#newBuyBoxPrice'
      ])
    );
    // "List Price: $249.99" or "Typical price: $179.99"
    const basis = first(doc, ['.basisPrice']);
    const basisMatch = basis && basis.match(/^([A-Za-z ]+?):?\s*\$/);
    const asin =
      first(doc, ['input#ASIN'], (el) => clean(el.getAttribute('value'))) || (url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1] || null;

    const rows = {};
    for (const row of doc.querySelectorAll('#productOverview_feature_div tr, #prodDetails tr, #detailBullets_feature_div li')) {
      const cells = row.matches('li') ? readable(row).split(/\s*:\s*/) : [...row.querySelectorAll('th, td')].map(readable);
      const key = clean(cells[0]).replace(/[\u200e\u200f]/g, '');
      const value = clean(cells.slice(1).join(' ')).replace(/[\u200e\u200f]/g, '');
      if (key && value && !(key in rows) && value.length < 120 && !/review|rank|feedback/i.test(key)) rows[key] = value;
    }
    const specs = Object.fromEntries(Object.entries(rows).slice(0, MAX_SPECS));

    // "Ships from: Amazon.com Sold by: Amazon.com" (the abbreviated block for the main offer)
    const shipSold = first(doc, ['#shipFromSoldByAbbreviatedODF_feature_div', '#tabular-buybox']) || '';
    const shipsFrom = (shipSold.match(/Ships from:?\s*(.+?)\s+Sold by/i) || [])[1] || null;
    const soldBy =
      (shipSold.match(/Sold by:?\s*(.+?)(?:\s+Returns|\s+Payment|$)/i) || [])[1] ||
      first(doc, [
        '[offer-display-feature-name="desktop-merchant-info"] .offer-display-feature-text-message',
        '#merchantInfoFeature_feature_div .offer-display-feature-text-message',
        '#sellerProfileTriggerId',
        '#merchant-info'
      ]);
    const returns = first(doc, ['[offer-display-feature-name="desktop-return-info"] .offer-display-feature-text-message']);
    const stars = first(doc, ['#acrPopover'], (el) => clean(el.getAttribute('title')) || readable(el));
    const count = first(doc, ['#acrCustomerReviewText']);
    const bullets = [...doc.querySelectorAll('#feature-bullets li')].map(readable).filter(Boolean).slice(0, 6);
    const notes = [
      first(doc, ['#dealBadge_feature_div']),
      first(doc, ['#couponBadgeRegularVpc', '[id^="couponText"]', '.couponLabelText']),
      first(doc, ['.savingsPercentage']) && `Shown as ${first(doc, ['.savingsPercentage'])} off`,
      returns && returns.length < 80 && `Returns: ${returns}`
    ].filter(Boolean);

    return {
      title,
      brand: (first(doc, ['#bylineInfo']) || '').replace(/^(Visit the |Brand:\s*)/i, '').replace(/ Store$/, '') || null,
      model: rows['Model Number'] || rows['Item model number'] || rows['Model Name'] || null,
      asin,
      // Amazon's canonical links vary; the /dp/ link is the product's stable address.
      pageUrl: asin ? `https://www.amazon.com/dp/${asin}` : null,
      store: 'Amazon.com',
      sellerNote: [shipsFrom && `ships from ${shipsFrom}`, soldBy && `sold by ${soldBy}`].filter(Boolean).join(', ') || null,
      condition: detectCondition(`${title} ${soldBy || ''}`),
      finalPrice: price,
      listPrice: parseMoney(basis),
      listPriceLabel: basisMatch ? clean(basisMatch[1]) : null,
      availability: first(doc, ['#availability']),
      rating: stars ? `${stars}${count ? ` ${count.replace(/[()]/g, '')} ratings` : ''}` : null,
      specs,
      notes,
      pageText: bullets.length ? bullets.join(' • ').slice(0, PAGE_TEXT_MAX) : null
    };
  }

  const ADAPTERS = [{ site: /(^|\.)amazon\.com$/, extract: amazonDeal }];

  /**
   * @param {Document} doc  a store's product page
   * @param {{url?: string, strict?: boolean}} [options]  `strict` accepts only
   *   pages that declare a product (product data, a known store's layout) or
   *   show one item to buy, not ones that merely show a heading and a price
   * @returns {object|null} the deal, shaped like extractDeal()'s, or null if
   *   the page has no recognizable product
   */
  function extractPageDeal(doc, options = {}) {
    const url = options.url || doc.location?.href || '';
    const site = hostOf(url);
    const adapter = ADAPTERS.find((a) => a.site.test(site));
    const found = (adapter && adapter.extract(doc, url)) || genericDeal(doc, url, Boolean(options.strict));
    if (!found || !found.title) return null;

    const deal = {
      title: found.title,
      productName: found.title,
      brand: null,
      model: null,
      upc: null,
      asin: null,
      sku: null,
      sellerNote: null,
      listPrice: null,
      listPriceLabel: null,
      shipping: null,
      availability: null,
      rating: null,
      specs: {},
      notes: [],
      pageText: null,
      ...found,
      site,
      pageUrl: found.pageUrl || canonicalUrl(doc, url)
    };
    deal.key = [deal.asin || deal.upc || deal.model || deal.sku || deal.title, site, deal.finalPrice].join('|');
    return deal;
  }

  ns.extractPageDeal = extractPageDeal;
  ns.scrubPersonal = scrubPersonal;
})(globalThis);
