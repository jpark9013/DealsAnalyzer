// The side panel that shows the verdict. Lives in a shadow root so the site's
// CSS can't reach it. Model output is only ever inserted as text.
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});

  const RATING_LABELS = {
    strong_no: 'Strong no',
    no: 'No',
    maybe: 'Maybe',
    yes: 'Yes',
    strong_yes: 'Strong yes'
  };
  const RATING_ORDER = Object.keys(RATING_LABELS);

  const MODEL_LABELS = {
    'claude-haiku-5-5': 'Haiku 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5'
  };

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel {
      position: fixed; top: 88px; right: 16px; z-index: 2147483000;
      width: 348px; max-height: calc(100vh - 112px); overflow: auto;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(31, 35, 40, .18);
    }
    [hidden] { display: none !important; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      border-bottom: 1px solid #eaeef2; position: sticky; top: 0; background: #fff; z-index: 1;
    }
    header .brand { font-weight: 650; flex: 1; }
    button { font: inherit; cursor: pointer; }
    .icon-btn {
      border: 0; background: transparent; color: #57606a; width: 28px; height: 28px;
      border-radius: 6px; font-size: 18px; line-height: 1;
    }
    .icon-btn:hover { background: #f3f4f6; color: #1f2328; }
    /* minmax(0, …) lets long one-line product names ellipsize instead of widening the panel. */
    .body { padding: 12px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .deal-title { font-weight: 600; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .muted { color: #57606a; }
    .small { font-size: 12px; }
    .verdict { display: grid; gap: 8px; }
    .verdict-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .pill {
      display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 700;
      font-size: 15px; letter-spacing: .02em; text-transform: uppercase; color: #fff;
    }
    .r-strong_no { background: #b42318; color: #fff; }
    .r-no { background: #d9480f; color: #fff; }
    .r-maybe { background: #f2c94c; color: #3d2f00; }
    .r-yes { background: #2f9e44; color: #fff; }
    .r-strong_yes { background: #0b6e3a; color: #fff; }
    .headline { font-size: 14px; }
    .scale { display: grid; grid-template-columns: repeat(5, 1fr); gap: 3px; }
    .seg { height: 6px; border-radius: 3px; }
    /* Zero-specificity defaults, so the .r-* rating colors always win. */
    :where(.seg) { background: #eaeef2; }
    :where(.dot) { background: #8c959f; }
    .scale-labels { display: grid; grid-template-columns: repeat(5, 1fr); font-size: 10px; color: #6e7781; text-align: center; }
    .scale-labels .on { color: #1f2328; font-weight: 700; }
    h3 { margin: 0 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #57606a; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 3px 0; vertical-align: top; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
    .delta { font-size: 11px; font-weight: 600; margin-left: 4px; }
    .good { color: #1a7f37; } .bad { color: #b42318; }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 2px 0; }
    .offers li { list-style: none; margin-left: -18px; padding: 6px 0; border-top: 1px solid #f0f2f4; display: flex; gap: 8px; }
    .offers li:first-child { border-top: 0; }
    .offers .what { flex: 1; min-width: 0; }
    .offers .store { font-weight: 600; }
    .offers .prod { color: #57606a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: #eef1f4; color: #57606a; margin-left: 4px; font-weight: 600; }
    .tag.same { background: #ddf4ff; color: #0969da; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .reasons { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
    details summary { cursor: pointer; color: #57606a; font-size: 12px; }
    details ul { margin-top: 6px; font-size: 12px; }
    footer {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid #eaeef2;
      font-size: 11px; color: #6e7781;
    }
    footer .meta { flex: 1; }
    .btn {
      border: 1px solid #d0d7de; background: #f6f8fa; color: #1f2328; border-radius: 6px; padding: 5px 10px; font-size: 12px; font-weight: 600;
    }
    .btn:hover { background: #eef1f4; }
    .btn.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
    .btn.primary:hover { background: #1a5fd0; }
    .notice { padding: 10px; border-radius: 8px; background: #f6f8fa; display: grid; gap: 8px; }
    .notice.error { background: #fff1f0; color: #82071e; }
    .spinner {
      width: 16px; height: 16px; border: 2px solid #d0d7de; border-top-color: #1f6feb; border-radius: 50%;
      animation: spin .8s linear infinite; flex: none;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading { display: flex; gap: 10px; align-items: flex-start; }
    .tab {
      position: fixed; right: 0; top: 140px; z-index: 2147483000; writing-mode: vertical-rl;
      border: 1px solid #d0d7de; border-right: 0; border-radius: 10px 0 0 10px; background: #fff;
      padding: 12px 6px; font: 700 12px system-ui, sans-serif; color: #1f2328; letter-spacing: .04em;
      box-shadow: 0 4px 14px rgba(31, 35, 40, .15); display: flex; align-items: center; gap: 8px;
    }
    .tab .dot { width: 10px; height: 10px; border-radius: 50%; }
    @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  `;

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function money(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function safeHref(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
      return null;
    }
  }

  function link(url, label) {
    const href = safeHref(url);
    return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, label) : label;
  }

  function timeAgo(iso) {
    const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
    return `${Math.round(seconds / 86400)} d ago`;
  }

  // "27% less than typical" / "8% more than typical"
  function deltaVs(dealPrice, reference) {
    if (!reference || typeof dealPrice !== 'number') return null;
    const pct = Math.round(((reference - dealPrice) / reference) * 100);
    if (pct === 0) return h('span', { class: 'delta muted' }, 'same');
    return pct > 0
      ? h('span', { class: 'delta good' }, `${pct}% less`)
      : h('span', { class: 'delta bad' }, `${-pct}% more`);
  }

  function renderScale(rating) {
    const active = RATING_ORDER.indexOf(rating);
    return h(
      'div',
      { 'aria-hidden': 'true' },
      h(
        'div',
        { class: 'scale' },
        RATING_ORDER.map((r, i) => h('div', { class: `seg${i === active ? ` r-${r}` : ''}` }))
      ),
      h(
        'div',
        { class: 'scale-labels' },
        RATING_ORDER.map((r, i) => h('span', { class: i === active ? 'on' : '' }, RATING_LABELS[r]))
      )
    );
  }

  function renderVerdict(result) {
    const v = result.verdict;
    const priceRows = [
      h('tr', null, h('td', null, 'This deal'), h('td', { class: 'num' }, money(v.dealPrice)))
    ];
    if (v.typicalPrice !== null) {
      priceRows.push(
        h(
          'tr',
          null,
          h('td', null, 'Typical price elsewhere'),
          h('td', { class: 'num' }, money(v.typicalPrice), deltaVs(v.dealPrice, v.typicalPrice))
        )
      );
    }
    if (v.lowestRecentPrice !== null) {
      priceRows.push(
        h('tr', null, h('td', null, 'Lowest recent price'), h('td', { class: 'num' }, money(v.lowestRecentPrice)))
      );
    }

    const offers = v.comparableOffers.length
      ? h(
          'section',
          null,
          h('h3', null, 'Compared with'),
          h(
            'ul',
            { class: 'offers' },
            v.comparableOffers.map((o) =>
              h(
                'li',
                null,
                h(
                  'div',
                  { class: 'what' },
                  h(
                    'div',
                    null,
                    h('span', { class: 'store' }, o.verified ? link(o.url, o.store) : o.store),
                    h('span', { class: `tag${o.sameProduct ? ' same' : ''}` }, o.sameProduct ? 'same item' : 'similar'),
                    o.condition && o.condition !== 'new' ? h('span', { class: 'tag' }, o.condition) : null
                  ),
                  o.product ? h('div', { class: 'prod', title: o.product }, o.product) : null
                ),
                h('div', { class: 'num' }, money(o.price))
              )
            )
          )
        )
      : null;

    const reasons =
      v.reasonsFor.length || v.reasonsAgainst.length
        ? h(
            'div',
            { class: 'reasons' },
            h('section', null, h('h3', null, 'Why buy'), h('ul', null, v.reasonsFor.map((r) => h('li', null, r)))),
            h('section', null, h('h3', null, 'Why skip'), h('ul', null, v.reasonsAgainst.map((r) => h('li', null, r))))
          )
        : null;

    const research =
      result.queries.length || result.sources.length
        ? h(
            'details',
            null,
            h(
              'summary',
              null,
              `${result.queries.length} search${result.queries.length === 1 ? '' : 'es'}, ${result.sources.length} source${result.sources.length === 1 ? '' : 's'}`
            ),
            result.queries.length ? h('ul', null, result.queries.map((q) => h('li', null, `“${q}”`))) : null,
            result.sources.length ? h('ul', null, result.sources.map((s) => h('li', null, link(s.url, s.title)))) : null
          )
        : null;

    return [
      h(
        'section',
        { class: 'verdict', 'data-rating': v.rating },
        h(
          'div',
          { class: 'verdict-row' },
          h('span', { class: `pill r-${v.rating}` }, RATING_LABELS[v.rating]),
          h('span', { class: 'muted small' }, `${v.confidence} confidence`)
        ),
        h('div', { class: 'headline' }, v.headline),
        renderScale(v.rating)
      ),
      h('section', null, h('h3', null, 'Price check'), h('table', null, h('tbody', null, priceRows))),
      offers,
      reasons,
      research
    ];
  }

  /**
   * @param {{onAnalyze: (force: boolean) => void, onOpenSettings: () => void,
   *          onCollapseChange?: (collapsed: boolean) => void}} handlers
   */
  function createPanel(handlers) {
    const host = h('div', { id: 'deals-analyzer-root' });
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const titleEl = h('div', { class: 'deal-title' });
    const subEl = h('div', { class: 'muted small' });
    const contentEl = h('div', { class: 'body-content', 'aria-live': 'polite' });
    const metaEl = h('span', { class: 'meta' });
    const reanalyzeBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => handlers.onAnalyze(true) }, 'Re-analyze');
    const footer = h('footer', { hidden: true }, metaEl, reanalyzeBtn);

    const tabDot = h('span', { class: 'dot' });
    const tabLabel = h('span', null, 'Deal check');
    const tab = h('button', { class: 'tab', type: 'button', hidden: true, 'aria-label': 'Show deal analysis', onclick: () => setCollapsed(false) }, tabDot, tabLabel);

    const panel = h(
      'aside',
      { class: 'panel', role: 'complementary', 'aria-label': 'Deal analysis', hidden: true },
      h(
        'header',
        null,
        h('span', { class: 'brand' }, 'Deal check'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: () => handlers.onOpenSettings() }, '⚙'),
        h('button', { class: 'icon-btn', type: 'button', title: 'Minimize', 'aria-label': 'Minimize', onclick: () => setCollapsed(true) }, '–')
      ),
      h('div', { class: 'body' }, h('div', null, titleEl, subEl), contentEl),
      footer
    );

    shadow.append(style, panel, tab);
    document.documentElement.append(host);

    let timer = null;
    let collapsed = false;
    let visible = false;

    function setCollapsed(next) {
      collapsed = next;
      panel.hidden = !visible || collapsed;
      tab.hidden = !visible || !collapsed;
      if (handlers.onCollapseChange) handlers.onCollapseChange(collapsed);
    }

    function setTab(rating) {
      tabDot.className = `dot${rating ? ` r-${rating}` : ''}`;
      tabLabel.textContent = rating ? RATING_LABELS[rating] : 'Deal check';
    }

    function setContent(...nodes) {
      if (timer) clearInterval(timer);
      timer = null;
      contentEl.replaceChildren(...nodes.flat().filter(Boolean));
    }

    function setFooter(result) {
      footer.hidden = !result;
      reanalyzeBtn.hidden = !result;
      if (!result) return;
      const parts = [MODEL_LABELS[result.model] || result.model];
      if (typeof result.usage?.costUsd === 'number') parts.push(`~$${result.usage.costUsd.toFixed(3)}`);
      parts.push(result.cached ? `cached, ${timeAgo(result.analyzedAt)}` : timeAgo(result.analyzedAt));
      metaEl.textContent = parts.join(' · ');
    }

    return {
      host,
      shadow,
      show({ collapsed: startCollapsed = false } = {}) {
        visible = true;
        setCollapsed(startCollapsed);
      },
      setDeal(deal) {
        titleEl.textContent = deal.title || deal.productName || 'This deal';
        titleEl.title = deal.productName || '';
        subEl.textContent = [money(deal.finalPrice), deal.store && `at ${deal.store}`, deal.condition !== 'new' && deal.condition]
          .filter(Boolean)
          .join(' · ');
      },
      showIdle() {
        setTab(null);
        setFooter(null);
        setContent(
          h(
            'div',
            { class: 'notice' },
            h('div', null, 'Check this deal against current prices at other stores.'),
            h('div', null, h('button', { class: 'btn primary', type: 'button', onclick: () => handlers.onAnalyze(false) }, 'Analyze deal'))
          )
        );
      },
      showNeedsKey() {
        setTab(null);
        setFooter(null);
        setContent(
          h(
            'div',
            { class: 'notice' },
            h('div', null, 'Add your Anthropic API key to start rating deals. It stays in this browser.'),
            h('div', null, h('button', { class: 'btn primary', type: 'button', onclick: () => handlers.onOpenSettings() }, 'Open settings'))
          )
        );
      },
      showLoading(queries = []) {
        setTab(null);
        setFooter(null);
        const started = Date.now();
        const status = h('div', null, 'Searching stores for current prices…');
        const elapsed = h('div', { class: 'muted small' }, '0 s');
        const list = queries.length ? h('ul', { class: 'small muted' }, queries.map((q) => h('li', null, `“${q}”`))) : null;
        setContent(h('div', { class: 'loading' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'Analyzing' }), h('div', null, status, elapsed, list)));
        timer = setInterval(() => {
          elapsed.textContent = `${Math.round((Date.now() - started) / 1000)} s`;
        }, 1000);
      },
      updateQueries(queries) {
        const box = contentEl.querySelector('.loading > div:last-child');
        if (!box) return;
        box.querySelector('ul')?.remove();
        if (queries.length) box.append(h('ul', { class: 'small muted' }, queries.map((q) => h('li', null, `“${q}”`))));
      },
      showResult(result) {
        setTab(result.verdict.rating);
        setContent(renderVerdict(result));
        setFooter(result);
      },
      showError(error) {
        setTab(null);
        setFooter(null);
        const needsSettings = error.code === 'auth' || error.code === 'no_key' || error.code === 'permission';
        setContent(
          h(
            'div',
            { class: 'notice error', role: 'alert' },
            h('div', null, error.message || 'Something went wrong.'),
            h(
              'div',
              null,
              needsSettings
                ? h('button', { class: 'btn', type: 'button', onclick: () => handlers.onOpenSettings() }, 'Open settings')
                : h('button', { class: 'btn', type: 'button', onclick: () => handlers.onAnalyze(true) }, 'Try again')
            )
          )
        );
      },
      destroy() {
        if (timer) clearInterval(timer);
        host.remove();
      }
    };
  }

  ns.createPanel = createPanel;
  ns.RATING_LABELS = RATING_LABELS;
})(globalThis);
