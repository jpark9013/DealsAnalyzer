// Runs the extension's analysis from the command line, for prompt work:
//   npm run analyze -- https://www.edealinfo.com/d/...
//   npm run analyze -- test/fixtures/detail-ebay-refurb-no-upc.html
//   PAGE_URL=https://www.amazon.com/dp/B0GKFQXR3R npm run analyze -- test/fixtures/store-amazon-monitor.html
//   npm run analyze -- <deal> "What would you buy instead?"   (adds a follow-up)
// eDealinfo pages use its extractor; any other page uses the store-page one
// (PAGE_URL tells a saved file where it came from, since adapters go by site).
// Reads ANTHROPIC_API_KEY from .env; MODEL, EFFORT and MAX_SEARCHES override
// the defaults. Calls the real API, so each run costs a few cents.
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { analyzeDeal, askFollowUp } from '../extension/src/background/claude.js';
import { sanitizeSettings } from '../extension/src/background/settings.js';

try {
  process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // fall through to the missing-key check
}

const [target, question] = process.argv.slice(2);
if (!target) {
  console.error('usage: npm run analyze -- <deal or product page URL, or saved .html file> ["follow-up question"]');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Set ANTHROPIC_API_KEY in .env first.');
  process.exit(1);
}

const fromFile = existsSync(target);
const url = fromFile ? process.env.PAGE_URL || 'https://www.edealinfo.com/d/local/' : target;
const html = fromFile
  ? readFileSync(target, 'utf8')
  : await (await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (DealsAnalyzer dev script)' } })).text();

const dom = new JSDOM(html, { url, runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
for (const file of ['extract.js', 'extract-page.js']) {
  dom.window.eval(readFileSync(new URL(`../extension/src/content/${file}`, import.meta.url), 'utf8'));
}
const { extractDeal, extractPageDeal } = dom.window.DealsAnalyzer;
const extracted = /(^|\.)edealinfo\.com$/.test(new URL(url).hostname)
  ? extractDeal(dom.window.document, { url })
  : extractPageDeal(dom.window.document, { url });
dom.window.close();
if (!extracted) {
  console.error('No deal found on that page.');
  process.exit(1);
}
const deal = JSON.parse(JSON.stringify(extracted));

const settings = sanitizeSettings({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.MODEL,
  effort: process.env.EFFORT,
  maxSearches: process.env.MAX_SEARCHES
});
console.error(`Analyzing "${deal.title}" ($${deal.finalPrice ?? '?'}) with ${settings.model}, effort ${settings.effort}…`);

// Prints a timeline: each search as it's issued, stage changes, and when the rating lands.
function progressLogger() {
  const started = Date.now();
  const at = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s`;
  let seen = 0;
  let stage = null;
  let rated = false;
  return ({ queries = [], stage: next, partial }) => {
    for (const q of queries.slice(seen)) console.error(`${at()}  search: ${q}`);
    seen = queries.length;
    if (next && next !== stage) console.error(`${at()}  ${(stage = next)}`);
    if (partial?.rating && !rated) {
      rated = true;
      console.error(`${at()}  rating: ${partial.rating}`);
    }
  };
}

let started = Date.now();
const result = await analyzeDeal(deal, settings, { onProgress: progressLogger() });
console.error(`Done in ${Math.round((Date.now() - started) / 1000)} s.`);
const output = { deal: deal.title, price: deal.finalPrice, ...result };

if (question) {
  console.error(`Follow-up: ${question}`);
  started = Date.now();
  const followUp = await askFollowUp(deal, question, settings, { previousResult: result, onProgress: progressLogger() });
  console.error(`Answered in ${Math.round((Date.now() - started) / 1000)} s.`);
  output.followUp = { question, answer: followUp.answer, revisedVerdict: followUp.verdict, usage: followUp.usage };
}
console.log(JSON.stringify(output, null, 2));
