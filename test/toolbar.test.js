import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// The service worker registers its listeners on import, so it gets a stand-in
// `chrome` that records them.
const listeners = {};
const opened = [];
const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
let analyzeTab;
let PAGE_SCRIPTS;

before(async () => {
  globalThis.chrome = {
    runtime: { onConnect: on('connect'), onMessage: on('message'), onInstalled: on('installed'), openOptionsPage: () => opened.push('options') },
    action: { onClicked: on('clicked') },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
  ({ analyzeTab, PAGE_SCRIPTS } = await import('../extension/src/background/service-worker.js'));
});

function fakeScripting({ loaded }) {
  const calls = [];
  return {
    calls,
    executeScript: async ({ target, files, func }) => {
      calls.push(files ? { tabId: target.tabId, files } : { tabId: target.tabId, func: func.toString() });
      if (func && /analyzePage\)/.test(func.toString())) return [{ result: loaded }];
      return [{ result: undefined }];
    }
  };
}

test('injects the page scripts once, then analyzes the page', async () => {
  const scripting = fakeScripting({ loaded: false });
  await analyzeTab(7, scripting);
  assert.equal(scripting.calls.length, 3);
  assert.deepEqual(scripting.calls[1], { tabId: 7, files: PAGE_SCRIPTS });
  assert.match(scripting.calls[2].func, /analyzePage\(\)/);
});

test("doesn't inject again where the scripts are already running", async () => {
  // eDealinfo pages, or a store page clicked a second time.
  const scripting = fakeScripting({ loaded: true });
  await analyzeTab(7, scripting);
  assert.equal(scripting.calls.length, 2);
  assert.ok(scripting.calls.every((c) => !c.files));
});

test('opens settings where pages cannot be scripted', async () => {
  const restricted = { executeScript: async () => { throw new Error('Cannot access a chrome:// URL'); } };
  globalThis.chrome.scripting = restricted;
  listeners.clicked({ id: 3 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(opened, ['options']);
});
