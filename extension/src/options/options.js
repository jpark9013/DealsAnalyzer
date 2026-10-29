import { MODELS, loadSettings, saveSettings } from '../background/settings.js';
import { testApiKey } from '../background/claude.js';
import { pruneCache } from '../background/cache.js';

const ext = globalThis.browser ?? globalThis.chrome;
const storage = ext.storage.local;
const REQUIRED_ORIGINS = ['https://api.anthropic.com/*', 'https://www.edealinfo.com/*'];

const $ = (id) => document.getElementById(id);
const form = $('settings');

function setStatus(el, message, kind) {
  el.textContent = message;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

function readForm() {
  return {
    apiKey: $('apiKey').value,
    model: $('model').value,
    effort: $('effort').value,
    maxSearches: $('maxSearches').value,
    autoAnalyze: $('autoAnalyze').checked
  };
}

function fillForm(settings) {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('effort').value = settings.effort;
  $('maxSearches').value = settings.maxSearches;
  $('autoAnalyze').checked = settings.autoAnalyze;
}

async function checkPermissions() {
  // Firefox can leave host permissions ungranted; Chrome grants them at install.
  if (!ext.permissions?.contains) return;
  const granted = await ext.permissions.contains({ origins: REQUIRED_ORIGINS });
  $('permission-warning').hidden = granted;
}

async function init() {
  for (const [id, info] of Object.entries(MODELS)) {
    $('model').append(new Option(info.label, id));
  }
  fillForm(await loadSettings(storage));
  await checkPermissions();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saved = await saveSettings(storage, readForm());
    fillForm(saved);
    setStatus($('save-status'), 'Saved.', 'ok');
    setTimeout(() => setStatus($('save-status'), ''), 2500);
  });

  $('toggle-key').addEventListener('click', (event) => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? 'Hide' : 'Show';
    event.currentTarget.setAttribute('aria-pressed', String(show));
  });

  $('test-key').addEventListener('click', async () => {
    const status = $('key-status');
    setStatus(status, 'Checking…');
    try {
      const { displayName } = await testApiKey($('apiKey').value.trim(), $('model').value);
      setStatus(status, `Key works — ${displayName} is available. Remember to save.`, 'ok');
    } catch (err) {
      setStatus(status, err.message, 'err');
    }
  });

  $('clear-cache').addEventListener('click', async () => {
    const removed = await pruneCache(storage, Date.now(), { all: true });
    setStatus($('cache-status'), `Cleared ${removed} saved result${removed === 1 ? '' : 's'}.`, 'ok');
  });

  $('grant').addEventListener('click', async () => {
    await ext.permissions.request({ origins: REQUIRED_ORIGINS });
    await checkPermissions();
  });
}

init();
