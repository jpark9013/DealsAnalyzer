import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeDom, fixture, plain } from './helpers.js';

function extract(html, url) {
  const dom = makeDom(html, { url, scripts: ['extension/src/content/extract-page.js'] });
  const deal = dom.window.DealsAnalyzer.extractPageDeal(dom.window.document, { url });
  dom.window.close();
  return deal && plain(deal);
}

function extractStrict(html, url) {
  const dom = makeDom(html, { url, scripts: ['extension/src/content/extract-page.js'] });
  const deal = dom.window.DealsAnalyzer.extractPageDeal(dom.window.document, { url, strict: true });
  dom.window.close();
  return deal && plain(deal);
}

const page = (head, body) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('extractPageDeal on Amazon (adapter)', () => {
  // A real product page, saved with scripts, ads and the site header removed.
  const deal = extract(fixture('store-amazon-monitor'), 'https://www.amazon.com/GIGABYTE-M27Q2/dp/B0GKFQXR3R/ref=sr_1_1');

  test('reads the product, price and identifiers', () => {
    assert.equal(deal.title, 'GIGABYTE M27Q2 27" SuperSpeed IPS QHD AMD Freesync Premium Gaming Monitor');
    assert.equal(deal.finalPrice, 159.99);
    assert.equal(deal.asin, 'B0GKFQXR3R');
    assert.equal(deal.model, 'M27Q2');
    assert.equal(deal.brand, 'GIGABYTE');
    assert.equal(deal.key, 'B0GKFQXR3R|amazon.com|159.99');
    assert.equal(deal.pageUrl, 'https://www.amazon.com/dp/B0GKFQXR3R');
  });

  test('reads who sells it, and labels the list price the way Amazon does', () => {
    assert.equal(deal.store, 'Amazon.com');
    // The page also has a used offer ("Amazon Resale"); that's not the deal.
    assert.equal(deal.sellerNote, 'ships from Amazon.com, sold by Amazon.com');
    assert.equal(deal.condition, 'new');
    assert.equal(deal.listPrice, 249.99);
    assert.equal(deal.listPriceLabel, 'List Price');
    assert.ok(deal.notes.includes('Returns: FREE 30-day refund/replacement'));
  });

  test('reads ratings, specs and the feature bullets, without page furniture', () => {
    assert.equal(deal.rating, '4.4 out of 5 stars 86 ratings');
    assert.equal(deal.availability, 'In Stock');
    assert.equal(deal.specs['Refresh Rate'], '200 hertz');
    assert.ok(Object.keys(deal.specs).length <= 15);
    assert.match(deal.pageText, /^QUANTUM DOT SUPERSPEED IPS PANEL/);
    // Inline scripts inside stock and promo elements must not leak into text.
    assert.ok(!/isInternal|cxcwPopoverLink/.test(JSON.stringify(deal)));
  });
});

describe('extractPageDeal on Woot (microdata and meta tags)', () => {
  const deal = extract(fixture('store-woot-headset'), 'https://computers.woot.com/offers/epos-adapt-160t-anc-usb-headset-0?ref=w_cnt');

  test("reads the product from microdata, not the page's banner heading", () => {
    // Woot's first <h1> is "Free shipping for Prime members on Woot!".
    assert.equal(deal.title, 'EPOS Adapt 160T ANC USB Headset');
    assert.equal(deal.finalPrice, 24.99);
    assert.equal(deal.availability, 'in stock');
    assert.equal(deal.condition, 'new');
  });

  test('reads shipping from the product meta tags and names the store once', () => {
    assert.equal(deal.shipping, '$6.00');
    // The microdata seller ("Woot!") is the site itself.
    assert.equal(deal.store, 'Computers.Woot');
    assert.equal(deal.site, 'computers.woot.com');
  });

  test('keeps the product section text, where Woot shows its reference price', () => {
    assert.match(deal.pageText, /\$159\.99 84% off Reference Price/);
    assert.ok(deal.pageText.length <= 2500);
  });
});

describe('extractPageDeal on other stores (generic)', () => {
  test('reads schema.org JSON-LD, including condition, seller and identifiers', () => {
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'BreadcrumbList', itemListElement: [] },
        {
          '@type': 'Product',
          name: 'Lenovo ThinkPad T14 Gen 3 14" Laptop',
          brand: { '@type': 'Brand', name: 'Lenovo' },
          mpn: '21AH00BCUS',
          gtin13: '0196802123456',
          sku: '6512345',
          aggregateRating: { ratingValue: 4.6, reviewCount: 212 },
          offers: {
            '@type': 'Offer',
            price: '549.99',
            priceCurrency: 'USD',
            itemCondition: 'https://schema.org/RefurbishedCondition',
            availability: 'https://schema.org/InStock',
            seller: { '@type': 'Organization', name: 'Best Buy' }
          }
        }
      ]
    };
    const deal = extract(
      page(
        `<title>Lenovo ThinkPad T14 - Best Buy</title><meta property="og:site_name" content="Best Buy"><script type="application/ld+json">${JSON.stringify(ld)}</script>`,
        '<h1>Holiday deals are here</h1><h1>Lenovo ThinkPad T14 Gen 3 14" Laptop</h1><div class="price">$549.99</div>'
      ),
      'https://www.bestbuy.com/site/lenovo-thinkpad-t14/6512345.p?skuId=6512345'
    );
    assert.equal(deal.title, 'Lenovo ThinkPad T14 Gen 3 14" Laptop');
    assert.equal(deal.finalPrice, 549.99);
    assert.equal(deal.brand, 'Lenovo');
    assert.equal(deal.model, '21AH00BCUS');
    assert.equal(deal.upc, '0196802123456');
    assert.equal(deal.condition, 'refurbished');
    assert.equal(deal.store, 'Best Buy');
    assert.equal(deal.rating, '4.6 out of 5 (212 reviews)');
    assert.equal(deal.key, '0196802123456|bestbuy.com|549.99');
  });

  test('falls back to meta tags, trimming the store name from the title', () => {
    const deal = extract(
      page(
        '<title>x</title><meta property="og:title" content="YETI Rambler 20 oz Tumbler | DICK\'S Sporting Goods"><meta property="og:site_name" content="DICK\'S Sporting Goods"><meta property="og:type" content="product"><meta property="product:price:amount" content="27.50"><meta property="product:price:currency" content="USD">',
        '<main><h1>YETI Rambler 20 oz Tumbler</h1><p>Double-wall vacuum insulation.</p></main>'
      ),
      'https://www.dickssportinggoods.com/p/yeti-rambler-20-oz-tumbler/123'
    );
    assert.equal(deal.title, 'YETI Rambler 20 oz Tumbler');
    assert.equal(deal.finalPrice, 27.5);
    assert.equal(deal.store, "DICK'S Sporting Goods");
    assert.match(deal.pageText, /Double-wall vacuum insulation/);
  });

  test('without structured data, takes the first price after the title, skipping struck-out prices', () => {
    const deal = extract(
      page(
        '<title>Acme 4K Projector – Acme Store</title><meta property="og:site_name" content="Acme Store">',
        '<div class="price">$5.00 off your first order</div><h1>Acme 4K Projector</h1><span class="price-was">$899.00</span><s><span class="price">$849.00</span></s><span class="sale-price">$599.00</span><p>Refurbished by Acme. 90-day warranty.</p>'
      ),
      'https://acme.example/products/projector'
    );
    assert.equal(deal.title, 'Acme 4K Projector');
    assert.equal(deal.finalPrice, 599);
    assert.equal(deal.condition, 'refurbished');
    assert.equal(deal.store, 'Acme Store');
  });

  test('strict mode needs the page to declare a product, not just show a heading and a price', () => {
    const html = page('<title>Acme Projector</title>', '<h1>Acme Projector</h1><span class="price">$599.00</span>');
    const url = 'https://acme.example/projector';
    const dom = makeDom(html, { url, scripts: ['extension/src/content/extract-page.js'] });
    const { extractPageDeal } = dom.window.DealsAnalyzer;
    assert.equal(extractPageDeal(dom.window.document, { url }).finalPrice, 599, 'the toolbar button reads it');
    assert.equal(extractPageDeal(dom.window.document, { url, strict: true }), null, 'but no tab appears on its own');
    dom.window.close();
    // Amazon's layout and Woot's microdata both count as declaring a product.
    assert.ok(extractStrict(fixture('store-amazon-monitor'), 'https://www.amazon.com/dp/B0GKFQXR3R'));
    assert.ok(extractStrict(fixture('store-woot-headset'), 'https://computers.woot.com/offers/x'));
  });

  test('strict mode also accepts a store that publishes no product data, by its single buy button', () => {
    // Newegg and Walmart stopped publishing schema.org Product data.
    const newegg = page(
      '<title>GIGABYTE M27Q2 27" Monitor - Newegg.com</title><meta property="og:type" content="website"><meta property="og:site_name" content="Newegg">',
      '<h1 class="product-title">GIGABYTE M27Q2 27" Monitor</h1><ul><li class="price-was">$279.99</li><li class="price-current">$<strong>159</strong><sup>.99</sup></li></ul><button class="btn-primary">Add to cart</button><div class="sticky"><button>Add to Cart</button></div>'
    );
    const deal = extractStrict(newegg, 'https://www.newegg.com/gigabyte-m27q2/p/N82E16824012073');
    assert.equal(deal.title, 'GIGABYTE M27Q2 27" Monitor');
    assert.equal(deal.finalPrice, 159.99);
    assert.equal(deal.store, 'Newegg');

    const walmart = page(
      '<title>Galaxy Tab A11 - Walmart.com</title><meta property="og:type" content="product.item"><meta property="og:site_name" content="Walmart.com">',
      '<h1>Galaxy Tab A11</h1><span itemprop="price">Now $269.00</span>'
    );
    assert.equal(extractStrict(walmart, 'https://www.walmart.com/ip/18089905174').finalPrice, 269);
  });

  test("strict mode skips search and category pages, which have a buy button per product", () => {
    const items = Array.from({ length: 8 }, (_, i) => `<div><span class="price">$${100 + i}.00</span><button>Add to cart</button></div>`).join('');
    assert.equal(extractStrict(page('<title>Monitors</title>', `<h1>Monitors</h1>${items}`), 'https://shop.example/monitors'), null);
  });

  test("isn't fooled by pages that aren't products", () => {
    const home = page('<title>Acme Store – Home</title>', '<h1>Welcome to Acme</h1><p>Shop our latest arrivals.</p>');
    assert.equal(extract(home, 'https://acme.example/'), null);
  });

  test('skips prices in other currencies', () => {
    const ld = { '@type': 'Product', name: 'Kettle', offers: { price: 40, priceCurrency: 'EUR' } };
    const deal = extract(page(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`, '<h1>Kettle</h1>'), 'https://shop.example.de/kettle');
    assert.equal(deal, null);
  });

  test('ignores invalid JSON-LD', () => {
    const deal = extract(
      page('<title>Kettle</title><script type="application/ld+json">{ not json</script>', '<h1>Kettle</h1><span class="price">$40.00</span>'),
      'https://shop.example/kettle'
    );
    assert.equal(deal.finalPrice, 40);
  });
});

describe('page text privacy', () => {
  test('cuts delivery locations and greetings out of the excerpt', () => {
    const deal = extract(
      page(
        '<title>Acme Kettle – Acme</title><meta property="og:site_name" content="Acme">',
        '<div id="top">Hello, Julian · Deliver to Julian - Anytown 12345</div>' +
          '<h1>Acme Kettle</h1><span class="price">$40.00</span>' +
          '<p>Delivering to Anytown 12345 Update location</p><p>Pickup at Anytown Supercenter. Arrives by Friday.</p>' +
          '<p>Free shipping to 12345. 1.7L stainless.</p>'
      ),
      'https://acme.example/kettle'
    );
    assert.match(deal.pageText, /^Acme Kettle \$40\.00/);
    assert.match(deal.pageText, /1\.7L stainless/);
    assert.ok(!/Anytown|12345|Julian|Supercenter/.test(deal.pageText), deal.pageText);
  });

  test("recognizes locations however the store words them, and keeps what isn't one", () => {
    const scrub = (text) => {
      const dom = makeDom('<!doctype html><html></html>', { scripts: ['extension/src/content/extract-page.js'] });
      const out = dom.window.DealsAnalyzer.scrubPersonal(text);
      dom.window.close();
      return out;
    };
    // Phrasings seen on Staples, eBay, Home Depot and Walmart pages.
    for (const text of [
      'Deliver by Tue, Nov 10 to Anytown, NY Free Returns',
      'Estimated between Mon, Nov 9 and Wed, Nov 18 to 12345',
      'Pickup at Anytown Delivering to Anytown',
      'Store: Anytown, NY 12345',
      'Pickup at Anytown Supercenter'
    ]) {
      assert.ok(!/Anytown|12345/.test(scrub(text)), scrub(text));
    }
    assert.equal(scrub('Ships from Best Buy. Available in Black, XL.'), 'Ships from Best Buy. Available in Black, XL.');
    assert.equal(scrub('Model 27Q2 at $159.99'), 'Model 27Q2 at $159.99');
  });
});

describe('deal sites', () => {
  // The shape of a real Slickdeals post: no product data or buy button, and a page price rounded to dollars.
  const post = (title, price = '$250') =>
    `<!doctype html><html><head><title>${title}</title><meta property="og:title" content="${title}"><meta property="og:site_name" content="Slickdeals"></head>` +
    `<body><h1>${title}</h1><div class="price">${price}</div><a href="/redirect">Best Buy</a></body></html>`;
  const read = extractStrict;

  test("recognizes a single deal's post, and takes the price from its title", () => {
    const deal = read(post('$249.99: GIGABYTE M27Q 27" 170Hz Gaming Monitor'), 'https://slickdeals.net/f/17266135-249-99-gigabyte-m27q-27-170hz-gaming-monitor');
    assert.equal(deal.finalPrice, 249.99);
    assert.equal(deal.dealSite, true);
    assert.equal(deal.store, 'Slickdeals');
  });

  test("doesn't take a deal site's other pages for a deal", () => {
    assert.equal(read(post('Hot Deals'), 'https://slickdeals.net/'), null);
    assert.equal(read(post('Tech Deals'), 'https://slickdeals.net/deals/tech/'), null);
  });

  test("doesn't apply to ordinary sites", () => {
    assert.equal(read(post('Best TVs of the year'), 'https://www.example.com/best-tvs-of-the-year-2026'), null);
  });
});
