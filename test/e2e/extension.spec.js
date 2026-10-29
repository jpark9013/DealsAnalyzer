// The real extension in Chromium, against saved eDealinfo pages and a stubbed
// Claude API. No network, no API key.
import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';

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
        rating: 'strong_yes',
        confidence: 'high',
        headline: 'Lowest price seen; usually $199.',
        deal_price: 159.99,
        typical_price: 199.99,
        lowest_recent_price: 159.99,
        comparable_offers: [
          { store: 'Best Buy', product: 'GIGABYTE M27Q2', price: 199.99, url: 'https://www.bestbuy.com/site/m27q2/1.p', same_product: true, condition: 'new' }
        ],
        reasons_for: ['All-time low'],
        reasons_against: []
      }
    }
  ]
};

// Serve saved eDealinfo pages, block everything else on the web, and replace
// the service worker's fetch so API calls are recorded instead of sent.
async function setUp(context, serviceWorker, { apiKey = 'sk-ant-e2e-dummy', pages = {} } = {}) {
  await context.route(/^https?:\/\//, (route) => {
    const html = pages[route.request().url()];
    return html ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort();
  });
  await serviceWorker.evaluate(
    async ({ reply, apiKey: key }) => {
      self.__apiCalls = [];
      self.fetch = async (url, init) => {
        self.__apiCalls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      await chrome.storage.local.set({ settings: key ? { apiKey: key } : {} });
    },
    { reply: API_REPLY, apiKey }
  );
}

const apiCalls = (serviceWorker) => serviceWorker.evaluate(() => self.__apiCalls);

test('rates a deal page in the side panel', async ({ context, serviceWorker }) => {
  await setUp(context, serviceWorker, { pages: { [DEAL_URL]: fixture('detail-amazon-monitor') } });
  const page = await context.newPage();
  await page.goto(DEAL_URL);

  const panel = page.locator('#deals-analyzer-root');
  await expect(panel.locator('.pill')).toHaveText('Strong yes');
  await expect(panel.locator('.headline')).toHaveText('Lowest price seen; usually $199.');
  await expect(panel.locator('.offers a')).toHaveAttribute('href', 'https://www.bestbuy.com/site/m27q2/1.p');
  await expect(panel.locator('footer')).toContainText('Haiku 5.5');

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
  await page.evaluate((html) => {
    document.getElementById('cboxLoadedContent').innerHTML = html;
  }, fixture('popup-ebay-openbox-coupon'));
  await page.getByRole('button', { name: 'Is this a good deal? Analyze' }).click();

  await expect(page.locator('#deals-analyzer-root .pill')).toHaveText('Strong yes');
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
  await page.getByLabel('Analyze automatically when I open a deal page').uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('Saved.');

  await page.reload();
  await expect(page.getByLabel('Anthropic API key')).toHaveValue('sk-ant-e2e-dummy');
  await expect(page.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('Web searches per deal (at most)')).toHaveValue('3');
  await expect(page.getByLabel('Analyze automatically when I open a deal page')).not.toBeChecked();
});
