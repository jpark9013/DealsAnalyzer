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

test('content scripts load the extractor and panel before the bootstrap', () => {
  const [cs] = manifest.content_scripts;
  assert.deepEqual(cs.js, ['src/content/extract.js', 'src/content/panel.js', 'src/content/main.js']);
  assert.ok(cs.matches.includes('https://www.edealinfo.com/*'));
});

test('asks only for what it uses', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://api.anthropic.com/*']);
});
