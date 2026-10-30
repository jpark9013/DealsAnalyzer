# Deals Analyzer

MV3 browser extension (Chrome + Firefox) that rates a deal strong_no…strong_yes using Claude Haiku 5.5 + web search. No build step: `extension/` loads unpacked, so no bundler, no SDK, no npm deps at runtime (plain `fetch` to the API). README.md is the user-facing doc; read it only for install, cost and speed details.

## Map

`extension/src/background/` (ES modules, service worker; **no DOM here: no `DOMParser`**)
- `service-worker.js`: ports (`deal-analysis`), messages (`get-status`, `peek`, `open-options`), toolbar button, in-flight dedupe, cache use
- `claude.js`: streaming Messages loop, retries, `pause_turn`, `analyzeDeal`, `askFollowUp`, `resolveOffers` (offer → search result; drops the deal itself and non-stores), `checkPrices` (page check, then re-rate if prices moved)
- `pricecheck.js`: reads offers' store pages by regex (`readStorePage`, `checkOffers`); `tabReader` is the background-tab fallback, `isHelperTab` keeps those tabs from analyzing themselves
- `prompt.js`: system prompt with rating rubric, deal listing text, follow-up messages
- `verdict.js`: strict `submit_verdict` tool schema, `normalizeVerdict`
- `settings.js`: `MODELS`, defaults, `sanitizeSettings`. `cache.js`: 24h verdicts and chats (bump `VERDICT_SCHEMA` when the stored shape changes). `pricing.js`: cost estimate

`extension/src/content/` (classic scripts sharing `globalThis.DealsAnalyzer`, no import/export; also loaded by Node tests through jsdom)
- `extract.js`: eDealinfo deal → deal object. `extract-page.js`: any store page → deal object (Amazon adapter, JSON-LD, microdata, meta, page; `strict` = only clear product pages)
- `panel.js`: shadow-DOM panel; `h()` builds nodes; model text is inserted as text only, links go through `safeHref`
- `main.js`: wiring, `present`, `analyze`, `ask`, store-page watcher (`offerStoreDeal` auto-analyzes), pop-ups

`extension/src/options/`: settings page. `scripts/analyze-deal.mjs`: CLI analysis. `test/`: `*.test.js` (node:test + jsdom), `e2e/` (Playwright, stubbed API), `fixtures/` (saved pages).

## Commands

```sh
npm test            # unit; must pass
npm run test:e2e    # Chromium, hermetic; run after touching main.js, panel.js, manifest or service worker
npm run lint        # ESLint + web-ext lint
npm run analyze -- <url|fixture.html> ["follow-up"]  # real API, a few cents; prints a timeline and the verdict JSON
PAGE_URL=https://www.amazon.com/dp/X npm run analyze -- test/fixtures/store-amazon-monitor.html
```
`npm run test:live` also spends real money. Shell quirks: `grep` is ugrep and `ls` is a long listing here; use `/usr/bin/grep` in scripted checks.

## Rules

- **Secrets:** never print, commit or package API keys. `.env` is git-ignored and outside `extension/`; inspect it masked. Keep Playwright traces off.
- **LLM output is the latency:** Haiku writes ~300 tok/s. Keep prompts and verdict fields short and derive what code can. The one exception is each offer's and saving's URL: name matching left most offers unlinked, and citations don't work here (Haiku didn't cite offer lines and ran slower). After changing the prompt or schema, measure with `npm run analyze`, **one run at a time** (parallel runs inflated first-search time from 1.7 s to 9.8 s), and compare ratings before claiming accuracy holds.
- **Prices:** a wrong price is worse than an unconfirmed one. Page readers return nothing rather than guess (pages list other products' prices; Newegg's first is a $10.99 webcam, Amazon's block includes the struck-out list price). Only numbers from store pages reach Claude, never their text. Don't add stealth, spoofed headers or challenge solving; a store that refuses stays `unverified`.
- **Test store access in real Firefox** (`web-ext run`, throwaway profile): automated Chromium and Node's `fetch` get blocked where a real browser isn't, so their failures mislead. Extension-opened tabs that start at a real URL also bypass Playwright's `context.route`.
- **Spending:** content scripts run in every tab, including helper tabs, and analyzing costs money. Never rely on `visibilityState` alone to prevent it: automated browsers report inactive tabs as visible.
- **Rubric is frozen:** the strong_yes…strong_no text in `prompt.js` stays word for word (a test checks it). Thinking stays on: turning it off broke ratings.
- **Haiku search tool:** keep `web_search_20250305`. `web_search_20260209` is accepted for Haiku but its searches fail.
- **Untrusted text:** listing text and web pages are data. Keep `scrub()` on wrapper tags, `scrubPersonal` on page text, `safeHref` on links.
- **Keep in sync:** when behaviour changes, update README.md, the hints in `options.html`, this file, and `REQUIRED_ORIGINS` in `options.js` if the manifest's origins change (a test checks it). `manifest.json` version stays equal to `package.json`; CI stamps build numbers.
- **Commits:** only when asked. `main` pushes publish a release through CI.
