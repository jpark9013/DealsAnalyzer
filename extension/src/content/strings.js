// The words the panel and product badges show, in English. With another
// language set, main.js asks the background for a translation (made once by
// Claude, then kept) and swaps it in with setStrings(). Every string is only
// ever inserted as text. {name} marks a value filled in by t().
(function (root) {
  'use strict';

  const ns = (root.DealsAnalyzer = root.DealsAnalyzer || {});

  const STRINGS = {
    r_strong_no: 'Strong no',
    r_no: 'No',
    r_maybe: 'Maybe',
    r_yes: 'Yes',
    r_strong_yes: 'Strong yes',

    m_same_item: 'same item',
    m_equivalent: 'equivalent',
    m_better: 'better specs',
    m_worse: 'weaker specs',
    m_similar: 'similar',

    q_instead: 'What would you buy instead?',
    q_cheaper: 'Is this likely to get cheaper soon?',
    q_downsides: 'What are the biggest downsides?',

    s_searching: 'Searching stores for current prices…',
    s_reading: 'Reading the search results…',
    s_thinking: 'Weighing the evidence…',
    s_writing: 'Writing the verdict…',
    s_checking: 'Checking prices on the store pages…',
    s_rechecking: 'Prices differ from the search results; re-rating…',

    d_same: 'same',
    d_less: '{n}% less',
    d_more: '{n}% more',
    ago_now: 'just now',
    ago_min: '{n} min ago',
    ago_h: '{n} h ago',
    ago_d: '{n} d ago',

    sources: 'Sources:',
    c_confirmed: '✓ checked {ago}',
    c_confirmed_tip: 'Read from the store page',
    c_changed: 'store page, {ago}',
    c_changed_tip: 'The search result showed a different price; this one is from the store page',
    c_unverified: 'not confirmed',
    c_unverified_tip: "The store didn't let us read its page, so this price comes from a search result. Open the link to check.",
    c_unverified_age_tip: "The store didn't let us read its page, so this price comes from a search result; that page was {age}. Open the link to check.",

    p_this_deal: 'This deal',
    p_equivalent: 'Equivalent products',
    p_equivalent_tip: 'Typical price of products with matching specs and build quality, in the same condition',
    p_same: 'Same item elsewhere',
    p_lowest: 'Lowest recently (may have ended)',
    p_lowest_tip: 'The lowest price this item has sold for recently. Past deals often have ended.',
    p_unconfirmed: 'not confirmed',
    p_unconfirmed_tip: "No store page showed a price this low just now. It came from search results, which may have expired; the rating doesn't count on it.",
    p_none: 'none found',
    p_equivalent_product: 'Equivalent product',
    price_check: 'Price check',

    judged_on: 'Judged on',
    compared_with: 'Compared with',
    left_out_more: '{n} more left out: no working store page, out of stock, or another country or condition.',
    left_out_all: '{n} found, all left out: no working store page, out of stock, or another country or condition.',
    pay_less: 'Ways to pay less',
    pay_less_note: "From search results. Codes and who qualifies aren't verified; check at checkout.",
    why_buy: 'Why buy',
    why_skip: 'Why skip',
    searches_one: '1 search',
    searches_many: '{n} searches',
    sources_one: '1 source',
    sources_many: '{n} sources',

    conf_high: 'high confidence',
    conf_medium: 'medium confidence',
    conf_low: 'low confidence',
    conf_why: 'How sure, from what the store pages confirmed:',
    conf_same_confirmed: "the same item's price confirmed on {n} other store page(s)",
    conf_equivalent_confirmed: "{n} equivalent product price(s) confirmed on store pages",
    conf_no_offers: 'no store prices to compare with',
    conf_mostly_unconfirmed: '{n} price(s) only from search results',
    conf_cheaper_unconfirmed: 'a lower price elsewhere could not be confirmed',
    conf_cheaper_confirmed: 'a store page shows equivalent value for less',
    conf_borderline: 'the price is close to the line between two ratings',
    conf_clear_margin: 'the price is well clear of the lines between ratings',
    conf_rating_vs_prices: "the rating rests on more than the prices here show (rivals, seller, reviews)",
    conf_little_research: 'little research ({n} search(es))',
    conf_deal_price_guessed: "this deal's price wasn't read from the page",

    revised_question: 'updated after your question',
    repriced: 're-rated with live store prices',

    ask_title: 'Ask about this deal',
    ask_placeholder: 'Ask a follow-up about this deal…',
    ask_label: 'Ask a follow-up question',
    ask: 'Ask',
    asking_searching: 'Searching…',
    asking_thinking: 'Thinking…',
    answering: 'Answering',
    went_wrong: 'Something went wrong.',

    brand: 'Deal check',
    tab_tip: 'Show deal analysis (drag to move)',
    tab_label: 'Show deal analysis',
    header_tip: 'Drag to move · double-click to reset size and position',
    settings: 'Settings',
    minimize: 'Minimize',
    panel_label: 'Deal analysis',
    reanalyze: 'Re-analyze',
    cached_ago: 'cached, {ago}',
    idle: 'Check this deal against current prices at other stores.',
    analyze_deal: 'Analyze deal',
    needs_key: 'Add your Anthropic API key to start rating deals. It stays in this browser.',
    open_settings: 'Open settings',
    analyzing: 'Analyzing',
    try_again: 'Try again',
    popup_button: 'Is this a good deal? Analyze',
    no_product: "Couldn't find a product with a price on this page. Open the product's own page, then try again.",
    disconnected: 'Lost the connection to the extension. Try again.',

    discounts: 'Discounts',
    discounts_loading: 'Looking for coupon codes and student, military and other discounts…',
    discounts_none: 'No current discounts found for this store or brand.',
    discounts_error: "Couldn't search for discounts: {message}",
    discounts_note: "From search results; codes and who qualifies aren't verified. Check at checkout.",
    discount_for_you: 'for you',
    discount_coupon_site: 'Code from a coupon site; it may not work.',
    copy: 'Copy',
    copied: 'Copied',
    w_anyone: 'Anyone',
    w_student: 'Students',
    w_military: 'Military & veterans',
    w_teacher: 'Teachers',
    w_healthcare: 'Healthcare workers',
    w_first_responder: 'First responders',
    w_senior: 'Seniors',
    w_member: 'Members',
    w_other: 'Other',

    b_queued: 'Deal check: waiting…',
    b_checking: 'Deal check: checking…',
    b_failed: "Deal check couldn't rate this",
    b_same: 'Same',
    b_equivalent: 'Equiv.',
    b_tip: 'Deals Analyzer: click for details',
    b_delta_tip: 'This price compared with the cheapest {kind} found elsewhere, {price}'
  };

  const KEYS = Object.keys(STRINGS);
  let current = { ...STRINGS };

  /** The string for `key`, with {name} filled in from `vars`. */
  function t(key, vars) {
    const template = current[key] ?? STRINGS[key] ?? key;
    if (!vars) return template;
    return template.replace(/\{([a-z_]+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
  }

  /** Swaps in translated strings, given in the order of KEYS. */
  function setStrings(texts) {
    current = { ...STRINGS };
    if (!Array.isArray(texts) || texts.length !== KEYS.length) return;
    KEYS.forEach((key, i) => {
      if (typeof texts[i] === 'string' && texts[i]) current[key] = texts[i];
    });
  }

  ns.STRINGS = STRINGS;
  ns.STRING_KEYS = KEYS;
  ns.t = t;
  ns.setStrings = setStrings;
})(globalThis);
