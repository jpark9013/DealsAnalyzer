// End-to-end against the real eDealinfo site and the real Claude API, set up
// the way a user would: key entered and saved on the options page.
// Costs a few cents per run, so it only runs via `npm run test:live`, with
// ANTHROPIC_API_KEY in a local .env file. Never runs in CI.
import { test, expect } from './fixtures.js';

const LIVE_DEAL_URL =
  process.env.LIVE_DEAL_URL ||
  'https://www.edealinfo.com/d/00889523049914/GIGABYTE-M27Q2-27-inch-Widescreen-WQHD-1440p-2560-x-1440-200Hz/?ref=tg';

if (process.env.LIVE) {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url));
  } catch {
    // no .env; the skip below explains
  }
}

test.skip(!process.env.LIVE, 'Live test: run `npm run test:live`');
test.skip(!process.env.ANTHROPIC_API_KEY, 'Live test needs ANTHROPIC_API_KEY in .env');

test('rates a real eDealinfo deal with the real API', async ({ context, extensionId }) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);

  // Set the field directly rather than with fill(), so the key never shows up
  // in Playwright's action log or error output.
  await options.locator('#apiKey').evaluate((input, key) => {
    input.value = key;
  }, process.env.ANTHROPIC_API_KEY);
  await options.getByRole('button', { name: 'Test key' }).click();
  await expect(options.locator('#key-status')).toContainText('Key works', { timeout: 30_000 });
  await options.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(options.locator('#save-status')).toHaveText('Saved.');

  const page = await context.newPage();
  await page.goto(LIVE_DEAL_URL, { waitUntil: 'domcontentloaded' });
  const panel = page.locator('#deals-analyzer-root');
  await expect(panel.locator('.spinner')).toBeVisible({ timeout: 30_000 });

  const outcome = panel.locator('.pill, [role="alert"]');
  await expect(outcome.first()).toBeVisible({ timeout: 200_000 });
  const report = await panel.locator('.panel').innerText();
  console.log(`\n----- panel -----\n${report}\n-----------------`);

  if (process.env.LIVE_SCREENSHOT) {
    await panel.locator('details').evaluate((el) => (el.open = true)).catch(() => {});
    await page.screenshot({ path: process.env.LIVE_SCREENSHOT });
  }
  await expect(panel.locator('[role="alert"]')).toHaveCount(0);
  await expect(panel.locator('.pill')).toHaveText(/^(Strong no|No|Maybe|Yes|Strong yes)$/);
});
