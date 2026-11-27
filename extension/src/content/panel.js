// The side panel that shows the verdict. Lives in a shadow root so the site's
// CSS can't reach it. Model output is only ever inserted as text.
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});

  // Words come from strings.js, in the shopper's language once translated.
  const t = (key, vars) => ns.t(key, vars);
  const RATING_ORDER = ['strong_no', 'no', 'maybe', 'yes', 'strong_yes'];
  const ratingLabel = (rating) => t(`r_${rating}`);
  // How a compared offer's specs stack up against the deal's product.
  const MATCHES = ['same_item', 'equivalent', 'better', 'worse'];
  const matchLabel = (match) => t(MATCHES.includes(match) ? `m_${match}` : 'm_similar');
  const SUGGESTED_QUESTIONS = ['q_instead', 'q_cheaper', 'q_downsides'];
  // What the panel says while an analysis runs.
  const STAGES = ['searching', 'reading', 'thinking', 'writing', 'checking', 'rechecking'];

  const MODEL_LABELS = {
    'claude-haiku-5-5': 'Haiku 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5'
  };

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    /* A fixed frame: header, a scrolling middle, then the question box and footer,
       which stay in view. Drag the header to move it; drag an edge to resize. */
    .panel {
      position: fixed; top: 88px; right: 16px; z-index: 2147483000;
      width: 348px; max-height: calc(100vh - 112px); overflow: hidden;
      display: flex; flex-direction: column;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 12px;
      box-shadow: 0 8px 28px rgba(31, 35, 40, .18);
    }
    .panel.dragging, .panel.dragging * { user-select: none; }
    [hidden] { display: none !important; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; flex: none;
      border-bottom: 1px solid #eaeef2; background: #fff; cursor: move; touch-action: none; user-select: none;
    }
    header button { cursor: pointer; }
    .scroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
    .rz { position: absolute; z-index: 3; touch-action: none; }
    .rz-l { left: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
    .rz-r { right: 0; top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
    .rz-b { bottom: 0; left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
    .rz-bl { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; }
    .rz-br { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; }
    .rz-br::after {
      content: ''; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px;
      border-right: 2px solid #c4cad1; border-bottom: 2px solid #c4cad1; border-bottom-right-radius: 3px;
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
    .body-content { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; }
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
    h3 { margin: 0 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #57606a; }
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
    .tag.m-same_item { background: #ddf4ff; color: #0969da; }
    .tag.m-better { background: #dafbe1; color: #1a7f37; }
    .tag.m-worse { background: #fff1e5; color: #bc4c00; }
    .check { display: block; font-size: 10px; font-weight: 600; text-align: right; white-space: nowrap; }
    .check.confirmed { color: #1a7f37; }
    .check.changed { color: #bc4c00; }
    .check.unverified { color: #6e7781; font-weight: 400; }
    .was { color: #6e7781; font-weight: 400; text-decoration: line-through; margin-right: 4px; }
    .savings .note, .offers-note { color: #6e7781; font-size: 11px; margin: 6px 0 0; }
    .offers .diff {
      color: #57606a; font-size: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    }
    .specs { display: flex; flex-wrap: wrap; gap: 4px; }
    .spec { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #f3f4f6; color: #3d444d; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .reasons { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
    details summary { cursor: pointer; color: #57606a; font-size: 12px; }
    .confidence { cursor: help; border-bottom: 1px dotted #8c959f; }
    .unconfirmed { display: block; font-size: 10px; font-weight: 400; color: #bc4c00; cursor: help; }
    td.num.dim > .amount { color: #6e7781; text-decoration: line-through; }
    .simple-row { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; border-top: 1px solid #f0f2f4; }
    .simple-row:first-child { border-top: 0; }
    .simple-row .what { flex: 1; min-width: 0; }
    .simple-row .what .prod { color: #57606a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .simple-row .num { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .discounts ul { padding: 0; }
    .discounts li { list-style: none; padding: 6px 0; border-top: 1px solid #f0f2f4; display: grid; gap: 2px; }
    .discounts li:first-child { border-top: 0; }
    .discounts .who { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: #57606a; }
    .discounts .mine { color: #1a7f37; margin-left: 6px; }
    .discounts .code { display: inline-flex; gap: 6px; align-items: center; margin-top: 2px; }
    .discounts code { font: 600 12px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 6px; border: 1px dashed #8c959f; border-radius: 4px; background: #f6f8fa; }
    .discounts .copy { font-size: 11px; padding: 1px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; }
    .discounts .warn { font-size: 10px; color: #bc4c00; }
    .discounts .note { color: #6e7781; font-size: 11px; margin: 6px 0 0; }
    .discounts .loading { display: flex; gap: 8px; align-items: center; color: #57606a; font-size: 12px; }
    .spinner.small-spinner { width: 14px; height: 14px; border-width: 2px; flex: none; }
    details ul { margin-top: 6px; font-size: 12px; }
    footer {
      display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid #eaeef2;
      font-size: 11px; color: #6e7781; flex: none;
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
      cursor: grab; touch-action: none; user-select: none;
    }
    /* Once dragged off the edge it floats, so it gets a full border. */
    .tab.floating { border-right: 1px solid #d0d7de; border-radius: 10px; }
    .tab.dragging { cursor: grabbing; }
    .tab .dot { width: 10px; height: 10px; border-radius: 50%; }
    .revised { font-size: 11px; color: #8250df; font-weight: 600; }
    .chat { display: grid; gap: 8px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip {
      border: 1px solid #d0d7de; background: #fff; color: #0969da; border-radius: 999px;
      padding: 3px 10px; font-size: 12px; font-weight: 600;
    }
    .chip:hover { background: #f3f8ff; }
    .msg { border-radius: 10px; padding: 7px 10px; overflow-wrap: anywhere; }
    .msg.user { justify-self: end; max-width: 88%; background: #ddf4ff; color: #0a3069; white-space: pre-wrap; }
    .msg.assistant { background: #f6f8fa; }
    .msg.assistant p { margin: 0 0 6px; }
    .msg.assistant ul { margin: 0 0 6px; }
    .msg.assistant > :last-child { margin-bottom: 0; }
    .msg .cites { margin-top: 6px; font-size: 11px; color: #57606a; }
    .msg .cites a { margin-right: 6px; }
    .msg .cost { margin-top: 4px; font-size: 10px; color: #8c959f; }
    .msg.error { background: #fff1f0; color: #82071e; }
    .msg.pending { display: flex; gap: 8px; align-items: flex-start; color: #57606a; }
    .msg.pending ul { margin: 4px 0 0; font-size: 12px; }
    /* Outside the scrolling area, so a question is always one click away. The
       box and button share a 34px height; the button stays at the bottom as the box grows. */
    .composer {
      flex: none; display: flex; gap: 6px; align-items: flex-end;
      padding: 8px 12px; background: #fff; border-top: 1px solid #eaeef2;
    }
    .composer textarea {
      flex: 1; resize: none; font: inherit; line-height: 20px; color: inherit; background: #fff;
      border: 1px solid #d0d7de; border-radius: 8px; padding: 6px 10px; margin: 0;
      height: 34px; min-height: 34px; max-height: 110px; display: block;
    }
    .composer .btn { height: 34px; padding: 0 14px; font-size: 13px; flex: none; }
    .composer textarea:focus { outline: none; border-color: #1f6feb; box-shadow: 0 0 0 3px rgba(31, 111, 235, .15); }
    .composer .btn:disabled, .chip:disabled { opacity: .5; cursor: default; }
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
    if (seconds < 60) return t('ago_now');
    if (seconds < 3600) return t('ago_min', { n: Math.round(seconds / 60) });
    if (seconds < 86400) return t('ago_h', { n: Math.round(seconds / 3600) });
    return t('ago_d', { n: Math.round(seconds / 86400) });
  }

  // "27% less than typical" / "8% more than typical"
  function deltaVs(dealPrice, reference) {
    if (!reference || typeof dealPrice !== 'number') return null;
    const pct = Math.round(((reference - dealPrice) / reference) * 100);
    if (pct === 0) return h('span', { class: 'delta muted' }, t('d_same'));
    return pct > 0
      ? h('span', { class: 'delta good' }, t('d_less', { n: pct }))
      : h('span', { class: 'delta bad' }, t('d_more', { n: -pct }));
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
        RATING_ORDER.map((r, i) => h('span', { class: i === active ? 'on' : '' }, ratingLabel(r)))
      )
    );
  }

  // Bold spans inside a line of Claude's answer.
  function inline(line) {
    return line.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? h('strong', null, part) : part));
  }

  // The little Markdown Claude uses in answers (paragraphs, "- " lists,
  // **bold**), built as DOM nodes so nothing in the answer is parsed as HTML.
  function richText(text) {
    const out = [];
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+/;
    for (const block of String(text).replace(/\r/g, '').split(/\n{2,}/)) {
      let para = null;
      let list = null;
      for (const raw of block.split('\n')) {
        const line = raw.replace(/^#+\s*/, '').trimEnd();
        if (!line.trim()) continue;
        if (bullet.test(line)) {
          if (!list) out.push((list = h('ul')));
          para = null;
          list.append(h('li', null, inline(line.replace(bullet, ''))));
        } else {
          if (para) para.append(h('br'));
          else out.push((para = h('p')));
          list = null;
          para.append(...inline(line));
        }
      }
    }
    return out;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function renderTurn(turn) {
    if (turn.role === 'user') return h('div', { class: 'msg user' }, turn.text);
    const sources = (turn.sources || []).filter((s) => safeHref(s.url));
    return h(
      'div',
      { class: 'msg assistant' },
      richText(turn.text),
      sources.length
        ? h(
            'div',
            { class: 'cites' },
            `${t('sources')} `,
            sources.map((s, i) =>
              h('a', { href: safeHref(s.url), target: '_blank', rel: 'noopener noreferrer', title: s.title }, `[${i + 1}] ${hostOf(s.url)}`)
            )
          )
        : null,
      typeof turn.costUsd === 'number' ? h('div', { class: 'cost' }, `~$${turn.costUsd.toFixed(3)}`) : null
    );
  }

  // Where an offer's price comes from, since only some could be read from the store.
  function renderCheck(o) {
    if (o.check === 'confirmed') return h('span', { class: 'check confirmed', title: t('c_confirmed_tip') }, t('c_confirmed', { ago: timeAgo(o.checkedAt) }));
    if (o.check === 'changed') return h('span', { class: 'check changed', title: t('c_changed_tip') }, t('c_changed', { ago: timeAgo(o.checkedAt) }));
    if (o.check === 'unverified') {
      const tip = o.pageAge ? t('c_unverified_age_tip', { age: o.pageAge }) : t('c_unverified_tip');
      return h('span', { class: 'check unverified', title: tip }, t('c_unverified'));
    }
    return null;
  }

  // "not confirmed" under a lower price no store page backed up (confidence.js).
  function unconfirmedTag(state) {
    return state === 'unconfirmed' ? h('span', { class: 'unconfirmed', title: t('p_unconfirmed_tip') }, t('p_unconfirmed')) : null;
  }

  // Why the confidence is what it is, for its tooltip.
  function confidenceTip(v) {
    const reasons = (v.confidenceReasons || []).map((r) => `${r.sign > 0 ? '+' : '−'} ${t(`conf_${r.code}`, { n: r.n ?? '' })}`);
    return reasons.length ? `${t('conf_why')}\n${reasons.join('\n')}` : null;
  }

  function verdictHeader(v, result) {
    return h(
      'div',
      { class: 'verdict-row' },
      h('span', { class: `pill r-${v.rating}` }, ratingLabel(v.rating)),
      v.confidence ? h('span', { class: 'muted small confidence', title: confidenceTip(v) }, t(`conf_${v.confidence}`)) : null,
      result.revisedAt ? h('span', { class: 'revised' }, t('revised_question')) : null,
      v.repriced ? h('span', { class: 'revised' }, t('repriced')) : null
    );
  }

  // Confirmed and live prices first, then the ones only a search result gave.
  function byEvidence(offers) {
    const live = (o) => (o.check === 'confirmed' || o.check === 'changed' ? 0 : 1);
    return [...offers].sort((a, b) => {
      if (live(a) !== live(b)) return live(a) - live(b);
      if (a.price === null || b.price === null) return (a.price === null) - (b.price === null);
      return a.price - b.price;
    });
  }

  // The simple verdict: the rating, and the deal against the same item and an
  // equivalent product elsewhere, each linked to the store page it was read from.
  function renderSimple(result) {
    const v = result.verdict;
    const support = v.priceSupport || {};
    const row = (label, offer, price, state) =>
      h(
        'div',
        { class: 'simple-row' },
        h(
          'div',
          { class: 'what' },
          h('div', null, label),
          offer ? h('div', { class: 'prod', title: offer.product || '' }, offer.url ? link(offer.url, offer.store) : offer.store, offer.product ? ` · ${offer.product}` : '') : null
        ),
        h(
          'div',
          { class: `num${state === 'unconfirmed' ? ' dim' : ''}` },
          typeof price === 'number' ? h('span', { class: 'amount' }, money(price)) : h('span', { class: 'muted' }, t('p_none')),
          typeof price === 'number' ? deltaVs(v.dealPrice, price) : null,
          offer ? renderCheck(offer) : null,
          unconfirmedTag(state)
        )
      );
    const sameOffer = v.comparableOffers.find((o) => o.match === 'same_item') || null;
    const equivOffer = v.comparableOffers.find((o) => o.match !== 'same_item') || null;
    return [
      v.rating ? h('section', { class: 'verdict', 'data-rating': v.rating }, verdictHeader(v, result), renderScale(v.rating)) : null,
      h(
        'section',
        null,
        h('h3', null, t('price_check')),
        row(t('p_this_deal'), null, v.dealPrice, null),
        row(t('p_same'), sameOffer, v.sameItemPrice, support.sameItem),
        row(v.equivalentProduct ? `${t('p_equivalent_product')}` : t('p_equivalent'), equivOffer, v.equivalentMarketPrice, support.equivalent)
      )
    ];
  }

  function renderVerdict(result) {
    const v = result.verdict;
    if (v.simple) return renderSimple(result);
    const support = v.priceSupport || {};
    const priceRow = (label, value, { compare = false, hint = null, state = null } = {}) =>
      value === null || value === undefined
        ? null
        : h(
            'tr',
            null,
            h('td', { title: hint }, label),
            h(
              'td',
              { class: `num${state === 'unconfirmed' ? ' dim' : ''}` },
              h('span', { class: 'amount' }, money(value)),
              compare ? deltaVs(v.dealPrice, value) : null,
              unconfirmedTag(state)
            )
          );
    const priceRows = [
      priceRow(t('p_this_deal'), v.dealPrice),
      priceRow(t('p_equivalent'), v.equivalentMarketPrice, { compare: true, hint: t('p_equivalent_tip'), state: support.equivalent }),
      priceRow(t('p_same'), v.sameItemPrice, { compare: true, state: support.sameItem }),
      priceRow(t('p_lowest'), v.lowestRecentPrice, { hint: t('p_lowest_tip') })
    ].filter(Boolean);

    const specs = v.keySpecs.length
      ? h('section', null, h('h3', null, t('judged_on')), h('div', { class: 'specs' }, v.keySpecs.map((s) => h('span', { class: 'spec' }, s))))
      : null;

    const byPrice = byEvidence(v.comparableOffers);
    const offers = byPrice.length
      ? h(
          'section',
          null,
          h('h3', null, t('compared_with')),
          h(
            'ul',
            { class: 'offers' },
            byPrice.map((o) =>
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
                    h('span', { class: `tag${o.match ? ` m-${o.match}` : ''}` }, matchLabel(o.match)),
                    o.condition && o.condition !== 'new' ? h('span', { class: 'tag' }, o.condition) : null
                  ),
                  o.product ? h('div', { class: 'prod', title: o.product }, o.product) : null,
                  o.specDifferences ? h('div', { class: 'diff', title: o.specDifferences }, o.specDifferences) : null
                ),
                h(
                  'div',
                  { class: 'num' },
                  o.check === 'changed' && o.quotedPrice !== null ? h('span', { class: 'was' }, money(o.quotedPrice)) : null,
                  money(o.price),
                  renderCheck(o)
                )
              )
            )
          ),
          v.offersHidden
            ? h('p', { class: 'offers-note' }, t('left_out_more', { n: v.offersHidden }))
            : null
        )
      : v.offersHidden
        ? h('section', null, h('h3', null, t('compared_with')), h('p', { class: 'offers-note' }, t('left_out_all', { n: v.offersHidden })))
        : null;

    const savings = v.savings?.length
      ? h(
          'section',
          { class: 'savings' },
          h('h3', null, t('pay_less')),
          h('ul', null, v.savings.map((s) => h('li', null, s.url ? link(s.url, s.text) : s.text))),
          h('p', { class: 'note' }, t('pay_less_note'))
        )
      : null;

    const reasons =
      v.reasonsFor.length || v.reasonsAgainst.length
        ? h(
            'div',
            { class: 'reasons' },
            h('section', null, h('h3', null, t('why_buy')), h('ul', null, v.reasonsFor.map((r) => h('li', null, r)))),
            h('section', null, h('h3', null, t('why_skip')), h('ul', null, v.reasonsAgainst.map((r) => h('li', null, r))))
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
              `${result.queries.length === 1 ? t('searches_one') : t('searches_many', { n: result.queries.length })}, ${
                result.sources.length === 1 ? t('sources_one') : t('sources_many', { n: result.sources.length })
              }`
            ),
            result.queries.length ? h('ul', null, result.queries.map((q) => h('li', null, `“${q}”`))) : null,
            result.sources.length ? h('ul', null, result.sources.map((s) => h('li', null, link(s.url, s.title)))) : null
          )
        : null;

    // While the verdict streams in, the rating may not have arrived yet.
    const verdict = v.rating
      ? h(
          'section',
          { class: 'verdict', 'data-rating': v.rating },
          verdictHeader(v, result),
          v.headline ? h('div', { class: 'headline' }, v.headline) : null,
          renderScale(v.rating)
        )
      : null;

    return [
      verdict,
      specs,
      priceRows.length ? h('section', null, h('h3', null, t('price_check')), h('table', null, h('tbody', null, priceRows))) : null,
      offers,
      savings,
      reasons,
      research
    ];
  }

  /**
   * @param {{onAnalyze: (force: boolean) => void, onOpenSettings: () => void,
   *          onAsk?: (question: string) => void,
   *          onExpand?: () => void,
   *          onCollapseChange?: (collapsed: boolean) => void,
   *          onLayoutChange?: (layout: {geometry: object|null, tabPosition: object|null}) => void}} handlers
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
    const reanalyzeBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => handlers.onAnalyze(true) }, t('reanalyze'));
    // Discounts load on their own, alongside the verdict, and stay across its states.
    const discountsEl = h('section', { class: 'discounts', hidden: true, 'aria-live': 'polite' });
    const footer = h('footer', { hidden: true }, metaEl, reanalyzeBtn);

    const input = h('textarea', {
      rows: '1',
      maxlength: '1000',
      placeholder: t('ask_placeholder'),
      'aria-label': t('ask_label')
    });
    const askBtn = h('button', { class: 'btn primary', type: 'submit' }, t('ask'));
    const composer = h(
      'form',
      {
        class: 'composer',
        hidden: true,
        onsubmit: (event) => {
          event.preventDefault();
          ask(input.value);
        }
      },
      input,
      askBtn
    );
    const chatEl = h('section', { class: 'chat', 'aria-live': 'polite' });

    const tabDot = h('span', { class: 'dot' });
    const tabLabel = h('span', null, t('brand'));
    const tab = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        hidden: true,
        title: t('tab_tip'),
        'aria-label': t('tab_label'),
        onclick: () => {
          if (tabDragged) tabDragged = false;
          else {
            setCollapsed(false);
            if (handlers.onExpand) handlers.onExpand();
          }
        }
      },
      tabDot,
      tabLabel
    );

    const brandEl = h('span', { class: 'brand' }, t('brand'));
    const settingsBtn = h('button', { class: 'icon-btn', type: 'button', title: t('settings'), 'aria-label': t('settings'), onclick: () => handlers.onOpenSettings() }, '⚙');
    const minimizeBtn = h('button', { class: 'icon-btn', type: 'button', title: t('minimize'), 'aria-label': t('minimize'), onclick: () => setCollapsed(true) }, '–');
    const header = h('header', { title: t('header_tip') }, brandEl, settingsBtn, minimizeBtn);
    const panel = h(
      'aside',
      { class: 'panel', role: 'complementary', 'aria-label': t('panel_label'), hidden: true },
      header,
      h('div', { class: 'scroll' }, h('div', { class: 'body' }, h('div', null, titleEl, subEl), contentEl, discountsEl)),
      composer,
      footer,
      ['l', 'r', 'b', 'bl', 'br'].map((edge) => h('div', { class: `rz rz-${edge}`, 'data-edge': edge, 'aria-hidden': 'true' }))
    );

    shadow.append(style, panel, tab);
    document.documentElement.append(host);

    let timer = null;
    let collapsed = false;
    let visible = false;
    let current = null; // the result on screen, with its chat turns
    let pending = null; // { question, queries } while a follow-up runs
    let askError = null;
    let loading = null; // the progress elements while an analysis runs
    let discounts = null; // { state: 'loading'|'done'|'error', items, error }
    let rerender = null; // redraws the current state, after the words change

    // --- Moving and resizing -------------------------------------------------
    // The panel starts docked top-right (from CSS). Once moved or resized it
    // has an explicit box; height stays automatic until an edge sets it.
    const MIN_WIDTH = 280;
    const MAX_WIDTH = 760;
    const MIN_HEIGHT = 220;
    const MARGIN = 8;
    let geometry = null; // { left, top, width, height|null }
    let tabPosition = null; // { left, top } once the tab is dragged
    let tabDragged = false;

    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi));

    // Keeps the panel on screen, even after the window shrinks.
    function applyGeometry() {
      const style = panel.style;
      if (!geometry) {
        for (const prop of ['left', 'top', 'right', 'width', 'height', 'maxHeight']) style[prop] = '';
        return;
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = clamp(geometry.width, MIN_WIDTH, Math.min(MAX_WIDTH, vw - 2 * MARGIN));
      const height = geometry.height === null ? null : clamp(geometry.height, MIN_HEIGHT, vh - 2 * MARGIN);
      const left = clamp(geometry.left, MARGIN, vw - width - MARGIN);
      const top = clamp(geometry.top, MARGIN, vh - (height ?? 60) - MARGIN);
      Object.assign(style, {
        left: `${left}px`,
        top: `${top}px`,
        right: 'auto',
        width: `${width}px`,
        height: height === null ? '' : `${height}px`,
        maxHeight: height === null ? `${vh - top - MARGIN}px` : 'none'
      });
    }

    function applyTabPosition() {
      tab.classList.toggle('floating', Boolean(tabPosition));
      if (!tabPosition) {
        tab.style.left = tab.style.top = tab.style.right = '';
        return;
      }
      const box = tab.getBoundingClientRect();
      tab.style.left = `${clamp(tabPosition.left, 0, window.innerWidth - box.width)}px`;
      tab.style.top = `${clamp(tabPosition.top, 0, window.innerHeight - box.height)}px`;
      tab.style.right = 'auto';
    }

    function saveLayout() {
      if (handlers.onLayoutChange) handlers.onLayoutChange({ geometry, tabPosition });
    }

    // Follows one pointer from pointerdown until it's released.
    function track(event, onMove, onEnd) {
      const target = event.currentTarget;
      if (target.setPointerCapture) target.setPointerCapture(event.pointerId);
      const x = event.clientX;
      const y = event.clientY;
      const move = (e) => onMove(e.clientX - x, e.clientY - y);
      const end = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', end);
        target.removeEventListener('pointercancel', end);
        onEnd();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', end);
      target.addEventListener('pointercancel', end);
    }

    header.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      const box = panel.getBoundingClientRect();
      const start = { left: box.left, top: box.top, width: box.width, height: geometry ? geometry.height : null };
      panel.classList.add('dragging');
      track(
        event,
        (dx, dy) => {
          geometry = { ...start, left: start.left + dx, top: start.top + dy };
          applyGeometry();
        },
        () => {
          panel.classList.remove('dragging');
          saveLayout();
        }
      );
    });
    header.addEventListener('dblclick', (event) => {
      if (event.target.closest('button')) return;
      geometry = null;
      applyGeometry();
      saveLayout();
    });

    for (const handle of panel.querySelectorAll('.rz')) {
      const edge = handle.dataset.edge;
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const box = panel.getBoundingClientRect();
        panel.classList.add('dragging');
        track(
          event,
          (dx, dy) => {
            const next = { left: box.left, top: box.top, width: box.width, height: geometry ? geometry.height : null };
            if (edge.includes('l')) {
              next.width = clamp(box.width - dx, MIN_WIDTH, MAX_WIDTH);
              next.left = box.left + box.width - next.width;
            }
            if (edge.includes('r')) next.width = clamp(box.width + dx, MIN_WIDTH, MAX_WIDTH);
            if (edge.includes('b')) next.height = Math.max(MIN_HEIGHT, box.height + dy);
            geometry = next;
            applyGeometry();
          },
          () => {
            panel.classList.remove('dragging');
            saveLayout();
          }
        );
      });
    }

    // A short press is a click (opens the panel); moving a few pixels drags.
    tab.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const box = tab.getBoundingClientRect();
      tabDragged = false;
      track(
        event,
        (dx, dy) => {
          if (!tabDragged && Math.hypot(dx, dy) < 4) return;
          tabDragged = true;
          tab.classList.add('dragging');
          tabPosition = { left: box.left + dx, top: box.top + dy };
          applyTabPosition();
        },
        () => {
          tab.classList.remove('dragging');
          if (tabDragged) saveLayout();
        }
      );
    });

    window.addEventListener('resize', () => {
      if (geometry) applyGeometry();
      if (tabPosition) applyTabPosition();
    });

    // Grows the question box with its text, up to the CSS max-height.
    function autosize() {
      input.style.height = '';
      if (input.value && input.scrollHeight) input.style.height = `${Math.min(input.scrollHeight + 2, 110)}px`;
    }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (event) => {
      // Keep the page's own keyboard shortcuts from firing while typing here.
      event.stopPropagation();
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        ask(input.value);
      }
    });

    function ask(text) {
      const question = String(text || '').trim();
      if (!question || pending || !current || !handlers.onAsk) return;
      input.value = '';
      autosize();
      handlers.onAsk(question);
    }

    function setAskingEnabled(enabled) {
      input.disabled = !enabled;
      askBtn.disabled = !enabled;
    }

    function renderChat() {
      const turns = current?.turns || [];
      const items = [h('h3', null, t('ask_title'))];
      if (!turns.length && !pending) {
        items.push(
          h(
            'div',
            { class: 'chips' },
            SUGGESTED_QUESTIONS.map((key) => h('button', { class: 'chip', type: 'button', onclick: () => ask(t(key)) }, t(key)))
          )
        );
      }
      items.push(...turns.map(renderTurn));
      if (pending) {
        items.push(
          h('div', { class: 'msg user' }, pending.question),
          h(
            'div',
            { class: 'msg pending' },
            h('div', { class: 'spinner', role: 'status', 'aria-label': t('answering') }),
            h(
              'div',
              null,
              pending.queries.length ? t('asking_searching') : t('asking_thinking'),
              pending.queries.length ? h('ul', null, pending.queries.map((q) => h('li', null, `“${q}”`))) : null
            )
          )
        );
      }
      if (askError) items.push(h('div', { class: 'msg error', role: 'alert' }, askError.message || t('went_wrong')));
      chatEl.replaceChildren(...items);
    }

    function revealLatest() {
      const last = chatEl.lastElementChild;
      if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' });
    }

    // The discounts found for this store and brand: like a coupon finder,
    // codes to copy and programs for groups such as students and military.
    function renderDiscounts() {
      if (!discounts) {
        discountsEl.hidden = true;
        discountsEl.replaceChildren();
        return;
      }
      discountsEl.hidden = false;
      const items = [h('h3', null, t('discounts'))];
      if (discounts.state === 'loading') {
        items.push(h('div', { class: 'loading' }, h('div', { class: 'spinner small-spinner', role: 'status' }), t('discounts_loading')));
      } else if (discounts.state === 'error') {
        items.push(h('p', { class: 'note' }, t('discounts_error', { message: discounts.error?.message || t('went_wrong') })));
      } else if (!discounts.items.length) {
        items.push(h('p', { class: 'note' }, t('discounts_none')));
      } else {
        const mine = new Set(discounts.groups || []);
        items.push(
          h(
            'ul',
            null,
            discounts.items.map((d) =>
              h(
                'li',
                null,
                h('span', { class: 'who' }, t(`w_${d.who}`), mine.has(d.who) ? h('span', { class: 'mine' }, `✓ ${t('discount_for_you')}`) : null),
                h('span', null, link(d.url, d.offer)),
                d.code
                  ? h(
                      'span',
                      { class: 'code' },
                      h('code', null, d.code),
                      h('button', { class: 'copy', type: 'button', onclick: (event) => copyCode(event.currentTarget, d.code) }, t('copy'))
                    )
                  : null,
                d.code && d.couponSite ? h('span', { class: 'warn' }, t('discount_coupon_site')) : null
              )
            )
          ),
          h('p', { class: 'note' }, t('discounts_note'))
        );
      }
      discountsEl.replaceChildren(...items);
    }

    function copyCode(button, code) {
      const done = () => {
        button.textContent = t('copied');
        setTimeout(() => (button.textContent = t('copy')), 1500);
      };
      try {
        Promise.resolve(navigator.clipboard?.writeText(code)).then(done, () => {});
      } catch {
        // No clipboard here; the code is on screen to select.
      }
    }

    function renderResult() {
      setTab(current.verdict.rating);
      setContent(renderVerdict(current), chatEl);
      setFooter(current);
      renderChat();
    }

    // Any non-result state: no verdict on screen, so nothing to ask about.
    function leaveResult() {
      current = null;
      pending = null;
      askError = null;
      composer.hidden = true;
    }

    function setCollapsed(next) {
      collapsed = next;
      panel.hidden = !visible || collapsed;
      tab.hidden = !visible || !collapsed;
      if (handlers.onCollapseChange) handlers.onCollapseChange(collapsed);
    }

    function setTab(rating) {
      tabDot.className = `dot${rating ? ` r-${rating}` : ''}`;
      tabLabel.textContent = rating ? ratingLabel(rating) : t('brand');
    }

    function setContent(...nodes) {
      if (timer) clearInterval(timer);
      timer = null;
      loading = null;
      contentEl.replaceChildren(...nodes.flat().filter(Boolean));
    }

    function setFooter(result) {
      footer.hidden = !result;
      reanalyzeBtn.hidden = !result;
      if (!result) return;
      const parts = [MODEL_LABELS[result.model] || result.model];
      if (typeof result.usage?.costUsd === 'number') parts.push(`~$${result.usage.costUsd.toFixed(3)}`);
      parts.push(result.cached ? t('cached_ago', { ago: timeAgo(result.analyzedAt) }) : timeAgo(result.analyzedAt));
      metaEl.textContent = parts.join(' · ');
    }

    return {
      host,
      shadow,
      show({ collapsed: startCollapsed = false, layout = null } = {}) {
        visible = true;
        geometry = layout?.geometry || null;
        tabPosition = layout?.tabPosition || null;
        setCollapsed(startCollapsed);
        applyGeometry();
        applyTabPosition();
      },
      setDeal(deal) {
        titleEl.textContent = deal.title || deal.productName || 'This deal';
        titleEl.title = deal.productName || '';
        const price = typeof deal.finalPrice === 'number' ? money(deal.finalPrice) : null;
        subEl.textContent = [price, deal.store && `at ${deal.store}`, deal.condition && deal.condition !== 'new' && deal.condition]
          .filter(Boolean)
          .join(' · ');
      },
      showIdle() {
        rerender = () => this.showIdle();
        leaveResult();
        setTab(null);
        setFooter(null);
        setContent(
          h(
            'div',
            { class: 'notice' },
            h('div', null, t('idle')),
            h('div', null, h('button', { class: 'btn primary', type: 'button', onclick: () => handlers.onAnalyze(false) }, t('analyze_deal')))
          )
        );
      },
      showNeedsKey() {
        rerender = () => this.showNeedsKey();
        leaveResult();
        setTab(null);
        setFooter(null);
        setContent(
          h(
            'div',
            { class: 'notice' },
            h('div', null, t('needs_key')),
            h('div', null, h('button', { class: 'btn primary', type: 'button', onclick: () => handlers.onOpenSettings() }, t('open_settings')))
          )
        );
      },
      showLoading() {
        rerender = null;
        leaveResult();
        setTab(null);
        setFooter(null);
        const started = Date.now();
        const status = h('div', null, t('s_searching'));
        const list = h('ul', { class: 'small muted' });
        // The verdict, field by field, as Claude writes it.
        const partial = h('div', { class: 'body-content' });
        const elapsed = h('div', { class: 'muted small' }, '0 s');
        setContent(
          h('div', { class: 'loading' }, h('div', { class: 'spinner', role: 'status', 'aria-label': t('analyzing') }), h('div', null, status, elapsed, list)),
          partial
        );
        loading = { status, list, partial };
        timer = setInterval(() => {
          elapsed.textContent = `${Math.round((Date.now() - started) / 1000)} s`;
        }, 1000);
      },
      /** @param {{stage?: string, queries?: string[], partial?: object|null}} progress */
      updateProgress({ stage, queries = [], partial = null } = {}) {
        if (!loading) return;
        if (STAGES.includes(stage)) loading.status.textContent = t(`s_${stage}`);
        loading.list.replaceChildren(...queries.map((q) => h('li', null, `“${q}”`)));
        if (partial) {
          if (partial.rating) setTab(partial.rating);
          loading.partial.replaceChildren(...renderVerdict({ verdict: partial, queries: [], sources: [] }).filter(Boolean));
        }
      },
      showResult(result) {
        rerender = () => renderResult();
        current = { ...result, turns: result.turns || [] };
        pending = null;
        askError = null;
        composer.hidden = !handlers.onAsk;
        setAskingEnabled(true);
        renderResult();
      },
      showAsking(question) {
        pending = { question, queries: [] };
        askError = null;
        setAskingEnabled(false);
        renderChat();
        revealLatest();
      },
      updateAskQueries(queries) {
        if (!pending) return;
        pending.queries = queries;
        renderChat();
      },
      // `revision` is set when the follow-up changed the verdict.
      showAnswer({ turns, revision }) {
        pending = null;
        current = { ...current, ...(revision || {}), turns };
        setAskingEnabled(true);
        if (revision) renderResult();
        else renderChat();
        revealLatest();
      },
      showAskError(error, question) {
        pending = null;
        askError = error || {};
        setAskingEnabled(true);
        if (!input.value) input.value = question || '';
        renderChat();
        revealLatest();
      },
      showError(error) {
        rerender = () => this.showError(error);
        leaveResult();
        setTab(null);
        setFooter(null);
        const needsSettings = error.code === 'auth' || error.code === 'no_key' || error.code === 'permission';
        setContent(
          h(
            'div',
            { class: 'notice error', role: 'alert' },
            h('div', null, error.message || t('went_wrong')),
            h(
              'div',
              null,
              needsSettings
                ? h('button', { class: 'btn', type: 'button', onclick: () => handlers.onOpenSettings() }, t('open_settings'))
                : h('button', { class: 'btn', type: 'button', onclick: () => handlers.onAnalyze(true) }, t('try_again'))
            )
          )
        );
      },
      /** @param {{state: string, items?: object[], groups?: string[], error?: object}|null} next */
      setDiscounts(next) {
        discounts = next ? { items: [], ...next } : null;
        renderDiscounts();
      },
      /** Puts the panel's own words in the language strings.js now holds. */
      relabel() {
        brandEl.textContent = t('brand');
        settingsBtn.title = t('settings');
        settingsBtn.setAttribute('aria-label', t('settings'));
        minimizeBtn.title = t('minimize');
        minimizeBtn.setAttribute('aria-label', t('minimize'));
        header.title = t('header_tip');
        panel.setAttribute('aria-label', t('panel_label'));
        tab.title = t('tab_tip');
        tab.setAttribute('aria-label', t('tab_label'));
        reanalyzeBtn.textContent = t('reanalyze');
        input.placeholder = t('ask_placeholder');
        input.setAttribute('aria-label', t('ask_label'));
        askBtn.textContent = t('ask');
        if (!loading) setTab(current?.verdict?.rating || null);
        if (rerender) rerender();
        if (current) setFooter(current);
        renderDiscounts();
      },
      destroy() {
        if (timer) clearInterval(timer);
        host.remove();
      }
    };
  }

  ns.createPanel = createPanel;
  // For the product badges (badges.js).
  ns.ui = { h, money, deltaVs, safeHref, ratingLabel, STYLE_RATINGS: STYLE.match(/\.r-strong_no[\s\S]*?\.r-strong_yes[^}]*\}/)[0] };
})(globalThis);
