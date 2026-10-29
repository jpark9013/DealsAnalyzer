// Checks that today's live eDealinfo pages still parse. The site can change its
// markup at any time; this catches it before users do. Run with `npm run canary`.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const BASE = 'https://www.edealinfo.com';
const WANTED = 4; // product deals to check
const MAX_PAGES = 12; // listings to look through to find them
const MIN_OK = 2;
const extractSource = readFileSync(new URL('../extension/src/content/extract.js', import.meta.url), 'utf8');

async function get(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; DealsAnalyzerCanary/1.0; layout check)' }
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

function extract(html, url, scopeSelector) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.eval(extractSource);
  const { document } = dom.window;
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
  const deal = scope && dom.window.DealsAnalyzer.extractDeal(scope, { url });
  // Site promos ("best sales happening now") have no price rows at all.
  const hasPriceRows = Boolean(scope && scope.querySelector('.deal-detail-heading-text'));
  dom.window.close();
  return { deal: deal && JSON.parse(JSON.stringify(deal)), hasPriceRows };
}

function problems(deal) {
  if (!deal) return ['no deal found'];
  const out = [];
  if (!deal.title) out.push('missing title');
  if (!deal.productName) out.push('missing product name');
  if (!deal.store) out.push('missing store');
  if (!(deal.finalPrice > 0)) out.push('missing final price');
  if (!deal.dealDate) out.push('missing deal date');
  return out;
}

const home = await get(`${BASE}/`);
// Listing pages open deals with showDetails("d", date, seq, upc14).
const calls = [...home.matchAll(/showDetails\("d","(\d{4}-\d{2}-\d{2})",(\d+),"(\d{14})"\)/g)];
const listings = [...new Map(calls.map((m) => [m[3], { date: m[1], seq: m[2], upc: m[3] }])).values()];
if (listings.length === 0) {
  console.error('FAIL: no deals found on the homepage (showDetails calls missing)');
  process.exit(1);
}

let ok = 0;
let failures = 0;
for (const { date, seq, upc } of listings.slice(0, MAX_PAGES)) {
  if (ok + failures >= WANTED) break;
  const pageUrl = `${BASE}/d/${upc}/`;
  const page = extract(await get(pageUrl), pageUrl);
  if (!page.deal && !page.hasPriceRows) {
    console.log(`skip ${pageUrl} (not a product deal)`);
    continue;
  }

  const popupUrl = `${BASE}/deals/showSystemDeal.php?status=yes&dealid=no&para=d&deal_date=${date}&seq_no=${seq}&final_upc=${upc}&mobile_browser_common=0&tablet_browser_common=0`;
  const popup = extract(`<div id="cboxLoadedContent">${await get(popupUrl)}</div>`, `${BASE}/`, '#cboxLoadedContent');

  const issues = [
    ...problems(page.deal).map((p) => `page: ${p}`),
    ...problems(popup.deal).map((p) => `popup: ${p}`)
  ];
  if (!issues.length && page.deal.key !== popup.deal.key) issues.push('page and popup disagree on the deal');
  if (issues.length) {
    failures++;
    console.error(`FAIL ${pageUrl}: ${issues.join(', ')}`);
  } else {
    ok++;
    console.log(`ok   ${pageUrl} $${page.deal.finalPrice} ${page.deal.store} — ${page.deal.title}`);
  }
}

if (failures || ok < MIN_OK) {
  console.error(
    `\n${failures} failed, ${ok} passed: eDealinfo's markup may have changed. ` +
      'Update extension/src/content/extract.js and the test fixtures.'
  );
  process.exit(1);
}
console.log(`\nAll ${ok} sampled deals parsed.`);
