# Deals Analyzer for eDealinfo

A browser extension that tells you whether a deal on [eDealinfo.com](https://www.edealinfo.com) is actually worth it. It has Claude Haiku 5.5 search the web for what the same product, and similar products, sell for right now, then rates the deal:

**Strong no · No · Maybe · Yes · Strong yes**

<img src="docs/panel.png" alt="The Deal check side panel rating a monitor deal as Maybe" width="348" align="right">

The verdict appears in a panel on the right side of the page with:

- the price compared with the typical and lowest recent price elsewhere
- comparable offers, either the same item at other stores or similar products (links appear only when the URL came from a real search result)
- reasons to buy and to skip
- the searches Claude ran and the sources it saw
- the model used and what the analysis cost

It works on deal pages (`/d/...`) and on the deal pop-ups on listing pages, which get an **"Is this a good deal? Analyze"** button. Minimize the panel and it shrinks to a tab on the edge of the screen showing the rating.

<br clear="right">

## Install (unpacked)

You need an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

Download `deals-analyzer-<version>.zip` from the latest release on the repo's **Releases** page. Every push to `main` that passes CI publishes a new one. To run straight from a clone instead, use the **`extension/`** folder (not the repo root) wherever the steps below say "the unzipped folder" or "the zip".

**Chrome / Edge / Brave**
1. Unzip the download.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. The settings page opens. Paste your API key, click **Test key** (free), then **Save**.

**Firefox** (142 or later)
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick the zip itself, or `manifest.json` inside the folder.
3. Open the extension's settings: click the puzzle-piece toolbar button, then **Deals Analyzer for eDealinfo**. Paste your key and save. If the page shows **Grant access**, click it.

Temporary add-ons in Firefox are removed when Firefox restarts. From a clone, `npm run start:firefox` opens a separate Firefox window with the extension installed and a profile that remembers your key.

**Updating in Chrome without re-entering your key:** unzip the new release into the *same* folder, replacing the files, then click the reload button on the extension's card in `chrome://extensions`. Chrome identifies an unpacked extension by its folder, so loading from a different folder gives you a fresh copy with empty settings.

Then open any eDealinfo deal.

## Settings

Click the toolbar icon or ⚙ in the panel.

| Setting | Default | Notes |
|---|---|---|
| API key | — | Stored in `chrome.storage.local` in this browser only; sent only to `api.anthropic.com`. |
| Model | Claude Haiku 5.5 | Sonnet 5.5 is more thorough at roughly 20× the cost. |
| Effort | Medium | Low is cheaper and faster but may search less. |
| Web searches per deal | 5 | Upper limit; Claude often needs fewer. $0.01 each. |
| Analyze automatically | On | When off, the panel shows an **Analyze deal** button. |

Verdicts are cached for 24 hours per deal, so revisiting a deal is free. **Re-analyze** forces a fresh one.

## Cost

With Haiku 5.5 a typical analysis costs **about $0.02–$0.07**, mostly for web searches ($0.01 each); tokens cost $0.10 per million in and $0.50 per million out. A live run on the GIGABYTE M27Q2 deal used 2 searches and cost about $0.024. The panel footer shows an estimate for every analysis.

## How it works

```
eDealinfo page ──► content scripts ──(port)──► background service worker ──► Claude Messages API
                   extract.js: read deal         claude.js: Haiku 5.5 + web_search
                   panel.js:   side panel        verdict.js: strict submit_verdict tool
                   main.js:    wiring            cache.js: 24h verdict cache
```

- **`extension/src/content/extract.js`**: reads the deal from the page: title, product, store and seller, condition (new, open box, refurbished, used), final price, the "Reg" price, coupon code, shipping, UPC, model number, ASIN, eDealinfo's price-comparison prices, and its price history for the item.
- **`extension/src/background/claude.js`**: calls `POST /v1/messages` with the `web_search` tool and a strict `submit_verdict` tool that structures the answer. It resumes `pause_turn` responses, retries 429/5xx errors, and handles refusals.
- **`extension/src/background/prompt.js`**: the rating rubric. It judges against real current street prices rather than inflated list prices, and accounts for condition, seller, coupons, and cheaper alternatives.
- The panel lives in a shadow DOM and inserts model output only as text.

The extension calls the API with plain `fetch` rather than the Anthropic SDK, so it loads unpacked with no build step.

## Privacy

When a deal is analyzed, its details (title, price, store, model number, the page URL) are sent to Anthropic's API, which runs the web searches. Nothing else from your browsing is sent. Your API key never reaches the eDealinfo page; only the background worker uses it.

## Development

```sh
npm install
npm test               # unit tests: extractor on saved eDealinfo pages, API loop with a mocked fetch, panel in jsdom
npm run test:e2e       # loads the extension in Chromium against saved pages and a stubbed API (run `npx playwright install chromium` once)
npm run lint           # ESLint + Mozilla's web-ext lint
npm run canary         # checks that today's live eDealinfo deals still parse
npm run package        # builds dist/*.zip from extension/
```

**Live test.** `npm run test:live` loads the extension, enters the key from a local `.env` on the settings page, opens a real eDealinfo deal, and waits for a real verdict. It costs a few cents per run.

```sh
cp .env.example .env   # then set ANTHROPIC_API_KEY=...
npm run test:live
```

`.env` is git-ignored and sits outside `extension/`, so it is never packaged or loaded by the browser. Keep it that way.

**Test fixtures.** `test/fixtures/` holds real eDealinfo pages (scripts and ads removed): an Amazon deal, an open-box eBay deal with a coupon, a refurbished deal without a UPC, a pop-up, and a promo pop-up that has no price. If the canary fails, save a fresh page there, update `extract.js`, and extend `test/extract.test.js`.

### CI

- **`.github/workflows/ci.yml`** (every push and PR): lint, unit tests, the Chromium end-to-end tests, then a packaged zip uploaded as a build artifact. It needs no secrets. On pushes to `main` that pass, it also publishes a GitHub release `v1.0.<run number>` with the zip attached (the build number is stamped into the manifest by `scripts/set-build-version.mjs`).
- **`.github/workflows/site-canary.yml`** (weekly, or run by hand): checks live eDealinfo pages still parse.
