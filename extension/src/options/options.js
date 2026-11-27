import { MODELS, loadSettings, saveSettings, isEnglish } from '../background/settings.js';
import { testApiKey } from '../background/claude.js';
import { pruneCache } from '../background/cache.js';

const ext = globalThis.browser ?? globalThis.chrome;
const storage = ext.storage.local;
// The API, the pages the content scripts run on (any store's product page), and
// the store pages the price check reads.
const REQUIRED_ORIGINS = ['https://api.anthropic.com/*', 'https://*/*', 'http://*/*'];

const $ = (id) => document.getElementById(id);
const form = $('settings');

function setStatus(el, message, kind) {
  el.textContent = message;
  el.className = `status${kind ? ` ${kind}` : ''}`;
}

const groupBoxes = () => [...document.querySelectorAll('#discountGroups input[type="checkbox"]')];

function readLanguage() {
  const choice = $('language-choice').value;
  return choice === '__other' ? $('language-other').value : choice;
}

function showLanguage(language) {
  const known = [...$('language-choice').options].some((o) => o.value === language);
  $('language-choice').value = known ? language : '__other';
  $('language-other').value = known ? '' : language;
  $('language-other').hidden = known;
}

function readForm() {
  return {
    apiKey: $('apiKey').value,
    model: $('model').value,
    effort: $('effort').value,
    maxSearches: $('maxSearches').value,
    autoAnalyze: $('autoAnalyze').checked,
    showOnStores: $('showOnStores').checked,
    checkInTabs: $('checkInTabs').checked,
    language: readLanguage(),
    detail: $('detail').value,
    findDiscounts: $('findDiscounts').checked,
    discountGroups: groupBoxes().filter((b) => b.checked).map((b) => b.value),
    analyzeLists: $('analyzeLists').checked
  };
}

function fillForm(settings) {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('effort').value = settings.effort;
  $('maxSearches').value = settings.maxSearches;
  $('autoAnalyze').checked = settings.autoAnalyze;
  $('showOnStores').checked = settings.showOnStores;
  $('checkInTabs').checked = settings.checkInTabs;
  showLanguage(settings.language);
  $('detail').value = settings.detail;
  $('findDiscounts').checked = settings.findDiscounts;
  for (const box of groupBoxes()) box.checked = settings.discountGroups.includes(box.value);
  $('analyzeLists').checked = settings.analyzeLists;
}

// --- This page in the chosen language -------------------------------------
// Elements holding only text (labels, options, headings, plain hints) are
// translated; ones mixing text with links or emphasis stay in English rather
// than be stitched from fragments. The language names in the list are left
// as they are, written in their own language.
const english = new Map();

function translatable() {
  const out = [];
  for (const el of document.querySelectorAll('main *')) {
    if (el.closest('#language-choice, .status, script, style, kbd, code')) continue;
    if (el.children.length || !el.textContent.trim()) continue;
    out.push(el);
  }
  return out;
}

async function translatePage(language) {
  const els = translatable();
  for (const el of els) if (!english.has(el)) english.set(el, el.textContent);
  if (isEnglish(language)) {
    for (const [el, text] of english) el.textContent = text;
    document.documentElement.lang = 'en';
    return;
  }
  const reply = await ext.runtime.sendMessage({ type: 'translate', texts: els.map((el) => english.get(el).replace(/\s+/g, ' ').trim()) });
  if (!reply?.texts) throw new Error(reply?.error?.message || 'Translation failed.');
  els.forEach((el, i) => (el.textContent = reply.texts[i]));
}

// The panel's words too, so the first product page doesn't wait for them.
async function translatePanel() {
  const ns = globalThis.DealsAnalyzer;
  if (!ns?.STRINGS) return;
  await ext.runtime.sendMessage({ type: 'translate', texts: ns.STRING_KEYS.map((key) => ns.STRINGS[key]) });
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
  const initial = await loadSettings(storage);
  fillForm(initial);
  await checkPermissions();
  if (!isEnglish(initial.language)) translatePage(initial.language).catch(() => {});

  $('language-choice').addEventListener('change', () => {
    const other = $('language-choice').value === '__other';
    $('language-other').hidden = !other;
    if (other) $('language-other').focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const before = await loadSettings(storage);
    const saved = await saveSettings(storage, readForm());
    fillForm(saved);
    if (saved.language !== before.language || (!isEnglish(saved.language) && saved.apiKey && !before.apiKey)) {
      if (!isEnglish(saved.language) && saved.apiKey) setStatus($('save-status'), `Saved. Translating into ${saved.language}…`);
      try {
        await Promise.all([translatePage(saved.language), isEnglish(saved.language) ? null : translatePanel()]);
      } catch (err) {
        setStatus($('save-status'), `Saved, but translating failed: ${err.message}`, 'err');
        return;
      }
    }
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
