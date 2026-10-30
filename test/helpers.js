import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const root = new URL('../', import.meta.url);

export const read = (relPath) => readFileSync(new URL(relPath, root), 'utf8');
export const fixture = (name) => read(`test/fixtures/${name}.html`);

export const DETAIL_URL =
  'https://www.edealinfo.com/d/00889523049914/GIGABYTE-M27Q2-27-inch-Widescreen-WQHD-1440p-2560-x-1440-200Hz/?ref=tg';
export const HOME_URL = 'https://www.edealinfo.com/';

export const CONTENT_SCRIPTS = ['extension/src/content/extract.js', 'extension/src/content/panel.js', 'extension/src/content/main.js'];

/** A jsdom window with the given content scripts run in it, as the browser would inject them. */
export function makeDom(html, { url = DETAIL_URL, scripts = [], before } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  if (before) before(dom.window);
  for (const script of scripts) dom.window.eval(read(script));
  return dom;
}

/** Homepage-like document with a colorbox pop-up holding the given deal HTML. */
export function popupPage(popupHtml) {
  return `<!doctype html><html><body><div id="colorbox"><div id="cboxLoadedContent">${popupHtml}</div></div></body></html>`;
}

/** Objects made inside jsdom have another realm's prototypes; this makes them comparable. */
export const plain = (value) => JSON.parse(JSON.stringify(value));

export const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakePort(name) {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    name,
    posted: [],
    disconnected: false,
    postMessage(msg) {
      this.posted.push(plain(msg));
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    // Test-side controls: deliver a message from, or drop, the background end.
    emit: (msg) => messageListeners.forEach((fn) => fn(msg)),
    drop: () => disconnectListeners.forEach((fn) => fn())
  };
}

/** Minimal stand-in for the `chrome` API the content scripts use. */
export function fakeExtensionApi({ status = { hasKey: true, autoAnalyze: true, showOnStores: true }, stored = {}, peek = null } = {}) {
  const ports = [];
  const sent = [];
  const api = {
    runtime: {
      sendMessage: async (msg) => {
        sent.push(plain(msg));
        if (msg.type === 'get-status') return status;
        if (msg.type === 'peek') return peek;
        return undefined;
      },
      connect: ({ name }) => {
        const port = fakePort(name);
        ports.push(port);
        return port;
      }
    },
    storage: {
      local: {
        get: async (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((k) => k in stored).map((k) => [k, stored[k]]));
        },
        set: async (items) => {
          Object.assign(stored, items);
        }
      }
    }
  };
  return { api, ports, sent, stored };
}

/** In-memory chrome.storage.local for the background modules. */
export function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    }
  };
}

/**
 * A Messages API reply as the server-sent events the extension reads, built
 * the way the API streams it: text, thinking and tool inputs arrive as
 * deltas (tool inputs in two pieces), search results arrive whole.
 */
export function sseFromMessage(message) {
  const events = [];
  const send = (event) => events.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage?.input_tokens ?? 0 } } });
  (message.content || []).forEach((block, index) => {
    const delta = (d) => send({ type: 'content_block_delta', index, delta: d });
    if (block.type === 'text') {
      send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      delta({ type: 'text_delta', text: block.text });
      for (const citation of block.citations || []) delta({ type: 'citations_delta', citation });
    } else if (block.type === 'thinking') {
      send({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
      delta({ type: 'thinking_delta', thinking: block.thinking });
      delta({ type: 'signature_delta', signature: block.signature });
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      send({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      const json = JSON.stringify(block.input);
      const cut = Math.floor(json.length / 2);
      delta({ type: 'input_json_delta', partial_json: json.slice(0, cut) });
      delta({ type: 'input_json_delta', partial_json: json.slice(cut) });
    } else {
      send({ type: 'content_block_start', index, content_block: block });
    }
    send({ type: 'content_block_stop', index });
  });
  send({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_details: message.stop_details ?? null }, usage: message.usage });
  send({ type: 'message_stop' });
  return events.join('');
}

/** A sample deal, shaped like extractDeal() output. */
export function sampleDeal(overrides = {}) {
  return {
    title: '27" GIGABYTE M27Q2 WQHD 200Hz Gaming Monitor',
    productName: 'GIGABYTE M27Q2 27" WQHD 200Hz IPS Gaming Monitor (Black)',
    summary: 'Get GIGABYTE M27Q2 from Amazon.com (Sold & Shipped directly by Amazon).',
    store: 'Amazon.com',
    sellerNote: 'Sold & Shipped directly by Amazon',
    condition: 'new',
    finalPrice: 159.99,
    finalPriceText: '$159.99 + Free Shipping',
    price: 159.99,
    listPrice: 249.99,
    discount: 'Reflected in sale price',
    couponCode: null,
    shipping: 'Free',
    extraRows: {},
    notes: [],
    upc: '889523049914',
    model: 'M27Q2',
    asin: 'B0GKFQXR3R',
    merchant: 'amazon',
    dealDate: '2026-10-29',
    publishedAt: '10/29/2026 17:16 PM ET',
    priceHistory: [{ date: '10/29/26', price: 159.99 }],
    comparisons: [],
    imageUrl: null,
    dealLink: 'https://www.edealinfo.com/cgi-bin/amazonsp.cgi?B0GKFQXR3R',
    pageUrl: 'https://www.edealinfo.com/d/00889523049914/GIGABYTE-M27Q2',
    key: '889523049914|2026-10-29|159.99',
    ...overrides
  };
}
