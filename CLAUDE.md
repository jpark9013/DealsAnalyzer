# Deals Analyzer

MV3 browser extension (Chrome + Firefox) that rates a deal strong_no…strong_yes using Claude Haiku 5.5 + web search. No build step: `extension/` loads unpacked, so no bundler, no SDK, no npm deps at runtime (plain `fetch` to the API). README.md is the user-facing doc; read it only for install, cost and speed details.

## Map

`extension/src/background/` (ES modules, service worker; **no DOM here: no `DOMParser`**)
- `service-worker.js`: ports (`deal-analysis` for analyze/ask/discounts, `deal-list` for list-page products, queued 3 at a time), messages (`get-status`, `peek`, `translate`, `open-options`), toolbar button, in-flight dedupe, cache use (`lookup`: a detailed verdict also serves a simple request)
- `claude.js`: streaming Messages loop, retries, `pause_turn`, `analyzeDeal`, `askFollowUp`, `analysisMode` (simple / list / savings), `resolveOffers` (offer → search result; drops the deal itself, non-stores, articles, foreign stores), `checkPrices` (page check, started early via `onOffers` while the verdict streams; re-rates at low effort if prices moved, an offer went, a lower price wasn't confirmed, or a "no" lists nothing cheaper)
- `pricecheck.js`: reads offers' store pages by regex (`readStorePage`, `checkOffers`, `prefetchOffers`): ended listings, buy-box stock, condition, currency/country, aggregate and variant prices (`loose`, `confirmOnly`); `tabReader` is the background-tab fallback (cheaper-than-deal offers first), `isHelperTab` keeps those tabs from analyzing themselves
- `confidence.js`: `assessConfidence` (scored from the checks, not asked of Claude) and `priceSupport` (which lower prices a page backed up)
- `prompt.js`: system prompt with rating rubric (simple, savings and language variants), deal listing text, follow-up and recheck messages
- `verdict.js`: strict `submit_verdict` tool schemas (`verdictTool({simple, savings})`, `revisionTool`), `normalizeVerdict`, `normalizeSimpleVerdict` (same shape; its two prices are its two offers)
- `discounts.js`: separate discount search (`findDiscounts`, own `submit_discounts` tool), cached per store+brand. `translate.js`: translates UI strings once per language, as numbered lines
- `settings.js`: `MODELS`, defaults, `sanitizeSettings`, `profileOf` (cache key part: model, detail, language). `cache.js`: 24h verdicts, chats, discounts (bump `VERDICT_SCHEMA` when the stored shape changes). `pricing.js`: cost estimate

`extension/src/content/` (classic scripts sharing `globalThis.DealsAnalyzer`, no import/export; also loaded by Node tests through jsdom)
- `strings.js` (loads first): every UI string, `t(key, vars)`, `setStrings` for translations. Add new panel/badge text here, not inline
- `extract.js`: eDealinfo deal → deal object. `extract-page.js`: any store page → deal object (Amazon adapter, JSON-LD, microdata, meta, page; `strict` = only clear product pages). `extract-list.js`: list page → `[{el, deal}]` (Amazon and eDealinfo adapters, else repeated priced tiles)
- `panel.js`: shadow-DOM panel; `h()` builds nodes; model text is inserted as text only, links go through `safeHref`; `ns.ui` shares helpers with `badges.js` (list-mode badges and their port)
- `main.js`: wiring, `present`, `analyze`, `ask`, `requestDiscounts` (after the analysis's searches), `loadStrings`, store-page watcher (`offerStoreDeal` auto-analyzes), `watchLists`, pop-ups

`extension/src/options/`: settings page. `scripts/analyze-deal.mjs`: CLI analysis. `scripts/publish-chrome.mjs`: Chrome Web Store upload and submit (API v2, service account; CI job runs only by hand). `test/`: `*.test.js` (node:test + jsdom), `e2e/` (Playwright, stubbed API), `fixtures/` (saved pages).

## Commands

```sh
npm test            # unit; must pass
npm run test:e2e    # Chromium, hermetic; run after touching main.js, panel.js, manifest or service worker
npm run lint        # ESLint + web-ext lint
npm run package     # dist/*.zip of extension/ only, less extension/screenshots/ (store-listing art); scripts/check-package.mjs fails it on any difference
npm run publish:chrome -- [zip] [--upload-only|--staged|--cancel-pending]  # real store submission of the newest zip in dist/ (or [zip]); needs CWS_* in .env and a version newer than the store's
npm run analyze -- <url|fixture.html> ["follow-up"]  # real API, a few cents; prints a timeline and the verdict JSON
PAGE_URL=https://www.amazon.com/dp/X npm run analyze -- test/fixtures/store-amazon-monitor.html
DETAIL=simple LANGUAGE=Español LIST=1 DISCOUNTS=1 GROUPS=student npm run analyze -- ...  # the other modes
```
`npm run test:live` also spends real money. Shell quirks: `grep` is ugrep and `ls` is a long listing here; use `/usr/bin/grep` in scripted checks.

## Rules

- **Secrets:** never print, commit or package API keys. `.env` is git-ignored and outside `extension/`; inspect it masked. Keep Playwright traces off.
- **LLM output is the latency:** Haiku writes ~300 tok/s. Keep prompts and verdict fields short and derive what code can. The one exception is each offer's and saving's URL: name matching left most offers unlinked, and citations don't work here (Haiku didn't cite offer lines and ran slower). After changing the prompt or schema, measure with `npm run analyze`, **one run at a time** (parallel runs inflated first-search time from 1.7 s to 9.8 s), and compare ratings before claiming accuracy holds. The same contention is why the discount search starts only after the analysis's searches are back (side by side, the first search took 7 s instead of 3). Confidence isn't in the schema: Haiku said "medium" regardless; `confidence.js` derives it.
- **Prices:** a wrong price is worse than an unconfirmed one. Page readers return nothing rather than guess (pages list other products' prices; Newegg's first is a $10.99 webcam, Amazon's block includes the struck-out list price). Only numbers from store pages reach Claude, never their text. Don't add stealth, spoofed headers or challenge solving; a store that refuses stays `unverified`.
- **Test store access in real Firefox** (`web-ext run`, throwaway profile): automated Chromium and Node's `fetch` get blocked where a real browser isn't, so their failures mislead. Extension-opened tabs that start at a real URL also bypass Playwright's `context.route`.
- **Spending:** content scripts run in every tab, including helper tabs, and analyzing costs money. Never rely on `visibilityState` alone to prevent it: automated browsers report inactive tabs as visible. List mode is off by default, rates only tiles in view, caps at 40 per page, and never opens helper tabs.
- **"Cheaper elsewhere" must be real:** the shopper's top complaint was lower prices that didn't exist or had expired. A lower price no store page confirmed is marked and not rated on (`priceSupport`, recheck); articles, foreign stores, ended listings and condition mismatches are dropped. Prefer leaving a price unconfirmed to showing a doubtful one.
- **Rubric is frozen:** the strong_yes…strong_no text in `prompt.js` stays word for word (a test checks it). Thinking stays on: turning it off broke ratings.
- **Haiku search tool:** keep `web_search_20250305`. `web_search_20260209` is accepted for Haiku but its searches fail.
- **Untrusted text:** listing text and web pages are data. Keep `scrub()` on wrapper tags, `scrubPersonal` on page text, `safeHref` on links.
- **Keep in sync:** when behaviour changes, update README.md, the hints in `options.html`, this file, and `REQUIRED_ORIGINS` in `options.js` if the manifest's origins change (a test checks it). `manifest.json` version stays equal to `package.json`; CI stamps build numbers.
- **Commits:** only when asked. `main` pushes publish a release through CI: the zip is the asset; GitHub's own "Source code" links are always the whole repo and can't be removed.
