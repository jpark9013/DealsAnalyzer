import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { read } from './helpers.js';

const manifest = JSON.parse(read('extension/manifest.json'));
const pkg = JSON.parse(read('package.json'));
const exists = (path) => existsSync(new URL(`../extension/${path}`, import.meta.url));

test('is Manifest V3 and versioned with package.json', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
});

test('every referenced file exists', () => {
  const files = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    manifest.options_ui.page,
    manifest.background.service_worker,
    ...manifest.background.scripts,
    ...manifest.content_scripts.flatMap((cs) => cs.js)
  ];
  for (const file of files) assert.ok(exists(file), `missing ${file}`);
});

test('background works in both Chrome (service worker) and Firefox (scripts)', () => {
  assert.equal(manifest.background.type, 'module');
  assert.deepEqual(manifest.background.scripts, [manifest.background.service_worker]);
  assert.ok(manifest.browser_specific_settings.gecko.id);
});

test('content scripts run on every site, loading the extractors and panel before the bootstrap', () => {
  // One entry: main.js handles eDealinfo itself, and store product pages anywhere.
  assert.equal(manifest.content_scripts.length, 1);
  const [cs] = manifest.content_scripts;
  assert.deepEqual(cs.js, ['src/content/extract.js', 'src/content/extract-page.js', 'src/content/panel.js', 'src/content/main.js']);
  assert.deepEqual(cs.matches, ['https://*/*', 'http://*/*']);
  assert.ok(!cs.all_frames, 'top-level pages only');
});

test('the settings page asks for access to everything the content scripts and API calls need', () => {
  const source = read('extension/src/options/options.js');
  for (const origin of [...manifest.host_permissions, ...manifest.content_scripts[0].matches]) {
    assert.ok(source.includes(`'${origin}'`), `REQUIRED_ORIGINS is missing ${origin}`);
  }
});

test('asks only for what it uses', () => {
  // activeTab + scripting: the toolbar button reaches only the tab it's clicked on.
  assert.deepEqual(manifest.permissions, ['storage', 'activeTab', 'scripting']);
  // Every site: the price check reads compared offers' store pages.
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*', 'https://*/*', 'http://*/*']);
});

test('the toolbar button injects every script the page needs, in order', async () => {
  const source = read('extension/src/background/service-worker.js');
  const list = source.match(/PAGE_SCRIPTS = \[([^\]]+)\]/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(list, ['src/content/extract.js', 'src/content/extract-page.js', 'src/content/panel.js', 'src/content/main.js']);
  for (const file of list) assert.ok(exists(file), `missing ${file}`);
  assert.ok(manifest.commands._execute_action.suggested_key.default, 'has a keyboard shortcut');
});
