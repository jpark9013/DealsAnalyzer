// The real extension in Chromium, against saved eDealinfo pages and a stubbed
// Claude API. No network, no API key.
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { sseFromMessage } from '../helpers.js';

const fixture = (name) => readFileSync(new URL(`../fixtures/${name}.html`, import.meta.url), 'utf8');

const DEAL_URL = 'https://www.edealinfo.com/d/00889523049914/GIGABYTE-M27Q2-27-inch-Widescreen-WQHD-1440p-2560-x-1440-200Hz/';
const HOME_URL = 'https://www.edealinfo.com/';

const API_REPLY = {
  id: 'msg_e2e',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  stop_reason: 'tool_use',
  usage: { input_tokens: 9000, output_tokens: 700, server_tool_use: { web_search_requests: 2 } },
  content: [
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'GIGABYTE M27Q2 price' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: [{ type: 'web_search_result', url: 'https://www.bestbuy.com/site/m27q2/1.p', title: 'Best Buy', encrypted_content: 'x' }]
    },
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'submit_verdict',
      input: {
        specs: ['27in 1440p', '200Hz IPS'],
        deal_price: 159.99,
        same_item_price: 199.99,
        lowest_price: 159.99,
        equivalent_price: 209.99,
        rating: 'strong_yes',
        confidence: 'high',
        headline: 'Lowest price seen; usually $199.',
        offers: [{ match: 'same_item', store: 'Best Buy', product: 'GIGABYTE M27Q2', price: 199.99, condition: 'new', diff: '' }],
        pros: ['All-time low'],
        cons: []
      }
    }
  ]
};

const FOLLOW_UP_REPLY = {
  id: 'msg_e2e_2',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  stop_reason: 'end_turn',
  usage: { input_tokens: 5000, output_tokens: 200 },
  content: [
    { type: 'text', text: 'For photo work I would get the **ASUS ProArt PA278QV** at ' },
    {
      type: 'text',
      text: '$249.99',
      citations: [{ type: 'web_search_result_location', url: 'https://www.bestbuy.com/site/proart/2.p', title: 'Best Buy ProArt', cited_text: '' }]
    },
    { type: 'text', text: '.\n- Factory calibrated\n- 75Hz, so worse for games' }
  ]
};

// Serve saved eDealinfo pages, block everything else on the web, and replace
// the service worker's fetch so API calls are recorded instead of sent.
// Follow-up questions (which carry the earlier verdict) get their own reply.
async function setUp(context, serviceWorker, { apiKey = 'sk-ant-e2e-dummy', pages = {}, checkInTabs = false, apiReply = API_REPLY } = {}) {
  await context.route(/^https?:\/\//, (route) => {
    const html = pages[route.request().url()];
    return html ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort();
  });
  await serviceWorker.evaluate(
    async ({ reply, followUp, apiKey: key, checkInTabs: inTabs }) => {
      self.__apiCalls = [];
      self.fetch = async (url, init) => {
        // A store page, for the price check: every store refuses.
        if (!init?.body) return new Response('', { status: 403 });
        const body = JSON.parse(init.body);
        self.__apiCalls.push({ url: String(url), headers: init.headers, body });
        const isFollowUp = JSON.stringify(body.messages[0].content).includes('<your_verdict>');
        return new Response(isFollowUp ? followUp : reply, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      };
      await chrome.storage.local.set({ settings: key ? { apiKey: key, checkInTabs: inTabs } : {} });
    },
    { reply: sseFromMessage(apiReply), followUp: sseFromMessage(FOLLOW_UP_REPLY), apiKey, checkInTabs }
  );
}

const apiCalls = (serviceWorker) => serviceWorker.evaluate(() => self.__apiCalls);

// Pointer positions land on sub-pixel boundaries, so layout checks allow 2px.
const expectNear = (actual, expected) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);

test('rates a deal page in the side panel', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.goto(DEAL_URL);

  const panel = page.locator('#deals-analyzer-root');
  await expect(panel.locator('.pill')).toHaveText('Strong yes');
  await expect(panel.locator('.headline')).toHaveText('Lowest price seen; usually $199.');
  await expect(panel.locator('.offers a')).toHaveAttribute('href', 'https://www.bestbuy.com/site/m27q2/1.p');
  await expect(panel.locator('footer')).toContainText('Haiku 5.5');
  await expect(panel.locator('.spec')).toHaveText(['27in 1440p', '200Hz IPS']);
  await expect(panel.locator('table')).toContainText('Equivalent products$209.9924% less');

  const calls = await apiCalls(serviceWorker);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
  expect(calls[0].headers['x-api-key']).toBe('sk-ant-e2e-dummy');
  expect(calls[0].body.model).toBe('claude-haiku-5-5');
  expect(calls[0].body.messages[0].content).toContain('UPC: 889523049914');

  // Coming back to the same deal is served from the cache.
  await page.reload();
  await expect(panel.locator('footer')).toContainText('cached');
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

test('minimizes to an edge tab showing the verdict', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.goto(DEAL_URL);
  const panel = page.locator('#deals-analyzer-root');
  await expect(panel.locator('.pill')).toBeVisible();

  await panel.getByRole('button', { name: 'Minimize' }).click();
  await expect(panel.locator('.tab')).toHaveText(/Strong yes/);
  await expect(panel.locator('.panel')).toBeHidden();
  await panel.locator('.tab').click();
  await expect(panel.locator('.panel')).toBeVisible();
});

test('asks for an API key before analyzing', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { apiKey: '', pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.goto(DEAL_URL);
  await expect(page.locator('#deals-analyzer-root')).toContainText('Add your Anthropic API key');
  expect(await apiCalls(serviceWorker)).toHaveLength(0);
});

test('analyzes a deal opened in a pop-up on a listing page', async ({ context, serviceWorker }) => {
  const home = '<!doctype html><html><body><h1>Deals</h1><div id="colorbox"><div id="cboxLoadedContent"></div></div></body></html>';
  await setUp(context, serviceWorker, { pages: { [HOME_URL]: home } });
  const page = await context.newPage();
  await page.goto(HOME_URL);

  // Open the pop-up the way the site does: by injecting the deal HTML.
  // No click needed: auto-analyze is on by default.
  await page.evaluate((html) => {
    document.getElementById('cboxLoadedContent').innerHTML = html;
  }, fixture('popup-ebay-openbox-coupon'));

  await expect(page.locator('#deals-analyzer-root .pill')).toHaveText('Strong yes');
  await expect(page.getByRole('button', { name: 'Is this a good deal? Analyze' })).toBeVisible();
  const [call] = await apiCalls(serviceWorker);
  expect(call.body.messages[0].content).toContain('Condition: open box');
});

test('options page saves the API key and settings', async ({ context, extensionId }) => {
  await context.route('https://api.anthropic.com/v1/models/**', (route) =>
    route.fulfill({ json: { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' } })
  );
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);

  await page.getByLabel('Anthropic API key').fill('sk-ant-e2e-dummy');
  await page.getByRole('button', { name: 'Test key' }).click();
  await expect(page.locator('#key-status')).toContainText('Key works — Claude Haiku 5.5 is available');

  await page.getByLabel('Web searches per deal (at most)').fill('3');
  await page.getByLabel('Analyze deals automatically as soon as I open them, on every site').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('Saved.');

  await page.reload();
  await expect(page.getByLabel('Anthropic API key')).toHaveValue('sk-ant-e2e-dummy');
  await expect(page.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Web searches per deal (at most)')).toHaveValue('3');
  await expect(page.getByLabel('Analyze deals automatically as soon as I open them, on every site')).not.toBeChecked();
});

test('answers a follow-up question in the panel', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.goto(DEAL_URL);
  const panel = page.locator('#deals-analyzer-root');
  await expect(panel.locator('.pill')).toHaveText('Strong yes');

  const box = panel.getByRole('textbox', { name: 'Ask a follow-up question' });
  await box.fill('I edit photos. What would you buy?');
  await box.press('Enter');

  const reply = panel.locator('.msg.assistant');
  await expect(reply).toContainText('For photo work I would get the ASUS ProArt PA278QV at $249.99.');
  await expect(reply.locator('strong')).toHaveText('ASUS ProArt PA278QV');
  await expect(reply.locator('li')).toHaveText(['Factory calibrated', '75Hz, so worse for games']);
  await expect(reply.locator('.cites a')).toHaveAttribute('href', 'https://www.bestbuy.com/site/proart/2.p');

  const calls = await apiCalls(serviceWorker);
  expect(calls).toHaveLength(2);
  const followUp = calls[1].body;
  expect(followUp.messages).toHaveLength(1);
  expect(followUp.messages[0].content).toContain('<your_verdict>');
  expect(followUp.messages[0].content).toMatch(/Question: I edit photos\. What would you buy\?$/);

  // The chat is still there after a reload (the verdict comes from the cache).
  await page.reload();
  await expect(panel.locator('.msg.user')).toHaveText('I edit photos. What would you buy?');
  await expect(panel.locator('.msg.assistant')).toContainText('ASUS ProArt');
  expect(await apiCalls(serviceWorker)).toHaveLength(2);
});

test('the panel can be moved and resized, and remembers it', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(DEAL_URL);
  const panel = page.locator('#deals-analyzer-root .panel');
  await expect(panel.locator('.pill')).toBeVisible();
  const before = await panel.boundingBox();

  // Drag by the header.
  const header = panel.locator('header');
  const h = await header.boundingBox();
  await page.mouse.move(h.x + 40, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 40 - 400, h.y + h.height / 2 + 100, { steps: 8 });
  await page.mouse.up();
  const moved = await panel.boundingBox();
  expectNear(moved.x, before.x - 400);
  expectNear(moved.y, before.y + 100);

  // Widen from the left edge, then make it shorter from the bottom-right corner.
  const left = await panel.locator('.rz-l').boundingBox();
  await page.mouse.move(left.x + 3, left.y + 50);
  await page.mouse.down();
  await page.mouse.move(left.x - 97, left.y + 50, { steps: 8 });
  await page.mouse.up();
  const corner = await panel.locator('.rz-br').boundingBox();
  await page.mouse.move(corner.x + 7, corner.y + 7);
  await page.mouse.down();
  await page.mouse.move(corner.x + 7, corner.y - 193, { steps: 8 });
  await page.mouse.up();
  const resized = await panel.boundingBox();
  expectNear(resized.width, moved.width + 100);
  expectNear(resized.x, moved.x - 100);
  expectNear(resized.height, moved.height - 200);

  await page.reload();
  await expect(panel.locator('.pill')).toBeVisible();
  const restored = await panel.boundingBox();
  for (const k of ['x', 'y', 'width', 'height']) expectNear(restored[k], resized[k]);

  // Double-clicking the header puts it back.
  await panel.locator('header .brand').dblclick();
  const reset = await panel.boundingBox();
  expectNear(reset.x, before.x);
  expectNear(reset.width, before.width);
});

test('the minimized tab can be dragged anywhere and still opens on click', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.goto(DEAL_URL);
  const root = page.locator('#deals-analyzer-root');
  await expect(root.locator('.pill')).toBeVisible();
  await root.getByRole('button', { name: 'Minimize' }).click();

  const tab = root.locator('.tab');
  const start = await tab.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(400, 500, { steps: 10 });
  await page.mouse.up();
  const dropped = await tab.boundingBox();
  expectNear(dropped.x + dropped.width / 2, 400);
  expectNear(dropped.y + dropped.height / 2, 500);
  await expect(root.locator('.panel')).toBeHidden(); // a drag isn't a click

  await page.reload();
  await expect(tab).toBeVisible();
  const restored = await tab.boundingBox();
  expectNear(restored.x, dropped.x);
  expectNear(restored.y, dropped.y);

  await tab.click();
  await expect(root.locator('.panel')).toBeVisible();
});

test('store product pages are analyzed automatically, and revisiting one is free', async ({ context, serviceWorker }) => {
  const STORE_URL = 'https://computers.woot.com/offers/epos-adapt-160t-anc-usb-headset-0';
  await setUp(context, serviceWorker, { pages: { [STORE_URL]: fixture('store-woot-headset') } });
  const page = await context.newPage();
  await page.goto(STORE_URL);

  const panel = page.locator('#deals-analyzer-root');
  await expect(panel.locator('aside')).toBeVisible();
  await expect(panel.locator('.pill')).toHaveText('Strong yes');
  await expect(panel.locator('.deal-title')).toHaveText('EPOS Adapt 160T ANC USB Headset');
  const calls = await apiCalls(serviceWorker);
  expect(calls).toHaveLength(1);
  expect(calls[0].body.messages[0].content).toContain('Shipping: $6.00');

  await page.reload();
  await expect(panel.locator('.pill')).toHaveText('Strong yes');
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

test('a compared store that blocks the fetch is read from a background tab, which closes itself', async ({ context, serviceWorker }) => {
  const OFFER_URL = 'https://www.bestbuy.com/site/m27q2/1.p';
  const offerPage = `<!doctype html><html><head><title>GIGABYTE M27Q2 - Best Buy</title><script type="application/ld+json">${JSON.stringify({
    '@type': 'Product',
    name: 'GIGABYTE M27Q2',
    offers: { price: 169.99, priceCurrency: 'USD' }
  })}</script></head><body><h1>GIGABYTE M27Q2</h1></body></html>`;
  await setUp(context, serviceWorker, {
    checkInTabs: true,
    pages: { [DEAL_URL]: fixture('detail-amazon-monitor'), [OFFER_URL]: offerPage }
  });
  const page = await context.newPage();
  await page.goto(DEAL_URL);

  const panel = page.locator('#deals-analyzer-root');
  // The fetch was refused, so this price can only have come from the tab.
  await expect(panel.locator('.offers li').first()).toContainText('$169.99', { timeout: 20_000 });
  await expect(panel.locator('.offers .was')).toHaveText('$199.99');
  await expect(panel.locator('.offers a')).toHaveAttribute('href', OFFER_URL);
  // The shopper's page stays in front, and the helper tab closed itself.
  expect(await page.evaluate(() => document.visibilityState)).toBe('visible');
  await expect.poll(() => serviceWorker.evaluate(async (url) => (await chrome.tabs.query({ url })).length, OFFER_URL)).toBe(0);
  // The analysis and a re-rating with the new price; the helper tab's page,
  // a product page like any other, started nothing of its own.
  const calls = await apiCalls(serviceWorker);
  expect(calls).toHaveLength(2);
  expect(JSON.stringify(calls[1].body.messages[0].content)).toContain('now $169.99');
});

test('with auto-analyze off, store pages get the Deal check tab, which analyzes when clicked', async ({ context, serviceWorker }) => {
  const STORE_URL = 'https://computers.woot.com/offers/epos-adapt-160t-anc-usb-headset-0';
  await setUp(context, serviceWorker, { pages: { [STORE_URL]: fixture('store-woot-headset') } });
  await serviceWorker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, autoAnalyze: false } });
  });
  const page = await context.newPage();
  await page.goto(STORE_URL);

  const panel = page.locator('#deals-analyzer-root');
  const tab = panel.locator('.tab');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText('Deal check');
  await expect(panel.locator('aside')).toBeHidden();
  expect(await apiCalls(serviceWorker)).toHaveLength(0);

  await tab.click();
  await expect(panel.locator('.pill')).toHaveText('Strong yes');
  await expect(panel.locator('.deal-title')).toHaveText('EPOS Adapt 160T ANC USB Headset');
  const calls = await apiCalls(serviceWorker);
  expect(calls).toHaveLength(1);
  expect(calls[0].body.messages[0].content).toContain('Shipping: $6.00');
  expect(calls[0].body.messages[0].content).toContain('Store page: https://computers.woot.com/offers/epos-adapt-160t-anc-usb-headset');

  // Back on the page later, the saved verdict is on the tab without another request.
  await page.reload();
  await expect(tab).toHaveText('Strong yes');
  expect(await apiCalls(serviceWorker)).toHaveLength(1);
});

